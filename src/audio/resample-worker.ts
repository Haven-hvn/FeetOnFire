// Worker that converts audio to another sample rate, off the main thread. See resample.ts.

import { resample, resampledLength } from './resample.ts';

export interface ResampleRequest {
  id: number;
  channels: Float32Array[];
  from: number;
  to: number;
  /** Put the result in shared memory, so that it can go to the audio thread without a copy. */
  shared: boolean;
}

export interface ResampleReply {
  id: number;
  channels?: Float32Array[];
  error?: string;
}

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: ResampleReply, transfer?: Transferable[]): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.onmessage = (e: MessageEvent) => {
  const request = e.data as ResampleRequest;
  try {
    const channels = request.channels.map((channel) => {
      const length = resampledLength(channel.length, request.from, request.to);
      const out = request.shared ? new Float32Array(new SharedArrayBuffer(length * 4)) : new Float32Array(length);
      return resample(channel, request.from, request.to, out);
    });
    scope.postMessage({ id: request.id, channels }, request.shared ? [] : channels.map((channel) => channel.buffer as ArrayBuffer));
  } catch (error) {
    scope.postMessage({ id: request.id, error: String(error) });
  }
};
