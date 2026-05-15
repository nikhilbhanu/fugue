/* tslint:disable */
/* eslint-disable */

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
    free(): void;
    [Symbol.dispose](): void;
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
     */
    active_spans(out: Uint32Array): void;
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
     */
    build_successor(new_source: string): Engine;
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
     */
    hot_swap(new_source: string): void;
    /**
     * Number of audio inputs the active patch expects per frame.
     */
    input_arity(): number;
    /**
     * Parse `source` as a `.fugue` patch, lower to IR, build an engine
     * at `sample_rate` Hz. Returns the engine on success, or a JS error
     * carrying the compiler diagnostics on failure.
     */
    constructor(source: string, sample_rate: number);
    /**
     * Number of audio outputs the active patch produces per frame.
     */
    output_arity(): number;
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
     */
    set_param(name: string, value: number): void;
    /**
     * Set voice `i`'s mixer gain (clamped non-negative). Out-of-range
     * indices are silently ignored — the playground sends indices it
     * derived from `voice_count`, so a stale index is benign.
     */
    set_voice_gain(i: number, gain: number): void;
    /**
     * Mute / un-mute voice `i`. Out-of-range indices are ignored.
     */
    set_voice_mute(i: number, mute: boolean): void;
    /**
     * Solo / un-solo voice `i`. While any voice is soloed, non-soloed
     * voices are silenced. Out-of-range indices are ignored.
     */
    set_voice_solo(i: number, solo: boolean): void;
    /**
     * Render `out.len() / output_arity()` audio frames into `out`. The
     * AudioWorklet's `process` callback calls this with a fixed-128
     * sample buffer (Web Audio's render quantum). Output frames are
     * interleaved at the engine's output arity.
     */
    step_block(out: Float32Array): void;
    /**
     * Number of voices in the active arrangement. The playground builds
     * one mixer strip per voice; stable until the next `hot_swap`.
     */
    voice_count(): number;
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
     */
    voice_levels(out: Float32Array): void;
    /**
     * Name of voice `i` (`voice <name> = …`), or `None` past the end.
     */
    voice_name(i: number): string | undefined;
}

/**
 * Workspace semver string baked at compile time. The playground reads
 * this on boot to render the header version pill — single source of
 * truth so the `play.fugue.dev` chrome can't drift from the shipping
 * library.
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_engine_free: (a: number, b: number) => void;
    readonly engine_active_spans: (a: number, b: number, c: number, d: any) => void;
    readonly engine_build_successor: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_hot_swap: (a: number, b: number, c: number) => [number, number];
    readonly engine_input_arity: (a: number) => number;
    readonly engine_new: (a: number, b: number, c: number) => [number, number, number];
    readonly engine_output_arity: (a: number) => number;
    readonly engine_set_param: (a: number, b: number, c: number, d: number) => [number, number];
    readonly engine_set_voice_gain: (a: number, b: number, c: number) => void;
    readonly engine_set_voice_mute: (a: number, b: number, c: number) => void;
    readonly engine_set_voice_solo: (a: number, b: number, c: number) => void;
    readonly engine_step_block: (a: number, b: number, c: number, d: any) => void;
    readonly engine_voice_count: (a: number) => number;
    readonly engine_voice_levels: (a: number, b: number, c: number, d: any) => void;
    readonly engine_voice_name: (a: number, b: number) => [number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
