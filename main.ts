// png-squeeze-01 entry: lossless PNG recompressor for 1280x720 RGBA screenshots.
//
// Strategy (all my own code, written from the PNG spec and the kit's RULES):
//  1. Decode the stored input PNG (colour type 6, unfiltered rows) to raw RGBA.
//  2. Analyse the image: opaque? grey? at most 256 distinct colours?
//  3. Try several lossless forms and pick the smallest total file:
//       - palette (type 3) when <= 256 colours, ordered by count or by luminance,
//         transparent entries first so tRNS stays short;
//       - grey (type 0) / grey+alpha (type 4) when every pixel is grey;
//       - RGB (type 2) / RGBA (type 6) otherwise, with a tRNS key instead of an
//         alpha channel when every non-opaque pixel is one fully-transparent value
//         no opaque pixel uses.
//  4. Per form, try several per-row filter selections (fixed filter, minimum
//     signed-sum, fewest-distinct-pairs, and brute-force per-row by real deflate
//     cost with a 32 KiB dictionary context) and keep the smallest zlib level 9
//     stream. Deterministic: fixed work per instance, no clock, no randomness.
//
// Run: node main.ts  (reads MAKEFUN_INPUT_DIR, writes MAKEFUN_OUTPUT_DIR;
// defaults /input and /output). Node 22, erasable TypeScript only, built-ins only.
import { inflateSync, deflateSync, constants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- PNG codec

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colourType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

// PNG filter 4 predictor (PNG spec section 12.8).
function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter one row of `cur` (stride samples, bpp bytes per pixel) against `prev`
// (the row above, or null) with filter `type`, writing into `out`.
function filterRow(type: number, cur: Uint8Array, prev: Uint8Array | null, bpp: number, out: Uint8Array): void {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredictor(a, b, c);
    }
  }
}

// Sum of |signed byte| over a filtered row: the minimum-sum heuristic's cost.
function signedSum(row: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Decode a PNG file (the contest's accepted subset) to RGBA. Throws on bad input.
function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idatParts: Uint8Array[] = [];
  let ended = false;
  while (at < bytes.length) {
    if (ended) throw new Error('bytes after IEND');
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) throw new Error(`${type} CRC mismatch`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      if (data[8] !== 8) throw new Error('bit depth is not 8');
      colourType = data[9];
      if (data[12] !== 0) throw new Error('interlaced');
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      ended = true;
    } else {
      throw new Error(`unexpected chunk ${type}`);
    }
  }
  if (!ended || idatParts.length === 0) throw new Error('no IEND or no IDAT');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType];
  if (channels === undefined) throw new Error(`colour type ${colourType} not supported`);
  const stride = width * channels;
  const expected = height * (stride + 1);
  const raw = inflateSync(idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts), {
    maxOutputLength: expected + 1,
  });
  if (raw.length !== expected) throw new Error(`inflated ${raw.length} bytes, expected ${expected}`);
  // Unfilter rows.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) throw new Error(`row ${y} filter ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= channels ? samples[o + i - channels] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] =
          raw[src + i] + (((i >= channels ? samples[o + i - channels] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? samples[o + i - channels] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= channels ? samples[p + i - channels] : 0;
        samples[o + i] = raw[src + i] + paethPredictor(a, b, c);
      }
    }
  }
  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    // Palette.
    const entries = (palette as Uint8Array).length / 3;
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = (palette as Uint8Array)[e * 3];
      rgba[d + 1] = (palette as Uint8Array)[e * 3 + 1];
      rgba[d + 2] = (palette as Uint8Array)[e * 3 + 2];
      rgba[d + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
  }
  return { width, height, rgba };
}

// ---------------------------------------------------------------- analysis

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
  word: number;
  count: number;
}

interface Analysis {
  opaque: boolean;
  grey: boolean;
  colours: Colour[] | null; // null when more than 256 distinct colours
}

function analyse(rgba: Uint8Array): Analysis {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true;
  let grey = true;
  const counts = new Map<number, number>();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  let colours: Colour[] | null = null;
  if (!many) {
    colours = [...counts.entries()].map(([word, count]) => {
      const b = new Uint8Array(Uint32Array.of(word).buffer);
      return { r: b[0], g: b[1], b: b[2], a: b[3], word, count };
    });
  }
  return { opaque, grey, colours };
}

