// WAV reading. Port of RageSoundReader_WAV.cpp: PCM (8, 16, 24 and 32 bit), 32-bit float and
// 4-bit Microsoft ADPCM, one or two channels. The sample values are the ones StepMania
// produces (e.g. 16-bit PCM is divided by 32768).
//
// Deviations:
//   - A data chunk with a negative size (larger than 2 GB when read as StepMania reads it) is
//     taken to run to the end of the file. StepMania's behaviour there is undefined.
//   - PCM and float data under the extensible header (format 0xFFFE, what most tools write
//     for 24-bit files) is played, with a note. StepMania rejects those files.

import { AudioDecodeError, deinterleave, type DecodedAudio } from './pcm.ts';

interface WavData {
  formatTag: number;
  channels: number;
  sampleRate: number;
  blockAlign: number;
  bitsPerSample: number;
  extraFmtPos: number;
  dataPos: number;
  dataSize: number;
}

const ADAPTION_TABLE = [230, 230, 230, 230, 307, 409, 512, 614, 768, 614, 512, 409, 307, 230, 230, 230];

function tag(bytes: Uint8Array, at: number): string {
  return at + 4 <= bytes.length ? String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!) : '';
}

function parse(bytes: Uint8Array, notes: string[]): WavData {
  if (tag(bytes, 0) !== 'RIFF' || tag(bytes, 8) !== 'WAVE') throw new AudioDecodeError('unknown', 'Not a WAV file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const need = (at: number, size: number): void => {
    if (at + size > bytes.length) throw new AudioDecodeError('failed', 'WAV file ends inside a chunk header');
  };

  const data: WavData = { formatTag: 0, channels: 0, sampleRate: 0, blockAlign: 0, bitsPerSample: 0, extraFmtPos: 0, dataPos: 0, dataSize: 0 };
  let gotFormat = false;
  let gotData = false;
  let at = 12;
  while (!gotFormat || !gotData) {
    need(at, 8);
    const id = tag(bytes, at);
    const size = view.getInt32(at + 4, true);
    const body = at + 8;
    // Chunks are word-aligned.
    const next = (body + size + 1) & ~1;

    if (id === 'fmt ') {
      need(body, 18);
      if (gotFormat) notes.push('The WAV file has more than one format chunk; the last one is used.');
      data.formatTag = view.getInt16(body, true);
      data.channels = view.getInt16(body + 2, true);
      data.sampleRate = view.getInt32(body + 4, true);
      data.blockAlign = view.getInt16(body + 12, true);
      data.bitsPerSample = view.getInt16(body + 14, true);
      data.extraFmtPos = body + 18;
      if (data.formatTag === -2 && size >= 40 && body + 40 <= bytes.length) {
        // Extensible header: the real format is the first field of a GUID.
        const sub = view.getUint16(body + 24, true);
        const guidTail = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
        if ((sub === 1 || sub === 3) && guidTail.every((b, i) => bytes[body + 26 + i] === b)) {
          data.formatTag = sub;
          notes.push('The WAV file uses the extensible header, which StepMania does not play.');
        }
      }
      if (data.channels < 1 || data.channels > 2) throw new AudioDecodeError('failed', `Unsupported channel count: ${data.channels}`);
      if (data.sampleRate < 4000 || data.sampleRate > 100000) throw new AudioDecodeError('failed', `Invalid sample rate: ${data.sampleRate}`);
      gotFormat = true;
    }
    if (id === 'data') {
      data.dataPos = body;
      const most = bytes.length - body;
      if (size < 0 || most < size) {
        if (size >= 0) notes.push(`The WAV file is cut short (${most} bytes of audio data, ${size} expected).`);
        data.dataSize = most;
      } else {
        data.dataSize = size;
      }
      gotData = true;
    }
    if (next <= at) throw new AudioDecodeError('failed', 'WAV file has a chunk with an invalid size');
    at = next;
  }
  return data;
}

function decodePcm(bytes: Uint8Array, wav: WavData): Float32Array {
  const bytesPerSample = Math.ceil(wav.bitsPerSample / 8);
  if (bytesPerSample < 1 || bytesPerSample > 4) throw new AudioDecodeError('failed', `Unsupported sample size ${wav.bitsPerSample}`);
  if (wav.formatTag === 3 && wav.bitsPerSample !== 32) throw new AudioDecodeError('failed', `Unsupported float sample size ${wav.bitsPerSample}`);

  const samples = Math.floor(wav.dataSize / bytesPerSample);
  const frames = Math.floor(samples / wav.channels);
  const count = frames * wav.channels;
  const out = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset + wav.dataPos, wav.dataSize);
  if (wav.formatTag === 3) {
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  } else if (bytesPerSample === 1) {
    for (let i = 0; i < count; i++) out[i] = (view.getUint8(i) - 128) / 128;
  } else if (bytesPerSample === 2) {
    for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  } else if (bytesPerSample === 3) {
    for (let i = 0; i < count; i++) {
      const at = i * 3;
      let sample = view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getUint8(at + 2) << 16);
      if (sample & 0x800000) sample |= ~0xffffff;
      out[i] = sample / 8388608;
    }
  } else {
    // The value is turned into a float first, then divided.
    for (let i = 0; i < count; i++) out[i] = Math.fround(view.getInt32(i * 4, true)) / 2147483648;
  }
  return out;
}

