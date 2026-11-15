// AudioWorklet processor for the Latency Lab. Loaded with audioWorklet.addModule(), so it
// must stay self-contained (no imports).
//
// - Publishes the frame it is rendering to shared memory (when available).
// - Plays test clicks at exact context frames.
// - Records its input (the microphone) together with the context frame of the first sample.
//
// process() never allocates; buffers are created in message handlers.

interface WorkletScope {
  readonly currentFrame: number;
  readonly sampleRate: number;
  registerProcessor(name: string, ctor: unknown): void;
  AudioWorkletProcessor: new () => { readonly port: MessagePort };
}

const scope = globalThis as unknown as WorkletScope;

const MAX_CLICKS = 1024;
// As in the game's mixer (src/audio/mixer-worklet.ts): keeps Chrome from taking the audio
// device away after 30 s of silence.
const KEEP_AWAKE = 1e-6;
// Shared Int32 slots.
const S_FRAME = 0;
const S_CALLBACKS = 1;
const S_DISCONTINUITIES = 2;
const S_GAP_FRAMES = 3; // size of the most recent discontinuity
const S_GAP_AT = 4; // frame at which it was seen

class LabProcessor extends scope.AudioWorkletProcessor {
  private readonly click: Float32Array;
  private readonly shared: Int32Array | null;
  private readonly clickFrames = new Float64Array(MAX_CLICKS);
  private clickCount = 0;
  private clickNext = 0;
  private rec: Float32Array | null = null;
  private recPos = 0;
  private recStart = -1;
  private lastFrame = -1;

  private readonly keepAwake: boolean;
  private awakeSign = 1;

  constructor(options: { processorOptions: { click: Float32Array; shared: SharedArrayBuffer | null; keepAwake?: boolean } }) {
    super();
    this.keepAwake = options.processorOptions.keepAwake === true;
    this.click = options.processorOptions.click;
    this.shared = options.processorOptions.shared ? new Int32Array(options.processorOptions.shared) : null;
    this.port.onmessage = (e: MessageEvent) => this.onMessage(e.data);
  }

  private onMessage(msg: { type: string; frames?: number[]; seconds?: number }): void {
    if (msg.type === 'clicks' && msg.frames) {
      // Drop clicks that have already been played, then append the new ones.
      if (this.clickNext > 0) {
        this.clickFrames.copyWithin(0, this.clickNext, this.clickCount);
        this.clickCount -= this.clickNext;
        this.clickNext = 0;
      }
      for (const f of msg.frames) {
        if (this.clickCount < MAX_CLICKS) this.clickFrames[this.clickCount++] = f;
      }
    } else if (msg.type === 'record' && msg.seconds) {
      this.rec = new Float32Array(Math.ceil(msg.seconds * scope.sampleRate));
      this.recPos = 0;
      this.recStart = -1;
    } else if (msg.type === 'stop') {
      this.finishRecording();
    }
  }

  private finishRecording(): void {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    this.port.postMessage({ type: 'recording', samples: rec, length: this.recPos, startFrame: this.recStart }, [rec.buffer]);
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const frame = scope.currentFrame;
    const out = outputs[0];
    const n = out[0].length;

    const shared = this.shared;
    if (shared) {
      Atomics.store(shared, S_FRAME, frame | 0);
      Atomics.add(shared, S_CALLBACKS, 1);
      if (this.lastFrame >= 0 && frame !== this.lastFrame + n) {
        Atomics.add(shared, S_DISCONTINUITIES, 1);
        Atomics.store(shared, S_GAP_FRAMES, (frame - this.lastFrame - n) | 0);
        Atomics.store(shared, S_GAP_AT, frame | 0);
      }
    }
    this.lastFrame = frame;

    // Clicks that overlap [frame, frame + n).
    const click = this.click;
    const len = click.length;
    for (let i = this.clickNext; i < this.clickCount; i++) {
      const start = this.clickFrames[i];
      if (start >= frame + n) break;
      const from = Math.max(0, frame - start);
      const to = Math.min(len, frame + n - start);
      for (let ch = 0; ch < out.length; ch++) {
        const o = out[ch];
        for (let k = from; k < to; k++) o[start + k - frame] += click[k];
      }
      if (start + len <= frame + n) this.clickNext = i + 1;
    }

    if (this.keepAwake) {
      let silent = true;
      for (let ch = 0; ch < out.length && silent; ch++) {
        const o = out[ch];
        for (let k = 0; k < n && silent; k++) silent = o[k] === 0;
      }
      if (silent) {
        out[0][0] = KEEP_AWAKE * this.awakeSign;
        this.awakeSign = -this.awakeSign;
      }
    }

    // Recording.
    const rec = this.rec;
    if (rec) {
      if (this.recStart < 0) this.recStart = frame;
      const input = inputs[0] && inputs[0][0];
      const room = Math.min(n, rec.length - this.recPos);
      if (input) {
        for (let k = 0; k < room; k++) rec[this.recPos + k] = input[k];
      }
      this.recPos += room;
      if (this.recPos >= rec.length) this.finishRecording();
    }
    return true;
  }
}

scope.registerProcessor('lab-processor', LabProcessor);
