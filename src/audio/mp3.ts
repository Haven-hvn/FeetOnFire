// MP3 frame layout, read the way StepMania's MP3 reader walks a file (RageSoundReader_MP3.cpp
// with libmad's frame search). The reader's output is the plain decoder output of the frames
// it accepts, one after the other from music time 0, so which frames it accepts decides where
// the audio starts:
//
//   - Nothing is trimmed. The encoder's and decoder's start delay stay in the output.
//   - ID3v2 tags and other bytes before the first frame are skipped.
//   - A first frame holding a `Xing` tag is skipped. One holding an `Info` tag is played (it
//     decodes to silence), which moves the music one frame later.
//   - A frame whose checksum is wrong is dropped.
//   - A frame with a different channel count than the first played frame gives no output.
//   - A frame cut off by the end of the file is dropped.
//   - The search for the next frame gives up after about 32 KB without one (tags not
//     counted). When that happens before the first frame, the file is not taken as MP3. The
//     exact figure in StepMania depends on how its read buffer happens to be filled.
//
// Not covered, because it needs the decoder itself: frames whose audio data is damaged
// (StepMania drops most of those). Free-format streams (bitrate index 0) are not supported
// here; StepMania plays them. Layers I and II are listed like layer III, but the browser's
// decoder may not play them.

export interface Mp3Header {
  /** 1, 2 or 2.5 */
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  /** True when a 16-bit checksum follows the header. */
  protection: boolean;
  /** Bits per second. */
  bitrate: number;
  sampleRate: number;
  channels: 1 | 2;
  /** Frame length in bytes, header included. */
  size: number;
  /** PCM frames this frame decodes to. */
  samples: number;
}

const BITRATES: readonly (readonly number[])[] = [
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // MPEG-1 layer I
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // MPEG-1 layer II
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 layer III
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], // MPEG-2 layer I
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2 layers II and III
];
const SAMPLE_RATES = [44100, 48000, 32000] as const;
/** Two fills of StepMania's 16 KB read buffer: how far it looks for a frame. */
const SEARCH_LIMIT = 2 * (16384 - 8);

function isSync(bytes: Uint8Array, at: number): boolean {
  return at + 1 < bytes.length && bytes[at] === 0xff && (bytes[at + 1]! & 0xe0) === 0xe0;
}

/** The frame header at `at`, or null where libmad would not take the four bytes as one. */
export function parseMp3Header(bytes: Uint8Array, at: number): Mp3Header | null {
  if (at + 4 > bytes.length || !isSync(bytes, at)) return null;
  const b1 = bytes[at + 1]!;
  const b2 = bytes[at + 2]!;
  const b3 = bytes[at + 3]!;
  const versionBits = (b1 >> 3) & 3;
  if (versionBits === 1) return null; // reserved
  const layerBits = (b1 >> 1) & 3;
  if (layerBits === 0) return null;
  const bitrateIndex = b2 >> 4;
  if (bitrateIndex === 15 || bitrateIndex === 0) return null; // 0 is free format: not supported
  const rateIndex = (b2 >> 2) & 3;
  if (rateIndex === 3) return null;

  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  const lsf = version !== 1;
  const row = lsf ? (layer === 1 ? 3 : 4) : layer - 1;
  const bitrate = BITRATES[row]![bitrateIndex]! * 1000;
  const sampleRate = SAMPLE_RATES[rateIndex]! / (version === 1 ? 1 : version === 2 ? 2 : 4);
  const padding = (b2 >> 1) & 1;
  const channels = b3 >> 6 === 3 ? 1 : 2;

  let size: number;
  let samples: number;
  if (layer === 1) {
    size = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    samples = 384;
  } else {
    const slots = layer === 3 && lsf ? 72 : 144;
    size = Math.floor((slots * bitrate) / sampleRate) + padding;
    samples = layer === 3 && lsf ? 576 : 1152;
  }
  return { version, layer, protection: (b1 & 1) === 0, bitrate, sampleRate, channels, size, samples };
}

/** Bytes of layer III side information. */
function sideInfoSize(h: Mp3Header): number {
  return h.version === 1 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
}

