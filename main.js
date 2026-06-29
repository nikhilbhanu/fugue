// fugue.fm — main-thread bootstrap.
//
// Wires the UI to the real AudioWorklet. Responsibilities:
//   - Fetch the patch set (patches/index.json) and drive the file tabs.
//   - Mount CodeMirror 6 (loaded at runtime from esm.sh) with an editorial
//     theme + a small fugue StreamLanguage; ⌘↵ evaluates (hot_swap).
//   - Boot the AudioWorklet, compile the wasm once, hot-swap on eval.
//   - Build the mixer from the worklet's voice list; VU meters are driven
//     by the {levels} postMessage, knobs/M/S by {set_voice} messages.
//   - Master-only spectrum + oscilloscope off an AnalyserNode.
//
// CodeMirror 6 has no in-tree bundler, so it loads from esm.sh. Every package
// is pinned to an EXACT version, and the dependents force the same
// @codemirror/state AND @codemirror/view via ?deps — so view/commands/language
// share ONE state and ONE view instance and esm.sh can't drift them apart.
//
// The VIEW dedup is load-bearing, not cosmetic: CodeMirror highlighting is
// facet-based, and a facet only matches within a single @codemirror/view
// module. If we pin view to 6.43.3 but let language resolve its own view (a
// range that floats to the latest, e.g. 6.43.4), syntaxHighlighting registers
// against that second view's facets while the editor runs on ours — and ALL
// syntax highlighting silently dies (no keyword colour, no mini-notation
// string backing). Pinning the version is NOT enough; it must be in ?deps so
// every package resolves to the same view build. (This is the bug an earlier
// "pin to exact versions" commit introduced by deduping state but not view.)
//
// @lezer/highlight is pinned and fed into @codemirror/language's ?deps for the
// SAME reason: HighlightStyle matches tokens by Tag *identity*, so the `tags`
// object we import must come from the exact same @lezer/highlight build that
// @codemirror/language tags its StreamLanguage tokens with. Left floating, the
// two can resolve to different 1.x builds and ALL highlighting silently dies.
//
// State is pinned to 6.7.0 because view 6.43.x calls a state method added there
// (EditorSelection.undirectionalRange) — on an older state, word-select on
// double-click threw.

import { EditorState, StateField, StateEffect, Transaction, ChangeSet, MapMode } from "https://esm.sh/@codemirror/state@6.7.0";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, Decoration, WidgetType,
} from "https://esm.sh/@codemirror/view@6.43.3?deps=@codemirror/state@6.7.0";
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from "https://esm.sh/@codemirror/commands@6.10.4?deps=@codemirror/state@6.7.0,@codemirror/view@6.43.3";
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching,
} from "https://esm.sh/@codemirror/language@6.12.4?deps=@codemirror/state@6.7.0,@codemirror/view@6.43.3,@lezer/highlight@1.2.1";
import { tags } from "https://esm.sh/@lezer/highlight@1.2.1";
import initWasm, { version as fugueVersion, Engine } from "./fugue_wasm.js";

const $ = (sel) => document.querySelector(sel);

/* ───────────────────────────────────────────────────────────────────
   store.js — a ~12-line Zustand-shaped store. Zero dependencies.
   One source of truth for discrete UI state; components subscribe.
   (Per-frame render scratch — meter peak-hold, FFT accumulators — and
   file contents are NOT in here; they stay as plain module locals.)
   ─────────────────────────────────────────────────────────────────── */
function createStore(init) {
  let state = init;
  const subs = new Set();
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      subs.forEach((fn) => fn(state));
    },
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
  };
}

const store = createStore({
  activeFile: null,        // filename string
  figTab: "spectrum",      // spectrum | scope
  frozen: false,
  specInteg: 200,          // ms — temporal averaging
  specSmooth: 20,          // %  — spectral smoothing
  specFloor: -96,          // dB — display floor
  scopeWindow: 14,         // ms — scope display window (post-trigger)
  voices: {},              // name -> { gain, mute, solo }; plus 'master'
  voiceOrder: [],          // index -> voice name (from the worklet ack)
  armable: new Set(),      // voice names that can take live MIDI (docs/midi.md)
  armedVoice: null,        // the voice the keyboard plays, or null
  armedMode: "override",   // "override" (pattern + live) | "midi-only" (live only)
  engineState: "idle",     // idle | loading | running | paused | error
  bouncing: false,         // offline WAV bounce in progress (transient — set by bounceToWav)
  mview: "code",           // mobile single-pane view: code | panels (desktop ignores it)
});

// File contents + dirty flags live outside the reactive store — they
// change on every keystroke and don't need to fan out to syncUI.
let fileContents = {};     // name -> source string
let fileDirty = {};        // name -> bool
let mountedFile = null;    // which file CodeMirror currently holds

function logEvent(msg) {
  $("#log-msg").textContent = msg;
  $("#log-ts").textContent = new Date().toTimeString().slice(0, 8);
}

// `#engine-state` carries a leading status dot (the orange/grey bullet);
// rewriting its textContent would blow that span away on every update.
function setEngineState(label, kind /* "running" | "idle" | "err" */) {
  const el = $("#engine-state");
  if (!el) return;
  el.classList.remove("idle", "err");
  if (kind === "idle" || kind === "err") el.classList.add(kind);
  el.innerHTML = `<span class="dot"></span>${label}`;
}

const setVoice = (name, patch) => {
  store.set((s) => ({ voices: { ...s.voices, [name]: { ...s.voices[name], ...patch } } }));
  pushVoiceToEngine(name, patch);
};
const soloActive = () =>
  store.get().voiceOrder.some((n) => store.get().voices[n] && store.get().voices[n].solo);

/* ───────────────────────────────────────────────────────────────────
   Patch set — fetch the manifest build.sh generated, then each source.
   ─────────────────────────────────────────────────────────────────── */
async function loadPatches() {
  try {
    const r = await fetch("./patches/index.json");
    if (r.ok) {
      const names = await r.json();
      if (Array.isArray(names) && names.length) {
        const entries = await Promise.all(names.map(async (n) => {
          const fr = await fetch("./patches/" + n);
          return [n, fr.ok ? await fr.text() : `// failed to load ${n}\n`];
        }));
        return Object.fromEntries(entries);
      }
    }
  } catch (err) {
    console.warn("patch manifest load failed, using inline fallback:", err);
  }
  // Final fallback: a literal DC patch so the page still boots if the
  // manifest fetch fails (offline, mid-deploy, dev typo).
  return { "fallback.fugue": "process { out = 0.1 }\n" };
}

/* ───────────────────────────────────────────────────────────────────
   Audio — AudioWorklet bootstrap. Adapted from the v0.2 playground;
   the worklet + wasm shim are unchanged, only the message contract
   grew ({voices} on the ack, {levels} pushed, {set_voice} accepted).
   ─────────────────────────────────────────────────────────────────── */
let audioCtx = null;
let workletNode = null;
let masterGainNode = null;
let analyser = null;
let wasmCompiled = null;
let freqData = null;     // Float32Array — analyser frequency bins (dB)
let timeData = null;     // Float32Array — analyser time-domain samples
let latestLevels = null; // Float32Array — [peak,rms] per voice + master
// Uint32Array from the worklet's {active} tap: a flat, packed list of
// [start,end] absolute-byte pairs — one per atom sounding this block, across
// all voices (a chord-name lights once; no rest sentinels). Drives the
// live pattern-step highlight — cleared on hot-swap, replaced on
// every {levels} push.
let latestActive = null;
// DSP load (render time / block budget, 0..1) from the worklet's {cpu} field;
// null until the first worklet report. Rendered to the `Load` status chunk by
// frame(); see processor.js for how it's measured.
let latestCpu = null;

async function compileWasmOnce() {
  if (wasmCompiled) return wasmCompiled;
  const r = await fetch("./fugue_wasm_bg.wasm");
  if (!r.ok) throw new Error(`wasm fetch failed: ${r.status}`);
  wasmCompiled = await WebAssembly.compileStreaming(r.clone()).catch(async () => {
    const bytes = await r.arrayBuffer();
    return WebAssembly.compile(bytes);
  });
  return wasmCompiled;
}

// Main-thread wasm-bindgen handle. Initialised once at boot so the
// header version pill can call `version()` without waiting for the
// worklet (Play). The same `WebAssembly.Module` is reused for the
// worklet's own init — wasm-bindgen keeps per-thread tables, so each
// context binds independently.
let wasmInitPromise = null;
async function ensureWasmInit() {
  if (!wasmInitPromise) {
    wasmInitPromise = (async () => {
      const mod = await compileWasmOnce();
      // Reuse the already-compiled module — the key MUST be `module_or_path`
      // for wasm-bindgen ≥0.2.93 (it was `module` before the rename). The
      // wrong key is silently dropped, so init falls back to its default
      // `new URL(...wasm)` and fetches + recompiles the 874 KB module a
      // second time on every uncached load. Positional `initWasm(mod)` also
      // works (as processor.js does) but trips a deprecation warning.
      await initWasm({ module_or_path: mod });
    })();
  }
  return wasmInitPromise;
}

async function paintVersionPill() {
  const pill = $("#version-pill");
  const txt = $("#version-text");
  if (!pill || !txt) return;
  try {
    await ensureWasmInit();
    // Write only the version text node — the pill also holds the hover-only
    // "· about" tail, which textContent on the pill would wipe.
    txt.textContent = `v${fugueVersion()}`;
    pill.classList.remove("cold");
  } catch (err) {
    console.error("version() failed:", err);
  }
}

// iOS-silent-switch unlock — the silent <audio> trick. Builds a ~50 ms
// silent WAV blob on first call, plays it on loop. The element doesn't
// connect anywhere audible; its only job is to keep an HTMLMediaElement
// in the "playing" state, which forces Safari's audio session category
// to "playback" instead of the default "ambient" that respects the
// silent switch. Harmless on desktop / Android — just a looping silent
// element with zero CPU cost.
let silentUnlockEl = null;
function unlockIosAudioSession() {
  if (silentUnlockEl) {
    silentUnlockEl.play().catch(() => {});
    return;
  }
  const sr = 22050, frames = Math.floor(sr / 20); // ~50 ms
  const buf = new ArrayBuffer(44 + frames);
  const dv = new DataView(buf);
  const tag = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + frames, true); tag(8, "WAVE");
  tag(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);  // PCM, mono
  dv.setUint32(24, sr, true); dv.setUint32(28, sr, true); // sr, byte rate
  dv.setUint16(32, 1, true); dv.setUint16(34, 8, true);   // block align, 8-bit
  tag(36, "data"); dv.setUint32(40, frames, true);
  for (let i = 0; i < frames; i++) dv.setUint8(44 + i, 0x80); // 8-bit PCM silence
  const url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
  silentUnlockEl = new Audio(url);
  silentUnlockEl.loop = true;
  silentUnlockEl.playsInline = true;
  silentUnlockEl.play().catch(() => {});
}

async function start() {
  if (audioCtx) return;
  store.set({ engineState: "loading" });
  // iOS Safari mutes Web Audio when the hardware silent switch is on
  // (its audio session defaults to "ambient"). An HTMLMediaElement that
  // is actively playing — even silently — elevates the session to
  // "playback", which bypasses the switch. Must be started inside the
  // click handler's user-gesture token; loops for the page's lifetime.
  unlockIosAudioSession();
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  // iOS WebKit (Safari + Chrome on iOS) creates AudioContext suspended and
  // only honours resume() while the user-gesture token is still live —
  // any await below burns it. Fire-and-forget here keeps the call inside
  // the click handler's synchronous prefix.
  audioCtx.resume().catch(() => {});
  // Reflect the actual sample rate the device gave us (44.1 vs 48 kHz).
  const srKHz = (audioCtx.sampleRate / 1000).toFixed(audioCtx.sampleRate % 1000 === 0 ? 0 : 1);
  $("#sr-status").textContent = `${srKHz} kHz`;
  // The polyfill must register FIRST — it defines TextDecoder/TextEncoder
  // on the AudioWorkletGlobalScope that processor.js's wasm import needs.
  await audioCtx.audioWorklet.addModule("./worklet-polyfill.js");
  await audioCtx.audioWorklet.addModule("./processor.js");
  const wasmModule = await compileWasmOnce();
  const source = fileContents[store.get().activeFile] || "process { out = 0.1 }\n";
  pendingEngineSource = source; // promoted to engineSource on the {ok} ack
  workletNode = new AudioWorkletNode(audioCtx, "fugue-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { wasmModule, source },
  });
  workletNode.port.onmessage = (e) => handleWorkletMessage(e.data);

  // Master gain node sits between the worklet and the analyser, so the
  // analyser (and so the figures) see post-master-fader signal.
  masterGainNode = audioCtx.createGain();
  masterGainNode.gain.value = (store.get().voices.master?.gain) ?? 1.0;
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0; // we do our own temporal averaging
  analyser.minDecibels = -120;
  analyser.maxDecibels = 0;
  freqData = new Float32Array(analyser.frequencyBinCount);
  timeData = new Float32Array(analyser.fftSize);
  workletNode.connect(masterGainNode).connect(analyser).connect(audioCtx.destination);
  logEvent("engine starting…");
}