// The one fully-transparent value (grey sample or RGB triple) the image may key
// by tRNS instead of an alpha channel: every non-opaque pixel is that exact
// value at alpha 0, and no opaque pixel has that value. Null when there is none.
function transparentKey(rgba: Uint8Array, grey: boolean): number | null {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// ---------------------------------------------------------------- forms

interface Form {
  colourType: number;
  bpp: number;
  samples: Uint8Array;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
  filters: Array<number | string>;
}

function paletteForm(rgba: Uint8Array, colours: Colour[], order: 'count' | 'luminance'): Form {
  const lum = (c: Colour) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const ta = x.a === 255 ? 1 : 0;
    const tb = y.a === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map<number, number>(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]) as number;
  return {
    colourType: 3,
    bpp: 1,
    samples: indices,
    plte,
    trns,
    filters: order === 'count' ? [0] : [0, 'minsum', 'brute'],
  };
}

function samplesOf(rgba: Uint8Array, ct: number): Uint8Array {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function formsOf(rgba: Uint8Array): Form[] {
  const { opaque, grey, colours } = analyse(rgba);
  const forms: Form[] = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct: number;
  let trns: Uint8Array | null = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct] as number;
  forms.push({
    colourType: ct,
    bpp,
    samples: samplesOf(rgba, ct),
    plte: null,
    trns,
    filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'brute'],
  });
  return forms;
}

// ---------------------------------------------------------------- filtering

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;

