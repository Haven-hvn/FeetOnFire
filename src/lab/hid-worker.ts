// WebHID in a dedicated worker: input reports are delivered here without waiting for the
// main thread. Used to compare dispatch delay against the main-thread listener.

import { toMainTime } from '../shared/clock.ts';
import { EventRing } from '../shared/ring.ts';
import { HidAnalyzer } from './hid-analyzer.ts';
import { EV_FIELDS, KIND_HID, hidApi, type HidDeviceLike, type HidReportEvent } from './hid-types.ts';

interface WorkerScope {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
}

type Command =
  | { type: 'start'; mainOrigin: number; ring: SharedArrayBuffer | null; busy: boolean }
  | { type: 'busy'; value: boolean }
  | { type: 'report' }
  | { type: 'stop' };

const scope = globalThis as unknown as WorkerScope;

let analyzer = new HidAnalyzer();
let ring: EventRing | null = null;
let mainOrigin = performance.timeOrigin;
let busy = false;
let devices: HidDeviceLike[] = [];

function onReport(e: HidReportEvent): void {
  const tHandler = toMainTime(performance.now(), performance.timeOrigin, mainOrigin);
  const tStamp = toMainTime(e.timeStamp, performance.timeOrigin, mainOrigin);
  const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
  if (analyzer.feed(tStamp, tHandler, e.reportId, bytes, busy)) {
    ring?.push([KIND_HID, e.reportId, 1, tStamp]);
    scope.postMessage({ type: 'down', t: tStamp });
  }
}

async function start(cmd: Extract<Command, { type: 'start' }>): Promise<void> {
  const api = hidApi();
  if (!api) throw new Error('WebHID is not exposed to workers in this browser');
  mainOrigin = cmd.mainOrigin;
  busy = cmd.busy;
  ring = cmd.ring ? new EventRing(cmd.ring, EV_FIELDS) : null;
  analyzer = new HidAnalyzer();
  devices = await api.getDevices();
  if (devices.length === 0) throw new Error('No permitted HID device is visible to the worker');
  for (const d of devices) {
    if (!d.opened) await d.open();
    d.addEventListener('inputreport', onReport);
  }
  scope.postMessage({ type: 'started', devices: devices.map((d) => d.productName) });
}

async function stop(): Promise<void> {
  for (const d of devices) {
    d.removeEventListener('inputreport', onReport);
    try {
      if (d.opened) await d.close();
    } catch {
      // The device may already be gone.
    }
  }
  devices = [];
  scope.postMessage({ type: 'stopped' });
}

scope.onmessage = (e: MessageEvent) => {
  const cmd = e.data as Command;
  if (cmd.type === 'start') {
    start(cmd).catch((err: unknown) => scope.postMessage({ type: 'error', message: String(err instanceof Error ? err.message : err) }));
  } else if (cmd.type === 'busy') {
    busy = cmd.value;
  } else if (cmd.type === 'report') {
    scope.postMessage({ type: 'report', report: analyzer.report() });
  } else if (cmd.type === 'stop') {
    void stop();
  }
};