async function teardown() {
  try { if (workletNode) workletNode.disconnect(); } catch {}
  try { if (masterGainNode) masterGainNode.disconnect(); } catch {}
  try { if (analyser) analyser.disconnect(); } catch {}
  try { if (audioCtx) await audioCtx.close(); } catch {}
  audioCtx = workletNode = masterGainNode = analyser = null;
}

// Stop audio when the page goes away. iOS keeps the AudioContext *and* the
// looping silent-unlock <audio> element alive when a tab is hidden, navigated
// away from, or closed (the media session lingers in the background), so the
// patch can keep playing after the tab is gone. `pagehide` fires on close,
// navigation, and bfcache entry — pause the unlock element (releases the media
// session) and suspend the context so nothing plays on. `pageshow` re-arms the
// unlock loop if the page is restored from bfcache.
window.addEventListener("pagehide", () => {
  try { silentUnlockEl?.pause(); } catch {}
  try { audioCtx?.suspend(); } catch {}
  if (audioCtx) store.set({ engineState: "paused" });
});
window.addEventListener("pageshow", (e) => {
  if (e.persisted && silentUnlockEl) { try { silentUnlockEl.play().catch(() => {}); } catch {} }
});

// `msg` is the full rendered diagnostic (message + line:col + caret block) —
// shown verbatim in the monospace strip. `head` labels the context.
function showBootError(msg, head = "compile error") {
  const el = $("#boot-error");
  if (!el) return;
  const headEl = $("#boot-error-head");
  if (headEl) headEl.textContent = head;
  $("#boot-error-msg").textContent = msg;
  el.hidden = false;
  // Pane is on screen → the status-bar "show" affordance isn't needed.
  setErrorToggle(false);
}

// Collapse the pane but keep the error addressable: the status-bar "show"
// button re-surfaces it. Distinct from hideBootError, which fully clears on a
// successful build.
function collapseBootError() {
  const el = $("#boot-error");
  if (el) el.hidden = true;
  setErrorToggle(true);
}

function hideBootError() {
  const el = $("#boot-error");
  if (el) el.hidden = true;
  setErrorToggle(false);
}

// The status-bar "show" button is visible only while a compile error is
// collapsed (error still active, pane hidden by the user).
function setErrorToggle(visible) {
  const btn = $("#error-toggle");
  if (btn) btn.hidden = !visible;
}

// wasm-bindgen's `String(jsError)` prepends its own "Error: " wrapper around
// our rendered diagnostic (which already starts with "error:"). Strip the
// wrapper so the strip reads `error: parse: …`, not `Error: error: parse: …`.
function unwrapErr(e) {
  return String(e).replace(/^Error:\s*/, "");
}

async function toggle() {
  if (!audioCtx) {
    try {
      await start();
      hideBootError();
    } catch (err) {
      store.set({ engineState: "error" });
      // The boot-error pane carries the full diagnostic; the status log stays a
      // terse status so the two surfaces don't duplicate the error text.
      showBootError(unwrapErr(err), "engine load failed");
      logEvent("engine load failed");
      // Full stack to DevTools — the strip shows the rendered diagnostic.
      console.error("start() failed:", err);
      await teardown();
    }
    return;
  }
  if (audioCtx.state === "running") {
    await audioCtx.suspend();
    store.set({ engineState: "paused" });
    logEvent("paused");
  } else {
    await audioCtx.resume();
    store.set({ engineState: "running" });
    logEvent("playing");
  }
}

function sendHotSwap(src) {
  // Remember what the engine is about to compile — the pattern-step
  // highlight maps its byte spans against this exact string (promoted to
  // `engineSource` on the worklet's ack). Drop the spans we still hold:
  // they index the *previous* source until the rebuild lands.
  pendingEngineSource = src;
  latestActive = null;
  if (!workletNode) { start().catch((e) => console.error(e)); return; }
  workletNode.port.postMessage({ hot_swap: src });
}

function pushVoiceToEngine(name, patch) {
  if (name === "master") {
    // Master is a Web Audio GainNode, not an engine voice.
    if (!masterGainNode) return;
    const m = store.get().voices.master;
    masterGainNode.gain.value = m.mute ? 0 : m.gain;
    return;
  }
  const idx = store.get().voiceOrder.indexOf(name);
  if (idx >= 0 && workletNode) {
    workletNode.port.postMessage({ set_voice: { index: idx, ...patch } });
  }
}

// Replay the whole mixer to a freshly-built engine. The engine carries
// voice_mix across hot_swap by name, but a cold `loaded` build starts at
// defaults — push anything the user already moved.
function replayMixer() {
  const s = store.get();
  s.voiceOrder.forEach((name, idx) => {
    const v = s.voices[name];
    if (!v || !workletNode) return;
    if (v.gain !== 1 || v.mute || v.solo) {
      workletNode.port.postMessage({ set_voice: { index: idx, gain: v.gain, mute: v.mute, solo: v.solo } });
    }
  });
}

/* ───────────────────────────────────────────────────────────────────
   MIDI keyboard — a playground input device, NOT a language feature
   (CLAUDE.md §8/§9). The keyboard plays the *armed* mixer voice; the engine
   owns note priority and the per-voice arm/override (docs/midi.md), so this
   module only (a) connects Web MIDI and forwards raw note events to the
   worklet, and (b) drives the status-bar connection chunk. The arm control
   itself lives on each mixer strip (see makeStrip / toggleArm).

   Web MIDI is Chromium + Firefox only — Safari/iOS has no support, so the
   chunk degrades to `n/a` there.
   ─────────────────────────────────────────────────────────────────── */
let midiAccess = null;        // MIDIAccess, once the user enables input

const midiSupported = () => typeof navigator !== "undefined" && !!navigator.requestMIDIAccess;

async function enableMidi() {
  if (!midiSupported()) return;
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    setMidiStatus("denied", "idle");
    console.error("requestMIDIAccess failed:", err);
    return;
  }
  attachMidiInputs();
  // Hot-plugged keyboards: re-attach + re-count as devices come and go.
  midiAccess.onstatechange = () => {
    attachMidiInputs();
    refreshMidiUI();
  };
  refreshMidiUI();
}

function attachMidiInputs() {
  if (!midiAccess) return;
  for (const input of midiAccess.inputs.values()) input.onmidimessage = onMidiMessage;
}

function midiInputCount() {
  if (!midiAccess) return 0;
  let n = 0;
  for (const _ of midiAccess.inputs.values()) n++;
  return n;
}

// Forward raw note events to the worklet. The engine resolves note priority
// and applies them to the armed voice (docs/midi.md) — the page holds no note
// state. Channel/velocity are ignored for now (mono + poly-by-allocation).
function onMidiMessage(e) {
  const [status, d1, d2] = e.data;
  const kind = status & 0xf0;
  if (kind === 0x90 && d2 > 0) {
    workletNode?.port.postMessage({ note_on: d1 });
  } else if (kind === 0x80 || (kind === 0x90 && d2 === 0)) {
    workletNode?.port.postMessage({ note_off: d1 });
  } else if (kind === 0xb0 && (d1 === 123 || d1 === 120)) {
    workletNode?.port.postMessage({ all_notes_off: true });
  }
}

// The MIDI status chunk carries a leading dot (like `#engine-state`); writing
// textContent would blow that span away, so rebuild it and toggle the kind on
// the chunk button. kind: "idle" (grey dot) | "on" (signal dot) | "na" (no dot).
function setMidiStatus(label, kind /* "idle" | "on" | "na" */) {
  const el = $("#midi-status");
  const chunk = $("#midi-enable");
  if (el) el.innerHTML = `<span class="dot"></span>${label}`;
  if (chunk) {
    chunk.classList.remove("idle", "on", "na");
    chunk.classList.add(kind);
  }
}

// Reconcile the status chunk: support, connection, device count. Target
// selection moved onto the mixer strips (the per-voice arm, docs/midi.md).
function refreshMidiUI() {
  const enableBtn = $("#midi-enable");
  if (!enableBtn) return;
  if (!midiSupported()) {
    enableBtn.disabled = true;
    setMidiStatus("n/a", "na");
    return;
  }
  if (!midiAccess) {
    setMidiStatus("off", "idle");
  } else {
    const n = midiInputCount();
    setMidiStatus(n === 0 ? "no device" : n === 1 ? "1 device" : `${n} devices`, "on");
  }
}

function bindMidi() {
  $("#midi-enable")?.addEventListener("click", enableMidi);
  refreshMidiUI();
}

// ── Per-voice arm (docs/midi.md) ──────────────────────────────────────────
// The keyboard drives exactly one voice at a time. A strip's arm button cycles
// off → override → MIDI-only → off; arming is exclusive, lazily connects MIDI,
// and is re-asserted to the engine on every (re)build (a cold build resets it).
//   override  — the pattern plays; live preempts while a key is held.
//   MIDI-only — the pattern is muted; only the keyboard sounds.

function toggleArm(name) {
  const s = store.get();
  let { armedVoice, armedMode } = s;
  if (armedVoice !== name) {
    armedVoice = name;            // off → override
    armedMode = "override";
  } else if (armedMode === "override") {
    armedMode = "midi-only";      // override → MIDI-only
  } else {
    armedVoice = null;            // MIDI-only → off
    armedMode = "override";
  }
  store.set({ armedVoice, armedMode });
  // Arming implies you want to play — request MIDI access if not yet granted.
  if (armedVoice && !midiAccess) enableMidi();
  applyArm();
  refreshArmUI();
}

// Push the current arm to the engine: voice index (or -1 to disarm) + the mode.
function applyArm() {
  const s = store.get();
  const idx = s.armedVoice ? s.voiceOrder.indexOf(s.armedVoice) : -1;
  workletNode?.port.postMessage({ arm: idx, midi_only: s.armedMode === "midi-only" });
}

// Light the armed voice's arm button: override fills the accent, MIDI-only fills
// dark (it mutes the pattern, echoing Mute). The button is the only "armed"
// signal, like solo; the overridden pattern stops highlighting on its own (the
// engine suppresses the active-span tap for the armed voice).
function refreshArmUI() {
  const armed = store.get().armedVoice;
  const midiOnly = store.get().armedMode === "midi-only";
  for (const [name, rec] of Object.entries(channels)) {
    if (rec.isMaster) continue;
    const on = name === armed;
    rec.armBtn?.classList.toggle("on", on);
    rec.armBtn?.classList.toggle("only", on && midiOnly);
  }
}

function handleWorkletMessage(data) {
  if (data?.levels) {
    latestLevels = data.levels;
    if (data.active instanceof Uint32Array) latestActive = data.active;
    if (typeof data.cpu === "number") latestCpu = data.cpu;
    return;
  }
  if (data?.ok) {
    // A successful build clears any lingering compile-error strip.
    hideBootError();
    // The worklet compiled `pendingEngineSource` — adopt it as the
    // coordinate frame for the pattern-step highlight (rebuilds the
    // byte→char map, resets edit tracking, forces a re-dispatch).
    promoteEngineSource();
    if (Array.isArray(data.voices)) onVoiceList(data.voices, data.armable);
    if (data.ok === "loaded" || data.ok === "loaded-on-edit") {
      store.set({ engineState: "running" });
      replayMixer();
      logEvent(data.ok === "loaded-on-edit" ? "reloaded on edit" : "loaded");
    } else if (data.ok === "swapped") {
      // A hot-swap doesn't change transport — a swap while paused must stay
      // paused. But a successful swap does clear a stale compile-error dot,
      // so resolve the state from the live context rather than forcing it.
      store.set({ engineState: audioCtx?.state === "running" ? "running" : "paused" });
      logEvent("hot-swapped");
    }
    return;
  }
  if (data?.error) {
    store.set({ engineState: "error" });
    // The strip shows the full rendered diagnostic (line:col + caret); the
    // status log stays a terse status — no point echoing the error text in
    // both, and the hand-font log shouldn't quote a monospace diagnostic. The
    // orange Eng chunk already flags the error state. The editor stays visible
    // above the strip so the user can fix the source — and on a hot-swap
    // failure the old engine keeps playing, so this is a non-blocking notice.
    showBootError(unwrapErr(data.error), "compile error");
    logEvent("compile error");
  }
}

// The worklet reports voice names on every (re)build. Reconcile the store
// by name so gain/mute/solo survive an edit, then rebuild the strips.
function onVoiceList(names, armable) {
  const prev = store.get().voices;
  const voices = {};
  for (const n of names) voices[n] = prev[n] || { gain: 1, mute: false, solo: false };
  voices.master = prev.master || { gain: 1, mute: false, solo: false };
  // `armable[]` is parallel to `names` — keep the armable voices as a name set.
  const armableSet = new Set((armable || []).flatMap((ok, i) => (ok ? [names[i]] : [])));
  // A rebuild may drop or un-arm the previously-armed voice.
  let armed = store.get().armedVoice;
  if (armed && !armableSet.has(armed)) armed = null;
  store.set({ voiceOrder: names, voices, armable: armableSet, armedVoice: armed });
  buildMixer(names);
  refreshArmUI();
  applyArm(); // re-assert the arm to the freshly-(re)built engine
}

/* ───────────────────────────────────────────────────────────────────
   CodeMirror 6 — editorial theme + a small fugue StreamLanguage. The
   eval-flash is a line Decoration driven by a StateField (a CodeMirror idiom).
   ─────────────────────────────────────────────────────────────────── */
