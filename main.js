// fugue.fm — main-thread bootstrap.
//
// Wires the UI to the real AudioWorklet. Responsibilities:
//   - Fetch the patch set (patches/index.json) and drive the file tabs.
//   - Mount CodeMirror 6 (loaded at runtime from esm.sh) with an editorial
//     theme + a small fugue StreamLanguage; ⌘↵ evaluates (hot_swap).
//   - Boot the AudioWorklet, compile the wasm once, hot-swap on eval.
//   - Build the mixer from the worklet's voice list; VU meters are driven
//     by the {levels} postMessage, knobs/M/S by {set_voice} messages.
//   - Master-only spectrum + oscilloscope off an AnalyserNode; a third
//     figure tab shows the patch block diagram (blank for scene files).
//
// CodeMirror 6 has no in-tree bundler, so it loads from esm.sh with
// ?deps pinned so view/commands/language all share one @codemirror/state.

import { EditorState, StateField, StateEffect, Transaction, ChangeSet, MapMode } from "https://esm.sh/@codemirror/state@6.6.0";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine,
  highlightActiveLineGutter, drawSelection, Decoration, WidgetType,
} from "https://esm.sh/@codemirror/view@6?deps=@codemirror/state@6.6.0";
import {
  defaultKeymap, history, historyKeymap, indentWithTab,
} from "https://esm.sh/@codemirror/commands@6?deps=@codemirror/state@6.6.0";
import {
  StreamLanguage, syntaxHighlighting, HighlightStyle, bracketMatching,
} from "https://esm.sh/@codemirror/language@6?deps=@codemirror/state@6.6.0";
import { tags } from "https://esm.sh/@lezer/highlight@1";
import initWasm, { version as fugueVersion } from "./fugue_wasm.js";

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
  figTab: "spectrum",      // spectrum | scope | diagram
  frozen: false,
  specInteg: 200,          // ms — temporal averaging
  specSmooth: 20,          // %  — spectral smoothing
  specFloor: -96,          // dB — display floor
  scopeWindow: 14,         // ms — scope display window (post-trigger)
  voices: {},              // name -> { gain, mute, solo }; plus 'master'
  voiceOrder: [],          // index -> voice name (from the worklet ack)
  engineState: "idle",     // idle | loading | running | paused | error
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
  return { "fallback.fugue": "process = 0.1;\n" };
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
// Uint32Array from the worklet's {active} tap: one [start,end] pair per
// voice (flattened). (0,0) = rest/unbound. Drives the Strudel-style
// pattern-step highlight — cleared on hot-swap, set on every {levels} push.
let latestActive = null;

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
      await initWasm({ module: mod });
    })();
  }
  return wasmInitPromise;
}