// Fewest-distinct-pairs cost of a filtered row.
function pairsOf(row: Uint8Array, seen: Uint32Array, stamp: number): number {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// Filter `samples` by `choice`: a fixed filter type, or 'minsum' / 'pairs' /
// 'brute' per-row selection (brute weighs each row's five filters by a real
// deflate at BRUTE_LEVEL with the previous 32 KiB as dictionary).
function filtered(
  samples: Uint8Array,
  width: number,
  height: number,
  bpp: number,
  choice: number | string,
  raw: Uint8Array,
): Uint8Array {
  const stride = width * bpp;
  const trial: Uint8Array[] = Array.from({ length: 5 }, () => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost: number;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else {
        cost = deflateSync(trial[t], {
          level: BRUTE_LEVEL,
          memLevel: 9,
          dictionary: before.length === 0 ? undefined : before,
        }).length;
      }
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

// ---------------------------------------------------------------- optimal deflate
//
// A zopfli-style DEFLATE encoder written from the DEFLATE spec (RFC 1951):
// LZ77 with hash chains, optimal parsing by shortest-path dynamic programming
// over a bit-cost model, iterated Huffman length refinement, and one dynamic
// Huffman block (falling back to a fixed-Huffman block when that is smaller).
// No clock, no randomness: the same input always yields the same stream.

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Length-code boundaries: the bit cost of a match only changes at these lengths.
const LEN_BOUNDARY = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

const LEN_CODE: Int32Array = (() => {
  const t = new Int32Array(259);
  for (let len = 3; len <= 258; len++) {
    let k = 0;
    while (k < 28 && len >= LEN_BASE[k + 1]) k++;
    t[len] = k;
  }
  return t;
})();
const DIST_CODE: Int32Array = (() => {
  const t = new Int32Array(32769);
  let k = 0;
  for (let d = 1; d <= 32768; d++) {
    while (k < 29 && d >= DIST_BASE[k + 1]) k++;
    t[d] = k;
  }
  return t;
})();

// Huffman code lengths from symbol frequencies, capped at `maxBits`.
// Builds an optimal Huffman tree with a heap; when its depth fits the cap
// those lengths are used as-is (a complete code by construction). When the
// tree is too deep, package-merge (Larmore & Hirschberg) supplies optimal
// length-limited lengths, verified in integer arithmetic to satisfy the
// Kraft equality exactly; if verification ever fails, a simple complete
// code (sorted by frequency) is used instead so the output is always a
// valid DEFLATE block.
function huffmanLengths(freqs: ArrayLike<number>, maxBits: number): Uint8Array {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Heap-built Huffman tree; when its depth fits the cap those lengths are
  // used as-is (a complete code by construction).
  const nf: number[] = [];
  const ns: number[] = [];
  const nl: number[] = [];
  const nr: number[] = [];
  const heap: number[] = [];
  const push = (id: number) => {
    heap.push(id);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (nf[heap[p]] <= nf[heap[i]]) break;
      const t = heap[p];
      heap[p] = heap[i];
      heap[i] = t;
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop() as number;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && nf[heap[l]] < nf[heap[m]]) m = l;
        if (r < heap.length && nf[heap[r]] < nf[heap[m]]) m = r;
        if (m === i) break;
        const t = heap[m];
        heap[m] = heap[i];
        heap[i] = t;
        i = m;
      }
    }
    return top;
  };
  for (const s of syms) {
    nf.push(freqs[s]);
    ns.push(s);
    nl.push(-1);
    nr.push(-1);
    push(nf.length - 1);
  }
  while (heap.length > 1) {
    const a = pop();
    const b = pop();
    nf.push(nf[a] + nf[b]);
    ns.push(-1);
    nl.push(a);
    nr.push(b);
    push(nf.length - 1);
  }
  const root = pop();
  const depth = new Int32Array(nf.length);
  const stack: number[] = [root];
  let maxDepth = 0;
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (ns[id] >= 0) {
      lengths[ns[id]] = depth[id];
      if (depth[id] > maxDepth) maxDepth = depth[id];
    } else {
      depth[nl[id]] = depth[id] + 1;
      depth[nr[id]] = depth[id] + 1;
      stack.push(nl[id], nr[id]);
    }
  }
  if (maxDepth <= maxBits) return lengths;
  // Too deep: package-merge (below) supplies length-limited lengths.
  lengths.fill(0);
  // Package-merge over the symbols sorted by frequency (ascending).
  const order = [...syms].sort((a, b) => freqs[a] - freqs[b] || a - b);
  const m = order.length;
  // An item is a set of symbol positions (into `order`) with a summed weight.
  interface Item {
    w: number;
    members: number[];
  }
  const singletons: Item[] = order.map((s, i) => ({ w: freqs[s], members: [i] }));
  let lists: Item[][] = [singletons];
  for (let k = 1; k < maxBits; k++) {
    const prev = lists[k - 1];
    const packaged: Item[] = [];
    for (let i = 0; i + 1 < prev.length; i += 2) {
      packaged.push({ w: prev[i].w + prev[i + 1].w, members: [...prev[i].members, ...prev[i + 1].members] });
    }
    if (prev.length % 2 === 1) packaged.push(prev[prev.length - 1]);
    const merged = [...packaged, ...singletons].sort((a, b) => a.w - b.w);
    lists.push(merged.slice(0, m - 1));
  }
  const counts = new Array<number>(m).fill(0);
  for (const list of lists) {
    for (const item of list) {
      for (const idx of item.members) counts[idx]++;
    }
  }
  // Verify: every length within the cap and the Kraft sum exactly 1.
  let ok = true;
  let kraftNum = 0; // Kraft sum scaled by 2^maxBits; must equal 2^maxBits.
  for (let i = 0; i < m; i++) {
    if (counts[i] < 1 || counts[i] > maxBits) {
      ok = false;
      break;
    }
    kraftNum += 2 ** (maxBits - counts[i]);
  }
  if (ok && kraftNum === 2 ** maxBits) {
    for (let i = 0; i < m; i++) lengths[order[i]] = counts[i];
    return lengths;
  }
  // Fallback: a complete code with lengths floor/ceil(log2(m)), shortest to
  // the most frequent symbols.
  const k = Math.ceil(Math.log2(m));
  const short = 2 ** k - m; // symbols at length k-1
  const byFreq = [...syms].sort((a, b) => freqs[b] - freqs[a] || a - b);
  byFreq.forEach((s, i) => {
    lengths[s] = i < short ? k - 1 : k;
  });
  return lengths;
}

