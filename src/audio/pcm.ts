// Decoded audio as the rest of the audio code passes it around.

export type AudioFormat = 'mp3' | 'ogg' | 'wav';

export interface DecodedAudio {
  sampleRate: number;
  /** One array per channel, each `frames` long. Frame 0 is music time 0, as in StepMania. */
  channels: Float32Array[];
  frames: number;
  format: AudioFormat;
  /** Which decoder produced it. */
  decoder: 'webcodecs' | 'decodeAudioData' | 'wav';
  /** Things the user may want to know, e.g. frames that were dropped. */
  notes: string[];
}

/**
 * Why a file could not be decoded.
 *   unknown: the bytes are not this format; another format may be tried.
 *   failed:  the bytes are this format but cannot be played.
 */
export class AudioDecodeError extends Error {
  readonly kind: 'unknown' | 'failed';

  constructor(kind: 'unknown' | 'failed', message: string) {
    super(message);
    this.name = 'AudioDecodeError';
    this.kind = kind;
  }
}

/** Splits interleaved samples into one array per channel. */
export function deinterleave(interleaved: Float32Array, channels: number): Float32Array[] {
  const frames = Math.floor(interleaved.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const plane = new Float32Array(frames);
    for (let i = 0, j = c; i < frames; i++, j += channels) plane[i] = interleaved[j]!;
    out.push(plane);
  }
  return out;
}
