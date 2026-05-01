// JPEG compression + resize for Asana attachment rehosting.
//
// Pure async function — never throws. Any failure (decode, resize, encode)
// falls back to returning the original bytes. The caller (rehost.ts) only
// invokes this for buffers that have already passed a magic-byte check.
//
// Quality and max long-edge are hard-coded per the implementation scope:
// quality 85, resize to 2048px long edge, preserve aspect ratio. EXIF
// orientation is baked into pixels by the decoder's default behavior, then
// stripped during re-encode — output renders consistently across viewers.

import decode, { init as initJpegDecode } from '@jsquash/jpeg/decode';
import encode, { init as initJpegEncode } from '@jsquash/jpeg/encode';
import resize, { initResize } from '@jsquash/resize';

// Wrangler's `CompiledWasm` rule (see wrangler.jsonc) compiles each imported
// .wasm file into a `WebAssembly.Module` at build time. We pass these to
// jsquash's init functions so the codecs use the bundled modules directly
// instead of attempting to fetch them at runtime (which fails in Workers).
import jpegDecWasm from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';
import jpegEncWasm from '@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm';
// resize ships a wasm-bindgen-generated `.d.ts` with named exports that
// shadows our `*.wasm` ambient declaration. Bypass that with a namespace
// import + cast — at runtime Wrangler still produces a `WebAssembly.Module`.
import * as resizeWasmExports from '@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm';
const resizeWasm = resizeWasmExports as unknown as WebAssembly.Module;

// jsquash's type signatures reference the DOM `ImageData` interface which is
// not in the Workers type set. Declaring it here keeps the type definitions
// happy without pulling the entire DOM lib into the project. At runtime
// jsquash returns plain objects with this shape — no constructor needed.
declare global {
  interface ImageData {
    readonly data: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  }
}

// One-time init across the isolate. Each Worker isolate runs init once on
// first compression; subsequent calls reuse the loaded modules.
let initPromise: Promise<void> | null = null;
async function ensureInitialised(): Promise<void> {
  if (!initPromise) {
    initPromise = Promise.all([
      initJpegDecode(jpegDecWasm),
      initJpegEncode(jpegEncWasm),
      initResize(resizeWasm),
    ]).then(() => undefined);
  }
  return initPromise;
}

const QUALITY = 85;
const MAX_LONG_EDGE = 2048;
// Cap on decoded RGBA pixel buffer size. A 20 MB JPEG of a 50 MP panorama
// expands to ~200 MB of raw pixels, which would OOM the Worker. Skip such
// outliers and pass through the original bytes.
const MAX_DECODED_RGBA_BYTES = 64 * 1024 * 1024;

export type CompressPath =
  | 'compressed'
  | 'passthrough_not_smaller'
  | 'skipped_dims'
  | 'decode_failed'
  | 'resize_failed'
  | 'encode_failed';

export interface CompressMeta {
  path: CompressPath;
  orig_bytes: number;
  final_bytes: number;
  decoded_dims: { width: number; height: number } | null;
  output_dims: { width: number; height: number } | null;
  compress_ms: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  meta: CompressMeta;
}

export async function compressJpeg(input: Uint8Array): Promise<CompressResult> {
  const start = Date.now();
  const orig_bytes = input.byteLength;

  try {
    await ensureInitialised();
  } catch {
    return fallback(input, orig_bytes, 'decode_failed', null, null, start);
  }

  // Copy to a fresh ArrayBuffer — input may be a view into a larger buffer
  // (e.g. from Response.arrayBuffer slicing), and the decoder expects to own
  // the bytes it reads.
  const sourceAb = input.slice().buffer;

  let decoded: ImageData;
  try {
    decoded = await decode(sourceAb);
  } catch {
    return fallback(input, orig_bytes, 'decode_failed', null, null, start);
  }

  const decodedDims = { width: decoded.width, height: decoded.height };

  if (decoded.width * decoded.height * 4 > MAX_DECODED_RGBA_BYTES) {
    return fallback(input, orig_bytes, 'skipped_dims', decodedDims, null, start);
  }

  const longEdge = Math.max(decoded.width, decoded.height);
  let target = decoded;
  let outputDims = decodedDims;
  if (longEdge > MAX_LONG_EDGE) {
    const ratio = MAX_LONG_EDGE / longEdge;
    const newWidth = Math.max(1, Math.round(decoded.width * ratio));
    const newHeight = Math.max(1, Math.round(decoded.height * ratio));
    try {
      target = await resize(decoded, { width: newWidth, height: newHeight });
      outputDims = { width: newWidth, height: newHeight };
    } catch {
      return fallback(input, orig_bytes, 'resize_failed', decodedDims, null, start);
    }
  }

  let encoded: ArrayBuffer;
  try {
    encoded = await encode(target, { quality: QUALITY });
  } catch {
    return fallback(input, orig_bytes, 'encode_failed', decodedDims, outputDims, start);
  }

  const final_bytes = encoded.byteLength;

  // Quality floor: never make a file larger. Already-optimised inputs stay as-is.
  if (final_bytes >= orig_bytes) {
    return fallback(input, orig_bytes, 'passthrough_not_smaller', decodedDims, outputDims, start);
  }

  return {
    bytes: new Uint8Array(encoded),
    meta: {
      path: 'compressed',
      orig_bytes,
      final_bytes,
      decoded_dims: decodedDims,
      output_dims: outputDims,
      compress_ms: Date.now() - start,
    },
  };
}

function fallback(
  input: Uint8Array,
  orig_bytes: number,
  path: CompressPath,
  decodedDims: { width: number; height: number } | null,
  outputDims: { width: number; height: number } | null,
  start: number,
): CompressResult {
  return {
    bytes: input,
    meta: {
      path,
      orig_bytes,
      final_bytes: orig_bytes,
      decoded_dims: decodedDims,
      output_dims: outputDims,
      compress_ms: Date.now() - start,
    },
  };
}

// First three bytes of every JPEG file are FF D8 FF (SOI marker + start of
// next segment). Used by the caller to gate entry into the compression path.
export function isJpegMagic(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
}