// v0.7 surface keywords: process / feedback / out / param / import|from|as
// (the v0.6 `fugue` block keyword retired); 4 top-level config names
// (tempo / sample_rate / channels / midi), and the stdlib names — stage
// primitives + pattern combinators + math + HOFs.
const FUGUE_KEYWORDS = /^(?:process|feedback|out|param|import|from|as)\b/;
const FUGUE_CONFIG   = /^(?:tempo|sample_rate|channels|midi)\b/;
const FUGUE_STDLIB = new Set([
  // oscillators
  "sine","tri","saw","square","pulse","phasor","noise","noise_pink",
  // filters
  "lpf","hpf","bpf","peak","ladder","smooth",
  // envelopes
  "ar","adsr","decay","env_follow","ramp",
  // dynamics
  "tanh","comp","tape_sat","bit_crush",
  // delays
  "delay","delay_frac","delay_thiran","delay_mod","allpass","comb_ff",
  // reverbs
  "fdn4","fdn8","fdn16","plate","freeverb",
  // modulation
  "lfo","vibrato","chorus","phaser","flanger","tremolo",
  // pitch / physical / drums
  "pitch_shift","karplus","kick","snare","hat",
  // math / samples / stereo
  "sin","cos","exp","mix","clamp","sample","play","scale",
  "pan","width","mid_side","from_mid_side","stereo",
  // HOFs + matrix helpers
  "par","sum","seq","prod","dot","matvec","matmat","norm",
  "hadamard","householder","identity","diag",
  // pattern combinators
  "pure","silence","fmap","cat","fastcat","stack",
  "fast","slow","rev","every","off","jux","palindrome","iter",
  "late","early","degrade","degrade_by","octave","voicing",
]);

const fugueLang = StreamLanguage.define({
  name: "fugue",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";        // mini-notation
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)) { // number + unit
      stream.match(/^(?:kHz|Hz|ms|us|s|dB|bpm|rad)\b/);
      return "number";
    }
    if (stream.match(FUGUE_KEYWORDS)) return "keyword";
    if (stream.match(FUGUE_CONFIG))   return "meta";                // top-level config
    if (stream.match(/^(?:\|>|->)/)) return "operator";            // |> compose, -> route
    const ident = stream.match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (ident) {
      const word = ident[0];
      if (FUGUE_STDLIB.has(word)) return "builtin";
      // dotted stdlib: param.log, midi.cc, midi.note, etc.
      const dot = stream.match(/^\.[A-Za-z_][A-Za-z0-9_]*/);
      if (dot && (word === "param" || word === "midi" || word === "ui")) return "builtin";
      return "variableName";
    }
    if (stream.match(/^[-+*/=<>().,;:{}\[\]]/)) return "operator";
    stream.next();
    return null;
  },
  languageData: { commentTokens: { line: "//" } },
});

const fugueHighlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--ink-3)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--ink)", fontWeight: "700" },
  { tag: tags.meta, color: "var(--signal)", fontWeight: "700" },
  { tag: tags.string, color: "var(--ink)", backgroundColor: "var(--signal-soft)" },
  { tag: tags.number, color: "var(--ink)", fontWeight: "500" },
  { tag: tags.variableName, color: "var(--ink)" },
  { tag: tags.standard(tags.variableName), color: "var(--ink-2)" },
  { tag: tags.operator, color: "var(--ink-2)" },
]);

const editorialTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--paper)", color: "var(--ink)" },
  ".cm-scroller": {
    fontFamily: "var(--mono)", fontSize: "13px", lineHeight: "1.85",
    overflow: "auto",
  },
  ".cm-content": { padding: "20px 0 40px", caretColor: "var(--signal)" },
  ".cm-line": { padding: "0 28px" },
  ".cm-gutters": {
    backgroundColor: "var(--paper)", color: "var(--ink-4)", border: "none",
    fontFamily: "var(--mono)", fontStyle: "italic", fontSize: "11px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 16px 0 14px", minWidth: "52px" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--signal)", fontWeight: "700", fontStyle: "normal" },
  ".cm-activeLine": { backgroundColor: "rgba(255, 85, 29, 0.05)", boxShadow: "inset 3px 0 0 var(--signal)" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--signal)", borderLeftWidth: "2px" },
  // Selection is drawn in its own layer that CM parks BEHIND the text (z-index
  // -2). Two problems with the old `--signal-soft` fill: it's the exact colour
  // of the string backing (so selecting a pattern showed nothing), and behind
  // the string's opaque backing it was occluded anyway. Pull the layer in FRONT
  // of the content and wash it with a translucent accent (`--signal-sel`,
  // recomputed per-accent in applyAccentVars) — readable through the text, and
  // visible over the string backings.
  //
  // `!important` is load-bearing: CM's base theme sets both the layer z-index
  // and the selection colour, and plain theme values lose to it (verified in a
  // headless repro — without it the computed values stayed at CM's -2 / default
  // lavender, and the selection was invisible).
  //
  // `pointerEvents: none` is REQUIRED now that the layer is in front: CM leaves
  // the layer hit-testable (computed `auto`), so an in-front selection rect
  // would swallow clicks/drags on the inline @param knob widgets it overlaps.
  // The cursor layer is pointer-events:none for the same reason; the rects
  // inherit it. (No !important needed — CM sets no pointer-events here.)
  ".cm-selectionLayer": { zIndex: "1 !important", pointerEvents: "none" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--signal-sel) !important",
  },
}, { dark: false });

// Eval flash — a line Decoration set over the evaluated range, cleared on
// a timer once the CSS animation has run.
const setFlash = StateEffect.define();
const clearFlash = StateEffect.define();
const flashLine = Decoration.line({ class: "cm-eval-flash" });
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlash)) {
        const { from, to } = e.value;
        const ranges = [];
        let pos = from;
        while (pos <= to) {
          const line = tr.state.doc.lineAt(pos);
          ranges.push(flashLine.range(line.from));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
        deco = Decoration.set(ranges, true);
      } else if (e.is(clearFlash)) {
        deco = Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// Pattern-step highlight — a mark Decoration over the mini-notation atoms
// currently sounding (the live-coding step-highlight idiom). The rAF loop maps the
// worklet's active-span tap (absolute `.fugue` byte ranges) onto live-doc
// positions and pushes a fresh set through `setPatternHl` whenever the set
// of lit atoms changes.
const setPatternHl = StateEffect.define();
const patternHlMark = Decoration.mark({ class: "cm-pattern-active" });
const patternHlField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    // Map through edits so a highlight set just before a keystroke
    // doesn't land on the wrong offsets for the one frame before the
    // rAF loop notices the buffer went dirty and clears it.
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPatternHl)) deco = e.value;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/* ───────────────────────────────────────────────────────────────────
   Inline @param knobs — the mixer's rotary control, rendered as a
   CodeMirror widget right after each @param's value. Dragging rewrites
   the numeric literal in the source (so the value stays visible and
   survives a save/eval) AND pushes a live `set_param` to the engine
   (so it's audible without a re-eval) — the mixer-knob contract,
   applied to declared parameters.

   The knob is a pure function of the document text: parse the value,
   draw the arc. A drag is the only writer; typing a number just
   re-renders. Bool params (gates) get no knob — they're driven by the
   pattern score, and a two-state "knob" reads as noise.
   ─────────────────────────────────────────────────────────────────── */

// Unit suffix → SI factor. set_param expects base units (Hz, seconds);
// the editor shows surface units (kHz, ms, …). Real params are unitless.
// Suffixes are case-sensitive, SI-spelled: `Hz`, `kHz`, `dB` capitalised.
const UNIT_SI = {
  Hz: 1, kHz: 1e3,
  ms: 1e-3, us: 1e-6, s: 1,
  dB: 1, rad: 1, bpm: 1,
};

