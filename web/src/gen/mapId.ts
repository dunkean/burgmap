import { deflateSync, inflateSync, strToU8, strFromU8 } from 'fflate';

// Wire format v1: these tables are frozen. Append-only changes require a new version.
const KEYS = ['seed', 'size', 'relief', 'coast', 'river', 'walls', 'castle', 'roads', 'style', 'culture',
  'population', 'biome', 'moat', 'cathedral', 'palace', 'monasteries', 'port', 'arena', 'activities',
  'suburbs', 'castles', 'shanty', 'site', 'center', 'seaLevel', 'contours', 'landuse', 'lang', 'labels',
  'legend', 'sprawl', 'mix', 'plan', 'map', 'settl', 'eager', 'mode', 'compose', 'set2', 'prefs',
  'hm', 'hscale', 'hsea'];
const VALUES = ['0', '1', '2', '3', 'auto', 'yes', 'no', 'none', 'some', 'many', 'single', 'double',
  'hamlet', 'village', 'town', 'city', 'capital', 'flat', 'hills', 'valley', 'mountains',
  'N', 'E', 'S', 'W', 'random', 'stream', 'river', 'major', 'parchment', 'atlas',
  'temperate', 'forest', 'desert', 'steppe', 'tropical', 'tundra', 'underdark', 'underdark-caverns',
  'e', 'a', 'l', 'custom', 'european-organic'];
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const MAX_BYTES = 1_000_000;
// Shared, frozen v1 dictionary: frequently repeated plan/list vocabulary costs no URL space.
const DICTIONARY = strToU8('{"nucleus":{"kind":"market"},"phases":[{"morphology":"organic",'
  + '"enclosure":{"shape":"circle","wall":"wall","fossil":"street","towers":"square"}}],'
  + '"faubourg":"organic","faubShare":0.2,"culture":"european-organic","population":3000,'
  + '"options":{"walls":"none","castle":"auto","cultureMix":null,"plan":null},'
  + '"weights":{"hilltop":2,"harbor":3},"waterSide":"S","hillSide":"N","margin":0.2,'
  + '"mountainFace":1,"flatness":1,"woodland":1,"centerInset":100,'
  + 'organic oval rectangular polygonal palisade ditch vanished round posad oppidum celtic-oppidum-town '
  + 'bastide grid medina hutong machiya kremlin radial concentric fortified '
  + 'russian-kremlin wizard-city french-organic roman-core chinese japanese elven dwarven barbarian '
  + 'drow-enclave duergar-hold myconid-colony phases sectors blend');

function base64(bytes: Uint8Array): string {
  let out = '', bits = 0, count = 0;
  for (const b of bytes) {
    bits = (bits << 8) | b; count += 8;
    while (count >= 6) { count -= 6; out += ALPHABET[(bits >>> count) & 63]; }
  }
  if (count) out += ALPHABET[(bits << (6 - count)) & 63];
  return out;
}
function unbase64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1 || s.length > MAX_BYTES * 2) throw new Error('Invalid map ID');
  const bytes = new Uint8Array(Math.floor(s.length * 6 / 8));
  let bits = 0, count = 0, i = 0;
  for (const c of s) {
    bits = (bits << 6) | ALPHABET.indexOf(c); count += 6;
    if (count >= 8) { count -= 8; bytes[i++] = (bits >>> count) & 255; }
  }
  if (count && (bits & ((1 << count) - 1))) throw new Error('Invalid padding');
  return bytes;
}
function varint(out: number[], n: number): void {
  do { const b = n % 128; n = Math.floor(n / 128); out.push(b | (n ? 128 : 0)); } while (n);
}
function reader(bytes: Uint8Array): { number(): number; bytes(n: number): Uint8Array; rest(): Uint8Array; done(): boolean } {
  let i = 0;
  return {
    number() {
      let n = 0, factor = 1;
      for (let k = 0; k < 4; k++) {
        if (i >= bytes.length) throw new Error('Truncated map ID');
        const b = bytes[i++]; n += (b & 127) * factor;
        if (!(b & 128)) return n;
        factor *= 128;
      }
      throw new Error('Invalid length');
    },
    bytes(n) {
      if (n > MAX_BYTES || i + n > bytes.length) throw new Error('Invalid length');
      const part = bytes.subarray(i, i + n); i += n; return part;
    },
    rest: () => bytes.subarray(i),
    done: () => i === bytes.length,
  };
}

/** Reversible map ID, independent of browser/Node APIs. No redundant generation hash. */
export function encodeMapId(query: string): string {
  const p = new URLSearchParams(query), out: number[] = [];
  for (let k = 0; k < KEYS.length; k++) {
    const value = p.get(KEYS[k]);
    if (value === null) continue;
    out.push(k);
    const v = VALUES.indexOf(value);
    if (v >= 0) varint(out, v * 2);
    else {
      // Compress the plan's JSON bytes directly instead of its legacy base64 text.
      const bytes = KEYS[k] === 'plan' ? unbase64(value) : strToU8(value);
      varint(out, bytes.length * 2 + 1);
      for (const b of bytes) out.push(b);
    }
  }
  if (out.length > MAX_BYTES) throw new Error('Map configuration is too large');
  const raw = Uint8Array.from(out);
  const compressed = deflateSync(raw, { level: 9, dictionary: DICTIONARY });
  const header: number[] = [];
  varint(header, raw.length);
  if (compressed.length + header.length < raw.length) {
    const packed = new Uint8Array(header.length + compressed.length);
    packed.set(header); packed.set(compressed, header.length);
    return '1z' + base64(packed);
  }
  return '1r' + base64(raw);
}

/** Throws for unsupported, truncated or oversized IDs; callers keep legacy query fallback. */
export function decodeMapId(id: string): URLSearchParams {
  if (!/^1[rz]/.test(id)) throw new Error('Unsupported map ID');
  let bytes = unbase64(id.slice(2));
  if (id[1] === 'z') {
    const r = reader(bytes), length = r.number();
    if (length > MAX_BYTES) throw new Error('Map configuration is too large');
    bytes = inflateSync(r.rest(), { out: new Uint8Array(length + 1), dictionary: DICTIONARY });
    if (bytes.length !== length) throw new Error('Invalid inflated length');
  }
  if (bytes.length > MAX_BYTES) throw new Error('Map configuration is too large');
  const r = reader(bytes), p = new URLSearchParams();
  while (!r.done()) {
    const key = KEYS[r.number()], tag = r.number();
    if (!key || p.has(key)) throw new Error('Invalid map field');
    let value: string;
    if (tag % 2 === 0) {
      value = VALUES[tag / 2];
      if (value === undefined) throw new Error('Invalid map value');
    } else {
      const data = r.bytes((tag - 1) / 2);
      value = key === 'plan' ? base64(data) : strFromU8(data);
    }
    p.set(key, value);
  }
  return p;
}

/** Explicit query parameters override the ID, allowing old tools and render switches. */
export function expandMapQuery(q: string | URLSearchParams): URLSearchParams {
  const outer = new URLSearchParams(q), id = outer.get('id');
  if (!id) return outer;
  let p: URLSearchParams;
  try { p = decodeMapId(id); } catch { return outer; }
  outer.forEach((value, key) => { if (key !== 'id') p.set(key, value); });
  return p;
}
