// A small zip reader: lists the entries of a zip file and gives the bytes of each. Reads only
// the parts of the file it needs (the directory at the end, then one entry at a time), so a
// large pack is never held in memory whole. Inflating is the platform's DecompressionStream.
//
// Supported: stored and deflated entries. Not supported: zip64 (files over 4 GB or more than
// 65,535 entries), encryption, other compression methods; those entries are reported.
// No DOM dependencies: runs under Node for tests.

export interface ZipEntry {
  /** Path inside the archive, with '/' separators. */
  path: string;
  size: number;
  /** Null when the entry can be read; else why not. */
  problem: string | null;
  /** The entry's content. */
  blob(): Promise<Blob>;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** Refuse to inflate an entry that claims more than this (a damaged or hostile archive). */
const MAX_ENTRY_BYTES = 1 << 30;

async function view(blob: Blob, start: number, end: number): Promise<DataView> {
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8) {
    // Not flagged as UTF-8: most tools write UTF-8 anyway. Fall back to Latin-1 if it is not.
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder('latin1').decode(bytes);
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/** Lists a zip file. Throws when the file is not a zip or is a zip64 archive. */
export async function readZip(file: Blob): Promise<ZipEntry[]> {
  // The end record is the last thing in the file, followed only by a comment of up to 64 KB.
  const tailStart = Math.max(0, file.size - (0xffff + 22));
  const tail = await view(file, tailStart, file.size);
  let at = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === EOCD) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('Not a zip file');
  const count = tail.getUint16(at + 10, true);
  const dirSize = tail.getUint32(at + 12, true);
  const dirOffset = tail.getUint32(at + 16, true);
  if (count === 0xffff || dirOffset === 0xffffffff || dirSize === 0xffffffff) throw new Error('Zip64 archives are not supported');
  // The directory ends where the end record begins.
  if (dirOffset + dirSize > tailStart + at) throw new Error('The zip file is cut short');

  const dir = await view(file, dirOffset, dirOffset + dirSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let n = 0; n < count && p + 46 <= dir.byteLength; n++) {
    if (dir.getUint32(p, true) !== CENTRAL) break;
    const flags = dir.getUint16(p + 8, true);
    const method = dir.getUint16(p + 10, true);
    const packed = dir.getUint32(p + 20, true);
    const size = dir.getUint32(p + 24, true);
    const nameLength = dir.getUint16(p + 28, true);
    const extraLength = dir.getUint16(p + 30, true);
    const commentLength = dir.getUint16(p + 32, true);
    const localOffset = dir.getUint32(p + 42, true);
    const name = decodeName(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength), (flags & 0x800) !== 0);
    p += 46 + nameLength + extraLength + commentLength;

    const path = name.replace(/\\/g, '/');
    if (path.endsWith('/')) continue; // a directory
    let problem: string | null = null;
    if (flags & 1) problem = 'encrypted';
    else if (method !== 0 && method !== 8) problem = `compression method ${method}`;
    else if (packed === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) problem = 'zip64 entry';
    else if (size > MAX_ENTRY_BYTES) problem = 'too large';

    entries.push({
      path,
      size,
      problem,
      async blob(): Promise<Blob> {
        if (problem) throw new Error(`${path}: ${problem}`);
        const local = await view(file, localOffset, localOffset + 30);
        if (local.byteLength < 30 || local.getUint32(0, true) !== LOCAL) throw new Error(`${path}: damaged entry`);
        const start = localOffset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
        const data = file.slice(start, start + packed);
        if (method === 0) return data;
        const inflated = await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        if (inflated.size !== size) throw new Error(`${path}: damaged entry`);
        return inflated;
      },
    });
  }
  return entries;
}