// One v0.3 @param line: `@param name: Kind = default [unit] [...]`.
const PARAM_RE_V3 =
  /^(\s*@param\s+)([A-Za-z_]\w*)(\s*:\s*)(Freq|Time|Real|Bool)(\s*=\s*)(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(kHz|Hz|ms|us|s|dB|rad)?/;

// One v0.6 param decl inside a process body:
//   `name = param.<taper>(lo[unit], hi[unit]) default[unit] [|> smooth(...)]`
// We don't capture the smooth tail here — the knob mounts at the default
// value token's end; dragging rewrites just the default literal.
const PARAM_RE_V6 =
  /^(\s*)([A-Za-z_]\w*)(\s*=\s*param\.)(lin|log|exp|step)(\s*\(\s*)(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(kHz|Hz|ms|us|s|dB|rad|bpm)?(\s*,\s*)(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(kHz|Hz|ms|us|s|dB|rad|bpm)?(\s*\)\s+)(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(kHz|Hz|ms|us|s|dB|rad|bpm)?/;

// Synthesised-range cache, keyed by param name. A `@param` with no
// declared `[lo,hi]` gets a knob range of `[0, 2·value]` — but anchored
// to the value *as loaded*, not the live literal. Without this anchor a
// drag rewrites the literal, the re-parse moves `hi` with it, and the
// knob fraction sticks at 0.5 (and the dragged value runs away). Pinned
// on first sighting; cleared on every file load (see loadIntoEditor).
const _synthRange = new Map();

// Scan the document for @param lines. Each entry carries the doc offsets
// of the numeric literal (what a drag rewrites), the value token end
// (where the knob mounts), and the knob's range/taper. A missing
// `[lo,hi]` is synthesised as [0, 2·default] so the knob still has throw.
// Engine-side param name. `compile.rs` namespaces a named process's
// params as `<process>_<param>` (idempotent if the source already
// prefixed it); an anonymous `process { }` / `process(in)` keeps bare
// names. The inline knob's live `set_param` MUST use this engine name —
// sending the bare `freq` against an engine that declared `drone_freq`
// is an `UnknownName` no-op, so the drag only lands on the next hot-swap.
function engineParamName(process, name) {
  if (!process) return name;
  const prefix = process + "_";
  return name.startsWith(prefix) ? name : prefix + name;
}

function parseParams(doc) {
  const out = [];
  // Track the enclosing process: `process foo(...) { … }` namespaces its
  // params; the anonymous forms (`process { …`, `process(in) { …`) don't.
  // A `param.*` line is always inside the most recent process header.
  let process = null;
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const named = /^\s*process\s+([A-Za-z_]\w*)/.exec(line.text);
    if (named) process = named[1];
    else if (/^\s*process\s*[{(]/.test(line.text)) process = null;
    const v6 = parseParamLineV6(line);
    if (v6) {
      v6.engineName = engineParamName(process, v6.name);
      out.push(v6);
      continue;
    }
    const v3 = parseParamLineV3(line);
    if (v3) {
      v3.engineName = v3.name; // v0.3 `@param` is module-global, never namespaced
      out.push(v3);
    }
  }
  return out;
}

// v0.3 `@param name: Kind = default[unit] [range] [smooth=] [taper=]`.
function parseParamLineV3(line) {
  const m = PARAM_RE_V3.exec(line.text);
  if (!m || m[4] === "Bool") return null;
  const [, g1, name, g3, kind, g5, numStr] = m;
  const unit = m[7] || "";
  const valFrom = line.from + g1.length + name.length + g3.length + kind.length + g5.length;
  const valTo = valFrom + numStr.length;
  const tokEnd = valTo + unit.length;
  const def = parseFloat(numStr);
  const siScale = UNIT_SI[unit] ?? 1;
  const valueSI = def * siScale;
  const tail = line.text.slice(tokEnd - line.from);
  const rng = /\[\s*(-?[0-9.eE+-]+)(kHz|Hz|ms|us|s|dB|rad)?\s*,\s*(-?[0-9.eE+-]+)(kHz|Hz|ms|us|s|dB|rad)?/.exec(tail);
  let lo, hi;
  if (rng) {
    lo = parseFloat(rng[1]) * (UNIT_SI[rng[2] ?? ""] ?? siScale);
    hi = parseFloat(rng[3]) * (UNIT_SI[rng[4] ?? ""] ?? siScale);
  } else {
    const cached = _synthRange.get(name);
    if (cached) {
      ({ lo, hi } = cached);
    } else {
      lo = 0;
      hi = valueSI > 0 ? valueSI * 2 : siScale;
      _synthRange.set(name, { lo, hi });
    }
  }
  const taperLog = /taper\s*=\s*log/.test(tail) && lo > 0;
  const dotIdx = numStr.indexOf(".");
  const decimals = (dotIdx < 0 || /[eE]/.test(numStr)) ? 0 : numStr.length - dotIdx - 1;
  return { name, unit, siScale, valFrom, valTo, tokEnd, value: valueSI, lo, hi, taperLog, decimals, lineFrom: line.from };
}

// v0.6 `name = param.taper(lo[unit], hi[unit]) default[unit] [|> smooth(...)]`.
// The knob mounts at the end of the *default* literal (and its unit); a
// drag rewrites just that literal. Bounds come from the `(lo, hi)` call
// args; taper from the `param.<taper>` segment. The optional `|> smooth(N)`
// tail is left alone — the engine already received the smoothing time on
// build and the knob's job is just to nudge the value.
function parseParamLineV6(line) {
  const m = PARAM_RE_V6.exec(line.text);
  if (!m) return null;
  const [
    , leadWs, name, eqAndParam, taper, openParen,
    loStr, loUnit, comma, hiStr, hiUnit, closeAndGap, defStr, defUnit,
  ] = m;
  // step taper → no knob (treat as a Bool-ish stepped param; surface that
  // later if step continuous params arrive).
  if (taper === "step") return null;
  const unit = defUnit || "";
  const siScale = UNIT_SI[unit] ?? 1;
  const valueSI = parseFloat(defStr) * siScale;

  const beforeDefault =
    leadWs.length + name.length + eqAndParam.length + taper.length +
    openParen.length + loStr.length + (loUnit?.length ?? 0) +
    comma.length + hiStr.length + (hiUnit?.length ?? 0) + closeAndGap.length;
  const valFrom = line.from + beforeDefault;
  const valTo = valFrom + defStr.length;
  const tokEnd = valTo + (defUnit?.length ?? 0);

  const loSI = parseFloat(loStr) * (UNIT_SI[loUnit ?? ""] ?? siScale);
  const hiSI = parseFloat(hiStr) * (UNIT_SI[hiUnit ?? ""] ?? siScale);
  const lo = Math.min(loSI, hiSI);
  const hi = Math.max(loSI, hiSI);
  const taperLog = taper === "log" && lo > 0;

  const dotIdx = defStr.indexOf(".");
  const decimals = (dotIdx < 0 || /[eE]/.test(defStr)) ? 0 : defStr.length - dotIdx - 1;
  return { name, unit, siScale, valFrom, valTo, tokEnd, value: valueSI, lo, hi, taperLog, decimals, lineFrom: line.from };
}

// value ⇄ [0,1] knob fraction, honouring a log taper (freq params).
const paramFrac = (p) =>
  p.hi === p.lo ? 0
  : p.taperLog ? Math.log(Math.max(p.value, p.lo) / p.lo) / Math.log(p.hi / p.lo)
  : (p.value - p.lo) / (p.hi - p.lo);
const paramValue = (p, f) => {
  f = Math.min(1, Math.max(0, f));
  return p.taperLog ? p.lo * Math.pow(p.hi / p.lo, f) : p.lo + f * (p.hi - p.lo);
};
// Honour the precision the author wrote into the literal. `540` ⇒ 0
// decimals, `540.00` ⇒ 2, `1.234` ⇒ 3 — the source declares both the
// range (via `[lo,hi]`) and the resolution. Uniform width across a
// drag (`tnum` is on in the editor) keeps the knob from jittering.
const fmtParam = (v, decimals) => (isFinite(v) ? v.toFixed(decimals) : "0");

// The widget: a tiny knob, mounted as an inline element at the end of
// each @param value token. The indicator angle is a pure function of
// the fraction, so `eq` lets CodeMirror reuse the DOM until the value
// visibly moves.
class ParamKnobWidget extends WidgetType {
  constructor(p) {
    super();
    this.name = p.name;
    this.frac = Math.min(1, Math.max(0, paramFrac(p)));
    // Carry the line-start position so the drag handler can locate this
    // specific param instance, not just any param with the same name.
    // Duplicate param names across voices (e.g. "freq" in drone + kick)
    // require position-based lookup; name-only find() picks the first match.
    this.lineFrom = p.lineFrom;
  }
  eq(o) {
    return o.name === this.name && o.lineFrom === this.lineFrom &&
           Math.abs(o.frac - this.frac) < 1e-4;
  }
  ignoreEvent() { return true; }
  toDOM() {
    const deg = -135 + this.frac * 270;
    const span = document.createElement("span");
    span.className = "cm-param-knob";
    span.title = `${this.name} — drag to set`;
    span.innerHTML = `
      <span class="ring"></span>
      <span class="ind" style="transform: translate(-50%, 0) rotate(${deg.toFixed(1)}deg)"></span>
      <span class="dot"></span>`;
    span.addEventListener("pointerdown", (e) => beginParamDrag(e, this.name, this.lineFrom));
    return span;
  }
}

// Vertical drag → rewrite the literal + push a live set_param. The
// pointer's y delta from pointerdown sets the new fraction (relative,
// like a real knob — not a click-to-jump). The param's range stays put
// across re-parses — declared `[lo,hi]` is fixed text, and a synthesised
// range is pinned by `_synthRange`.
//
// Identity is anchored by (name, lineFrom) rather than name alone, so that
// duplicate param names across voices (e.g. "freq" in drone, kick, sub,
// glass) each get their own knob throw — name-only lookup always hit the
// first occurrence regardless of which knob was dragged.
function beginParamDrag(e, name, lineFrom) {
  e.preventDefault();
  e.stopPropagation();
  const knobEl = e.currentTarget;
  knobEl.classList.add("dragging");
  // Find the param on the exact line the knob was built for. After each
  // drag-move dispatch the value literal changes length, shifting tokEnd,
  // but the line-start (lineFrom) is stable as long as no line is inserted
  // or deleted — which a value rewrite never does.
  const find = () => parseParams(editor.state.doc).find(
    (p) => p.name === name && p.lineFrom === lineFrom
  );
  const start = find();
  if (!start) { knobEl.classList.remove("dragging"); return; }
  const y0 = e.clientY;
  const f0 = paramFrac(start);
  const move = (ev) => {
    const p = find();
    if (!p) return;
    const f = Math.min(1, Math.max(0, f0 + (y0 - ev.clientY) * 0.005));
    const value = paramValue(p, f); // SI (Hz, s, …)
    // Knob drags are a control surface, not typing — keep them out of
    // the undo history so one drag isn't dozens of ⌘Z steps. The value
    // is in the text either way; the updateListener still marks dirty.
    editor.dispatch({
      changes: { from: p.valFrom, to: p.valTo, insert: fmtParam(value / p.siScale, p.decimals) },
      annotations: Transaction.addToHistory.of(false),
    });
    if (workletNode) {
      workletNode.port.postMessage({
        // `engineName` carries the `<process>_<param>` namespacing the
        // compiler applies; the bare `name` would miss the engine param.
        set_param: { name: p.engineName, value },  // already SI — no extra scale
      });
    }
  };
  const up = () => {
    knobEl.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Rebuild the knob widget set whenever the document changes — small
// docs, one pass, positions always fresh. parseParams walks lines
// top-down so the ranges are already sorted by offset.
function buildParamKnobs(state) {
  const widgets = parseParams(state.doc).map((p) =>
    Decoration.widget({ widget: new ParamKnobWidget(p), side: 1 }).range(p.tokEnd)
  );
  return Decoration.set(widgets, true);
}
const paramKnobField = StateField.define({
  create: (state) => buildParamKnobs(state),
  update: (deco, tr) => (tr.docChanged ? buildParamKnobs(tr.state) : deco),
  provide: (f) => EditorView.decorations.from(f),
});

let editor = null;
// Set while loadIntoEditor() swaps the document programmatically, so the
// updateListener doesn't mistake a tab switch for a user edit (dirty).
let loadingProgrammatically = false;

function evaluate() {
  if (!editor) return;
  const sel = editor.state.selection.main;
  editor.dispatch({ effects: setFlash.of({ from: sel.from, to: sel.to }) });
  setTimeout(() => { if (editor) editor.dispatch({ effects: clearFlash.of(null) }); }, 520);
  // The eval is always whole-file: a .fugue source compiles to one
  // patch/scene, so "evaluate a line" is cosmetic feedback only — the
  // engine rebuild is always from the full document.
  const src = editor.state.doc.toString();
  const name = store.get().activeFile;
  fileContents[name] = src;
  markDirty(name, false);
  sendHotSwap(src);
  logEvent(`evaluated ${name}`);
}

function mountEditor() {
  const evalKeymap = keymap.of([
    { key: "Mod-Enter", preventDefault: true, run: () => { evaluate(); return true; } },
    indentWithTab,
  ]);
  editor = new EditorView({
    parent: $("#editor-mount"),
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        history(),
        bracketMatching(),
        evalKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        fugueLang,
        syntaxHighlighting(fugueHighlight),
        editorialTheme,
        flashField,
        patternHlField,
        paramKnobField,
        // Track user edits → file content + dirty dot (outside the
        // store). A programmatic document swap (tab switch) is skipped.
        // The same listener updates the cursor readout in the editor
        // head — selection changes always fire even when the doc didn't.
        EditorView.updateListener.of((u) => {
          if (u.docChanged && !loadingProgrammatically) {
            const name = store.get().activeFile;
            fileContents[name] = u.state.doc.toString();
            markDirty(name, true);
            // Accumulate edits so the engine's byte spans (indexed against
            // the *compiled* source) still resolve onto the live buffer
            // before the next eval — e.g. while dragging a @param knob.
            if (editsSinceCompile) editsSinceCompile = editsSinceCompile.compose(u.changes);
          }
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            const pos = $("#editor-pos");
            if (pos) pos.textContent = `ln ${line.number} · ${head - line.from + 1}`;
          }
        }),
      ],
    }),
  });
}

function loadIntoEditor(name) {
  mountedFile = name;
  loadingProgrammatically = true;
  // Re-anchor synthesised knob ranges to the incoming file's authored
  // values; the next parseParams (triggered by the dispatch) repopulates.
  _synthRange.clear();
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: fileContents[name] || "" },
    effects: clearFlash.of(null),
    selection: { anchor: 0 },
  });
  loadingProgrammatically = false;
}

function markDirty(name, dirty) {
  fileDirty[name] = dirty;
  // Light-touch DOM update — no need to fan out through the store.
  const tab = document.querySelector(`.file-tab[data-file="${CSS.escape(name)}"] .dot`);
  if (tab) tab.classList.toggle("dirty", dirty);
}

/* ── File tabs ──────────────────────────────────────────────────────── */
function renderFileTabs() {
  const bar = $("#file-tabs");
  bar.innerHTML = "";
  const names = Object.keys(fileContents);
  const closable = names.length > 1; // never strip the last tab's only patch
  names.forEach((name, i) => {
    const tab = document.createElement("button");
    tab.className = "file-tab";
    tab.dataset.file = name;
    const idx = String(i + 1).padStart(2, "0");
    tab.innerHTML =
      `<span class="idx">${idx}</span>` +
      `<span>${name}</span>` +
      `<span class="dot" title="unsaved edits"></span>` +
      (closable ? `<span class="close" title="close">×</span>` : "");
    tab.addEventListener("click", () => switchFile(name));
    const x = tab.querySelector(".close");
    if (x) x.addEventListener("click", (e) => { e.stopPropagation(); closeFile(name); });
    bar.appendChild(tab);
  });
  const add = document.createElement("button");
  add.className = "tab-add";
  add.title = "new patch";
  add.textContent = "+";
  add.addEventListener("click", newFile);
  bar.appendChild(add);
  // Re-apply the active highlight: closing a background tab rebuilds the bar
  // without a store change, so syncUI never fires to restore it.
  const a = store.get().activeFile;
  bar.querySelectorAll(".file-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.file === a));
}

function switchFile(name) {
  if (name === store.get().activeFile) return;
  // Persist the current editor buffer before swapping it out.
  if (editor && mountedFile) fileContents[mountedFile] = editor.state.doc.toString();
  store.set({ activeFile: name });
  // Independent patches: switching tabs hot-swaps the engine to that file.
  sendHotSwap(fileContents[name] || "");
  logEvent(`switched to ${name}`);
}

function newFile() {
  let n = 1, name;
  do { name = `untitled-${n}.fugue`; n++; } while (fileContents[name] !== undefined);
  fileContents[name] = "process { out = sine(220Hz) * 0.2 }\n";
  fileDirty[name] = false;
  renderFileTabs();
  switchFile(name); // persists current buffer, sets active, hot-swaps, loads editor
}

function closeFile(name) {
  const list = Object.keys(fileContents);
  if (list.length <= 1) return; // never close the last tab
  if (fileDirty[name] && !confirm(`Discard unsaved edits to ${name}?`)) return;
  const wasActive = name === store.get().activeFile;
  const idx = list.indexOf(name);
  delete fileContents[name];
  delete fileDirty[name];
  if (mountedFile === name) mountedFile = null; // so switchFile won't re-persist a deleted file
  renderFileTabs();
  if (wasActive) {
    const rest = Object.keys(fileContents);
    const next = rest[idx] || rest[idx - 1] || rest[0]; // prefer right neighbor, else left
    switchFile(next);
  }
  logEvent(`closed ${name}`);
}

/* ───────────────────────────────────────────────────────────────────
   Mixer — one strip per voice + a master strip. Each strip owns a VU
   meter, a rotary gain knob, mute/solo, and a dBFS readout. Strip state
   is read/written through the store; `channels` holds DOM refs + scratch.
   ─────────────────────────────────────────────────────────────────── */
const channels = {};
// Fader law: travel maps linearly in dB (a log gain taper), so the fader
// feels like a console fader instead of crowding every useful level into
// the bottom sliver of a linear ramp. Top of travel = +6 dB, floor = −60 dB,
// and the very bottom snaps to true silence. Unity (0 dB) lands at ~91%.
const FADER_DB_TOP = 6;
const FADER_DB_FLOOR = -60;
const FADER_DB_SPAN = FADER_DB_TOP - FADER_DB_FLOOR;

// Fader position fraction ∈ [0,1] → linear gain.
const faderToGain = (f) => {
  f = Math.max(0, Math.min(1, f));
  return f <= 0 ? 0 : Math.pow(10, (FADER_DB_FLOOR + f * FADER_DB_SPAN) / 20);
};
// Inverse: linear gain → the handle's left% along the travel.
const handlePct = (gain) => {
  if (gain <= 0) return 0;
  const f = (20 * Math.log10(gain) - FADER_DB_FLOOR) / FADER_DB_SPAN;
  return Math.max(0, Math.min(1, f)) * 100;
};
function renderHandle(rec) {
  const gain = store.get().voices[rec.name].gain;
  rec.handle.style.left = handlePct(gain).toFixed(2) + "%";
}

function makeStrip(name, idx, isMaster) {
  const strip = document.createElement("div");
  strip.className = "channel-strip" + (isMaster ? " master-strip" : "");
  strip.innerHTML = `
    <div class="idx">${idx}</div>
    <div class="label">
      <span class="key">${name}</span>
    </div>
    <div class="gain-slider">
      <div class="track">
        <div class="rms"></div>
        <div class="peak"></div>
        <div class="handle"></div>
      </div>
    </div>
    <div class="ms-buttons">
      <button class="mute" title="mute">M</button>
      <button class="solo" title="solo">S</button>
      ${!isMaster && store.get().armable.has(name)
        ? '<button class="arm" title="live MIDI — off → override → MIDI-only" aria-label="arm for MIDI keyboard"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M11.2 16.4V5.2c2.7.45 4.6 1.95 4.6 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="8.5" cy="16.6" rx="3.1" ry="2.4" fill="currentColor" transform="rotate(-22 8.5 16.6)"/></svg></button>'
        : ""}
    </div>
    <div class="db-readout">—</div>
  `;
  const slider = strip.querySelector(".gain-slider");
  const track = strip.querySelector(".gain-slider .track");
  const rec = {
    name, isMaster, el: strip,
    slider, track,
    rms: strip.querySelector(".gain-slider .rms"),
    peak: strip.querySelector(".gain-slider .peak"),
    handle: strip.querySelector(".gain-slider .handle"),
    readout: strip.querySelector(".db-readout"),
    muteBtn: strip.querySelector(".mute"),
    soloBtn: strip.querySelector(".solo"),
    armBtn: strip.querySelector(".arm"),
    peakHold: 0, peakHoldT: 0,
    rmsBallistic: 0, peakBallistic: 0, lastFrame: 0,
  };
  channels[name] = rec;

  slider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    slider.classList.add("dragging");
    // Cache the track rect at pointerdown — the user is dragging a
    // hardware fader, not picking pixels from a moving target. A page
    // reflow mid-drag would be misery either way.
    const rect = track.getBoundingClientRect();
    const apply = (clientX) => {
      setVoice(name, { gain: faderToGain((clientX - rect.left) / rect.width) });
    };
    apply(e.clientX);
    const move = (ev) => apply(ev.clientX);
    const up = () => {
      slider.classList.remove("dragging");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  rec.muteBtn.addEventListener("click", () =>
    setVoice(name, { mute: !store.get().voices[name].mute }));
  rec.soloBtn.addEventListener("click", () =>
    setVoice(name, { solo: !store.get().voices[name].solo }));
  rec.armBtn?.addEventListener("click", () => toggleArm(name));
  // Master has no engine-side solo concept; the button stays for parity
  // but is inert (master solo is never read).
  if (isMaster) rec.soloBtn.disabled = true;
  return strip;
}

function buildMixer(names) {
  const list = $("#channel-list");
  list.innerHTML = "";
  for (const k of Object.keys(channels)) delete channels[k];
  names.forEach((name, i) =>
    list.appendChild(makeStrip(name, String(i + 1).padStart(2, "0"), false)));
  list.appendChild(makeStrip("master", "M", true));
  syncUI(store.get());
}

/* ───────────────────────────────────────────────────────────────────
   Figures — master-only. Spectrum + scope read an AnalyserNode on the
   post-master-gain signal. The spectrum keeps the Saike-derived Pareto
   core (log-freq, dB grid, exp-averaging, peak-hold, +3 dB/oct tilt).
   ─────────────────────────────────────────────────────────────────── */
const NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
};
function figFrame(id) {
  const host = $("#fig-" + id);
  host.innerHTML = "";
  // Match viewBox to the host's true pixel size so strokes and text render
  // 1:1 instead of being non-uniformly stretched on resize.
  const W = Math.max(1, host.clientWidth | 0);
  const H = Math.max(1, host.clientHeight | 0);
  const s = svg("svg", { class: "fig-svg", viewBox: `0 0 ${W} ${H}` });
  host.appendChild(s);
  s.dataset.w = W; s.dataset.h = H;
  return s;
}

const SPEC_PTS = 112, SPEC_REF = -120;
const specFreqs = new Float32Array(SPEC_PTS);
for (let i = 0; i < SPEC_PTS; i++) specFreqs[i] = 20 * Math.pow(1000, i / (SPEC_PTS - 1));
const specAvg = new Float32Array(SPEC_PTS);
const specPeak = new Float32Array(SPEC_PTS);
const specDisp = new Float32Array(SPEC_PTS);
const specPeakDisp = new Float32Array(SPEC_PTS);

function analyzeSpectrum(s) {
  analyser.getFloatFrequencyData(freqData);            // dB per linear bin
  const binHz = audioCtx.sampleRate / analyser.fftSize;
  const alpha = s.specInteg <= 0 ? 1 : 1 - Math.exp(-16.7 / s.specInteg);
  for (let p = 0; p < SPEC_PTS; p++) {
    const bin = Math.min(freqData.length - 1, Math.max(0, Math.round(specFreqs[p] / binHz)));
    let db = freqData[bin];
    if (!isFinite(db)) db = SPEC_REF;
    db += 3 * Math.log2(specFreqs[p] / 20);            // +3 dB/oct tilt
    const v = Math.max(0, Math.min(1, (db - SPEC_REF) / -SPEC_REF));
    specAvg[p] += (v - specAvg[p]) * alpha;
    specPeak[p] = Math.max(specAvg[p], specPeak[p] - 0.004);
  }
}
function spectralSmooth(src, dst, pct) {
  const half = Math.round((pct / 100) * 6);
  if (half <= 0) { dst.set(src); return; }
  for (let i = 0; i < src.length; i++) {
    let acc = 0, cnt = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < src.length) { acc += src[j]; cnt++; }
    }
    dst[i] = acc / cnt;
  }
}
const specX = (f, x0, x1) => x0 + (Math.log10(f / 20) / 3) * (x1 - x0);
function floorMap(vn, floor) {
  const db = SPEC_REF + vn * -SPEC_REF;
  return Math.max(0, Math.min(1, (db - floor) / -floor));
}
function drawSpectrum(s) {
  spectralSmooth(specAvg, specDisp, s.specSmooth);
  spectralSmooth(specPeak, specPeakDisp, s.specSmooth);
  const fig = figFrame("spectrum");
  const W = +fig.dataset.w, H = +fig.dataset.h;
  const x0 = 4, x1 = W - 4, y0 = 16, y1 = H - 22;
  for (let db = 0; db >= s.specFloor; db -= 12) {
    const y = y0 + (db / s.specFloor) * (y1 - y0);
    fig.appendChild(svg("line", { class: "ax-soft", x1: x0, y1: y, x2: x1, y2: y }));
    const t = svg("text", { x: x0 + 2, y: y - 2 }); t.textContent = db + " dB";
    fig.appendChild(t);
  }
  [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].forEach((f) =>
    fig.appendChild(svg("line", { class: "ax-soft", x1: specX(f, x0, x1), y1: y0, x2: specX(f, x0, x1), y2: y1 })));
  [["100 Hz", 100], ["1 kHz", 1000], ["10 kHz", 10000]].forEach(([lbl, f]) => {
    const t = svg("text", { x: specX(f, x0, x1) + 2, y: y1 + 13 });
    t.textContent = lbl; fig.appendChild(t);
  });
  const pts = [];
  for (let p = 0; p < SPEC_PTS; p++) {
    const x = x0 + (p / (SPEC_PTS - 1)) * (x1 - x0);
    pts.push(`${x.toFixed(1)},${(y1 - floorMap(specDisp[p], s.specFloor) * (y1 - y0)).toFixed(1)}`);
  }
  fig.appendChild(svg("polygon", { class: "ink-fill", opacity: 0.15, points: `${x0},${y1} ${pts.join(" ")} ${x1},${y1}` }));
  fig.appendChild(svg("polyline", { class: "ink-line", points: pts.join(" "), "stroke-width": 1.3 }));
  const pk = [];
  for (let p = 0; p < SPEC_PTS; p++) {
    const x = x0 + (p / (SPEC_PTS - 1)) * (x1 - x0);
    pk.push(`${x.toFixed(1)},${(y1 - floorMap(specPeakDisp[p], s.specFloor) * (y1 - y0)).toFixed(1)}`);
  }
  fig.appendChild(svg("polyline", { class: "accent", points: pk.join(" "), "stroke-width": 1, opacity: 0.5 }));
  if (s.frozen) {
    const tg = svg("text", { class: "tag", x: x1, y: 14, "text-anchor": "end" });
    tg.textContent = "HOLD";
    fig.appendChild(tg);
  }
}
function drawScope(s) {
  const fig = figFrame("scope");
  const W = +fig.dataset.w, H = +fig.dataset.h, mid = H / 2;
  fig.appendChild(svg("line", { class: "ax-soft", x1: 0, y1: mid, x2: W, y2: mid }));
  fig.appendChild(svg("line", { class: "ax-soft", x1: 0, y1: 22, x2: W, y2: 22 }));
  fig.appendChild(svg("line", { class: "ax-soft", x1: 0, y1: H - 30, x2: W, y2: H - 30 }));
  for (let i = 1; i < 8; i++)
    fig.appendChild(svg("line", { class: "ax-soft dash", x1: (W * i) / 8, y1: 22, x2: (W * i) / 8, y2: H - 30 }));
  // Rising zero-cross trigger in the captured time-domain buffer.
  let t0 = 0;
  for (let k = 1; k < timeData.length - 1; k++) {
    if (timeData[k - 1] < 0 && timeData[k] >= 0) { t0 = k; break; }
  }
  const want = Math.round(audioCtx.sampleRate * s.scopeWindow / 1000);
  const span = Math.max(2, Math.min(want, timeData.length - t0 - 1));
  const N = 420;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const idx = t0 + Math.floor((i / N) * span);
    const v = timeData[idx] || 0;
    pts.push(`${((i / N) * W).toFixed(1)},${(mid - v * (mid - 34)).toFixed(1)}`);
  }
  fig.appendChild(svg("polyline", { class: "ink-line", points: pts.join(" "), "stroke-width": 1.4 }));
  if (s.frozen) {
    const lbl = svg("text", { class: "tag", x: 0, y: 14 });
    lbl.textContent = "HOLD";
    fig.appendChild(lbl);
  }
}

