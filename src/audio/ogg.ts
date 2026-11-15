// Ogg Vorbis: reads the sample rate and channel count from the stream's first header. The
// audio itself is decoded by the browser (see decode.ts).

export interface VorbisInfo {
  sampleRate: number;
  channels: number;
}

/** How far the Vorbis library StepMania uses looks for the first page. */
const SEARCH_LIMIT = 65536;

/**
 * The identification header of an Ogg Vorbis file, or null when the bytes are not Ogg Vorbis
 * (another Ogg codec, or no Ogg page near the start).
 */
export function probeOggVorbis(bytes: Uint8Array): VorbisInfo | null {
  const last = Math.min(bytes.length - 27, SEARCH_LIMIT);
  for (let at = 0; at <= last; at++) {
    // "OggS", stream structure version 0
    if (bytes[at] !== 0x4f || bytes[at + 1] !== 0x67 || bytes[at + 2] !== 0x67 || bytes[at + 3] !== 0x53 || bytes[at + 4] !== 0) continue;
    const segments = bytes[at + 26]!;
    const body = at + 27 + segments;
    if (body + 16 > bytes.length) return null;
    // Packet type 1, "vorbis", version 0
    const magic = [0x01, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73, 0, 0, 0, 0];
    if (!magic.every((b, i) => bytes[body + i] === b)) return null;
    const channels = bytes[body + 11]!;
    const sampleRate = (bytes[body + 12]! | (bytes[body + 13]! << 8) | (bytes[body + 14]! << 16) | (bytes[body + 15]! << 24)) >>> 0;
    if (channels === 0 || sampleRate === 0) return null;
    return { sampleRate, channels };
  }
  return null;
}
