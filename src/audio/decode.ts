// Audio file decoding. The result is the audio StepMania's readers produce from the same
// file: the same frames in the same places, so music time 0 is frame 0.
//
//   MP3   The frames StepMania plays are picked out (mp3.ts) and handed one by one to the
//         browser's decoder through WebCodecs. Nothing is trimmed, as in StepMania. Where
//         WebCodecs cannot do it, decodeAudioData is used and its trimming is undone from the
//         file's encoder tag.
//   Ogg   decodeAudioData, at the file's own sample rate. Lines up with StepMania as is.
//   WAV   Own decoder (wav.ts).
//
// Measured against the reference tool: tools/audio-study and tests/e2e/audio.e2e.mjs.
//
// Needs a window: decodeAudioData does not exist in workers.

import { scanMp3, type Mp3Layout } from './mp3.ts';
import { probeOggVorbis } from './ogg.ts';
import { AudioDecodeError, type AudioFormat, type DecodedAudio } from './pcm.ts';
import { decodeWav, looksLikeWav, wavHoldsMp3 } from './wav.ts';

/** Delay of an MP3 decoder's filter bank, in frames, plus one. Decoders that trim remove it with the encoder's delay. */
const MP3_DECODER_DELAY = 529;

/** Encoder names for which the browser's decoder (FFmpeg) takes the delay from the tag. */
const TRIMMED_ENCODERS = /^(LAME|Lavf|Lavc)/;

/**
 * The formats to try for a file name, in order. As StepMania: the one the extension names
 * first, then the others.
 */
export function formatOrder(name: string): AudioFormat[] {
  const dot = name.lastIndexOf('.');
  const ext = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  const all: AudioFormat[] = ['mp3', 'ogg', 'wav'];
  const first: AudioFormat | null = ext === 'mp3' ? 'mp3' : ext === 'ogg' || ext === 'oga' ? 'ogg' : ext === 'wav' ? 'wav' : null;
  return first ? [first, ...all.filter((f) => f !== first)] : all;
}

function isOgg(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
}

/** A copy of the bytes in a buffer of their own: decodeAudioData takes the buffer away. */
function ownBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

async function browserDecode(bytes: Uint8Array, sampleRate: number, channels: number): Promise<AudioBuffer> {
  // At the file's own rate, so that the browser does not resample.
  const context = new OfflineAudioContext(channels, 1, sampleRate);
  return context.decodeAudioData(ownBuffer(bytes));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mp3ViaWebCodecs(bytes: Uint8Array, layout: Mp3Layout): Promise<Float32Array[] | string> {
  if (typeof AudioDecoder === 'undefined') return 'WebCodecs is not available';
  const config: AudioDecoderConfig = { codec: 'mp3', sampleRate: layout.sampleRate, numberOfChannels: layout.channels };
  try {
    if (!(await AudioDecoder.isConfigSupported(config)).supported) return 'the browser has no WebCodecs MP3 decoder';
  } catch (error) {
    return describe(error);
  }

  const expected = layout.pcmFrames;
  // In an object: the decoder's callbacks change it behind the compiler's back.
  const state: { planes: Float32Array[]; written: number; failure: string | null } = { planes: [], written: 0, failure: null };
  for (let c = 0; c < layout.channels; c++) state.planes.push(new Float32Array(expected));
  const decoder = new AudioDecoder({
    output: (audio) => {
      try {
        const count = audio.numberOfFrames;
        if (state.written + count > state.planes[0]!.length) {
          // More than StepMania would give: keep it, the difference is reported below.
          state.planes = state.planes.map((plane) => {
            const larger = new Float32Array(Math.max(state.written + count, plane.length + 16384));
            larger.set(plane);
            return larger;
          });
        }
        for (let c = 0; c < state.planes.length; c++) {
          const planeIndex = Math.min(c, audio.numberOfChannels - 1);
          audio.copyTo(state.planes[c]!.subarray(state.written, state.written + count), { planeIndex, format: 'f32-planar' });
        }
        state.written += count;
      } catch (error) {
        state.failure ??= describe(error);
      } finally {
        audio.close();
      }
    },
    error: (error) => {
      state.failure ??= describe(error);
    },
  });
  try {
    decoder.configure(config);
    const microsPerFrame = (layout.samplesPerFrame * 1e6) / layout.sampleRate;
    for (let i = 0; i < layout.offsets.length && state.failure === null; i++) {
      const data = bytes.subarray(layout.offsets[i]!, layout.offsets[i]! + layout.sizes[i]!);
      decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(i * microsPerFrame), duration: Math.round(microsPerFrame), data }));
      // Let the decoder catch up now and then, so the queue stays short.
      if (decoder.decodeQueueSize > 256) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    if (state.failure === null) await decoder.flush();
  } catch (error) {
    state.failure ??= describe(error);
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }
  if (state.failure !== null) return state.failure;
  if (state.written !== expected) return `the decoder gave ${state.written} frames where ${expected} were expected`;
  return state.planes;
}