const FIG_CAP = {
  spectrum: "log-frequency magnitude.",
  scope:    "zero-cross triggered.",
};

/* ── Header controls ────────────────────────────────────────────────── */
function bindFigureControls() {
  $("#fig-tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".fig-tab");
    if (btn) store.set({ figTab: btn.dataset.fig });
  });
  $("#hold-btn").addEventListener("click", () => store.set((s) => ({ frozen: !s.frozen })));
  bindCtl("ctl-integ", "specInteg", 0, 2000, 4);
  bindCtl("ctl-smooth", "specSmooth", 0, 100, 0.5);
  bindCtl("ctl-floor", "specFloor", -120, -48, 0.5);
  bindCtl("ctl-window", "scopeWindow", 1, 40, 0.1);
}
function bindCtl(elId, key, lo, hi, step) {
  document.getElementById(elId).addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const y0 = e.clientY, v0 = store.get()[key];
    const move = (ev) => store.set({ [key]: Math.min(hi, Math.max(lo, v0 + (y0 - ev.clientY) * step)) });
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/* ───────────────────────────────────────────────────────────────────
   syncUI — the single store subscriber: discrete state → DOM. Per-frame
   animation (meters, figures) is the rAF loop below.
   ─────────────────────────────────────────────────────────────────── */
function syncUI(s) {
  // file tabs + editor
  document.querySelectorAll(".file-tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.file === s.activeFile));
  if (s.activeFile && s.activeFile !== mountedFile && editor) loadIntoEditor(s.activeFile);

  // figure header
  document.querySelectorAll(".fig-tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.fig === s.figTab));
  document.querySelectorAll(".fig-panel").forEach((p) =>
    p.classList.toggle("active", p.dataset.fig === s.figTab));
  $("#spec-ctls").classList.toggle("hidden", s.figTab !== "spectrum");
  $("#scope-ctls").classList.toggle("hidden", s.figTab !== "scope");
  $("#hold-btn").classList.toggle("on", s.frozen);
  $("#ctl-integ").querySelector(".cv").innerHTML = `${Math.round(s.specInteg)}<i>ms</i>`;
  $("#ctl-smooth").querySelector(".cv").innerHTML = `${Math.round(s.specSmooth)}<i>%</i>`;
  $("#ctl-floor").querySelector(".cv").innerHTML = `−${Math.abs(Math.round(s.specFloor))}<i>dB</i>`;
  $("#ctl-window").querySelector(".cv").innerHTML = `${s.scopeWindow.toFixed(1)}<i>ms</i>`;
  $("#cap-text").textContent = FIG_CAP[s.figTab];

  // transport / engine state
  const running = s.engineState === "running";
  // The Eng status dot is driven straight from the store, so pause /
  // resume / error / learn-open all stay honest — store.set is the single
  // source of truth (no scattered setEngineState() calls to forget).
  setEngineState(s.engineState, running ? "running" : s.engineState === "error" ? "err" : "idle");
  $("#play").classList.toggle("on", running);
  // The play button is icon-only; rewrite just the glyph (play ⇄ pause).
  const glyph = $("#play-glyph");
  if (glyph) glyph.innerHTML = running
    ? `<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="3" height="10" fill="currentColor"/><rect x="8" y="2" width="3" height="10" fill="currentColor"/></svg>`
    : `<svg width="15" height="15" viewBox="0 0 14 14" fill="none"><polygon points="3,2 12,7 3,12" fill="currentColor"/></svg>`;
  // Record → bounce: the dot breathes while an offline WAV render runs.
  $("#rec")?.classList.toggle("on", s.bouncing);
  $("#rec")?.setAttribute("title", s.bouncing
    ? "Bouncing to WAV…"
    : "Bounce a WAV — pick a length");
  // Once the engine has started for the first time, the splash hint and
  // the pulsing call-to-action are no longer needed; keep them off for
  // the rest of the session even if the user hits stop.
  if (running || s.engineState === "paused") {
    $("#play").classList.remove("idle");
  }

  // mixer — knob + mute/solo per strip
  Object.values(channels).forEach((rec) => {
    const v = s.voices[rec.name];
    if (!v) return;
    rec.muteBtn.classList.toggle("on", v.mute);
    rec.soloBtn.classList.toggle("on", v.solo);
    rec.el.classList.toggle("muted", v.mute);
    renderHandle(rec);
  });

  // mobile single-pane view — CSS keys off body[data-mview]; the bottom nav
  // highlights the live segment. (No-op on desktop, where the layout ignores it.)
  document.body.dataset.mview = s.mview;
  document.querySelectorAll(".mnav-btn").forEach((b) =>
    b.classList.toggle("on", b.dataset.mview === s.mview));
}
store.subscribe(syncUI);

/* ───────────────────────────────────────────────────────────────────
   Animation loop — per-frame render scratch only: VU meters, knob
   live-rings, and the active figure.
   ─────────────────────────────────────────────────────────────────── */
// VU-ish ballistics for the RMS bar: asymmetric one-pole, a touch quicker
// than classical 300/300 so percussion doesn't read sluggish. The peak
// ballistic feeds the dBFS readout text only (the position dot below
// keeps its own hold+decay); fast attack, classic PPM-style 1.5 s release.
const VU_TAU_ATTACK_MS = 50;
const VU_TAU_RELEASE_MS = 200;
const PEAK_TAU_RELEASE_MS = 100;

function meterStrip(rec, rms, peak) {
  const now = performance.now();
  // First frame: lastFrame=0 → large dt → α≈1 → snap to target (correct).
  const dt = rec.lastFrame ? now - rec.lastFrame : 16;
  rec.lastFrame = now;

  const tauRms = rms > rec.rmsBallistic ? VU_TAU_ATTACK_MS : VU_TAU_RELEASE_MS;
  rec.rmsBallistic += (1 - Math.exp(-dt / tauRms)) * (rms - rec.rmsBallistic);
  if (peak > rec.peakBallistic) rec.peakBallistic = peak;
  else rec.peakBallistic += (1 - Math.exp(-dt / PEAK_TAU_RELEASE_MS)) * (peak - rec.peakBallistic);

  const rmsPct = Math.min(100, rec.rmsBallistic * 140);
  const peakPct = Math.min(100, peak * 140);
  rec.rms.style.width = rmsPct + "%";
  if (peakPct > rec.peakHold) { rec.peakHold = peakPct; rec.peakHoldT = now; }
  else if (now - rec.peakHoldT > 800) rec.peakHold = Math.max(peakPct, rec.peakHold - 0.6);
  rec.peak.style.left = Math.min(99, rec.peakHold) + "%";
  if (rec.slider) rec.slider.classList.toggle("clip", peak >= 0.99);
  return rmsPct;
}
function dbfs(lin) {
  if (lin <= 0.0001) return "−∞";
  const db = 20 * Math.log10(lin);
  return (db >= 0 ? "+" : "−") + Math.abs(db).toFixed(1);
}

// ── Pattern-step highlight: engine-span → editor-position mapping ─────
//
// The worklet's active-span tap gives UTF-8 *byte* offsets into the source
// the engine *compiled*. Two coordinate gaps separate that from a
// CodeMirror document position:
//   1. Encoding — CodeMirror indexes in UTF-16 code units. submerged.fugue's
//      comment rules (─) and em-dashes (—) drift bytes vs. units by ~900.
//   2. Staleness — the offsets are against the compiled source, but the
//      live buffer runs ahead of it: a @param-knob drag rewrites a numeric
//      literal (shifting every later offset) without re-evaluating.
// `engineByteToChar` closes gap 1; `editsSinceCompile` (a ChangeSet of every
// edit since the compile) closes gap 2. Neither depends on `fileDirty` — the
// mapping is exact whether or not the buffer has unsaved edits.
let engineSource = "";        // exact source string the engine last compiled
let engineByteToChar = null;  // Uint32Array: UTF-8 byte offset → UTF-16 index
let editsSinceCompile = null; // ChangeSet: engineSource → current editor doc
let pendingEngineSource = ""; // source sent to the worklet, promoted on ack

function buildByteToChar(str) {
  const bytes = new TextEncoder().encode(str);
  const map = new Uint32Array(bytes.length + 1);
  let ci = 0;
  for (let bi = 0; bi < bytes.length; ) {
    const b = bytes[bi];
    const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
    for (let k = 0; k < len && bi + k < bytes.length; k++) map[bi + k] = ci;
    ci += len === 4 ? 2 : 1; // astral chars are a UTF-16 surrogate pair
    bi += len;
  }
  map[bytes.length] = ci;
  return map;
}

// Adopt the source the worklet just acked as the highlight's coordinate
// frame: rebuild the byte→char map and reset edit tracking to empty (the
// buffer now matches the engine again).
function promoteEngineSource() {
  engineSource = pendingEngineSource;
  engineByteToChar = buildByteToChar(engineSource);
  editsSinceCompile = ChangeSet.empty(engineSource.length);
  // Any spans we still hold are against the *old* coordinate frame (the new
  // engine hasn't tapped through its commit yet), so a queued pre-swap `active`
  // would map wrong for one frame against the new map. Drop them; the new
  // engine's first tap repaints within ~16 ms.
  latestActive = null;
  lastHlKey = null; // force the next frame to re-dispatch the highlight
}

// Pattern-step highlight — driven by the worklet's active-span tap (a flat,
// packed, byte-span-deduped list of the sounding atoms). Re-decorates only on
// an actual change (a few times a second at most); `lastHlKey = null` forces a
// re-dispatch on the next frame.
let lastHlKey = null;
function updatePatternHighlight() {
  if (!editor) return;
  // "error" is a hot-swap compile failure: the *old* engine keeps playing, and
  // its spans still map onto the live buffer via `editsSinceCompile`, so keep
  // tracking it. (With no engine at all the `latestActive` guard below keeps it
  // dark.) Only a real stop — "paused" — blanks the highlight.
  const st = store.get().engineState;
  const running = st === "running" || st === "error";
  let ranges = [];
  if (running && latestActive && engineByteToChar && editsSinceCompile) {
    const map = engineByteToChar;
    const docLen = editor.state.doc.length;
    // `latestActive` is a flat, packed list of [start,end] byte pairs — one per
    // sounding atom across all voices (a chord-name lights once). No rest
    // sentinels; only real atoms are packed.
    for (let i = 0; i + 1 < latestActive.length; i += 2) {
      const fromB = latestActive[i], toB = latestActive[i + 1];
      // A span past the compiled source is a stale tap from mid hot-swap — skip.
      if (fromB >= toB || toB >= map.length) continue;
      // byte → UTF-16 offset in the compiled source → live-doc position,
      // mapped through every edit since that compile. `TrackDel` returns
      // -1 when the atom itself was edited away.
      const from = editsSinceCompile.mapPos(map[fromB], 1, MapMode.TrackDel);
      const to = editsSinceCompile.mapPos(map[toB], -1, MapMode.TrackDel);
      if (from < 0 || to < 0 || from >= to || to > docLen) continue;
      ranges.push([from, to]);
    }
    // Sort by (from, to) for CodeMirror's RangeSet. The engine already dedups
    // by byte-span, so no JS dedup pass is needed (and overlapping marks are
    // harmless if an in-flight edit ever maps two spans to one doc range).
    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }
  const key = ranges.map((r) => r[0] + ":" + r[1]).join("|");
  if (key === lastHlKey) return; // no boundary crossed — nothing to do
  lastHlKey = key;
  const deco = ranges.length
    ? Decoration.set(ranges.map(([f, t]) => patternHlMark.range(f, t)))
    : Decoration.none;
  editor.dispatch({ effects: setPatternHl.of(deco) });
}

// Paint the DSP-load status chunk from latestCpu (a 0..1 budget fraction).
// Coalesced — only touches the DOM when the rounded reading or warn state
// changes, so the rAF loop never reflows the status bar for a number that
// only moves a few times a second. `—` until the first worklet report.
let loadLastText = null, loadLastWarn = false;
function renderLoad() {
  const el = $("#load-status");
  if (!el) return;
  let text, warn = false;
  if (latestCpu == null) {
    text = "—";
  } else {
    text = `${Math.min(999, Math.round(latestCpu * 100))}%`;
    warn = latestCpu >= 0.8; // ≥80% of budget → over-subscription risk
  }
  if (text !== loadLastText) { el.textContent = text; loadLastText = text; }
  if (warn !== loadLastWarn) { el.classList.toggle("warn", warn); loadLastWarn = warn; }
}

// On mobile in the Code view the mixer + figure are offscreen — their
// per-frame redraw is wasted work, so skip it (audio is untouched). The
// editor's pattern highlight and the status load readout stay live.
const mqMobile = matchMedia("(max-width: 900px)");

function frame() {
  const s = store.get();
  const order = s.voiceOrder;
  const panelsVisible = !(mqMobile.matches && s.mview === "code");

  // Per-voice strips, fed by the worklet's {levels} push. Layout:
  // [peak0,rms0, peak1,rms1, …, peakMaster,rmsMaster].
  if (panelsVisible && latestLevels && order.length) {
    order.forEach((name, i) => {
      const rec = channels[name];
      if (!rec) return;
      const peak = latestLevels[2 * i] || 0;
      const rms = latestLevels[2 * i + 1] || 0;
      meterStrip(rec, rms, peak);
      rec.readout.innerHTML = `<span class="neg">${dbfs(rec.rmsBallistic)}</span>`;
    });
    const mrec = channels.master;
    if (mrec) {
      const mPeak = latestLevels[2 * order.length] || 0;
      const mRms = latestLevels[2 * order.length + 1] || 0;
      meterStrip(mrec, mRms, mPeak);
      mrec.readout.innerHTML = `<span class="neg">${dbfs(mrec.rmsBallistic)}</span>`;
    }
  }

  // Active figure — Hold gates the analysis (data capture), not the redraw.
  if (panelsVisible && analyser) {
    if (s.figTab === "spectrum") {
      if (!s.frozen) analyzeSpectrum(s);
      drawSpectrum(s);
    } else if (s.figTab === "scope") {
      if (!s.frozen) analyser.getFloatTimeDomainData(timeData);
      drawScope(s);
    }
  }

  // Pattern-step highlight — cheap (a key-string compare); only dispatches
  // a CodeMirror transaction on an actual step-boundary crossing.
  updatePatternHighlight();

  renderLoad();

  requestAnimationFrame(frame);
}

/* ───────────────────────────────────────────────────────────────────
   Chrome controls — theme, accent, zen. Stateless from the store's POV:
   they toggle classes / inline CSS vars on <body>; the panes restyle
   themselves from the new var values on the next paint.
   ─────────────────────────────────────────────────────────────────── */
// Shared accent + theme state. The accent dot's `--signal-soft` shade
// has to track the theme — a light tint (toward white) reads on cream
// paper, a dark tint (toward black) reads on the dark theme's recess.
// One source of truth, re-applied whenever either input changes.
let currentAccent = "#ff551d";
let currentTheme = "light";
function applyAccentVars() {
  document.body.style.setProperty("--signal", currentAccent);
  document.body.style.setProperty("--signal-deep", shadeHex(currentAccent, -0.22));
  // Dark theme wants a *dark* tint of the accent for highlight backings;
  // light theme wants a *light* tint. Same code path either way.
  const softAmt = currentTheme === "dark" ? -0.72 : 0.6;
  document.body.style.setProperty("--signal-soft", shadeHex(currentAccent, softAmt));
  // Text-selection wash — a translucent accent that rides in front of the text
  // (see the `.cm-selectionLayer` rule). Translucent, so one alpha reads on
  // both grounds; tracks the accent picker like every other signal var.
  document.body.style.setProperty("--signal-sel", rgbaHex(currentAccent, 0.3));
}

function bindThemeToggle() {
  const light = $("#theme-light"), dark = $("#theme-dark");
  // The mobile sheet carries a mirror of the theme switch (data-theme buttons).
  const sheetBtns = document.querySelectorAll("#sheet-theme button[data-theme]");
  const apply = (mode) => {
    currentTheme = mode;
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add("theme-" + mode);
    light.classList.toggle("on", mode === "light");
    dark.classList.toggle("on", mode === "dark");
    sheetBtns.forEach((b) => b.classList.toggle("on", b.dataset.theme === mode));
    applyAccentVars();
  };
  light.addEventListener("click", () => apply("light"));
  dark.addEventListener("click", () => apply("dark"));
  sheetBtns.forEach((b) => b.addEventListener("click", () => apply(b.dataset.theme)));
}

// hex + amt (-1..1) → tinted hex. Same shape as the design's `shade`.
function shadeHex(hex, amt) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  if (amt >= 0) {
    r = Math.round(r + (255 - r) * amt);
    g = Math.round(g + (255 - g) * amt);
    b = Math.round(b + (255 - b) * amt);
  } else {
    const a = 1 + amt;
    r = Math.round(r * a); g = Math.round(g * a); b = Math.round(b * a);
  }
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

// hex + alpha (0..1) → `rgba(r, g, b, a)`. Sibling of shadeHex for the
// translucent accent washes (text selection) that can't be a flat hex.
function rgbaHex(hex, alpha) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function bindAccentPicker() {
  const dots = document.querySelectorAll(".accent-dot");
  const apply = (color) => {
    currentAccent = color;
    applyAccentVars();
    dots.forEach((d) => d.classList.toggle("on", d.dataset.color === color));
  };
  dots.forEach((d) => d.addEventListener("click", () => apply(d.dataset.color)));
}

/* ───────────────────────────────────────────────────────────────────
   Mobile chrome — the bottom nav, the overflow sheet, and the mobile
   hot-swap button. All no-ops on desktop (those elements are display:none),
   so this wires unconditionally at boot.
   ─────────────────────────────────────────────────────────────────── */
function bindMobileChrome() {
  // Bottom nav → switch the single visible pane.
  document.querySelectorAll(".mnav-btn").forEach((b) =>
    b.addEventListener("click", () => store.set({ mview: b.dataset.mview })));

  // Overflow sheet — open from the hamburger, dismiss via the scrim.
  const sheet = $("#sheet"), scrim = $("#sheet-scrim");
  const openSheet = () => { sheet?.classList.add("open"); scrim?.classList.add("open"); };
  const closeSheet = () => { sheet?.classList.remove("open"); scrim?.classList.remove("open"); };
  $("#menu-btn")?.addEventListener("click", openSheet);
  scrim?.addEventListener("click", closeSheet);

  // Sheet workspace actions reuse the existing chrome handlers, then close.
  document.querySelectorAll(".sheet-act").forEach((b) =>
    b.addEventListener("click", () => {
      const act = b.dataset.act;
      if (act === "learn") $("#learn-btn")?.click();
      else if (act === "ref") $("#cheat-btn")?.click();
      else if (act === "share") shareCurrentPatch();
      closeSheet();
    }));

  // Mobile hot-swap — the touch equivalent of ⌘↵ (evaluate flashes the doc).
  $("#hotswap-m")?.addEventListener("click", () => evaluate());
}

function bindZen() {
  const btn = $("#zen-btn");
  const setZen = (on) => {
    document.body.classList.toggle("zen", on);
    btn.title = on ? "Exit zen (Esc)" : "Zen mode (Esc to exit)";
    // The "Ref" button is hidden in zen, so close the drawer too — it must not
    // be stranded open behind hidden chrome.
    if (on) { const d = $("#cheat-drawer"); if (d) d.hidden = true; }
  };
  btn.addEventListener("click", () => setZen(!document.body.classList.contains("zen")));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("zen")) {
      setZen(false);
    }
  });
}

