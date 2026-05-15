// AudioWorkletGlobalScope polyfill: TextEncoder + TextDecoder, utf-8.
//
// `wasm-bindgen --target web` emits JS glue that creates a singleton
// `new TextDecoder('utf-8')` and `new TextEncoder()` at module load.
// `AudioWorkletGlobalScope` does not expose either constructor (Chrome
// + Safari as of 2026), so importing `fugue_wasm.js` into the worklet
// throws `ReferenceError: TextDecoder is not defined`, which fails the
// worklet module load, which makes `registerProcessor` never run, which
// makes `new AudioWorkletNode(..., "fugue-processor", ...)` throw
// `InvalidStateError: node name is not defined in AudioWorkletGlobalScope`.
//
// Registering this file as its own worklet module *before* `processor.js`
// (see `main.js`) defines the globals on the worklet thread; the
// subsequent `processor.js` load imports `fugue_wasm.js`, which now sees
// the polyfilled constructors.
//
// Only utf-8 is implemented — wasm-bindgen never uses any other encoding.

(() => {
  if (
    typeof globalThis.TextDecoder !== 'undefined' &&
    typeof globalThis.TextEncoder !== 'undefined'
  ) {
    return;
  }

  function utf8Decode(bytes) {
    let s = '';
    let i = 0;
    const len = bytes.length;
    while (i < len) {
      const b = bytes[i++];
      if (b < 0x80) {
        s += String.fromCharCode(b);
      } else if (b < 0xc0) {
        // Invalid lead byte; skip.
        continue;
      } else if (b < 0xe0) {
        s += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i++] & 0x3f));
      } else if (b < 0xf0) {
        s += String.fromCharCode(
          ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f),
        );
      } else {
        const cp =
          ((b & 0x07) << 18) |
          ((bytes[i++] & 0x3f) << 12) |
          ((bytes[i++] & 0x3f) << 6) |
          (bytes[i++] & 0x3f);
        const off = cp - 0x10000;
        s +=
          String.fromCharCode(0xd800 + (off >>> 10)) +
          String.fromCharCode(0xdc00 + (off & 0x3ff));
      }
    }
    return s;
  }

  function utf8Encode(str) {
    // Worst case: 4 bytes per code unit.
    const out = new Uint8Array(str.length * 4);
    let w = 0;
    for (let i = 0; i < str.length; i++) {
      let cp = str.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff && i + 1 < str.length) {
        const lo = str.charCodeAt(i + 1);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
          i++;
        }
      }
      if (cp < 0x80) {
        out[w++] = cp;
      } else if (cp < 0x800) {
        out[w++] = 0xc0 | (cp >> 6);
        out[w++] = 0x80 | (cp & 0x3f);
      } else if (cp < 0x10000) {
        out[w++] = 0xe0 | (cp >> 12);
        out[w++] = 0x80 | ((cp >> 6) & 0x3f);
        out[w++] = 0x80 | (cp & 0x3f);
      } else {
        out[w++] = 0xf0 | (cp >> 18);
        out[w++] = 0x80 | ((cp >> 12) & 0x3f);
        out[w++] = 0x80 | ((cp >> 6) & 0x3f);
        out[w++] = 0x80 | (cp & 0x3f);
      }
    }
    return out.slice(0, w);
  }

  if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
      constructor(encoding = 'utf-8') {
        const e = String(encoding).toLowerCase().replace(/-/g, '');
        if (e !== 'utf8') {
          throw new RangeError(
            `TextDecoder polyfill: only utf-8 supported (got '${encoding}')`,
          );
        }
      }
      get encoding() {
        return 'utf-8';
      }
      decode(input) {
        if (!input) return '';
        if (input instanceof Uint8Array) return utf8Decode(input);
        if (input.buffer) {
          return utf8Decode(
            new Uint8Array(input.buffer, input.byteOffset, input.byteLength),
          );
        }
        return utf8Decode(new Uint8Array(input));
      }
    };
  }

  if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
      get encoding() {
        return 'utf-8';
      }
      encode(str) {
        return utf8Encode(String(str ?? ''));
      }
      encodeInto(str, dest) {
        const s = String(str ?? '');
        const encoded = utf8Encode(s);
        const n = Math.min(encoded.length, dest.length);
        for (let i = 0; i < n; i++) dest[i] = encoded[i];
        // `read` is the count of chars consumed from `str`. wasm-bindgen
        // uses encodeInto with a destination sized via a length probe,
        // so truncation should never happen in practice; we report the
        // full string length on success.
        return { read: s.length, written: n };
      }
    };
  }
})();
