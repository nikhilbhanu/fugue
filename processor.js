// AudioWorklet processor — runs on Web Audio's render thread.
//
// Holds the fugue Engine and renders one block per `process()` call.
// The main thread sends source updates via `port.postMessage({hot_swap})`;
// a successful swap builds the successor engine. Structural swaps (the
// dominant retune edit: every node carries, nothing added/removed)
// migrate DSP state — oscillator phase, reverb tails, held poly notes,
// LFO phase + the sample clock — from the outgoing engine into the
// successor *before* render, then hard-cut with a one-block declicker
// (C0-continuous: out[0] matches the prior block's last sample, settles
// to the new output over ~2.7 ms). Non-structural swaps (nodes
// added/removed) equal-power crossfade old→new across one block. A bare
// swap without either rebirths every phase + constant at zero, which
// clicks. Failed hot-swaps keep the old engine running (no audio context
// death).
//
// Owns no Monaco / DOM / fetch — anything that would block or alloc must
// happen on the main thread and be shipped here via postMessage.

import init, { Engine } from "./fugue_wasm.js";

// Read the engine's @param manifest into a plain JSON array — name,
// kind, default, lo/hi (synthesised to [0, 2·default] when undeclared),
// taper, unit. Off-render call only; main.js renders one sidebar slider
// per entry. Returns `[]` for patches with no declared params.
function enumerateParams(engine) {
  const n = engine.param_count();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const def = engine.param_default(i) ?? 0;
    const hasRange = engine.param_has_range(i);
    const lo = hasRange ? (engine.param_lo(i) ?? 0)
                        : 0;
    const hi = hasRange ? (engine.param_hi(i) ?? def)
                        : (def > 0 ? def * 2 : 1);
    out[i] = {
      name: engine.param_name(i) ?? `p${i}`,
      kind: engine.param_kind(i) ?? "real",
      unit: engine.param_unit(i) ?? "",
      default: def,
      lo,
      hi,
      hasRange,
      taper: engine.param_taper(i) ?? "linear",
    };
  }
  return out;
}

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

