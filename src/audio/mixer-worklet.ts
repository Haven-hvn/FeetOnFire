// AudioWorklet processor that plays the game's audio. Loaded with audioWorklet.addModule(), so
// it must stay self-contained (no imports).
//
// - Music: one buffer, already at the context's sample rate, placed on the context's frame
//   count: music frame `offsetFrames + (f - startFrame)` is rendered at context frame `f`.
//   The main thread computes music time from the same two numbers (engine.ts), so what is
//   heard and what the game believes cannot drift apart.
// - Effect sounds: short buffers started at exact context frames.
// - Publishes the frame being rendered to shared memory (when available).
//
// process() never allocates; buffers arrive in messages. The one exception is the message
// sent when the music runs out.

interface WorkletScope {
  readonly currentFrame: number;
  readonly sampleRate: number;
  registerProcessor(name: string, ctor: unknown): void;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
}

// Makes this file a module of its own, so its names do not meet those of other worklets.
export {};

const scope = globalThis as unknown as WorkletScope;

const MAX_VOICES = 16;
// Chrome hands a context that has rendered only zeros for 30 s to a timer instead of the
// audio device, and restarts the device when sound returns. Measured (docs/LATENCY.md
// section 7): the heard position steps by about +4 ms and then -30 ms, and the timer skips
// quanta. One sample far below anything audible (-120 dB) in an otherwise silent quantum
// keeps the device running.
const KEEP_AWAKE = 1e-6;
const MAX_SOUNDS = 64;

// Shared Int32 slots. Keep in step with mixer.ts.
const S_FRAME = 0; // first frame of the quantum being rendered
const S_CALLBACKS = 1;
const S_DISCONTINUITIES = 2; // times the frame count did not follow on from the last quantum
const S_GAP_FRAMES = 3; // size of the most recent one
const S_GAP_AT = 4; // frame at which it was seen
const S_MUSIC_STATE = 5; // 0 idle, 1 playing, 2 ran out
const S_MUSIC_FRAME = 6; // music frame at S_FRAME (may be negative: lead-in)

interface Message {
  type: string;
  channels?: Float32Array[];
  startFrame?: number;
  offsetFrames?: number;
  gain?: number;
  fadeFrames?: number;
  rampFrames?: number;
  id?: number;
  atFrame?: number;
  seq?: number;
}

class MixerProcessor extends scope.AudioWorkletProcessor {
  private readonly shared: Int32Array | null;
  private lastFrame = -1;
  private quantum = 128;
  private callbacks = 0;
  private discontinuities = 0;

  // Music.
  private left: Float32Array | null = null;
  private right: Float32Array | null = null;
  private frames = 0;
  private playing = false;
  private ended = false;
  private startFrame = 0;
  private offsetFrames = 0;
  private gain = 1;
  private gainTarget = 1;
  private gainStep = 0;
  private rampLeft = 0;
  private fadeTotal = 0;
  private fadeLeft = -1; // -1: not fading out
  // What the last quantum did, for the state report.
  private seenFrame = -1;
  private seenMusicFrame = 0;

  // Effect sounds.
  private readonly sounds: (Float32Array[] | null)[] = new Array<Float32Array[] | null>(MAX_SOUNDS).fill(null);
  private readonly voiceSound: (Float32Array[] | null)[] = new Array<Float32Array[] | null>(MAX_VOICES).fill(null);
  private readonly voiceStart = new Float64Array(MAX_VOICES); // -1: at the next quantum
  private readonly voiceGain = new Float32Array(MAX_VOICES);

  private readonly keepAwake: boolean;
  private awakeSign = 1;