/* ───────────────────────────────────────────────────────────────────
   Learn modal — the 8-lesson primer, surfaced as an overlay <iframe> of
   learn/index.html?modal=1 over the live playground. The lesson page runs
   its own isolated engine, so opening Learn suspends the playground audio
   (and resumes it on close) to keep the two from overlapping. The iframe
   posts {type:"fugue-learn-close"} when the user closes from inside; we
   post {type:"fugue-learn-stop"} back so it suspends when closed from here.
   ─────────────────────────────────────────────────────────────────── */
function bindLearn() {
  const btn = $("#learn-btn");
  const overlay = $("#learn-overlay");
  const frame = $("#learn-frame");
  if (!btn || !overlay || !frame) return;
  let wasRunning = false;

  const open = () => {
    if (!overlay.hidden) return;
    // Hand the modal the current theme/accent so its paper skin matches the
    // session. First open: as query params, so it paints right on frame one.
    // Reopen (the iframe is lazy-loaded once and persists): postMessage, since
    // the theme may have changed while it was closed.
    if (!frame.getAttribute("src")) {
      frame.src = `learn/index.html?modal=1&theme=${currentTheme}&accent=${encodeURIComponent(currentAccent)}`;
    } else {
      try { frame.contentWindow.postMessage({ type: "fugue-theme", theme: currentTheme, accent: currentAccent }, "*"); } catch {}
    }
    wasRunning = !!(audioCtx && audioCtx.state === "running");
    if (wasRunning) { audioCtx.suspend(); store.set({ engineState: "paused" }); }
    overlay.hidden = false;
    requestAnimationFrame(() => { try { frame.contentWindow.focus(); } catch {} });
  };
  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    try { frame.contentWindow.postMessage({ type: "fugue-learn-stop" }, "*"); } catch {}
    if (wasRunning && audioCtx) { audioCtx.resume(); store.set({ engineState: "running" }); }
    wasRunning = false;
    btn.focus();
  };

  btn.addEventListener("click", open);
  // Click the scrim (outside the centered frame) to dismiss.
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "fugue-learn-close") close();
  });
}