async function mp3ViaDecodeAudioData(bytes: Uint8Array, layout: Mp3Layout, notes: string[]): Promise<Float32Array[]> {
  let buffer: AudioBuffer;
  try {
    buffer = await browserDecode(bytes, layout.sampleRate, layout.channels);
  } catch (error) {
    throw new AudioDecodeError('failed', `The browser could not decode this MP3 file (${describe(error)})`);
  }
  // The browser does not play the tag frame, and removes the encoder's and the decoder's delay
  // when the tag gives them. StepMania keeps the delay, plays an `Info` frame, and plays any
  // tag frame it does not recognise. `shift` is where the browser's first frame belongs in
  // StepMania's output.
  const seen = layout.decoderTag;
  let shift = 0;
  if (seen !== null) {
    shift += layout.samplesPerFrame;
    if (seen.encoderDelay !== null && seen.encoder !== null && TRIMMED_ENCODERS.test(seen.encoder)) shift += seen.encoderDelay + MP3_DECODER_DELAY;
  }
  if (layout.tag !== null && layout.tag.type === 'xing') shift -= layout.samplesPerFrame;
  const planes: Float32Array[] = [];
  for (let c = 0; c < layout.channels; c++) {
    const plane = new Float32Array(Math.max(layout.pcmFrames, 0));
    const source = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
    const skip = Math.max(0, -shift);
    const at = Math.max(0, shift);
    const count = Math.min(source.length - skip, plane.length - at);
    if (count > 0) plane.set(source.subarray(skip, skip + count), at);
    planes.push(plane);
  }
  notes.push('Decoded with the browser\'s general decoder; the start of the audio is placed from the file\'s encoder tag and may be slightly off.');
  return planes;
}

async function decodeMp3(bytes: Uint8Array): Promise<DecodedAudio> {
  // Deviation: a file that starts as Ogg or WAV is not searched for MP3 frames. StepMania's
  // MP3 reader does search, and nearly always finds nothing it can decode.
  if (isOgg(bytes) || (looksLikeWav(bytes) && !wavHoldsMp3(bytes))) throw new AudioDecodeError('unknown', 'Not an MP3 file');
  const layout = scanMp3(bytes);
  if (layout === null) throw new AudioDecodeError('unknown', 'No MP3 audio found');

  const notes: string[] = [];
  if (layout.droppedChecksum > 0) notes.push(`${layout.droppedChecksum} MP3 frame(s) with a wrong checksum were left out, as StepMania does.`);
  if (layout.droppedChannels > 0) notes.push(`${layout.droppedChannels} MP3 frame(s) with a different channel count were left out, as StepMania does.`);
  if (layout.mixed) notes.push('The MP3 file changes sample rate or layer part-way; it will not play correctly.');

  let channels: Float32Array[];
  let decoder: DecodedAudio['decoder'] = 'webcodecs';
  const result = layout.offsets.length === 0 ? [] : await mp3ViaWebCodecs(bytes, layout);
  if (typeof result === 'string') {
    notes.push(`WebCodecs could not be used (${result}).`);
    channels = await mp3ViaDecodeAudioData(bytes, layout, notes);
    decoder = 'decodeAudioData';
  } else {
    channels = result;
  }
  if (channels.length === 0) for (let c = 0; c < layout.channels; c++) channels.push(new Float32Array(0));
  return { sampleRate: layout.sampleRate, channels, frames: channels[0]!.length, format: 'mp3', decoder, notes };
}

async function decodeOgg(bytes: Uint8Array): Promise<DecodedAudio> {
  const info = probeOggVorbis(bytes);
  if (info === null) throw new AudioDecodeError('unknown', 'Not an Ogg Vorbis file');
  const notes: string[] = [];
  let buffer: AudioBuffer;
  try {
    buffer = await browserDecode(bytes, info.sampleRate, Math.min(info.channels, 2));
  } catch (error) {
    throw new AudioDecodeError('failed', `The browser could not decode this Ogg Vorbis file (${describe(error)})`);
  }
  if (buffer.sampleRate !== info.sampleRate) throw new AudioDecodeError('failed', `The browser decoded at ${buffer.sampleRate} Hz instead of ${info.sampleRate} Hz`);
  if (buffer.numberOfChannels > 2) notes.push(`The file has ${buffer.numberOfChannels} channels; the first two are used.`);
  const channels: Float32Array[] = [];
  for (let c = 0; c < Math.min(buffer.numberOfChannels, 2); c++) channels.push(buffer.getChannelData(c).slice());
  return { sampleRate: info.sampleRate, channels, frames: buffer.length, format: 'ogg', decoder: 'decodeAudioData', notes };
}

const DECODERS: Record<AudioFormat, (bytes: Uint8Array) => Promise<DecodedAudio>> = {
  mp3: decodeMp3,
  ogg: decodeOgg,
  wav: async (bytes) => decodeWav(bytes),
};

/**
 * Decodes an audio file. `name` is the file's name; its extension decides which format is
 * tried first. Throws AudioDecodeError when the file cannot be played.
 */
export async function decodeAudioFile(bytes: Uint8Array, name: string): Promise<DecodedAudio> {
  let last: AudioDecodeError | null = null;
  for (const format of formatOrder(name)) {
    try {
      return await DECODERS[format](bytes);
    } catch (error) {
      // A file that is of this format but broken is not tried as anything else.
      if (!(error instanceof AudioDecodeError) || error.kind === 'failed') throw error;
      last = error;
    }
  }
  throw new AudioDecodeError('failed', `"${name}" is not an MP3, Ogg Vorbis or WAV file${last ? ` (${last.message})` : ''}`);
}