  constructor(options?: { processorOptions?: { shared?: SharedArrayBuffer | null; keepAwake?: boolean } }) {
    super();
    const shared = options?.processorOptions?.shared;
    this.shared = shared ? new Int32Array(shared) : null;
    this.keepAwake = options?.processorOptions?.keepAwake === true;
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data as Message);
  }

  private onMessage(msg: Message): void {
    switch (msg.type) {
      case 'music': {
        const channels = msg.channels ?? [];
        this.playing = false;
        this.ended = false;
        this.left = channels[0] ?? null;
        this.right = channels[1] ?? channels[0] ?? null;
        this.frames = this.left ? this.left.length : 0;
        break;
      }
      case 'play':
        if (!this.left) break;
        this.startFrame = Math.round(msg.startFrame ?? scope.currentFrame);
        this.offsetFrames = Math.round(msg.offsetFrames ?? 0);
        this.gain = this.gainTarget = msg.gain ?? 1;
        this.rampLeft = 0;
        this.fadeLeft = -1;
        this.ended = false;
        this.playing = true;
        break;
      case 'stop': {
        const fade = Math.round(msg.fadeFrames ?? 0);
        if (!this.playing || fade <= 0) {
          this.playing = false;
        } else if (this.fadeLeft < 0) {
          this.fadeTotal = this.fadeLeft = fade;
        }
        break;
      }
      case 'gain': {
        const ramp = Math.round(msg.rampFrames ?? 0);
        this.gainTarget = msg.gain ?? 1;
        if (!this.playing || ramp <= 0) {
          this.gain = this.gainTarget;
          this.rampLeft = 0;
        } else {
          this.rampLeft = ramp;
          this.gainStep = (this.gainTarget - this.gain) / ramp;
        }
        break;
      }
      case 'sound': {
        const id = msg.id ?? -1;
        if (id < 0 || id >= MAX_SOUNDS) break;
        const channels = msg.channels && msg.channels.length > 0 && msg.channels[0]!.length > 0 ? msg.channels : null;
        // Voices still playing the old buffer are cut.
        for (let v = 0; v < MAX_VOICES; v++) if (this.voiceSound[v] === this.sounds[id]) this.voiceSound[v] = null;
        this.sounds[id] = channels;
        break;
      }
      case 'trigger': {
        const sound = this.sounds[msg.id ?? -1];
        if (!sound) break;
        // A free voice, or else the one that started first.
        let voice = 0;
        for (let v = 0; v < MAX_VOICES; v++) {
          if (this.voiceSound[v] === null) {
            voice = v;
            break;
          }
          if (this.voiceStart[v]! < this.voiceStart[voice]!) voice = v;
        }
        this.voiceSound[voice] = sound;
        this.voiceStart[voice] = msg.atFrame === undefined || msg.atFrame < 0 ? -1 : Math.round(msg.atFrame);
        this.voiceGain[voice] = msg.gain ?? 1;
        break;
      }
      case 'sync':
        this.port.postMessage({
          type: 'synced',
          seq: msg.seq,
          frame: scope.currentFrame,
          callbacks: this.callbacks,
          discontinuities: this.discontinuities,
          playing: this.playing,
          ended: this.ended,
          quantumFrame: this.seenFrame,
          musicFrame: this.seenMusicFrame,
        });
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const frame = scope.currentFrame;
    const out = outputs[0]!;
    const outLeft = out[0]!;
    const outRight = out.length > 1 ? out[1]! : null;
    const n = outLeft.length;

    this.callbacks++;
    if (this.lastFrame >= 0 && frame !== this.lastFrame + this.quantum) this.discontinuities++;
    const shared = this.shared;
    if (shared) {
      Atomics.store(shared, S_FRAME, frame | 0);
      Atomics.store(shared, S_CALLBACKS, this.callbacks | 0);
      if (this.lastFrame >= 0 && frame !== this.lastFrame + this.quantum) {
        Atomics.store(shared, S_DISCONTINUITIES, this.discontinuities | 0);
        Atomics.store(shared, S_GAP_FRAMES, (frame - this.lastFrame - this.quantum) | 0);
        Atomics.store(shared, S_GAP_AT, frame | 0);
      }
    }
    this.lastFrame = frame;
    this.quantum = n;

    const left = this.left;
    if (this.playing && left) {
      const right = this.right ?? left;
      const index = this.offsetFrames + (frame - this.startFrame); // music frame of out[0]
      this.seenFrame = frame;
      this.seenMusicFrame = index;
      // Nothing before the start frame, before music frame 0 or after the last one.
      let from = index < 0 ? -index : 0;
      if (this.startFrame - frame > from) from = this.startFrame - frame;
      const to = Math.min(n, this.frames - index);

      if (this.rampLeft === 0 && this.fadeLeft < 0) {
        const gain = this.gain;
        if (gain === 1) {
          for (let k = from; k < to; k++) outLeft[k]! += left[index + k]!;
          if (outRight) for (let k = from; k < to; k++) outRight[k]! += right[index + k]!;
        } else {
          for (let k = from; k < to; k++) outLeft[k]! += left[index + k]! * gain;
          if (outRight) for (let k = from; k < to; k++) outRight[k]! += right[index + k]! * gain;
        }
      } else {
        // The gain is moving: frame by frame.
        for (let k = 0; k < n; k++) {
          if (this.rampLeft > 0) {
            this.gain += this.gainStep;
            if (--this.rampLeft === 0) this.gain = this.gainTarget;
          }
          let gain = this.gain;
          if (this.fadeLeft >= 0) {
            gain *= this.fadeLeft / this.fadeTotal;
            if (this.fadeLeft > 0) this.fadeLeft--;
          }
          if (k >= from && k < to) {
            outLeft[k]! += left[index + k]! * gain;
            if (outRight) outRight[k]! += right[index + k]! * gain;
          }
        }
        if (this.fadeLeft === 0) {
          this.playing = false;
          this.fadeLeft = -1;
        }
      }

      if (this.playing && index + n >= this.frames) {
        this.playing = false;
        this.ended = true;
        // The context frame at which the music ran out.
        this.port.postMessage({ type: 'ended', frame: frame + Math.max(0, this.frames - index) });
      }
      if (shared) {
        Atomics.store(shared, S_MUSIC_STATE, this.playing ? 1 : this.ended ? 2 : 0);
        Atomics.store(shared, S_MUSIC_FRAME, index | 0);
      }
    } else if (shared) {
      Atomics.store(shared, S_MUSIC_STATE, this.ended ? 2 : 0);
    }

    for (let v = 0; v < MAX_VOICES; v++) {
      const sound = this.voiceSound[v];
      if (!sound) continue;
      let start = this.voiceStart[v]!;
      if (start < 0) {
        start = frame;
        this.voiceStart[v] = frame;
      }
      const sLeft = sound[0]!;
      const sRight = sound.length > 1 ? sound[1]! : sLeft;
      const index = frame - start; // sound frame of out[0]
      const from = index < 0 ? -index : 0;
      const to = Math.min(n, sLeft.length - index);
      const gain = this.voiceGain[v]!;
      for (let k = from; k < to; k++) outLeft[k]! += sLeft[index + k]! * gain;
      if (outRight) for (let k = from; k < to; k++) outRight[k]! += sRight[index + k]! * gain;
      if (index + n >= sLeft.length) this.voiceSound[v] = null;
    }

    if (this.keepAwake) {
      let silent = true;
      for (let k = 0; k < n && silent; k++) silent = outLeft[k] === 0 && (!outRight || outRight[k] === 0);
      if (silent) {
        // Alternating, so that it adds up to nothing.
        outLeft[0] = KEEP_AWAKE * this.awakeSign;
        this.awakeSign = -this.awakeSign;
      }
    }
    return true;
  }
}

scope.registerProcessor('mixer', MixerProcessor);