/* ───────────────────────────────────────────────────────────────────
   Bounce to WAV — an offline, deterministic render of the *currently
   playing* patch to a downloadable 16-bit WAV. Reuses the main-thread
   wasm `Engine` (already inited for the version pill): a fresh engine
   renders from t=0 — a clean downbeat, a seamless loop — faster than
   realtime, so the live worklet keeps playing untouched. Knob values
   already ride in the source text (the inline @param knobs rewrite the
   literal on drag); only mixer state (gain/mute/solo + master) lives
   outside it, so we replay that onto the fresh engine.

   This is an export bounce, not a live take — it captures current knob
   *values*, not their movement. Live performance-capture is deferred; it
   would share encodeWav16 + downloadWav below.
   ─────────────────────────────────────────────────────────────────── */

// Replay the mixer (per-voice gain/mute/solo) onto a fresh offline engine
// — mirrors replayMixer()'s worklet path, but drives the Engine directly.
function replayMixerTo(eng) {
  const s = store.get();
  s.voiceOrder.forEach((name, idx) => {
    const v = s.voices[name];
    if (!v) return;
    if (v.gain !== 1) eng.set_voice_gain(idx, v.gain);
    if (v.mute) eng.set_voice_mute(idx, true);
    if (v.solo) eng.set_voice_solo(idx, true);
  });
}

// Interleave two channels into a 16-bit PCM stereo WAV Blob. Samples are
// clipped to [-1, 1] before quantising (the DAC clips anyway); no dither.
function encodeWav16(left, right, sampleRate) {
  const frames = left.length;
  const dataBytes = frames * 2 * 2; // 2 channels · 16-bit
  const buf = new ArrayBuffer(44 + dataBytes);
  const dv = new DataView(buf);
  const tag = (off, str) => { for (let i = 0; i < str.length; i++) dv.setUint8(off + i, str.charCodeAt(i)); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + dataBytes, true); tag(8, "WAVE");
  tag(12, "fmt "); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);          // PCM, stereo
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 4, true);                        // byte rate (2ch · 2B)
  dv.setUint16(32, 4, true); dv.setUint16(34, 16, true);         // block align, bit depth
  tag(36, "data"); dv.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of [left, right]) {
      const x = Math.max(-1, Math.min(1, ch[i]));
      dv.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Object-URL download of a Blob under `name`.
function downloadWav(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Render `seconds` of the currently-playing patch to a WAV and download.
// Off the audio path: a fresh Engine renders deterministically from t=0,
// chunked with yields so a long bounce neither janks the UI nor freezes
// the "rendering" breath.
async function bounceToWav(bars) {
  if (store.get().bouncing) return;          // ignore re-entry mid-render
  const src = engineSource || fileContents[store.get().activeFile];
  if (!src) { logEvent("nothing to bounce"); return; }
  const sr = audioCtx?.sampleRate ?? 48000;
  store.set({ bouncing: true });
  logEvent(`bouncing ${bars} bar${bars === 1 ? "" : "s"}…`);
  let eng = null;
  try {
    await ensureWasmInit();
    eng = new Engine(src, sr);
    replayMixerTo(eng);
    const arity = Math.max(eng.output_arity(), 1);
    // Bars → frames via the engine's own cycle rate (1 cycle = 1 bar), so the
    // export is a whole number of cycles and loops seamlessly whatever the
    // patch's `tempo`. Fall back to a 120-bpm cycle if the rate is degenerate.
    const spc = eng.samples_per_cycle();
    const framesPerBar = Number.isFinite(spc) && spc > 0 ? spc : sr * 2;
    const total = Math.round(bars * framesPerBar);
    const interleaved = new Float32Array(total * arity);
    // Render in 128-frame blocks — the SAME render quantum the live worklet
    // uses. The arrangement samples each pattern/control value once per
    // step_block call and holds it across the block (arrangement.rs §"once per
    // block"), so the block size IS the timing grid: a bigger block snaps note
    // and lead onsets to a coarser grid. 128 makes the bounce match what was
    // heard. Yield to the event loop only every ~0.25 s of audio so a long
    // render stays responsive without thousands of setTimeouts.
    const BLOCK = 128;
    const yieldEvery = Math.max(1, Math.round((sr * 0.25) / BLOCK));
    let sinceYield = 0;
    for (let f = 0; f < total; f += BLOCK) {
      const n = Math.min(BLOCK, total - f);
      eng.step_block(interleaved.subarray(f * arity, (f + n) * arity));
      if (++sinceYield >= yieldEvery) { sinceYield = 0; await new Promise((r) => setTimeout(r, 0)); }
    }
    // De-interleave to L/R using the worklet's fold rule (host channel c
    // reads engine output c, or output 0 when the patch is narrower), and
    // fold in master gain/mute as a scalar (master is a JS node, not a voice).
    const m = store.get().voices.master;
    const masterScalar = m ? (m.mute ? 0 : m.gain) : 1;
    const rCh = arity > 1 ? 1 : 0;
    const left = new Float32Array(total);
    const right = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      left[i] = interleaved[i * arity] * masterScalar;
      right[i] = interleaved[i * arity + rCh] * masterScalar;
    }
    const base = (store.get().activeFile || "patch").replace(/\.fugue$/, "");
    const ts = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
    downloadWav(encodeWav16(left, right, sr), `fugue-${base}-${bars}bar-${ts}.wav`);
    const kHz = (sr / 1000).toFixed(sr % 1000 ? 1 : 0);
    logEvent(`bounced ${bars} bar${bars === 1 ? "" : "s"} · ${(total / sr).toFixed(1)}s · ${kHz} kHz`);
  } catch (err) {
    showBootError(unwrapErr(err), "bounce failed");
    logEvent("bounce failed");
    console.error("bounceToWav failed:", err);
  } finally {
    eng?.free();
    store.set({ bouncing: false });
  }
}

/* Record button → bounce. Clicking opens a small length menu (1–32 bars);
   picking a length renders the patch to a WAV and downloads it. Bars, not
   seconds — the export is a whole number of cycles, so it loops seamlessly.
   The red dot breathes while the (faster-than-realtime) render runs. Last
   length sticks in localStorage. No playback needed — it renders the playing
   source from t=0 and never touches the live engine. */
const REC_LENGTHS = [1, 2, 4, 8, 16, 32];
function bindRecord() {
  const rec = $("#rec");
  const menu = $("#rec-menu");
  if (!rec || !menu) return;

  let pick = parseInt(localStorage.getItem("fugue:bounceBars") || "4", 10);
  if (!REC_LENGTHS.includes(pick)) pick = 4;
  const mark = () => menu.querySelectorAll("button").forEach((b) =>
    b.classList.toggle("on", +b.dataset.bars === pick));
  mark();

  const onDoc = (e) => { if (!menu.contains(e.target) && !rec.contains(e.target)) closeMenu(); };
  const closeMenu = () => { menu.hidden = true; document.removeEventListener("click", onDoc, true); };
  const openMenu = () => {
    if (!menu.hidden) return;
    menu.hidden = false;
    document.addEventListener("click", onDoc, true);
  };

  rec.addEventListener("click", () => { menu.hidden ? openMenu() : closeMenu(); });
  menu.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-bars]");
    if (!b) return;
    pick = +b.dataset.bars;
    localStorage.setItem("fugue:bounceBars", String(pick));
    mark();
    closeMenu();
    bounceToWav(pick);
  });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) closeMenu(); });
}

/* ───────────────────────────────────────────────────────────────────
   About — a small modal opened by either "about" door (the
   wordmark or the version pill). On the first session the "about" cue
   reveals itself once (then it's hover-only), gated by localStorage.
   ─────────────────────────────────────────────────────────────────── */
