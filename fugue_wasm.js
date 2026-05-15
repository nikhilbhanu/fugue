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
     * Fill `out` with the active event spans from the most recent
     * `step_block`, one `[start, end]` u32 pair per voice in voice
     * order. `(0, 0)` means no event is active for that voice (rest or
     * unbound). `out` must be at least `voice_count() * 2` long; a
     * shorter slice is filled as far as it reaches. Mirrors the
     * `voice_levels` fill-buffer pattern — no allocation on our side.
     *
     * The playground pre-allocates one `Uint32Array` and passes it
     * here on every meter tap (~62 Hz). Each non-zero pair is an
     * absolute `.fugue` byte range that CodeMirror highlights.
     * @param {Uint32Array} out
     */
    active_spans(out) {
        var ptr0 = passArray32ToWasm0(out, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        wasm.engine_active_spans(this.__wbg_ptr, ptr0, len0, out);
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
     * Number of audio outputs the active patch produces per frame.
     * @returns {number}
     */
    output_arity() {
        const ret = wasm.engine_output_arity(this.__wbg_ptr);
        return ret >>> 0;
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
 * truth so the `play.fugue.dev` chrome can't drift from the shipping
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
