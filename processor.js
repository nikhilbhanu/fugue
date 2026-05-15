// AudioWorklet processor — runs on Web Audio's render thread.
//
// Holds the fugue Engine and renders one block per `process()` call.
// The main thread sends source updates via `port.postMessage({hot_swap})`;
// a successful swap builds the successor engine, then `process()`
// equal-power crossfades old→new across one render block so the swap
// doesn't click (a bare swap rebirths every oscillator phase and filter
// state at zero — a step discontinuity). Failed hot-swaps keep the old
// engine running (no audio context death).
//
// Owns no Monaco / DOM / fetch — anything that would block or alloc must
// happen on the main thread and be shipped here via postMessage.

import init, { Engine } from "./fugue_wasm.js";

// Max audio channels the playground supports without re-allocating on
// the audio thread. Web Audio's render quantum is 128 frames; we pre-
// allocate `128 * MAX_CHANNELS` floats once and slice the active portion
// based on the engine's current output_arity. Hot-swapping a 1-output
// patch to a 2-output patch must not alloc on the render thread.
const MAX_CHANNELS = 16;
const FRAMES_PER_BLOCK = 128;
// Post per-voice + master level meters this often (in render quanta).
// 128 frames / 48 kHz ≈ 2.67 ms, so every 6 blocks ≈ 62 Hz — at or above
// the meter UI's rAF cadence, and a fraction of the ~375 Hz process()
// rate so we don't flood the postMessage channel.
const LEVEL_POST_INTERVAL = 6;

class FugueProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.engine = null;
    this.outArity = 0;
    this.wasmReady = false;
    this.sampleRate = 48000;
    // Pre-allocate at max-channels so hot_swap to a wider patch never
    // re-allocates. 128 * 16 * 4 bytes = 8 KB; trivial.
    this.scratch = new Float32Array(FRAMES_PER_BLOCK * MAX_CHANNELS);
    // Second interleaved scratch buffer for the *incoming* engine during
    // a hot-swap crossfade — both engines render the same block, blended
    // under an equal-power ramp. Same MAX_CHANNELS sizing as `scratch`.
    this.scratchB = new Float32Array(FRAMES_PER_BLOCK * MAX_CHANNELS);
    // Hot-swap crossfade state. `pendingEngine` is the successor built by
    // `Engine.build_successor`; the next `process()` renders it alongside
    // the current engine across one block, blends, then commits. The
    // equal-power ramp tables are precomputed once here so process()
    // never evaluates a transcendental on the audio thread.
    this.pendingEngine = null;
    this.pendingArity = 0;
    this.pendingVoiceCount = 0;
    this.pendingVoiceNames = [];
    this.pendingLevelBuf = null;
    this.pendingActiveBuf = null;
    this.fadeRampLen = FRAMES_PER_BLOCK;
    this.fadeOld = new Float32Array(FRAMES_PER_BLOCK);
    this.fadeNew = new Float32Array(FRAMES_PER_BLOCK);
    this.buildFadeRamp(FRAMES_PER_BLOCK);
    // Voice metadata + the level-meter tap buffer. `levelBuf` is sized to
    // `(voice_count + 1) * 2` by refreshVoices() on every engine
    // (re)build — never on the audio thread. `levelTick` throttles the
    // postMessage in process().
    this.voiceCount = 0;
    this.voiceNames = [];
    // Pre-allocated Uint32Array for active-span taps: voice_count*2 u32s,
    // one [start,end] pair per voice. (0,0) = no active event (rest/unbound).
    // Sized once in refreshVoices() so process() never allocates.
    this.activeBuf = null;
    this.levelBuf = null;
    this.levelTick = 0;
    this.port.onmessage = (e) => this.handle(e.data);
    // The first message after construction carries the wasm bytes plus
    // the initial source — see main.js's `audioWorklet.addModule + node
    // creation` flow.
    if (options?.processorOptions?.wasmModule) {
      this.bootstrap(
        options.processorOptions.wasmModule,
        options.processorOptions.source,
        sampleRate
      );
    }
  }

  // Refresh `this.outArity` from the engine; called after every
  // successful Engine construction or hot_swap so the JS-side interleave
  // stride stays in lockstep with the Rust-side output_buf.
  refreshArity() {
    this.outArity = this.engine.output_arity();
    if (this.outArity > MAX_CHANNELS) {
      // Patches above the pre-allocated cap would alloc on the audio
      // thread; refuse the swap and surface to the UI rather than
      // silently producing wrong output.
      this.port.postMessage({
        error: `output_arity ${this.outArity} > MAX_CHANNELS ${MAX_CHANNELS}`,
      });
    }
  }

  // Refresh voice metadata (count + names) and re-size the level-meter
  // and active-span tap buffers. Called after every successful Engine
  // construction or hot_swap. Allocates only here (off the audio thread)
  // — process() only ever fills and reads them.
  refreshVoices() {
    this.voiceCount = this.engine.voice_count();
    this.voiceNames = [];
    for (let i = 0; i < this.voiceCount; i++) {
      this.voiceNames.push(this.engine.voice_name(i) ?? `voice ${i}`);
    }
    // (voice_count + 1) pairs: one [peak, rms] per voice, then master.
    const needed = (this.voiceCount + 1) * 2;
    if (!this.levelBuf || this.levelBuf.length !== needed) {
      this.levelBuf = new Float32Array(needed);
    }
    // One [start, end] u32 pair per voice for the active-span tap.
    const spanLen = this.voiceCount * 2;
    if (!this.activeBuf || this.activeBuf.length !== spanLen) {
      this.activeBuf = new Uint32Array(spanLen);
    }
  }

  // Ack payload shared by `loaded` / `loaded-on-edit`.
  voiceAck() {
    return { voices: this.voiceNames };
  }

  // Precompute an equal-power crossfade ramp for an `n`-frame block:
  // gOld² + gNew² = 1 across the block, gOld 1→0 and gNew 0→1. Called
  // once in the constructor (and again only if the render quantum ever
  // changes size) so `process()` never evaluates a transcendental.
  buildFadeRamp(n) {
    n = Math.min(n, FRAMES_PER_BLOCK);
    for (let i = 0; i < n; i++) {
      const t = ((i + 1) / n) * (Math.PI / 2);
      this.fadeOld[i] = Math.cos(t);
      this.fadeNew[i] = Math.sin(t);
    }
    this.fadeRampLen = n;
  }

  // Voice metadata + tap buffers for an incoming hot-swap engine, built
  // off the render path (in `handle()`, like the old `refreshVoices`).
  // `commitPending()` swaps these in once the crossfade block has run.
  // Allocates here — moving the engine build (and so this) fully off the
  // audio thread is the shared-memory follow-up, not this change.
  prepareIncomingVoices(engine) {
    this.pendingVoiceCount = engine.voice_count();
    this.pendingVoiceNames = [];
    for (let i = 0; i < this.pendingVoiceCount; i++) {
      this.pendingVoiceNames.push(engine.voice_name(i) ?? `voice ${i}`);
    }
    this.pendingLevelBuf = new Float32Array((this.pendingVoiceCount + 1) * 2);
    this.pendingActiveBuf = new Uint32Array(this.pendingVoiceCount * 2);
  }

  // Promote the crossfaded-in engine to current. Called from `process()`
  // the instant the fade block completes: drop the old engine, adopt the
  // pending engine + its metadata/buffers, clear the pending slot.
  commitPending() {
    this.engine.free();
    this.engine = this.pendingEngine;
    this.outArity = this.pendingArity;
    this.voiceCount = this.pendingVoiceCount;
    this.voiceNames = this.pendingVoiceNames;
    this.levelBuf = this.pendingLevelBuf;
    this.activeBuf = this.pendingActiveBuf;
    this.pendingEngine = null;
    this.pendingLevelBuf = null;
    this.pendingActiveBuf = null;
  }

  async bootstrap(wasmModule, source, sr) {
    try {
      // `init` takes either a URL or a compiled `WebAssembly.Module`.
      // The main thread compiles once and ships the Module across
      // postMessage so we don't fetch a second time on the render
      // thread.
      await init(wasmModule);
      this.wasmReady = true;
      this.sampleRate = Math.round(sr);
    } catch (err) {
      this.port.postMessage({ error: `wasm init: ${String(err)}` });
      return;
    }
    // Try to build the initial engine. On failure (parser error in the
    // source, unknown stage, etc.) leave `this.engine = null` and
    // surface the error — the user can edit the source and a debounced
    // hot_swap message will retry the construction via `handle()`.
    try {
      this.engine = new Engine(source, this.sampleRate);
      this.refreshArity();
      this.refreshVoices();
      this.port.postMessage({
        ok: "loaded",
        outArity: this.outArity,
        ...this.voiceAck(),
      });
    } catch (err) {
      this.port.postMessage({ error: String(err) });
    }
  }

  handle(msg) {
    if (msg?.hot_swap) {
      if (this.engine) {
        // Build the successor off the current engine — it carries param /
        // transport / voice-mix state forward. Both engines now live at
        // once: `process()` equal-power crossfades them over one render
        // block, masking the click a bare swap produces (oscillator phase
        // + filter state reborn at zero). On failure the old engine keeps
        // running and the error surfaces to the UI.
        let next;
        try {
          next = this.engine.build_successor(msg.hot_swap);
        } catch (err) {
          this.port.postMessage({ error: String(err) });
          return;
        }
        // A new patch may have a different output_arity; the crossfade
        // and the post-commit interleave stride both read it from here.
        const nextArity = next.output_arity();
        if (nextArity > MAX_CHANNELS) {
          // Above the pre-allocated cap → would alloc on the audio
          // thread in process(). Refuse the swap, keep the old engine.
          next.free();
          this.port.postMessage({
            error: `output_arity ${nextArity} > MAX_CHANNELS ${MAX_CHANNELS}`,
          });
          return;
        }
        // A swap landing before the previous one's fade block has run
        // supersedes it — newest source wins; drop the stale successor.
        if (this.pendingEngine) this.pendingEngine.free();
        this.pendingEngine = next;
        this.pendingArity = Math.max(nextArity, 1);
        this.prepareIncomingVoices(next);
        // Ack now, with the incoming voice list: the fade is one block
        // (≈ 2.7 ms @ 48 kHz), far below the UI's reaction time, so the
        // mixer can reconcile to the new voices immediately.
        this.port.postMessage({
          ok: "swapped",
          outArity: nextArity,
          voices: this.pendingVoiceNames,
        });
      } else if (this.wasmReady) {
        // No engine yet — the initial bootstrap likely failed on a bad
        // source. Try to build one with the new source. If it succeeds
        // we recover; if it fails again the error surfaces and the
        // user can keep editing.
        try {
          this.engine = new Engine(msg.hot_swap, this.sampleRate);
          this.refreshArity();
          this.refreshVoices();
          this.port.postMessage({
            ok: "loaded-on-edit",
            outArity: this.outArity,
            ...this.voiceAck(),
          });
        } catch (err) {
          this.port.postMessage({ error: String(err) });
        }
      }
      // If wasm itself failed to initialise, we don't try to recover.
    } else if (msg?.set_param && this.engine) {
      // Inline-knob edit from the editor. set_param rejects unknown
      // names / out-of-range values (typed-wire, v0.3) — swallow it so a
      // knob nudged before a re-eval can't throw out of onmessage or
      // flip the engine into an error state mid-drag (see fugue_wasm.d.ts).
      const { name, value } = msg.set_param;
      try {
        this.engine.set_param(name, value);
      } catch (_) {
        /* unknown name or out-of-range — ignore, keep audio alive */
      }
      // Mirror onto a pending successor so a knob nudged inside the
      // one-block fade window isn't lost when the swap commits.
      if (this.pendingEngine) {
        try {
          this.pendingEngine.set_param(name, value);
        } catch (_) {
          /* same swallow — the successor's manifest may differ */
        }
      }
    } else if (msg?.set_voice && this.engine) {
      // Mixer-strip edit. One message may carry any subset of
      // gain/mute/solo — the UI sends whichever control moved. Applied to
      // a pending successor too, for the same reason as set_param above.
      const v = msg.set_voice;
      const targets = this.pendingEngine
        ? [this.engine, this.pendingEngine]
        : [this.engine];
      for (const eng of targets) {
        if (v.gain !== undefined) eng.set_voice_gain(v.index, v.gain);
        if (v.mute !== undefined) eng.set_voice_mute(v.index, v.mute);
        if (v.solo !== undefined) eng.set_voice_solo(v.index, v.solo);
      }
    }
  }

  process(_inputs, outputs, _params) {
    if (!this.engine) {
      // Pre-bootstrap (wasm still initialising or failed): emit silence
      // so the AudioContext doesn't drop us.
      return true;
    }
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const frames = out[0].length; // Web Audio render quantum (128 today)
    const channels = out.length;

    if (this.pendingEngine) {
      // Hot-swap crossfade: render the outgoing and incoming engine into
      // separate interleaved buffers, blend across this one block under
      // the precomputed equal-power ramp, then commit. One block ≈ 2.7 ms
      // @ 48 kHz — enough to mask the swap discontinuity, short enough to
      // still read as a clean cut for live coding.
      if (frames !== this.fadeRampLen) this.buildFadeRamp(frames);
      const oldStride = Math.max(this.outArity, 1);
      const newStride = Math.max(this.pendingArity, 1);
      const a = this.scratch, b = this.scratchB;
      this.engine.step_block(a.subarray(0, frames * oldStride));
      this.pendingEngine.step_block(b.subarray(0, frames * newStride));
      const gOld = this.fadeOld, gNew = this.fadeNew;
      for (let ch = 0; ch < channels; ch++) {
        const dst = out[ch];
        // Same fold-to-0 rule as the normal path: a host channel past an
        // engine's output_arity reads engine output 0.
        const srcOld = ch < this.outArity ? ch : 0;
        const srcNew = ch < this.pendingArity ? ch : 0;
        for (let i = 0; i < frames; i++) {
          dst[i] = gOld[i] * a[i * oldStride + srcOld] +
                   gNew[i] * b[i * newStride + srcNew];
        }
      }
      // Fade done — the incoming engine is now current. Skip this block's
      // level tap: `levelBuf` + engine identity just changed; the meters
      // resume next block (one ~2.7 ms gap is imperceptible).
      this.commitPending();
      return true;
    }

    const interleaved = this.scratch;
    const stride = Math.max(this.outArity, 1);
    // step_block writes `frames * stride` interleaved samples into the
    // sub-view. The pre-allocated scratch is big enough for the worst
    // case (128 * MAX_CHANNELS), so subarray is just a view, not an alloc.
    this.engine.step_block(interleaved.subarray(0, frames * stride));
    // Route per-channel: engine output i → host channel i. If the patch
    // has fewer outputs than the host has channels (mono engine → stereo
    // host), every host channel reads engine output 0.
    for (let ch = 0; ch < channels; ch++) {
      const dst = out[ch];
      const srcChan = ch < this.outArity ? ch : 0;
      for (let i = 0; i < frames; i++) {
        dst[i] = interleaved[i * stride + srcChan];
      }
    }
    // Level-meter tap, throttled to ~62 Hz. voice_levels() fills the
    // pre-allocated levelBuf in place (no alloc on our side); the
    // postMessage structured-clone copies it synchronously, so reuse
    // next tick is safe. We sample one block per window rather than
    // accumulating — imperceptible at meter cadence.
    if (this.levelBuf && ++this.levelTick >= LEVEL_POST_INTERVAL) {
      this.levelTick = 0;
      this.engine.voice_levels(this.levelBuf);
      // active_spans fills the pre-allocated Uint32Array with [start,end]
      // pairs — one per voice, (0,0) on rests. The structured-clone in
      // postMessage copies it synchronously so reuse next tick is safe.
      if (this.activeBuf) this.engine.active_spans(this.activeBuf);
      this.port.postMessage({
        levels: this.levelBuf,
        active: this.activeBuf,
      });
    }
    return true;
  }
}

registerProcessor("fugue-processor", FugueProcessor);