const int16 = (value: number): number => (value << 16) >> 16;

function decodeAdpcm(bytes: Uint8Array, wav: WavData): Float32Array {
  if (wav.bitsPerSample !== 4) throw new AudioDecodeError('failed', `Unsupported ADPCM sample size ${wav.bitsPerSample}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new AudioDecodeError('failed', 'WAV file ends inside the ADPCM header');
  };
  if (wav.extraFmtPos + 4 > bytes.length) fail();
  const framesPerBlock = view.getInt16(wav.extraFmtPos, true);
  const numCoef = view.getInt16(wav.extraFmtPos + 2, true);
  if (numCoef < 0 || wav.extraFmtPos + 4 + numCoef * 4 > bytes.length) fail();
  const coef1: number[] = [];
  const coef2: number[] = [];
  for (let i = 0; i < numCoef; i++) {
    coef1.push(view.getInt16(wav.extraFmtPos + 4 + i * 4, true));
    coef2.push(view.getInt16(wav.extraFmtPos + 6 + i * 4, true));
  }
  if (wav.blockAlign <= 0 || framesPerBlock < 2) throw new AudioDecodeError('failed', 'Invalid ADPCM block size');

  const channels = wav.channels;
  const dataEnd = wav.dataPos + wav.dataSize;
  const headerSize = 7 * channels;
  const blocks = Math.ceil(wav.dataSize / wav.blockAlign);
  const out = new Float32Array(blocks * framesPerBlock * channels);
  let n = 0;

  const delta = [0, 0];
  const samp1 = [0, 0];
  const samp2 = [0, 0];
  const c1 = [0, 0];
  const c2 = [0, 0];
  let at = wav.dataPos;
  while (at < dataEnd) {
    // A block header cut off by the end of the file ends the audio.
    if (at + headerSize > bytes.length) break;
    for (let c = 0; c < channels; c++) {
      let predictor = view.getInt8(at + c);
      if (predictor < 0 || predictor >= numCoef) predictor = 0;
      c1[c] = coef1[predictor] ?? 0;
      c2[c] = coef2[predictor] ?? 0;
      delta[c] = view.getInt16(at + channels + c * 2, true);
      samp1[c] = view.getInt16(at + channels * 3 + c * 2, true);
      samp2[c] = view.getInt16(at + channels * 5 + c * 2, true);
    }
    at += headerSize;
    let left = Math.min(wav.blockAlign - headerSize, dataEnd - at);
    if (left <= 0) break; // a header without data gives nothing

    for (let c = 0; c < channels; c++) out[n++] = samp2[c]! / 32768;
    for (let c = 0; c < channels; c++) out[n++] = samp1[c]! / 32768;

    let buf = 0;
    let nibbles = 0;
    let done = false;
    for (let i = 2; !done && i < framesPerBlock; i++) {
      for (let c = 0; !done && c < channels; c++) {
        if (nibbles === 0) {
          if (left === 0) {
            done = true;
            continue;
          }
          buf = bytes[at++]!;
          left--;
          nibbles = 2;
        }
        const unsigned = buf >> 4;
        const signed = unsigned >= 8 ? unsigned - 16 : unsigned;
        buf = (buf << 4) & 0xff;
        nibbles--;

        let predicted = Math.trunc((samp1[c]! * c1[c]! + samp2[c]! * c2[c]!) / 256);
        if (predicted < -32768) predicted = -32768;
        if (predicted > 32767) predicted = 32767;
        const sample = int16(predicted + delta[c]! * signed);
        out[n++] = sample / 32768;

        delta[c] = Math.max(16, int16(Math.trunc((delta[c]! * ADAPTION_TABLE[unsigned]!) / 256)));
        samp2[c] = samp1[c]!;
        samp1[c] = sample;
      }
    }
    at += left; // nothing is left unless the block held more data than frames
  }
  return out.subarray(0, n - (n % channels));
}

/** True when the bytes start like a WAV file. */
export function looksLikeWav(bytes: Uint8Array): boolean {
  return tag(bytes, 0) === 'RIFF' && tag(bytes, 8) === 'WAVE';
}

/** True for a WAV file whose audio data is MP3 (format 85). */
export function wavHoldsMp3(bytes: Uint8Array): boolean {
  try {
    return parse(bytes, []).formatTag === 85;
  } catch {
    return false;
  }
}

/**
 * Decodes a WAV file. Throws AudioDecodeError: `unknown` when the bytes are not a WAV file or
 * hold MP3 data (StepMania then tries its other readers), `failed` for a WAV file it cannot
 * play.
 */
export function decodeWav(bytes: Uint8Array): DecodedAudio {
  const notes: string[] = [];
  const wav = parse(bytes, notes);
  let interleaved: Float32Array;
  switch (wav.formatTag) {
    case 1:
    case 3:
      interleaved = decodePcm(bytes, wav);
      break;
    case 2:
      interleaved = decodeAdpcm(bytes, wav);
      break;
    case 85:
      throw new AudioDecodeError('unknown', 'WAV file holding MP3 data');
    default:
      throw new AudioDecodeError('failed', `Unsupported data format ${wav.formatTag}`);
  }
  const channels = deinterleave(interleaved, wav.channels);
  return { sampleRate: wav.sampleRate, channels, frames: channels[0]!.length, format: 'wav', decoder: 'wav', notes };
}