// DSP-load metering. AudioWorkletGlobalScope exposes no high-res clock —
// `performance` is absent in Chrome's worklet scope, and `currentTime` /
// `currentFrame` advance by the block duration regardless of render cost. The
// only wall clock available here is `Date.now()` (integer ms, an ECMAScript
// core built-in present in every realm). A single block renders in well under
// 1 ms, so each per-block delta is mostly 0 and occasionally 1 ms — but its
// *expectation* is the true render time, because Date.now()'s read phase
// relative to the ms grid is effectively random across the ~375 Hz callback
// rate. A slow EMA integrates these 1-bit dithered reads back to the true mean.
// (Cross-origin isolation would buy a finer clock, but fugue.fm can't be COI —
// GitHub Pages sends no COOP/COEP — and a service-worker shim isn't worth it
// for a status gauge.) CPU_EMA_ALPHA ≈ a ~270 ms time constant at the callback
// rate (1 - exp(-1/100)), long enough to tame the 1 ms quantisation jitter.
const CPU_EMA_ALPHA = 0.01;

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
    // Whether the pending swap is structural (every DSP node carries; nothing
    // added/removed). Set from `Engine.swap_is_structural()` when the successor
    // is staged. When true, `process()` migrates state and hard-cuts (the cut is
    // click-free because phase/tails are continuous); when false it keeps the
    // one-block equal-power fade to mask the unavoidable step.
    this.swapStructural = false;
    this.pendingArity = 0;
    this.pendingVoiceCount = 0;
    this.pendingVoiceNames = [];
    this.pendingLevelBuf = null;
    this.pendingActiveBuf = null;
    this.fadeRampLen = FRAMES_PER_BLOCK;
    this.fadeOld = new Float32Array(FRAMES_PER_BLOCK);
    this.fadeNew = new Float32Array(FRAMES_PER_BLOCK);
    this.buildFadeRamp(FRAMES_PER_BLOCK);
    // Declicker for the structural hard-cut path. A structural swap migrates
    // state before render, so phase/tails are continuous — but a const edit
    // (gain, cutoff) still lands this block and produces a step at sample 0.
    // The declicker subtracts a decaying correction so out[0] matches the
    // previous block's last sample (C0-continuous) and settles to the new
    // output over one block (~2.7 ms). `lastOut` holds the prior block's
    // final sample per host channel; `declickRamp` is a 1→0 linear ramp
    // precomputed once so process() never evaluates anything per-sample.
    this.lastOut = new Float32Array(MAX_CHANNELS);
    this.declickRamp = new Float32Array(FRAMES_PER_BLOCK);
    for (let i = 0; i < FRAMES_PER_BLOCK; i++) {
      this.declickRamp[i] = 1.0 - (i + 1) / FRAMES_PER_BLOCK;
    }
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
    // EMA of render-work time as a fraction of the block's real-time budget
    // (0..1; >1 means we're over budget). Updated every steady-state block,
    // shipped with the level tap. See CPU_EMA_ALPHA above.
    this.cpuLoad = 0;
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
    // Active-span tap: a flat, packed list of [start, end] u32 pairs (every
    // atom sounding this block, across all voices). Sized to the engine's
    // worst-case capacity so the fill is never truncated and process() never
    // allocates.
    const spanCap = this.engine.active_spans_capacity();
    if (!this.activeBuf || this.activeBuf.length !== spanCap) {
      this.activeBuf = new Uint32Array(spanCap);
    }
  }

  // Ack payload shared by `loaded` / `loaded-on-edit` / `swapped`. Voices
  // drive the mixer; params drive the sidebar sliders. Both enumerated
  // off the audio thread (in `handle()`), never inside `process()`.
  voiceAck() {
    // `armable[i]` tells the mixer which strips get a live-MIDI arm control
    // (docs/midi.md) — a voice that drives a note/trig process under a pattern.
    const armable = [];
    for (let i = 0; i < this.voiceCount; i++) armable.push(this.engine.armable(i));
    return { voices: this.voiceNames, params: enumerateParams(this.engine), armable };
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
    this.pendingActiveBuf = new Uint32Array(engine.active_spans_capacity());
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
        // Structural swaps migrate DSP state + hard-cut (declicked); the
        // rest fade (below). `swap_is_structural()` reads the migration
        // plan's `structural` flag, set at build time by plan_migration.
        this.swapStructural = next.swap_is_structural();
        this.pendingArity = Math.max(nextArity, 1);
        this.prepareIncomingVoices(next);
        // Ack now, with the incoming voice list: the fade is one block
        // (≈ 2.7 ms @ 48 kHz), far below the UI's reaction time, so the
        // mixer can reconcile to the new voices immediately. `armable` is the
        // *incoming* engine's (docs/midi.md) — without it the per-strip arm
        // buttons vanish on every hot-swap (tab switch / ⌘↵).
        const armable = [];
        for (let i = 0; i < this.pendingVoiceCount; i++) armable.push(next.armable(i));
        this.port.postMessage({
          ok: "swapped",
          outArity: nextArity,
          voices: this.pendingVoiceNames,
          params: enumerateParams(next),
          armable,
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
    } else if (
      this.engine &&
      (msg?.arm !== undefined ||
        msg?.note_on !== undefined ||
        msg?.note_off !== undefined ||
        msg?.all_notes_off)
    ) {
      // Live MIDI keyboard (docs/midi.md). The engine owns note priority and
      // the per-voice arm/override; the main thread just forwards raw events
      // (arm index, note_on/off pitch, all_notes_off). Same swallow-on-error
      // discipline as set_param — a stray index/pitch must never throw out of
      // onmessage. Mirror to a pending successor so an event during the
      // one-block hot-swap fade survives the commit.
      const targets = this.pendingEngine
        ? [this.engine, this.pendingEngine]
        : [this.engine];
      for (const eng of targets) {
        try {
          if (msg.arm !== undefined) eng.arm(msg.arm, !!msg.midi_only);
          if (msg.note_on !== undefined) eng.note_on(msg.note_on);
          if (msg.note_off !== undefined) eng.note_off(msg.note_off);
          if (msg.all_notes_off) eng.all_notes_off();
        } catch (_) {
          /* keep audio alive */
        }
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

    if (this.pendingEngine && this.swapStructural) {
      // Structural hot-swap (the dominant retune edit: every DSP node carries,
      // nothing added/removed). Migrate state from the outgoing engine into the
      // successor — reverb tails, oscillator phase, held poly notes, LFO phase +
      // the sample clock — *before* rendering, so both are at block-start state.
      // Then hard-cut with a one-block declicker: the cut is click-free for
      // phase/tails (they're continuous), and the declicker subtracts a decaying
      // correction so out[0] matches the previous block's last sample (C0-
      // continuous), smoothing the residual const-step (gain/cutoff) that
      // migrate can't carry. `migrate_from` is a `mem::swap` per node (no
      // audio-thread alloc); it leaves the outgoing engine holding default
      // state, which is fine since we free it at commit.
      this.pendingEngine.migrate_from(this.engine);
      const stride = Math.max(this.pendingArity, 1);
      const b = this.scratch;
      this.pendingEngine.step_block(b.subarray(0, frames * stride));
      const ramp = this.declickRamp;
      for (let ch = 0; ch < channels; ch++) {
        const dst = out[ch];
        const srcChan = ch < this.pendingArity ? ch : 0;
        const step = b[srcChan] - this.lastOut[ch];
        for (let i = 0; i < frames; i++) {
          dst[i] = b[i * stride + srcChan] - step * ramp[i];
        }
        this.lastOut[ch] = dst[frames - 1];
      }
      this.commitPending();
      return true;
    }

    if (this.pendingEngine) {
      // Non-structural hot-swap (nodes added/removed): equal-power crossfade the
      // outgoing and incoming engine across this one block to mask the step from
      // genuinely added/removed content. We DO migrate matched DSP state (LFO /
      // oscillator phase, filter coeffs, reverb tails) old→new — but only AFTER
      // rendering the outgoing engine's fade-OUT block into `a`, so the
      // `mem::swap` that guts the outgoing engine costs us nothing (its block is
      // already captured). The successor then renders its fade-IN half from the
      // carried state instead of phase 0, so free-running LFOs / oscillators stay
      // continuous across the swap; only genuinely-new nodes start fresh, and the
      // crossfade masks those. One block ≈ 2.7 ms @ 48 kHz.
      if (frames !== this.fadeRampLen) this.buildFadeRamp(frames);
      const oldStride = Math.max(this.outArity, 1);
      const newStride = Math.max(this.pendingArity, 1);
      const a = this.scratch, b = this.scratchB;
      this.engine.step_block(a.subarray(0, frames * oldStride));
      this.pendingEngine.migrate_from(this.engine);
      this.pendingEngine.step_block(b.subarray(0, frames * newStride));
      const gOld = this.fadeOld, gNew = this.fadeNew;
      for (let ch = 0; ch < channels; ch++) {
        const dst = out[ch];
        const srcOld = ch < this.outArity ? ch : 0;
        const srcNew = ch < this.pendingArity ? ch : 0;
        for (let i = 0; i < frames; i++) {
          dst[i] = gOld[i] * a[i * oldStride + srcOld] +
                   gNew[i] * b[i * newStride + srcNew];
        }
        this.lastOut[ch] = dst[frames - 1];
      }
      this.commitPending();
      return true;
    }

    const t0 = Date.now();
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
      this.lastOut[ch] = dst[frames - 1];
    }
    // DSP-load tap: time the render work (step_block + routing) against this
    // block's real-time budget and feed the EMA. Date.now() is integer-ms, so a
    // single block's delta is a coarse 1-bit read; the EMA recovers the mean
    // (see CPU_EMA_ALPHA). Excludes the level/active tap below — it runs 1-in-6
    // blocks and would bias the gauge.
    const blockMs = (frames / this.sampleRate) * 1000;
    this.cpuLoad += ((Date.now() - t0) / blockMs - this.cpuLoad) * CPU_EMA_ALPHA;
    // Level-meter tap, throttled to ~62 Hz. voice_levels() fills the
    // pre-allocated levelBuf in place (no alloc on our side); the
    // postMessage structured-clone copies it synchronously, so reuse
    // next tick is safe. We sample one block per window rather than
    // accumulating — imperceptible at meter cadence.
    if (this.levelBuf && ++this.levelTick >= LEVEL_POST_INTERVAL) {
      this.levelTick = 0;
      this.engine.voice_levels(this.levelBuf);
      // active_spans packs the sounding atoms' absolute [start,end] pairs into
      // the pre-allocated Uint32Array and returns the u32 count; we ship just
      // the written slice. The structured-clone in postMessage copies it
      // synchronously so reuse next tick is safe.
      const nSpans = this.activeBuf ? this.engine.active_spans(this.activeBuf) : 0;
      this.port.postMessage({
        levels: this.levelBuf,
        active: this.activeBuf ? this.activeBuf.subarray(0, nSpans) : null,
        cpu: this.cpuLoad,
      });
    }
    return true;
  }
}

registerProcessor("fugue-processor", FugueProcessor);
