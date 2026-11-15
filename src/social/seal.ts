// Haven framed AES-256-GCM opening. Mirrors board-core's reader layout.

const BASE_IV_BYTES = 12;
const HEADER_BYTES = 8;
const GCM_TAG_BYTES = 16;
const CHUNK_PLAINTEXT_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function deriveChunkIv(baseIv: Uint8Array, chunkIndex: number): Uint8Array {
  const iv = new Uint8Array(baseIv);
  const idx = BigInt(chunkIndex);
  for (let i = 0; i < 8; i++) {
    iv[4 + i] = (iv[4 + i] as number) ^ Number((idx >> BigInt(8 * (7 - i))) & 0xffn);
  }
  return iv;
}

function readU32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function isFramed(data: Uint8Array): boolean {
  if (data.length < BASE_IV_BYTES + HEADER_BYTES + GCM_TAG_BYTES) return false;
  let offset = BASE_IV_BYTES;
  let expected = 0;
  while (offset < data.length) {
    if (offset + HEADER_BYTES > data.length) return false;
    const index = readU32le(data, offset);
    const length = readU32le(data, offset + 4);
    if (index !== expected || length < GCM_TAG_BYTES || length > MAX_CHUNK_BYTES) return false;
    offset += HEADER_BYTES + length;
    if (offset > data.length) return false;
    expected++;
  }
  return expected > 0;
}

async function importKey(aesKey: Uint8Array): Promise<CryptoKey> {
  if (aesKey.length !== 32) throw new Error('AES key must be 32 bytes');
  return crypto.subtle.importKey('raw', toArrayBuffer(aesKey), { name: 'AES-GCM' }, false, ['decrypt']);
}

async function openFramed(sealed: Uint8Array, key: CryptoKey, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const baseIv = sealed.subarray(0, BASE_IV_BYTES);
  let chunks = 0;
  for (let offset = BASE_IV_BYTES; offset < sealed.length; ) {
    chunks++;
    offset += HEADER_BYTES + readU32le(sealed, offset + 4);
  }
  const out: Uint8Array[] = [];
  let offset = BASE_IV_BYTES;
  let expected = 0;
  while (offset < sealed.length) {
    const index = readU32le(sealed, offset);
    const length = readU32le(sealed, offset + 4);
    if (index !== expected) throw new Error('sealed chunk out of order');
    const start = offset + HEADER_BYTES;
    const ct = sealed.subarray(start, start + length);
    if (ct.length !== length) throw new Error('sealed data truncated');
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(deriveChunkIv(baseIv, index)) }, key, toArrayBuffer(ct));
    out.push(new Uint8Array(pt));
    offset = start + length;
    expected++;
    onProgress?.(expected, chunks);
    if (expected < chunks) await new Promise((r) => setTimeout(r, 0));
  }
  return concat(out);
}

async function openLegacy(sealed: Uint8Array, key: CryptoKey): Promise<Uint8Array> {
  if (sealed.length < BASE_IV_BYTES + GCM_TAG_BYTES) throw new Error('sealed data too short');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: toArrayBuffer(sealed.subarray(0, BASE_IV_BYTES)) }, key, toArrayBuffer(sealed.subarray(BASE_IV_BYTES)));
  return new Uint8Array(pt);
}

export async function openSealedBytes(sealed: Uint8Array, aesKey: Uint8Array, onProgress?: (done: number, total: number) => void): Promise<Uint8Array> {
  const key = await importKey(aesKey);
  const framed = isFramed(sealed);
  try {
    return framed ? await openFramed(sealed, key, onProgress) : await openLegacy(sealed, key);
  } catch (error) {
    if (framed) return openLegacy(sealed, key);
    return openFramed(sealed, key, onProgress);
  }
}