function bindAbout() {
  const overlay = $("#about-overlay");
  if (!overlay) return;
  const pill = $("#version-pill");
  const word = $("#wordmark");
  const cue = $("#about-cue");

  const open = () => {
    if (!overlay.hidden) return;
    const v = $("#about-version");
    if (v) v.textContent = $("#version-text")?.textContent || "";
    overlay.hidden = false;
    $("#about-close")?.focus();
  };
  const close = () => {
    if (overlay.hidden) return;
    overlay.hidden = true;
    (pill || word)?.focus();
  };

  pill?.addEventListener("click", open);
  word?.addEventListener("click", open);
  $("#about-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) close(); });

  // Placeholder links route into the existing in-app surfaces.
  $("#about-learn")?.addEventListener("click", () => { close(); $("#learn-btn")?.click(); });
  $("#about-ref")?.addEventListener("click", () => { close(); $("#cheat-btn")?.click(); });

  // First-run cue — teach the about door once, then retire to hover-only.
  if (cue) {
    let taught = false;
    try { taught = localStorage.getItem("fugue.aboutTaught") === "1"; } catch {}
    if (!taught) {
      setTimeout(() => {
        cue.classList.add("reveal");
        setTimeout(() => cue.classList.remove("reveal"), 3200);
      }, 900);
      try { localStorage.setItem("fugue.aboutTaught", "1"); } catch {}
    }
  }
}

/* ───────────────────────────────────────────────────────────────────
   Cheatsheet drawer — a non-modal reference that overlays the panels
   column. The editor stays live while it's open, so there's no
   click-outside / Esc dismissal: the "Ref" button toggles it, the ✕
   closes it. Content is fetched once from ./cheatsheet.html (the source
   of truth) and cached. Click any `.cs-copy` token to copy it; "Copy all"
   serialises the whole sheet to Markdown for pasting into an LLM.
   ─────────────────────────────────────────────────────────────────── */

// Framing prepended to the "Copy all" Markdown so a pasted-in LLM knows
// what it's reading and which rules dominate.
// The imperative half of the LLM payload. The body that follows (the cheatsheet
// serialised to Markdown by cheatToMarkdown) carries the generated fact tables +
// gotchas; this preamble carries the generation rules. Together they ARE the LLM
// payload — there is no separate file (the former docs/CHEATSHEET.llm.md retired
// into this preamble 2026-06-27).
const CHEAT_LLM_PREAMBLE = [
  "# Fugue — patch generation rules (v0.7). Reference of what actually compiles.",
  "",
  "Generate ONE `.fugue` source and nothing else — no prose, no code fences. A patch is " +
    "`process` blocks (signal graphs) followed by a score (`pattern -> target` routing lines). " +
    "Obey the rules here; the tables below are exhaustive — do NOT invent stages, chord " +
    "qualities, scales, mini-notation tokens, or transforms that are not listed. Anything not " +
    "listed does not compile.",
  "",
  "Output contract:",
  "- Every `process` body must assign `out = …` (no `out` ⇒ silent; `out = (l, r)` ⇒ stereo).",
  "- Pitched voice: `process name(note, trig) { … }`. Drum: `process name(trig) { … }`. The trigger port MUST be named `trig`.",
  "- Polyphony is explicit: `process pad(note, trig) voices 6 { … }` (default 1).",
  "- `|>` pipes the left signal into the FIRST argument of the next stage.",
  "",
  "Never (these do not compile):",
  "- NEVER use a pipeline as a `*`/`+` operand without parens — write `(saw(note) |> lpf(c,q)) * env`, not `saw(note) |> lpf(c,q) * env` (`|>` binds loosest).",
  "- NEVER pass a bare number where a stage arg shows `:Hz`/`:s`/`:dB` — use a unit literal (`8kHz`, `220ms`, `-12dB`).",
  "- NEVER use a unit suffix INSIDE a quote — atoms are bare numbers (`\"<200 600>\"`, not `\"<200Hz 600Hz>\"`).",
  "- NEVER drive pitch and gate from one port — split into `(note, trig)`.",
  "- NEVER use `@ ! / { } , ( ) | 0..7` inside a quote (only the mini-notation tokens below parse).",
  "- A chord-name quote needs `|> voicing` (plus a `voices N` pool) to make sound.",
  "- `note` in a body is a frequency in Hz (`note*2` = octave up), not a MIDI/degree number.",
  "- `lfo(hz)` is bipolar ±1 — drive a param as `center + lfo(hz)*depth`.",
  "",
  "The full reference (generated from the compiler) follows; its \"Gotchas\" table lists more natural-guess → real-form fixes.",
].join("\n");

// Serialise the rendered cheatsheet (#cheat-body) to clean Markdown. We own the
// fragment's structure, so this stays small: sections → ## headings, <pre> →
// fenced code, <th>-led rows → "- **group**: `tok` `tok`", 2-col rows → bullets,
// .cs-note paragraphs → prose. <code> → backticks, <b> → bold.
function cheatToMarkdown(root) {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const inline = (el) => {
    let s = "";
    el.childNodes.forEach((n) => {
      if (n.nodeType === 3) s += n.textContent;
      else if (n.tagName === "CODE") s += "`" + norm(n.textContent) + "`";
      else if (n.tagName === "B" || n.tagName === "STRONG") s += "**" + norm(inline(n)) + "**";
      else s += inline(n);
    });
    return norm(s);
  };
  const chips = (el) =>
    [...el.querySelectorAll("code")].map((c) => "`" + norm(c.textContent) + "`").join(" ");

  const lines = [];
  root.querySelectorAll(".cs-sec").forEach((sec) => {
    const h3 = sec.querySelector("h3");
    if (h3) {
      const sub = h3.querySelector(".cs-sub");
      const title = norm([...h3.childNodes].filter((n) => n !== sub).map((n) => n.textContent).join(""));
      const warn = h3.classList.contains("cs-warn") ? "⚠ " : "";
      lines.push("", `## ${warn}${title}${sub ? ` — ${norm(sub.textContent)}` : ""}`);
    }
    [...sec.children].forEach((child) => {
      if (child === h3) return;
      if (child.tagName === "PRE") {
        lines.push("", "```fugue", child.textContent.replace(/\s+$/, ""), "```");
      } else if (child.tagName === "TABLE") {
        lines.push("");
        const sep = child.classList.contains("cs-gotchas") ? " → " : " — ";
        [...child.rows].forEach((row) => {
          const cells = [...row.cells];
          if (cells[0].tagName === "TH") lines.push(`- **${inline(cells[0])}**: ${chips(cells[1])}`);
          else lines.push(`- ${inline(cells[0])}${sep}${inline(cells[1])}`);
        });
      } else if (child.tagName === "UL") {
        lines.push("");
        [...child.children].forEach((li) => lines.push(`- ${inline(li)}`));
      } else if (child.classList.contains("cs-note")) {
        lines.push("", inline(child));
      }
    });
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function bindCheatsheet() {
  const drawer = $("#cheat-drawer");
  const body = $("#cheat-body");
  if (!drawer || !body) return;
  let loaded = false, loadingP = null;
  // Fetch-once, shared promise so "Copy all" can await the same load as "open".
  const ensureLoaded = () => {
    if (loaded) return Promise.resolve();
    if (loadingP) return loadingP;
    loadingP = (async () => {
      try {
        const res = await fetch("./cheatsheet.html");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        body.innerHTML = await res.text();
        loaded = true;
      } catch (err) {
        body.innerHTML = '<div class="cheat-loading">couldn’t load the cheatsheet.</div>';
        loadingP = null; // let the next attempt retry
        throw err;
      }
    })();
    return loadingP;
  };
  const open = () => { drawer.hidden = false; ensureLoaded().catch(() => {}); };
  const close = () => { drawer.hidden = true; };
  $("#cheat-btn")?.addEventListener("click", () => (drawer.hidden ? open() : close()));
  $("#cheat-close")?.addEventListener("click", close);

  // "Copy all" → whole sheet as LLM-friendly Markdown.
  let copyResetT = null;
  $("#cheat-copyall")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    let ok = false;
    try {
      await ensureLoaded();
      await navigator.clipboard.writeText(CHEAT_LLM_PREAMBLE + "\n\n" + cheatToMarkdown(body));
      ok = true;
    } catch { /* load or clipboard failed */ }
    // CSS swaps the copy icon for a check on .copied; .failed tints it.
    btn.classList.toggle("copied", ok);
    btn.classList.toggle("failed", !ok);
    btn.title = ok ? "Copied to clipboard" : "Copy the whole cheatsheet as Markdown — paste into Claude";
    clearTimeout(copyResetT);
    copyResetT = setTimeout(() => {
      btn.classList.remove("copied", "failed");
      btn.title = "Copy the whole cheatsheet as Markdown — paste into Claude";
    }, 1500);
  });

  // Click a single snippet → clipboard, with a brief highlight (echoes the Share flash).
  let flashEl = null, flashT = null;
  body.addEventListener("click", async (e) => {
    const code = e.target.closest(".cs-copy");
    if (!code) return;
    try { await navigator.clipboard.writeText(code.textContent.trim()); } catch { /* insecure ctx */ }
    if (flashEl) flashEl.classList.remove("copied");
    clearTimeout(flashT);
    flashEl = code;
    code.classList.add("copied");
    flashT = setTimeout(() => { code.classList.remove("copied"); }, 900);
  });
}

/* ───────────────────────────────────────────────────────────────────
   Share links — encode the live patch into the URL hash so any patch is
   a copy-pasteable permalink. Determinism makes the link exact: the same
   source rebuilds the same engine, so the URL *is* the patch.

   Hash format: `#<scheme><payload>`. Scheme `0` = base64url(UTF-8), no
   padding. The leading scheme char reserves room for a future compressed
   scheme (e.g. `1` = deflate) without breaking links already in the wild.
   ─────────────────────────────────────────────────────────────────── */
const SHARE_NAME = "shared.fugue"; // tab label for a URL-loaded patch

// UTF-8 string ⇄ base64url (no padding). btoa is Latin-1-only, so route
// through the byte array — fugue sources carry Unicode (─, —, café, …).
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(token) {
  const b64 = token.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

const encodeShareToken = (src) => "0" + b64urlEncode(src);
function decodeShareToken(token) {
  if (!token || token[0] !== "0") return null; // unknown / absent scheme
  try { return b64urlDecode(token.slice(1)); } catch { return null; }
}

// Decode the shared patch from location.hash, or null if absent/garbage
// (a plain `#anchor` fragment decodes to null and is ignored at boot).
function sourceFromHash() {
  const h = (location.hash || "").replace(/^#/, "");
  return h ? decodeShareToken(h) : null;
}

// Share button — encode the live editor doc into the hash + clipboard.
// The button is icon-only now, so confirmation lives in the status log.
async function shareCurrentPatch() {
  if (!editor) return;
  const token = encodeShareToken(editor.state.doc.toString());
  // Update the address bar in place — no new history entry, no reload.
  // NB: `window.history` — the bare `history` is CodeMirror's undo-history
  // extension, imported at the top of this module (it shadows the global).
  try { window.history.replaceState(null, "", "#" + token); } catch {}
  // Native OS share sheet where it exists (mobile, some desktops). A user
  // dismissal (AbortError) is not a failure — just stop, the URL is updated.
  if (navigator.share) {
    try {
      await navigator.share({ title: "fugue.fm patch", url: location.href });
      logEvent("shared patch");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
      /* anything else (no share target, permission) → clipboard fallback */
    }
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(location.href);
    copied = true;
  } catch { /* insecure context or no permission — link is in the URL bar */ }
  logEvent(copied ? "share link copied to clipboard" : "share link in address bar");
}

/* ───────────────────────────────────────────────────────────────────
   Boot.
   ─────────────────────────────────────────────────────────────────── */
(async () => {
  mountEditor();
  bindFigureControls();
  bindThemeToggle();
  bindAccentPicker();
  bindZen();
  bindCheatsheet();
  bindLearn();
  bindAbout();
  bindRecord();
  bindMidi();
  bindMobileChrome();
  $("#play").classList.add("idle"); // pulse until first play
  $("#play").addEventListener("click", toggle);
  $("#stop").addEventListener("click", async () => {
    if (audioCtx && audioCtx.state === "running") {
      await audioCtx.suspend();
      store.set({ engineState: "paused" });
      logEvent("stopped");
    }
  });
  $("#share")?.addEventListener("click", shareCurrentPatch);
  // Compile-error pane: collapse from the pane, re-surface from the status bar.
  $("#boot-error-collapse")?.addEventListener("click", collapseBootError);
  $("#error-toggle")?.addEventListener("click", () => {
    const el = $("#boot-error");
    if (el) el.hidden = false;
    setErrorToggle(false);
  });
  // ⌘↵ also works when the editor isn't focused.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); evaluate(); }
  });

  paintVersionPill();

  fileContents = await loadPatches();
  fileDirty = {};
  // A shared link (#<token>) overrides the default patch: inject the
  // decoded source as a dedicated tab and open it first. The built-in
  // patches stay available as the remaining tabs.
  const shared = sourceFromHash();
  if (shared != null) {
    const rest = { ...fileContents };
    delete rest[SHARE_NAME];
    fileContents = { [SHARE_NAME]: shared, ...rest };
  }
  const names = Object.keys(fileContents);
  const first = shared != null ? SHARE_NAME : names[0];
  renderFileTabs();
  store.set({ activeFile: first }); // syncUI loads it into the editor
  logEvent(shared != null ? "loaded shared patch — press ▶" : "press ▶ to listen");
  requestAnimationFrame(frame);
})();
