// engine-core.js — the shared Fugue audio core.
//
// Wraps the playground's WASM-on-AudioWorklet pipeline (compile once →
// AudioWorkletNode → equal-power hot-swap → level/active-span readback) behind
// a small class, so any surface — the playground or the Learn page — can drive
// the *real* engine instead of re-implementing audio. The worklet + wasm shim
// (processor.js, worklet-polyfill.js, fugue_wasm*) are reused verbatim.
//
// Asset URLs resolve relative to THIS module (import.meta.url), so the file
// works whether imported from `./engine-core.js` (playground) or
// `../engine-core.js` (learn/): the worklet and wasm always load from the
// directory this module lives in.

const asset = (rel) => new URL(rel, import.meta.url).href;

let wasmCompiled = null;
// Compile the wasm module once; the same WebAssembly.Module is shipped to the
// worklet via processorOptions (no second fetch on the render thread).
export async function compileWasmOnce() {
  if (wasmCompiled) return wasmCompiled;
  const r = await fetch(asset("./fugue_wasm_bg.wasm"));
  if (!r.ok) throw new Error(`wasm fetch failed: ${r.status}`);
  wasmCompiled = await WebAssembly.compileStreaming(r.clone()).catch(async () =>
    WebAssembly.compile(await r.arrayBuffer())
  );
  return wasmCompiled;
}

// iOS-silent-switch unlock — a looping silent <audio> keeps an HTMLMediaElement
// "playing", forcing Safari's audio session to "playback" instead of the
// default "ambient" (which respects the hardware silent switch). Harmless on
// desktop/Android. Must be called inside a user-gesture handler.
let silentUnlockEl = null;
function unlockIosAudioSession() {
  if (silentUnlockEl) { silentUnlockEl.play().catch(() => {}); return; }
  const sr = 22050, frames = Math.floor(sr / 20); // ~50 ms
  const buf = new ArrayBuffer(44 + frames);
  const dv = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + frames, true); tag(8, "WAVE");
  tag(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);   // PCM, mono
  dv.setUint32(24, sr, true); dv.setUint32(28, sr, true);  // sr, byte rate
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);    // block align, 8-bit
  tag(36, "data"); dv.setUint32(40, frames, true);
  for (let i = 0; i < frames; i++) dv.setUint8(44 + i, 0x80); // 8-bit silence
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  silentUnlockEl = new Audio(url);
  silentUnlockEl.loop = true;
  silentUnlockEl.playsInline = true;
  silentUnlockEl.play().catch(() => {});
}

export class EngineCore {
  // opts: { onReady({voices, params}), onError(message), onMeter({levels, active}) }
  constructor(opts = {}) {
    this.audioCtx = null;
    this.workletNode = null;
    this.masterGainNode = null;
    this.analyser = null;
    this.wasmModule = null;
    this.voices = [];          // current voice names, in voice order
    this.params = [];          // current @param manifest
    this.latestLevels = null;  // Float32Array [peak,rms] per voice + master
    this.latestActive = null;  // Uint32Array — packed [start,end] byte-spans of sounding atoms (all voices)
    this.onReady = opts.onReady || (() => {});
    this.onError = opts.onError || (() => {});
    this.onMeter = opts.onMeter || (() => {});
  }

  get running() { return this.audioCtx?.state === "running"; }
  get started() { return !!this.audioCtx; }

  // Boot the audio graph and load `source`. Call from a user gesture (the
  // AudioContext + iOS unlock both require a live gesture token).
  async start(source, sampleRate = 48000) {
    if (this.audioCtx) return;
    unlockIosAudioSession();
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    this.audioCtx.resume().catch(() => {});
    // polyfill (TextDecoder/Encoder for the wasm glue) MUST register first.
    await this.audioCtx.audioWorklet.addModule(asset("./worklet-polyfill.js"));
    await this.audioCtx.audioWorklet.addModule(asset("./processor.js"));
    this.wasmModule = await compileWasmOnce();
    this.workletNode = new AudioWorkletNode(this.audioCtx, "fugue-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmModule: this.wasmModule, source },
    });
    this.workletNode.port.onmessage = (e) => this._handle(e.data);
    this.masterGainNode = this.audioCtx.createGain();
    this.masterGainNode.gain.value = 1.0;
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0;
    this.workletNode.connect(this.masterGainNode).connect(this.analyser).connect(this.audioCtx.destination);
  }

  // Re-compile `source` and hand it to the worklet, which migrates DSP state
  // and hard-cuts for a structural (retune) edit, or equal-power crossfades
  // old→new over one block when nodes were added/removed.
  hotSwap(source) {
    this.latestActive = null; // spans index the previous source until the ack
    if (!this.workletNode) return;
    this.workletNode.port.postMessage({ hot_swap: source });
  }

  setParam(name, value) {
    this.workletNode?.port.postMessage({ set_param: { name, value } });
  }

  // Mute/unmute a voice by name (maps to the engine's voice index).
  muteVoice(name, mute) {
    const index = this.voices.indexOf(name);
    if (index < 0) return;
    this.workletNode?.port.postMessage({ set_voice: { index, mute } });
  }

  setMasterGain(g) { if (this.masterGainNode) this.masterGainNode.gain.value = g; }

  async resume() { if (this.audioCtx) await this.audioCtx.resume(); }
  async suspend() { if (this.audioCtx) await this.audioCtx.suspend(); }

  async teardown() {
    try { this.workletNode?.disconnect(); } catch {}
    try { this.masterGainNode?.disconnect(); } catch {}
    try { this.analyser?.disconnect(); } catch {}
    try { await this.audioCtx?.close(); } catch {}
    this.audioCtx = this.workletNode = this.masterGainNode = this.analyser = null;
  }

  _handle(data) {
    if (data?.ok) {
      this.voices = data.voices || [];
      this.params = data.params || [];
      this.onReady({ voices: this.voices, params: this.params });
    } else if (data?.error) {
      this.onError(data.error);
    } else if (data?.levels) {
      this.latestLevels = data.levels;
      if (data.active) this.latestActive = data.active;
      this.onMeter({ levels: data.levels, active: data.active });
    }
  }
}
