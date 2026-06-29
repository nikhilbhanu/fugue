/* @ts-self-types="./fugue_wasm.d.ts" */

/**
 * Hot-swap shim around [`fugue_eval::Engine`]. Stores the active
 * interpreter; `new` and `hot_swap` re-build from source.
 *
 * The `hot_swap` migration path uses Engine's existing `move_node_state`
 * (W1.1's RT-safe degradation pattern preserves the audio thread on
 * invalid input). State across hot-swap is migrated *by node identity*
 * — patches that share node names + arities migrate state; renamed
 * nodes restart at default.
 */
export class Engine {
    static __wrap(ptr) {
        const obj = Object.create(Engine.prototype);
        obj.__wbg_ptr = ptr;
        EngineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        EngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_engine_free(ptr, 0);
    }
    /**
     * Fill `out` with the active mini-notation spans from the most recent
     * `step_block` as a flat, packed list of `[start, end]` u32 pairs — one
     * per atom sounding at the block's first sample, across all voices (a
     * voiced chord-name lights once; simultaneous voices each contribute).
     * Returns the number of u32s written (`pairs * 2`); the tail of `out` is
     * left untouched. No allocation on our side — mirrors the `voice_levels`
     * fill-buffer pattern.
     *
     * The playground pre-allocates one `Uint32Array` sized to
     * `active_spans_capacity()` and passes it here on every meter tap (~62 Hz),
     * then reads back the returned length. Each pair is an absolute `.fugue`
     * byte range that CodeMirror highlights.
     * @param {Uint32Array} out
     * @returns {number}
     */
    active_spans(out) {
        var ptr0 = passArray32ToWasm0(out, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_active_spans(this.__wbg_ptr, ptr0, len0, out);
        return ret >>> 0;
    }
    /**
     * Upper bound on the u32s `active_spans` can write this build — the
     * playground sizes its tap buffer to this so the fill is never truncated.
     * @returns {number}
     */
    active_spans_capacity() {
        const ret = wasm.engine_active_spans_capacity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Panic / all-notes-off.
     */
    all_notes_off() {
        wasm.engine_all_notes_off(this.__wbg_ptr);
    }
    /**
     * Arm voice `i` for the live keyboard, or `-1` to disarm. `midi_only`
     * selects the mode: `false` = override (pattern plays, live preempts while
     * held), `true` = MIDI-only (pattern muted whenever armed). Exclusive:
     * arming one voice disarms any other. Non-armable / out-of-range disarms.
     * @param {number} voice
     * @param {boolean} midi_only
     */
    arm(voice, midi_only) {
        wasm.engine_arm(this.__wbg_ptr, voice, midi_only);
    }
    /**
     * Whether voice `i` can take live input (drives a note/trig process).
     * @param {number} i
     * @returns {boolean}
     */
    armable(i) {
        const ret = wasm.engine_armable(this.__wbg_ptr, i);
        return ret !== 0;
    }
    /**
     * Build the successor engine for a hot-swap **without installing it**.
     * Returns a fresh `Engine` carrying param / transport / voice-mix
     * state from `self`; the caller holds both and crossfades.
     *
     * This is the playground's hot-swap entry point: the worklet renders
     * the old and new engine across one render block under an equal-power
     * ramp, masking the click a bare swap produces (every oscillator
     * phase and filter state is reborn at zero in the new engine). On
     * compile/build failure the old engine is untouched and the error
     * surfaces to the UI.
     * @param {string} new_source
     * @returns {Engine}
     */
    build_successor(new_source) {
        const ptr0 = passStringToWasm0(new_source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_build_successor(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Engine.__wrap(ret[0]);
    }
    /**
     * Re-parse the source, build a new engine, migrate state from the
     * current one, and install. The audio thread keeps running through
     * the swap — the simple v0.2 strategy is "build new engine, swap
     * in, drop old." Structural per-node state migration via
     * `Engine::move_node_state` + `fugue-swap` plan-diffing is owed
     * (so a feedback delay's buffer survives a rename-free edit) but
     * deferred until W13 ships the playground and the user-visible
     * effect can actually be observed.
     *
     * On compile or build failure, the existing engine keeps running
     * (the JavaScript caller surfaces the error to the UI; the audio
     * context is never silenced by a bad edit).
     * @param {string} new_source
     */
    hot_swap(new_source) {
        const ptr0 = passStringToWasm0(new_source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_hot_swap(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Number of audio inputs the active patch expects per frame.
     * @returns {number}
     */
    input_arity() {
        const ret = wasm.engine_input_arity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Migrate DSP state from the engine `self` succeeds — call once, at
     * swap-commit, with the outgoing engine, just before dropping it. Moves
     * matched node state (reverb tails, oscillator phase, held poly notes, LFO
     * phase + the sample clock) from `old` into `self` using the plan stashed by
     * [`Engine::build_successor`]. A no-op on an engine that wasn't built as a
     * successor (`swap` is `None`).
     *
     * Called on **both** swap paths: the structural (hard-cut) path migrates then
     * declicks, and the non-structural (fade) path migrates the matched nodes so
     * free-running phase stays continuous, then crossfades to mask the added /
     * removed ones. Only the `matched` pairs move, so the non-structural case
     * leaves unmatched nodes on their fresh state. `old` is left holding `self`'s
     * prior default state; the caller drops it right after (the worklet's
     * `commitPending`).
     *
     * The migration loop ([`ArrangementEngine::apply_migration`]) is itself
     * alloc/drop-free (a `mem::swap` per node) — that is what keeps the **native**
     * rtsan-gated path clean. The `take()` here drops the spent plan (a short
     * `Vec` of node-id pairs); on the wasm worklet that drop lands on the audio
     * thread, but it is co-located with — and dwarfed by — the outgoing engine's
     * own drop in the same `commitPending`, both part of the worklet swap's
     * already-accepted allocation cost (moving the whole swap off-thread is the
     * shared-memory follow-up, processor.js). It is never on the native audio
     * callback.
     * @param {Engine} old
     */
    migrate_from(old) {
        _assertClass(old, Engine);
        wasm.engine_migrate_from(this.__wbg_ptr, old.__wbg_ptr);
    }
    /**
     * Parse `source` as a `.fugue` patch, lower to IR, build an engine
     * at `sample_rate` Hz. Returns the engine on success, or a JS error
     * carrying the compiler diagnostics on failure.
     * @param {string} source
     * @param {number} sample_rate
     */
    constructor(source, sample_rate) {
        const ptr0 = passStringToWasm0(source, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_new(ptr0, len0, sample_rate);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        EngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Live note-off.
     * @param {number} pitch
     */
    note_off(pitch) {
        wasm.engine_note_off(this.__wbg_ptr, pitch);
    }
    /**
     * Live note-on (mono last-note; poly allocates a pool voice).
     * @param {number} pitch
     */
    note_on(pitch) {
        wasm.engine_note_on(this.__wbg_ptr, pitch);
    }
    /**
     * Number of audio outputs the active patch produces per frame.
     * @returns {number}
     */
    output_arity() {
        const ret = wasm.engine_output_arity(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Number of declared `@param`s in the active patch. Stable until
     * the next `hot_swap`. The playground enumerates these on every
     * (re)build to render one slider per param.
     * @returns {number}
     */
    param_count() {
        const ret = wasm.engine_param_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Declared default for param `i`. `None` past the end.
     * @param {number} i
     * @returns {number | undefined}
     */
    param_default(i) {
        const ret = wasm.engine_param_default(this.__wbg_ptr, i);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Whether param `i` has a declared `[lo, hi]` range. Without one
     * the playground synthesises `[0, 2·default]` so the slider still
     * has throw.
     * @param {number} i
     * @returns {boolean}
     */
    param_has_range(i) {
        const ret = wasm.engine_param_has_range(this.__wbg_ptr, i);
        return ret !== 0;
    }
    /**
     * Declared upper bound for param `i`. Returns the default if no
     * range is declared — pair with `param_has_range` to disambiguate.
     * @param {number} i
     * @returns {number | undefined}
     */
    param_hi(i) {
        const ret = wasm.engine_param_hi(this.__wbg_ptr, i);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Kind tag for param `i`: `"real"`, `"bool"`, or `"quantity"`.
     * `None` past the end. Real / Quantity params get a slider; Bool
     * params get a checkbox (or no widget — the playground decides).
     * @param {number} i
     * @returns {string | undefined}
     */
    param_kind(i) {
        const ret = wasm.engine_param_kind(this.__wbg_ptr, i);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Declared lower bound for param `i`. Returns the default if no
     * range is declared — pair with `param_has_range` to disambiguate.
     * @param {number} i
     * @returns {number | undefined}
     */
    param_lo(i) {
        const ret = wasm.engine_param_lo(this.__wbg_ptr, i);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Name of param `i`, or `None` past the end. Declaration order —
     * the same order the source's `@param` lines appear.
     * @param {number} i
     * @returns {string | undefined}
     */
    param_name(i) {
        const ret = wasm.engine_param_name(this.__wbg_ptr, i);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Taper tag for param `i`: `"linear"`, `"log"`, or `"exp"`. UI
     * surfaces with a log taper map the slider's `[0, 1]` fraction
     * through `lo·(hi/lo)^f`; linear is `lo + f·(hi-lo)`.
     * @param {number} i
     * @returns {string | undefined}
     */
    param_taper(i) {
        const ret = wasm.engine_param_taper(this.__wbg_ptr, i);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Unit string for a `Quantity`-typed param (e.g. `"Hz"`, `"s"`),
     * or an empty string for `Real` / `Bool`. `None` past the end.
     * @param {number} i
     * @returns {string | undefined}
     */
    param_unit(i) {
        const ret = wasm.engine_param_unit(this.__wbg_ptr, i);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Samples per cycle (= per bar) at the active patch's `tempo`. The
     * playground's WAV bounce renders `bars · samples_per_cycle` frames so
     * the export is a whole number of cycles and loops seamlessly.
     * @returns {number}
     */
    samples_per_cycle() {
        const ret = wasm.engine_samples_per_cycle(this.__wbg_ptr);
        return ret;
    }
    /**
     * Set a smoothed/plain parameter by name. Equivalent to
     * `fugue_eval::Engine::set_param`; useful for the playground's
     * "knob bar" UI.
     *
     * v0.3 typed-wire (Puckette §5): returns a JS error string on
     * unknown name / out-of-range / quantised violations. The
     * playground UI surfaces this in the status bar; ignoring it on
     * the JS side keeps the existing "drag knob, hear sound" flow
     * unchanged for the happy path.
     * @param {string} name
     * @param {number} value
     */
    set_param(name, value) {
        const ptr0 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.engine_set_param(this.__wbg_ptr, ptr0, len0, value);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set voice `i`'s mixer gain (clamped non-negative). Out-of-range
     * indices are silently ignored — the playground sends indices it
     * derived from `voice_count`, so a stale index is benign.
     * @param {number} i
     * @param {number} gain
     */
    set_voice_gain(i, gain) {
        wasm.engine_set_voice_gain(this.__wbg_ptr, i, gain);
    }
    /**
     * Mute / un-mute voice `i`. Out-of-range indices are ignored.
     * @param {number} i
     * @param {boolean} mute
     */
    set_voice_mute(i, mute) {
        wasm.engine_set_voice_mute(this.__wbg_ptr, i, mute);
    }
    /**
     * Solo / un-solo voice `i`. While any voice is soloed, non-soloed
     * voices are silenced. Out-of-range indices are ignored.
     * @param {number} i
     * @param {boolean} solo
     */
    set_voice_solo(i, solo) {
        wasm.engine_set_voice_solo(this.__wbg_ptr, i, solo);
    }
    /**
     * Render `out.len() / output_arity()` audio frames into `out`. The
     * AudioWorklet's `process` callback calls this with a fixed-128
     * sample buffer (Web Audio's render quantum). Output frames are
     * interleaved at the engine's output arity.
     * @param {Float32Array} out
     */
    step_block(out) {
        var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.engine_step_block(this.__wbg_ptr, ptr0, len0, out);
    }
    /**
     * Whether the pending swap is structural (every node carries; nothing added
     * or removed) — the all-`matched` "retune" case. The worklet hard-cuts when
     * true (migrated state makes the cut click-free) and keeps the one-block
     * equal-power fade otherwise (it masks the unavoidable step). `false` for a
     * non-successor engine.
     * @returns {boolean}
     */
    swap_is_structural() {
        const ret = wasm.engine_swap_is_structural(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Number of voices in the active arrangement. The playground builds
     * one mixer strip per voice; stable until the next `hot_swap`.
     * @returns {number}
     */
    voice_count() {
        const ret = wasm.engine_voice_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Copy the most recent block's level meters into `out`, interleaved
     * as `[peak, rms]` pairs: one pair per voice in voice order, then
     * the master-bus pair last. `out` should be `(voice_count() + 1) * 2`
     * long; a shorter slice is filled as far as it reaches, a longer one
     * leaves the tail untouched.
     *
     * No allocation on our side — the worklet pre-allocates one
     * `Float32Array` and reuses it every block, the same pattern
     * `step_block` uses for its output buffer.
     * @param {Float32Array} out
     */
    voice_levels(out) {
        var ptr0 = passArrayF32ToWasm0(out, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.engine_voice_levels(this.__wbg_ptr, ptr0, len0, out);
    }
    /**
     * Name of voice `i` (`voice <name> = …`), or `None` past the end.
     * @param {number} i
     * @returns {string | undefined}
     */
    voice_name(i) {
        const ret = wasm.engine_voice_name(this.__wbg_ptr, i);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
}
if (Symbol.dispose) Engine.prototype[Symbol.dispose] = Engine.prototype.free;

/**
 * Workspace semver string baked at compile time. The playground reads
 * this on boot to render the header version pill — single source of
 * truth so the `fugue.fm` chrome can't drift from the shipping
 * library.
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_bce6d499ff0a4aff: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_copy_to_typed_array_787746aeb47818bc: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_9c31b086c2b26051: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./fugue_wasm_bg.js": import0,
    };
}

const EngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_engine_free(ptr, 1));

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('fugue_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