function crc16(bytes: Uint8Array, from: number, to: number, crc: number): number {
  for (let i = from; i < to; i++) {
    crc ^= bytes[i]! << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** True unless the frame carries a checksum that does not match (layer III only). */
function checksumOk(bytes: Uint8Array, at: number, h: Mp3Header): boolean {
  if (!h.protection || h.layer !== 3) return true;
  const side = sideInfoSize(h);
  if (at + 6 + side > bytes.length) return true;
  const target = (bytes[at + 4]! << 8) | bytes[at + 5]!;
  let crc = crc16(bytes, at + 2, at + 4, 0xffff);
  crc = crc16(bytes, at + 6, at + 6 + side, crc);
  return crc === target;
}

/**
 * Size of an ID3 tag starting at `at`: 128 for ID3v1, the full size for ID3v2, -1 for an ID3v2
 * footer (StepMania's reader stops at one), 0 for no tag.
 */
function id3Size(bytes: Uint8Array, at: number): number {
  const left = bytes.length - at;
  if (left >= 3 && bytes[at] === 0x54 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x47) return 128; // "TAG"
  if (left < 10) return 0;
  const head = bytes[at] === 0x49 && bytes[at + 1] === 0x44 && bytes[at + 2] === 0x33; // "ID3"
  const foot = bytes[at] === 0x33 && bytes[at + 1] === 0x44 && bytes[at + 2] === 0x49; // "3DI"
  if (!head && !foot) return 0;
  if (bytes[at + 3]! >= 0xff || bytes[at + 4]! >= 0xff) return 0;
  for (let i = 6; i < 10; i++) if (bytes[at + i]! >= 0x80) return 0;
  if (foot) return -1;
  const size = (bytes[at + 6]! << 21) | (bytes[at + 7]! << 14) | (bytes[at + 8]! << 7) | bytes[at + 9]!;
  const footer = (bytes[at + 5]! & 0x10) !== 0;
  return 10 + size + (footer ? 10 : 0);
}

export interface Mp3Tag {
  /** `Xing`: the frame is skipped. `Info`: the frame is played as silence. */
  type: 'xing' | 'info';
  /** Byte offset of the frame that holds the tag. */
  offset: number;
  /** Frame count from the tag, when present. */
  frames: number | null;
  /** Encoder name from the LAME extension, e.g. "LAME3.100" or "Lavc61.3". */
  encoder: string | null;
  /** Samples the encoder put before the audio (LAME extension), when present. */
  encoderDelay: number | null;
  /** Samples the encoder added after the audio (LAME extension), when present. */
  encoderPadding: number | null;
}

export interface Mp3Layout {
  sampleRate: number;
  channels: 1 | 2;
  layer: 1 | 2 | 3;
  /** PCM frames per MP3 frame. */
  samplesPerFrame: number;
  /** Byte offsets of the frames that are played, in order. */
  offsets: Uint32Array;
  /** Their sizes in bytes. */
  sizes: Uint32Array;
  /** PCM frames in StepMania's output: played frames times samplesPerFrame. */
  pcmFrames: number;
  /** The tag in the first frame, if any, as StepMania finds it. */
  tag: Mp3Tag | null;
  /**
   * The tag as decoders that trim find it: at a fixed place in the first frame, whatever else
   * the frame holds. LAME writes it there, which in a frame with a checksum is not where
   * StepMania looks: such a file has a tag here and none in `tag`.
   */
  decoderTag: Mp3Tag | null;
  /** Bytes before the first frame (tags and junk). */
  leadingBytes: number;
  /** Frames dropped for a wrong checksum. */
  droppedChecksum: number;
  /** Frames that give no output because their channel count differs from the first. */
  droppedChannels: number;
  /** True when a played frame has another sample rate or layer than the first. */
  mixed: boolean;
}

/**
 * The Xing or Info tag of the frame at `at`. With `fixed`, looked for as trimming decoders do
 * (Mp3Layout.decoderTag); otherwise as StepMania does.
 */
function readTag(bytes: Uint8Array, at: number, h: Mp3Header, fixed = false): Mp3Tag | null {
  if (h.layer !== 3) return null;
  const sideStart = at + 4 + (h.protection && !fixed ? 2 : 0);
  let p = sideStart + sideInfoSize(h);
  const end = at + h.size;
  if (p + 8 > end) return null;
  // StepMania: the tag sits where the frame's audio data would start; that is only directly
  // after the side information when the frame carries no audio data.
  if (!fixed) for (let i = sideStart; i < p; i++) if (bytes[i] !== 0) return null;
  const magic = String.fromCharCode(bytes[p]!, bytes[p + 1]!, bytes[p + 2]!, bytes[p + 3]!);
  if (magic !== 'Xing' && magic !== 'Info') return null;
  const u32 = (o: number): number => ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  const flags = u32(p + 4);
  p += 8;
  let frames: number | null = null;
  if (flags & 1) {
    if (p + 4 > end) return null;
    frames = u32(p);
    p += 4;
  }
  if (flags & 2) {
    if (p + 4 > end) return null;
    p += 4;
  }
  if (flags & 4) {
    if (p + 100 > end) return null;
    p += 100;
  }
  if (flags & 8) {
    if (p + 4 > end) return null;
    p += 4;
  }
  const tag: Mp3Tag = { type: magic === 'Xing' ? 'xing' : 'info', offset: at, frames, encoder: null, encoderDelay: null, encoderPadding: null };
  // LAME extension: 9 bytes of encoder name, then 12 bytes, then delay and padding (12 bits each).
  if (p + 24 <= end) {
    let name = '';
    for (let i = 0; i < 9; i++) {
      const c = bytes[p + i]!;
      if (c < 0x20 || c > 0x7e) break;
      name += String.fromCharCode(c);
    }
    if (name.length >= 4) {
      tag.encoder = name.trim();
      const d = p + 21;
      tag.encoderDelay = (bytes[d]! << 4) | (bytes[d + 1]! >> 4);
      tag.encoderPadding = ((bytes[d + 1]! & 0x0f) << 8) | bytes[d + 2]!;
    }
  }
  return tag;
}

/**
 * Walks the file as StepMania's reader does and lists the frames it plays. Returns null when
 * no frame is found (StepMania then does not take the file as MP3).
 */
export function scanMp3(bytes: Uint8Array): Mp3Layout | null {
  const n = bytes.length;
  const offsets: number[] = [];
  const sizes: number[] = [];
  let first: Mp3Header | null = null;
  let firstPending = true; // the next accepted frame is checked for a tag
  let tag: Mp3Tag | null = null;
  let decoderTag: Mp3Tag | null = null;
  let leadingBytes = 0;
  let droppedChecksum = 0;
  let droppedChannels = 0;
  let mixed = false;

  let at = 0;
  let inSync = true; // a header is expected exactly at `at`
  let searchFrom = 0; // where the search for the next played frame started, tags taken out
  for (;;) {
    let start: number;
    if (inSync) {
      if (at > n) break;
      if (!isSync(bytes, at)) {
        const tagSize = id3Size(bytes, at);
        if (tagSize < 0) break;
        if (tagSize > 0) {
          at += tagSize;
          searchFrom += tagSize;
          continue;
        }
        inSync = false;
        at += 1;
        continue;
      }
      start = at;
    } else {
      start = at;
      while (start < n - 1 && !isSync(bytes, start)) start++;
      if (!isSync(bytes, start)) break;
      if (start - searchFrom > SEARCH_LIMIT) break;
    }

    const h = parseMp3Header(bytes, start);
    if (h === null) {
      inSync = false;
      at = start + 1;
      continue;
    }
    if (start + h.size > n) break; // cut off by the end of the file
    if (start + h.size - searchFrom > SEARCH_LIMIT) break; // too far without a frame
    if (!inSync) {
      // After a search, a frame only counts when another header follows it.
      if (!isSync(bytes, start + h.size)) {
        at = start + 1;
        continue;
      }
      inSync = true;
    }
    at = start + h.size;

    if (!checksumOk(bytes, start, h)) {
      droppedChecksum++;
      continue;
    }
    if (firstPending) {
      firstPending = false;
      tag = readTag(bytes, start, h);
      decoderTag = readTag(bytes, start, h, true);
      if (tag !== null && tag.type === 'xing') continue; // skipped
    }
    if (first === null) {
      first = h;
      leadingBytes = start;
    } else {
      if (h.channels !== first.channels) {
        droppedChannels++;
        searchFrom = at;
        continue;
      }
      if (h.sampleRate !== first.sampleRate || h.layer !== first.layer) mixed = true;
    }
    offsets.push(start);
    sizes.push(h.size);
    searchFrom = at;
  }

  if (first === null) return null;
  return {
    sampleRate: first.sampleRate,
    channels: first.channels,
    layer: first.layer,
    samplesPerFrame: first.samples,
    offsets: Uint32Array.from(offsets),
    sizes: Uint32Array.from(sizes),
    pcmFrames: offsets.length * first.samples,
    tag,
    decoderTag,
    leadingBytes,
    droppedChecksum,
    droppedChannels,
    mixed,
  };
}
