// Main-thread side of the mixer worklet (mixer-worklet.ts). Works on any audio context,
// including an OfflineAudioContext, which is how the tests check it sample by sample.

import mixerWorkletUrl from './mixer-worklet.ts?worker&url';

/** What the worklet reports when asked. */
export interface MixerState {
  /** First frame of the next quantum to be rendered. */
  frame: number;
  callbacks: number;
  /** Times the frame count did not follow on from the previous quantum. */
  discontinuities: number;
  playing: boolean;
  /** True once the music has run out. */
  ended: boolean;
  /** First frame of the last quantum in which music was placed, and the music frame placed there. */
  quantumFrame: number;
  musicFrame: number;
}

// Shared Int32 slots. Keep in step with mixer-worklet.ts.
export const MIXER_SLOT = { frame: 0, callbacks: 1, discontinuities: 2, gapFrames: 3, gapAt: 4, musicState: 5, musicFrame: 6 } as const;
const SLOTS = 8;

function canShare(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

/** Buffers to hand over with a message: every buffer once, shared ones left out. */
function transferList(channels: Float32Array[]): Transferable[] {
  const list: Transferable[] = [];
  for (const channel of channels) {
    const buffer = channel.buffer;
    if (buffer instanceof ArrayBuffer && !list.includes(buffer)) list.push(buffer);
  }
  return list;
}

export class Mixer {
  readonly context: BaseAudioContext;
  readonly node: AudioWorkletNode;
  /** The worklet's counters (MIXER_SLOT), or null where memory cannot be shared. */
  readonly shared: Int32Array | null;
  /** Called with the context frame at which the music ran out. */
  onEnded: ((frame: number) => void) | null = null;

  private seq = 0;
  private readonly waiting = new Map<number, (state: MixerState) => void>();

  private constructor(context: BaseAudioContext, node: AudioWorkletNode, shared: Int32Array | null) {
    this.context = context;
    this.node = node;
    this.shared = shared;
    node.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; seq: number; frame: number } & MixerState;
      if (msg.type === 'ended') {
        this.onEnded?.(msg.frame);
      } else if (msg.type === 'synced') {
        const done = this.waiting.get(msg.seq);
        this.waiting.delete(msg.seq);
        done?.({
          frame: msg.frame,
          callbacks: msg.callbacks,
          discontinuities: msg.discontinuities,
          playing: msg.playing,
          ended: msg.ended,
          quantumFrame: msg.quantumFrame,
          musicFrame: msg.musicFrame,
        });
      }
    };
  }

  /**
   * Loads the worklet into `context` and connects it to the output.
   *
   * `keepAwake` (on for a real-time context) makes silence not quite silent, so that the
   * browser does not take the audio device away after 30 s of it: see mixer-worklet.ts.
   */
  static async create(context: BaseAudioContext, options: { keepAwake?: boolean } = {}): Promise<Mixer> {
    const keepAwake = options.keepAwake ?? (typeof OfflineAudioContext === 'undefined' || !(context instanceof OfflineAudioContext));
    await context.audioWorklet.addModule(mixerWorkletUrl);
    const sab = canShare() ? new SharedArrayBuffer(SLOTS * 4) : null;
    const node = new AudioWorkletNode(context, 'mixer', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { shared: sab, keepAwake },
    });
    node.connect(context.destination);
    return new Mixer(context, node, sab ? new Int32Array(sab) : null);
  }

  /**
   * Sets the music: one or two channels at the context's sample rate. Stops what is playing.
   * The arrays are handed over to the worklet and can no longer be used here, unless they are
   * backed by shared memory.
   */
  setMusic(channels: Float32Array[]): void {
    this.node.port.postMessage({ type: 'music', channels }, transferList(channels));
  }

  clearMusic(): void {
    this.node.port.postMessage({ type: 'music', channels: [] });
  }

  /**
   * Plays the music so that music frame `offsetFrames` is rendered at context frame
   * `startFrame`; nothing is rendered before it. A negative `offsetFrames` gives silence
   * until music frame 0 comes up.
   */
  play(startFrame: number, offsetFrames: number, gain = 1): void {
    this.node.port.postMessage({ type: 'play', startFrame, offsetFrames, gain });
  }

  stop(fadeFrames = 0): void {
    this.node.port.postMessage({ type: 'stop', fadeFrames });
  }

  setGain(gain: number, rampFrames = 256): void {
    this.node.port.postMessage({ type: 'gain', gain, rampFrames });
  }

  /** Stores an effect sound under `id` (0..63). The arrays are handed over, as with setMusic. */
  setSound(id: number, channels: Float32Array[]): void {
    this.node.port.postMessage({ type: 'sound', id, channels }, transferList(channels));
  }

  /** Starts sound `id` at context frame `atFrame`, or at once when it is left out. */
  trigger(id: number, atFrame = -1, gain = 1): void {
    this.node.port.postMessage({ type: 'trigger', id, atFrame, gain });
  }

  /** Resolves once the worklet has handled everything sent before, with its state. */
  sync(): Promise<MixerState> {
    return new Promise((resolve) => {
      const seq = ++this.seq;
      this.waiting.set(seq, resolve);
      this.node.port.postMessage({ type: 'sync', seq });
    });
  }
}