async function paintVersionPill() {
  const el = $("#version-pill");
  if (!el) return;
  try {
    await ensureWasmInit();
    el.textContent = `v${fugueVersion()}`;
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
  setEngineState("loading", "idle");
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
  const source = fileContents[store.get().activeFile] || "process = 0.1;\n";
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

function showBootError(msg) {
  const el = $("#boot-error");
  if (!el) return;
  $("#boot-error-msg").textContent = msg;
  el.hidden = false;
}
function hideBootError() {
  const el = $("#boot-error");
  if (el) el.hidden = true;
}

async function toggle() {
  if (!audioCtx) {
    try {
      await start();
      hideBootError();
    } catch (err) {
      store.set({ engineState: "error" });
      const line = String(err).split("\n")[0];
      logEvent(`engine load failed: ${line}`);
      showBootError(line);
      // Full stack to DevTools — the banner only shows the first line.
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

function handleWorkletMessage(data) {
  if (data?.levels) {
    latestLevels = data.levels;
    if (data.active instanceof Uint32Array) latestActive = data.active;
    return;
  }
  if (data?.ok) {
    // The worklet compiled `pendingEngineSource` — adopt it as the
    // coordinate frame for the pattern-step highlight (rebuilds the
    // byte→char map, resets edit tracking, forces a re-dispatch).
    promoteEngineSource();
    if (Array.isArray(data.voices)) onVoiceList(data.voices);
    if (data.ok === "loaded" || data.ok === "loaded-on-edit") {
      store.set({ engineState: "running" });
      setEngineState("running", "running");
      replayMixer();
      logEvent(data.ok === "loaded-on-edit" ? "reloaded on edit" : "loaded");
    } else if (data.ok === "swapped") {
      setEngineState("running", "running");
      logEvent("hot-swapped");
    }
    return;
  }
  if (data?.error) {
    store.set({ engineState: "error" });
    setEngineState("error", "err");
    logEvent(`error: ${String(data.error).split("\n")[0]}`);
  }
}

// The worklet reports voice names on every (re)build. Reconcile the store
// by name so gain/mute/solo survive an edit, then rebuild the strips.
function onVoiceList(names) {
  const prev = store.get().voices;
  const voices = {};
  for (const n of names) voices[n] = prev[n] || { gain: 1, mute: false, solo: false };
  voices.master = prev.master || { gain: 1, mute: false, solo: false };
  store.set({ voiceOrder: names, voices });
  buildMixer(names);
  renderDiagram(); // refresh the scene-file voice count now that it's known
}

/* ───────────────────────────────────────────────────────────────────
   CodeMirror 6 — editorial theme + a small fugue StreamLanguage. The
   eval-flash is a line Decoration driven by a StateField (Strudel idiom).
   ─────────────────────────────────────────────────────────────────── */
const fugueLang = StreamLanguage.define({
  name: "fugue",
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) { stream.skipToEnd(); return "comment"; }
    if (stream.match(/^@\w+/)) return "meta";                       // @param, @transport
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) return "string";        // mini-notation
    if (stream.match(/^[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)) { // number + unit
      stream.match(/^(?:kHz|Hz|ms|us|s|dB|bpm|rad)\b/);
      return "number";
    }
    if (stream.match(/^(?:voice|scene|patch|let|in|process|fn)\b/)) return "keyword";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "variableName";
    if (stream.match(/^(?:\|>|[-+*/=<>().,;:{}])/)) return "operator";
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
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "var(--signal-soft)",
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

// Pattern-step highlight — a mark Decoration over the mini-notation step
// each voice is currently playing (Strudel's live-step idiom). The rAF
// loop recomputes the active ranges from the transport phase + the
// worklet's step spans and pushes a fresh set through `setPatternHl`
// whenever a step boundary is crossed.
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
const UNIT_SI = { Hz: 1, kHz: 1e3, ms: 1e-3, us: 1e-6, s: 1, dB: 1, rad: 1 };

// One @param line: prefix, name, ': ', kind, ' = ', number, optional unit.
const PARAM_RE =
  /^(\s*@param\s+)([A-Za-z_]\w*)(\s*:\s*)(Freq|Time|Real|Bool)(\s*=\s*)(-?[0-9.]+(?:[eE][+-]?[0-9]+)?)(kHz|Hz|ms|us|s|dB|rad)?/;

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
function parseParams(doc) {
  const out = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const m = PARAM_RE.exec(line.text);
    if (!m || m[4] === "Bool") continue;
    const [, g1, name, g3, kind, g5, numStr] = m;
    const unit = m[7] || "";
    const valFrom = line.from + g1.length + name.length + g3.length + kind.length + g5.length;
    const valTo = valFrom + numStr.length;
    const tokEnd = valTo + unit.length;
    const def = parseFloat(numStr);
    const siScale = UNIT_SI[unit] ?? 1;
    const valueSI = def * siScale;
    const tail = line.text.slice(tokEnd - line.from);
    // Capture optional unit suffixes from [lo, hi] bounds so that mixed-unit
    // ranges like [300Hz, 6kHz] are correctly normalised to SI. If a bound has
    // no suffix, fall back to the default value's unit scale (siScale).
    const rng = /\[\s*(-?[0-9.eE+-]+)(kHz|Hz|ms|us|s|dB|rad)?\s*,\s*(-?[0-9.eE+-]+)(kHz|Hz|ms|us|s|dB|rad)?/.exec(tail);
    let lo, hi;
    if (rng) {
      lo = parseFloat(rng[1]) * (UNIT_SI[rng[2] ?? ""] ?? siScale);
      hi = parseFloat(rng[3]) * (UNIT_SI[rng[4] ?? ""] ?? siScale);
    } else {
      // Synthesised range: pin it on first sighting so a drag rewriting
      // the literal can't drag `hi` along with it.
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
    // The literal's own fractional-digit count is the precision the
    // author asked for: `540` → integer steps, `540.00` → 0.01 steps.
    // Sci-notation (`1.5e3`) collapses to integer for the rewrite.
    const dotIdx = numStr.indexOf(".");
    const decimals = (dotIdx < 0 || /[eE]/.test(numStr))
      ? 0 : numStr.length - dotIdx - 1;
    out.push({ name, unit, siScale, valFrom, valTo, tokEnd, value: valueSI, lo, hi, taperLog, decimals });
  }
  return out;
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
  }
  eq(o) { return o.name === this.name && Math.abs(o.frac - this.frac) < 1e-4; }
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
    span.addEventListener("pointerdown", (e) => beginParamDrag(e, this.name));
    return span;
  }
}

// Vertical drag → rewrite the literal + push a live set_param. The
// pointer's y delta from pointerdown sets the new fraction (relative,
// like a real knob — not a click-to-jump). The param's range stays put
// across re-parses — declared `[lo,hi]` is fixed text, and a synthesised
// range is pinned by `_synthRange`. The drag closes over the param
// *name*, not stale offsets.
function beginParamDrag(e, name) {
  e.preventDefault();
  e.stopPropagation();
  const knobEl = e.currentTarget;
  knobEl.classList.add("dragging");
  const find = () => parseParams(editor.state.doc).find((p) => p.name === name);
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
        set_param: { name, value },  // already SI — no extra scale needed
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
  renderDiagram();
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
  Object.keys(fileContents).forEach((name, i) => {
    const tab = document.createElement("button");
    tab.className = "file-tab";
    tab.dataset.file = name;
    const idx = String(i + 1).padStart(2, "0");
    tab.innerHTML =
      `<span class="idx">${idx}</span>` +
      `<span>${name}</span>` +
      `<span class="dot" title="unsaved edits"></span>`;
    tab.addEventListener("click", () => switchFile(name));
    bar.appendChild(tab);
  });
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

/* ───────────────────────────────────────────────────────────────────
   Mixer — one strip per voice + a master strip. Each strip owns a VU
   meter, a rotary gain knob, mute/solo, and a dBFS readout. Strip state
   is read/written through the store; `channels` holds DOM refs + scratch.
   ─────────────────────────────────────────────────────────────────── */
const channels = {};
const GAIN_MAX = 1.2;

// The slider handle's left% as a function of gain ∈ [0, GAIN_MAX].
const handlePct = (gain) => (Math.max(0, Math.min(GAIN_MAX, gain)) / GAIN_MAX) * 100;
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
      const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      setVoice(name, { gain: f * GAIN_MAX });
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

// Block diagram — third figure tab. Scene files (voice/scene decls) have
// no single signal-flow graph, so they render a blank state pointing the
// user back to the mixer.
function isSceneFile(src) {
  const cleaned = String(src).replace(/\/\/.*$/gm, "");
  return /\bvoice\b/.test(cleaned) || /\bscene\b/.test(cleaned);
}
function renderDiagram() {
  const host = $("#fig-diagram");
  if (!host) return; // patch tab disabled — re-enable in index.html to restore
  const name = store.get().activeFile;
  const src = fileContents[name] || "";
  const blank = document.createElement("div");
  blank.className = "fig-blank";
  if (isSceneFile(src)) {
    blank.innerHTML =
      `<div class="glyph">⌗</div>` +
      `<div class="msg">scene file — see mixer.</div>`;
  } else {
    blank.innerHTML =
      `<div class="glyph">▤</div>` +
      `<div class="msg">single-patch file.</div>`;
  }
  host.innerHTML = "";
  host.appendChild(blank);
}

const FIG_CAP = {
  spectrum: "log-frequency magnitude.",
  scope:    "zero-cross triggered.",
  diagram:  "signal flow of the current patch.",
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
  $("#hold-btn").classList.toggle("hidden", s.figTab === "diagram");
  $("#hold-btn").classList.toggle("on", s.frozen);
  $("#ctl-integ").querySelector(".cv").innerHTML = `${Math.round(s.specInteg)}<i>ms</i>`;
  $("#ctl-smooth").querySelector(".cv").innerHTML = `${Math.round(s.specSmooth)}<i>%</i>`;
  $("#ctl-floor").querySelector(".cv").innerHTML = `−${Math.abs(Math.round(s.specFloor))}<i>dB</i>`;
  $("#ctl-window").querySelector(".cv").innerHTML = `${s.scopeWindow.toFixed(1)}<i>ms</i>`;
  $("#cap-text").textContent = FIG_CAP[s.figTab];

  // transport / engine state
  const running = s.engineState === "running";
  $("#play").classList.toggle("on", running);
  // The play button keeps its glyph + label children (not just text), so
  // we rewrite only what changes — the SVG inside .glyph and the label.
  const glyph = $("#play-glyph");
  if (glyph) glyph.innerHTML = running
    ? `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="3" y="2" width="3" height="10" fill="currentColor"/><rect x="8" y="2" width="3" height="10" fill="currentColor"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><polygon points="3,2 12,7 3,12" fill="currentColor"/></svg>`;
  const lbl = $("#play-label");
  if (lbl) lbl.textContent = running ? "Pause" : "Play";
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
}
store.subscribe(syncUI);

/* ───────────────────────────────────────────────────────────────────
   Animation loop — per-frame render scratch only: VU meters, knob
   live-rings, and the active figure.
   ─────────────────────────────────────────────────────────────────── */
const topbarVu = () => $("#topbar-vu");

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
  lastHlKey = null; // force the next frame to re-dispatch the highlight
}

// Pattern-step highlight — driven by the worklet's active-span tap.
// Each voice ships a [start,end] pair; (0,0) = rest. Re-decorates only
// on an actual change (a few times a second at most).
// `null` forces a re-dispatch on the next frame.
let lastHlKey = null;
function updatePatternHighlight() {
  if (!editor) return;
  const running = store.get().engineState === "running";
  const ranges = [];
  if (running && latestActive && engineByteToChar && editsSinceCompile) {
    const map = engineByteToChar;
    const docLen = editor.state.doc.length;
    for (let i = 0; i + 1 < latestActive.length; i += 2) {
      const fromB = latestActive[i], toB = latestActive[i + 1];
      // (0,0) is the "no active event" sentinel; a span past the compiled
      // source is a stale tap from mid hot-swap — skip either way.
      if (fromB >= toB || toB >= map.length) continue;
      // byte → UTF-16 offset in the compiled source → live-doc position,
      // mapped through every edit since that compile. `TrackDel` returns
      // -1 when the atom itself was edited away.
      const from = editsSinceCompile.mapPos(map[fromB], 1, MapMode.TrackDel);
      const to = editsSinceCompile.mapPos(map[toB], -1, MapMode.TrackDel);
      if (from < 0 || to < 0 || from >= to || to > docLen) continue;
      ranges.push([from, to]);
    }
    ranges.sort((a, b) => a[0] - b[0]);
  }
  const key = ranges.map((r) => r[0] + ":" + r[1]).join("|");
  if (key === lastHlKey) return; // no boundary crossed — nothing to do
  lastHlKey = key;
  const deco = ranges.length
    ? Decoration.set(ranges.map(([f, t]) => patternHlMark.range(f, t)))
    : Decoration.none;
  editor.dispatch({ effects: setPatternHl.of(deco) });
}

function frame() {
  const s = store.get();
  const order = s.voiceOrder;

  // Per-voice strips, fed by the worklet's {levels} push. Layout:
  // [peak0,rms0, peak1,rms1, …, peakMaster,rmsMaster].
  if (latestLevels && order.length) {
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
      const mPct = meterStrip(mrec, mRms, mPeak);
      mrec.readout.innerHTML = `<span class="neg">${dbfs(mrec.rmsBallistic)}</span>`;
      // Chrome master strip: same VU, plus a dBFS readout next to it.
      const tv = topbarVu();
      if (tv) {
        tv.querySelector(".rms").style.width = mPct + "%";
        tv.querySelector(".peak").style.left = Math.min(99, mrec.peakHold) + "%";
      }
      const dbEl = $("#master-db");
      if (dbEl) dbEl.textContent = `${dbfs(mrec.peakBallistic)} dB`;
    }
  }

  // Active figure — Hold gates the analysis (data capture), not the redraw.
  if (analyser) {
    if (s.figTab === "spectrum") {
      if (!s.frozen) analyzeSpectrum(s);
      drawSpectrum(s);
    } else if (s.figTab === "scope") {
      if (!s.frozen) analyser.getFloatTimeDomainData(timeData);
      drawScope(s);
    }
    // diagram is static — rendered on file change, not per-frame.
  }

  // Pattern-step highlight — cheap (a key-string compare); only dispatches
  // a CodeMirror transaction on an actual step-boundary crossing.
  updatePatternHighlight();

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
}

function bindThemeToggle() {
  const light = $("#theme-light"), dark = $("#theme-dark");
  const apply = (mode) => {
    currentTheme = mode;
    document.body.classList.remove("theme-light", "theme-dark");
    document.body.classList.add("theme-" + mode);
    light.classList.toggle("on", mode === "light");
    dark.classList.toggle("on", mode === "dark");
    applyAccentVars();
  };
  light.addEventListener("click", () => apply("light"));
  dark.addEventListener("click", () => apply("dark"));
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

function bindAccentPicker() {
  const dots = document.querySelectorAll(".accent-dot");
  const apply = (color) => {
    currentAccent = color;
    applyAccentVars();
    dots.forEach((d) => d.classList.toggle("on", d.dataset.color === color));
  };
  dots.forEach((d) => d.addEventListener("click", () => apply(d.dataset.color)));
}

function bindZen() {
  const btn = $("#zen-btn");
  const setZen = (on) => {
    document.body.classList.toggle("zen", on);
    btn.title = on ? "Exit zen (Esc)" : "Zen mode (Esc to exit)";
  };
  btn.addEventListener("click", () => setZen(!document.body.classList.contains("zen")));
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("zen")) {
      setZen(false);
    }
  });
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
  $("#play").classList.add("idle"); // pulse until first play
  $("#play").addEventListener("click", toggle);
  $("#stop").addEventListener("click", async () => {
    if (audioCtx && audioCtx.state === "running") {
      await audioCtx.suspend();
      store.set({ engineState: "paused" });
      logEvent("stopped");
    }
  });
  // ⌘↵ also works when the editor isn't focused.
  window.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); evaluate(); }
  });

  paintVersionPill();

  fileContents = await loadPatches();
  fileDirty = {};
  const names = Object.keys(fileContents);
  const first = names[0];
  renderFileTabs();
  store.set({ activeFile: first }); // syncUI loads it into the editor
  logEvent("press ▶ to listen");
  requestAnimationFrame(frame);
})();