// Canonical Huffman codes from lengths: codes[sym] is the code value with
// its most-significant bit first, lengths[sym] its bit length.
function canonicalCodes(lengths: Uint8Array): { codes: Uint32Array; lengths: Uint8Array } {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Uint32Array(maxLen + 1);
  for (let i = 0; i < lengths.length; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Uint32Array(maxLen + 1);
  let code = 0;
  for (let b = 1; b <= maxLen; b++) {
    code = (code + blCount[b - 1]) << 1;
    nextCode[b] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i] > 0) codes[i] = nextCode[lengths[i]]++;
  }
  return { codes, lengths };
}

function reverseBits(code: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

class BitWriter {
  bytes: number[] = [];
  bitbuf = 0;
  bitcnt = 0;
  writeBits(value: number, len: number): void {
    this.bitbuf |= value << this.bitcnt;
    this.bitcnt += len;
    while (this.bitcnt >= 8) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(code: number, len: number): void {
    this.writeBits(reverseBits(code, len), len);
  }
  align(): void {
    if (this.bitcnt > 0) {
      this.bytes.push(this.bitbuf & 0xff);
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
  }
  finish(): Uint8Array {
    this.align();
    return Uint8Array.from(this.bytes);
  }
  totalBits(): number {
    return this.bytes.length * 8 + this.bitcnt;
  }
  // Append another writer's bits (its bytes, then its partial byte) into this one.
  append(other: BitWriter): void {
    for (const b of other.bytes) this.writeBits(b, 8);
    if (other.bitcnt > 0) this.writeBits(other.bitbuf, other.bitcnt);
  }
}

// One LZ77 sequence: syms[i] is a literal byte (0..255) or 257 + length-code
// index; dists[i] is the match distance for matches, 0 for literals;
// lens[i] is the match length for matches, 0 for literals.
interface LzSeq {
  syms: Int32Array;
  dists: Int32Array;
  lens: Int32Array;
  count: number;
}

// Greedy lazy-matching parse of `data` (no dynamic programming): at each
// position the longest match (hash chain plus structural distances) is
// weighed against the match one position ahead, and the better is taken.
// Much faster than the optimal parse; used only to estimate the Huffman
// frequencies for the optimal parse's cost model.
function greedyParse(data: Uint8Array, rowLen = 0): LzSeq {
  const n = data.length;
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i: number): number => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
  let inserted = 0;
  const ensureInserted = (upto: number) => {
    while (inserted < upto) {
      const h = hashAt(inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
      inserted++;
    }
  };
  const findMatch = (i: number): [number, number] => {
    if (i + 3 > n) return [0, 0];
    const maxLen = Math.min(258, n - i);
    let bestLen = 2;
    let bestDist = 0;
    const consider = (dist: number) => {
      if (dist <= 0 || dist > i || dist > 32768) return;
      const src = i - dist;
      if (data[src] !== data[i] || data[src + 2] !== data[i + 2]) return;
      let len = 0;
      while (len < maxLen && data[src + len] === data[i + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = dist;
      }
    };
    const h = hashAt(i);
    let cand = head[h];
    let maxChain = 32;
    let chain = 0;
    while (cand >= 0 && chain < maxChain) {
      const dist = i - cand;
      if (dist > 32768) break;
      if (data[cand + bestLen] === data[i + bestLen]) {
        let len = 0;
        while (len < maxLen && data[cand + len] === data[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= 128) break;
          if (len >= 32) maxChain = 8;
        }
      }
      cand = prev[cand];
      chain++;
    }
    if (rowLen > 0 && bestLen < 64) {
      consider(1);
      consider(rowLen - 1);
      consider(rowLen);
      consider(rowLen + 1);
      consider(2 * rowLen);
    }
    return [bestLen, bestDist];
  };
  const syms: number[] = [];
  const dists: number[] = [];
  const lens: number[] = [];
  let i = 0;
  let pending: [number, number] | null = null;
  while (i < n) {
    ensureInserted(i);
    const m0 = pending ?? findMatch(i);
    pending = null;
    if (m0[0] < 3) {
      syms.push(data[i]);
      dists.push(0);
      lens.push(0);
      i++;
      continue;
    }
    ensureInserted(i + 1);
    const m1 = findMatch(i + 1);
    if (m1[0] > m0[0]) {
      syms.push(data[i]);
      dists.push(0);
      lens.push(0);
      pending = m1;
      i++;
      continue;
    }
    syms.push(257 + LEN_CODE[m0[0]]);
    dists.push(m0[1]);
    lens.push(m0[0]);
    i += m0[0];
  }
  return { syms: Int32Array.from(syms), dists: Int32Array.from(dists), lens: Int32Array.from(lens), count: syms.length };
}

// Optimal parse of `data` under a bit-cost model. `rowLen` is the filtered
// rows' length (width*bpp + 1) when known: screenshots repeat rows, so the
// same column one or two rows back is tried explicitly as a match distance
// (hash chains alone would need a very long walk to reach it through the
// many repeats of a flat run). Returns the LZ77 sequence.
function optimalParse(
  data: Uint8Array,
  litCost: Float64Array,
  lenCost: Float64Array,
  distCost: Float64Array,
  rowLen = 0,
): LzSeq {
  const n = data.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  cost[0] = 0;
  const choiceLen = new Int32Array(n + 1); // 0 = literal, else match length
  const choiceDist = new Int32Array(n + 1);
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const hashAt = (i: number): number => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci !== Infinity) {
      // Literal.
      const lc = ci + litCost[data[i]];
      if (lc < cost[i + 1]) {
        cost[i + 1] = lc;
        choiceLen[i + 1] = 0;
      }
      // Match search through the hash chain. Two candidates are kept: the
      // longest match and the cheapest (a shorter match at a much smaller
      // distance can cost fewer bits than a longer far one). Structural
      // distances (a run, the same column one or two rows back) are tried
      // explicitly: they are where a screenshot's best matches live, and a
      // hash chain would need a very long walk to reach them.
      if (i + 3 <= n) {
        const h = hashAt(i);
        let cand = head[h];
        let bestLen = 2;
        let bestDist = 0;
        let cheapLen = 2;
        let cheapDist = 0;
        let cheapCost = Infinity;
        const consider = (dist: number) => {
          if (dist <= 0 || dist > i || dist > 32768) return;
          const src = i - dist;
          // Probe: a useful match needs its first three bytes to match;
          // checking offsets 0 and 2 filters nearly all candidates cheaply.
          if (data[src] !== data[i] || data[src + 2] !== data[i + 2]) return;
          let len = 0;
          while (len < maxLenAll && data[src + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = dist;
          }
          if (len >= 3) {
            const c = lenCost[len] + distCost[DIST_CODE[dist]];
            if (c < cheapCost) {
              cheapCost = c;
              cheapLen = len;
              cheapDist = dist;
            }
          }
        };
        const maxLenAll = Math.min(258, n - i);
        let maxChain = 64;
        let chain = 0;
        while (cand >= 0 && chain < maxChain) {
          const dist = i - cand;
          if (dist > 32768) break;
          // Quick reject: a candidate that differs at offset bestLen cannot
          // beat it. When it passes, the true length is computed from
          // offset 0: the 15-bit hash is not injective, so a chain candidate
          // may share the hash without sharing the first three bytes.
          if (data[cand + bestLen] === data[i + bestLen]) {
            let len = 0;
            while (len < maxLenAll && data[cand + len] === data[i + len]) len++;
            if (len > bestLen) {
              bestLen = len;
              bestDist = dist;
              if (len >= 128) break;
              if (len >= 32) maxChain = 16;
              else if (len >= 8) maxChain = 32;
            }
            if (len >= 3) {
              const c = lenCost[len] + distCost[DIST_CODE[dist]];
              if (c < cheapCost) {
                cheapCost = c;
                cheapLen = len;
                cheapDist = dist;
              }
            }
          }
          cand = prev[cand];
          chain++;
        }
        // Structural distances, skipped when the chain walk already found a
        // long match: they cost a full length scan each, and a long match is
        // rarely beaten by enough to matter.
        if (rowLen > 0 && bestLen < 64) {
          consider(1);
          consider(rowLen - 1);
          consider(rowLen);
          consider(rowLen + 1);
          consider(2 * rowLen);
        }
        if (bestLen >= 3) {
          const cands: Array<[number, number]> = [[bestLen, bestDist]];
          if (cheapDist !== 0 && cheapDist !== bestDist) cands.push([cheapLen, cheapDist]);
          for (const [mlen, mdist] of cands) {
            const dc = distCost[DIST_CODE[mdist]];
            // Only lengths where the length-code cost changes can be optimal.
            for (let b = 0; b < LEN_BOUNDARY.length; b++) {
              const L = LEN_BOUNDARY[b];
              if (L > mlen) break;
              const c = ci + lenCost[L] + dc;
              if (c < cost[i + L]) {
                cost[i + L] = c;
                choiceLen[i + L] = L;
                choiceDist[i + L] = mdist;
              }
            }
            if (!LEN_BOUNDARY.includes(mlen)) {
              const c = ci + lenCost[mlen] + dc;
              if (c < cost[i + mlen]) {
                cost[i + mlen] = c;
                choiceLen[i + mlen] = mlen;
                choiceDist[i + mlen] = mdist;
              }
            }
          }
        }
      }
    }
    // Insert this position into the hash chain for later positions.
    if (i + 3 <= n) {
      const h = hashAt(i);
      prev[i] = head[h];
      head[h] = i;
    }
  }
  // Backtrack.
  const syms: number[] = [];
  const dists: number[] = [];
  const lens: number[] = [];
  let i = n;
  while (i > 0) {
    const L = choiceLen[i];
    if (L === 0) {
      syms.push(data[i - 1]);
      dists.push(0);
      lens.push(0);
      i -= 1;
    } else {
      syms.push(257 + LEN_CODE[L]);
      dists.push(choiceDist[i]);
      lens.push(L);
      i -= L;
    }
  }
  syms.reverse();
  dists.reverse();
  lens.reverse();
  return { syms: Int32Array.from(syms), dists: Int32Array.from(dists), lens: Int32Array.from(lens), count: syms.length };
}

function countFreqs(seq: LzSeq): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (let i = 0; i < seq.count; i++) {
    const s = seq.syms[i];
    litFreq[s]++;
    if (s >= 257) distFreq[DIST_CODE[seq.dists[i]]]++;
  }
  litFreq[256] = 1; // end of block
  return { litFreq, distFreq };
}

// Bit costs of one symbol under given code lengths.
function costsOf(
  litLen: Uint8Array,
  distLen: Uint8Array,
): { litCost: Float64Array; lenCost: Float64Array; distCost: Float64Array } {
  const litCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = litLen[s];
  const lenCost = new Float64Array(259);
  for (let len = 3; len <= 258; len++) {
    const k = LEN_CODE[len];
    lenCost[len] = litLen[257 + k] + LEN_EXTRA[k];
  }
  const distCost = new Float64Array(31);
  for (let k = 0; k < 30; k++) distCost[k] = distLen[k] + DIST_EXTRA[k];
  return { litCost, lenCost, distCost };
}

const FIXED_LIT_LEN: Uint8Array = (() => {
  const l = new Uint8Array(288);
  for (let s = 0; s < 288; s++) l[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  return l;
})();
const FIXED_DIST_LEN: Uint8Array = new Uint8Array(32).fill(5);

// Encode the sequence as one block, dynamic-Huffman or fixed-Huffman,
// whichever is smaller, appended to `out` (blocks share one bitstream: no
// byte alignment between blocks). `final` marks the stream's last block.
function encodeBlock(seq: LzSeq, litLen: Uint8Array, distLen: Uint8Array, final: boolean, out: BitWriter): void {
  // Trim trailing zero-length codes.
  let litCount = 286;
  while (litCount > 257 && litLen[litCount - 1] === 0) litCount--;
  let distCount = 30;
  while (distCount > 1 && distLen[distCount - 1] === 0) distCount--;
  const lit = canonicalCodes(litLen);
  const dist = canonicalCodes(distLen);
  // Code-length-code RLE over litLen[0..litCount) then distLen[0..distCount).
  const clSyms: number[] = [];
  const clExtra: number[] = [];
  const emitRun = (value: number, run: number) => {
    if (value === 0) {
      while (run >= 11) {
        const r = Math.min(run, 138);
        clSyms.push(18);
        clExtra.push(r - 11);
        run -= r;
      }
      while (run >= 3) {
        const r = Math.min(run, 10);
        clSyms.push(17);
        clExtra.push(r - 3);
        run -= r;
      }
      while (run > 0) {
        clSyms.push(0);
        clExtra.push(0);
        run--;
      }
    } else {
      clSyms.push(value);
      clExtra.push(0);
      run--;
      while (run >= 3) {
        const r = Math.min(run, 6);
        clSyms.push(16);
        clExtra.push(r - 3);
        run -= r;
      }
      while (run > 0) {
        clSyms.push(value);
        clExtra.push(0);
        run--;
      }
    }
  };
  {
    let prev = -1;
    let run = 0;
    const all: number[] = [];
    for (let i = 0; i < litCount; i++) all.push(litLen[i]);
    for (let i = 0; i < distCount; i++) all.push(distLen[i]);
    for (const v of all) {
      if (v === prev) run++;
      else {
        if (run > 0) emitRun(prev, run);
        prev = v;
        run = 1;
      }
    }
    if (run > 0) emitRun(prev, run);
  }
  const clFreq = new Uint32Array(19);
  for (const s of clSyms) clFreq[s]++;
  const clLen = huffmanLengths(clFreq, 7);
  const clOrder = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let clCount = 19;
  while (clCount > 4 && clLen[clOrder[clCount - 1]] === 0) clCount--;
  const cl = canonicalCodes(clLen);

  const dyn = new BitWriter();
  dyn.writeBits(final ? 1 : 0, 1); // BFINAL
  dyn.writeBits(2, 2); // BTYPE = dynamic
  dyn.writeBits(litCount - 257, 5);
  dyn.writeBits(distCount - 1, 5);
  dyn.writeBits(clCount - 4, 4);
  for (let i = 0; i < clCount; i++) dyn.writeBits(clLen[clOrder[i]], 3);
  for (let i = 0; i < clSyms.length; i++) {
    const s = clSyms[i];
    dyn.writeCode(cl.codes[s], clLen[s]);
    if (s === 16) dyn.writeBits(clExtra[i], 2);
    else if (s === 17) dyn.writeBits(clExtra[i], 3);
    else if (s === 18) dyn.writeBits(clExtra[i], 7);
  }
  for (let i = 0; i < seq.count; i++) {
    const s = seq.syms[i];
    dyn.writeCode(lit.codes[s], litLen[s]);
    if (s >= 257) {
      const k = s - 257;
      if (LEN_EXTRA[k] > 0) dyn.writeBits(seq.lens[i] - LEN_BASE[k], LEN_EXTRA[k]);
      const d = seq.dists[i];
      const dk = DIST_CODE[d];
      dyn.writeCode(dist.codes[dk], distLen[dk]);
      if (DIST_EXTRA[dk] > 0) dyn.writeBits(d - DIST_BASE[dk], DIST_EXTRA[dk]);
    }
  }
  dyn.writeCode(lit.codes[256], litLen[256]);
  const fix = new BitWriter();
  fix.writeBits(final ? 1 : 0, 1);
  fix.writeBits(1, 2); // BTYPE = fixed
  const flit = canonicalCodes(FIXED_LIT_LEN);
  const fdist = canonicalCodes(FIXED_DIST_LEN);
  for (let i = 0; i < seq.count; i++) {
    const s = seq.syms[i];
    fix.writeCode(flit.codes[s], FIXED_LIT_LEN[s]);
    if (s >= 257) {
      const k = s - 257;
      if (LEN_EXTRA[k] > 0) fix.writeBits(seq.lens[i] - LEN_BASE[k], LEN_EXTRA[k]);
      const d = seq.dists[i];
      const dk = DIST_CODE[d];
      fix.writeCode(fdist.codes[dk], 5);
      if (DIST_EXTRA[dk] > 0) fix.writeBits(d - DIST_BASE[dk], DIST_EXTRA[dk]);
    }
  }
  fix.writeCode(flit.codes[256], FIXED_LIT_LEN[256]);
  // Append the smaller of the two block encodings (by bit count).
  if (dyn.totalBits() <= fix.totalBits()) out.append(dyn);
  else out.append(fix);
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// Bytes per DEFLATE block in the optimal encoder: each block gets its own
// Huffman tables, so statistics can follow the image (flat regions, text,
// photo patches) instead of one compromise table for the whole stream.
const OPT_BLOCK_SIZE = 262144;

// A zlib stream of `data` from the optimal-parse deflate, split into blocks.
// `rowLen` is the filtered rows' length (width*bpp + 1) when known.
function deflateOptimal(data: Uint8Array, rowLen = 0): Uint8Array {
  const w = new BitWriter();
  for (let start = 0; start < data.length; start += OPT_BLOCK_SIZE) {
    const slice = data.subarray(start, Math.min(data.length, start + OPT_BLOCK_SIZE));
    const last = start + OPT_BLOCK_SIZE >= data.length;
    // Pass 1: greedy parse, only to estimate the Huffman frequencies.
    const f1 = countFreqs(greedyParse(slice, rowLen));
    const litLen1 = huffmanLengths(f1.litFreq, 15);
    const distLen1 = huffmanLengths(f1.distFreq, 15);
    const c1 = costsOf(litLen1, distLen1);
    // Pass 2: full optimal parse under those costs.
    const seq = optimalParse(slice, c1.litCost, c1.lenCost, c1.distCost, rowLen);
    const f2 = countFreqs(seq);
    const litLen = huffmanLengths(f2.litFreq, 15);
    const distLen = huffmanLengths(f2.distFreq, 15);
    if (f2.distFreq.every((v) => v === 0)) distLen[0] = 1; // no matches: dummy distance code
    encodeBlock(seq, litLen, distLen, last, w);
  }
  const body = w.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(data));
  return out;
}

// ---------------------------------------------------------------- main

const SCREEN = { level: 9, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };

function pngOfForm(width: number, height: number, form: Form, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

function compressOne(rgba: Uint8Array, width: number, height: number): Uint8Array {
  // Screen every (form, filter) candidate with zlib level 6 (fast, and its
  // ranking matches level 9's); re-weigh the three best at level 9 and keep
  // the winner. The winner's filtered data is then re-encoded with the
  // optimal-parse deflate; whichever stream is smaller is written.
  const SCREEN6 = { level: 6, memLevel: 9, strategy: constants.Z_DEFAULT_STRATEGY };
  const ranked: Array<{ bytes: number; form: Form; data: Uint8Array }> = [];
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunkOverhead =
      (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice, new Uint8Array(size));
      const zlib = deflateSync(data, SCREEN6);
      ranked.push({ bytes: zlib.length + chunkOverhead, form, data });
    }
  }
  ranked.sort((a, b) => a.bytes - b.bytes);
  let win: { bytes: number; form: Form; data: Uint8Array } = {
    bytes: Infinity,
    form: ranked[0].form,
    data: ranked[0].data,
  };
  for (const cand of ranked.slice(0, 3)) {
    const zlib = deflateSync(cand.data, SCREEN);
    const bytes =
      zlib.length +
      (cand.form.plte === null ? 0 : 12 + cand.form.plte.length) +
      (cand.form.trns === null ? 0 : 12 + cand.form.trns.length);
    if (bytes < win.bytes) win = { bytes, form: cand.form, data: cand.data };
  }
  const opt = deflateOptimal(win.data, width * win.form.bpp + 1);
  const optBytes =
    opt.length +
    (win.form.plte === null ? 0 : 12 + win.form.plte.length) +
    (win.form.trns === null ? 0 : 12 + win.form.trns.length);
  if (optBytes < win.bytes) {
    return pngOfForm(width, height, win.form, opt);
  }
  return pngOfForm(width, height, win.form, new Uint8Array(deflateSync(win.data, SCREEN)));
}

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
for (const id of readdirSync(I).sort()) {
  const { width, height, rgba } = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'image.png'), compressOne(rgba, width, height));
}
