// Input section of the Latency Lab: how good are the timestamps of keyboard, Gamepad API
// and WebHID events, and how long do the events wait before a handler runs.
//
// Every "down" is also written to an EventRing so the video worker can measure how old
// an input is when a frame starts.

import { EventRing } from '../shared/ring.ts';
import { Series, round, roundSummary, summarize } from '../shared/stats.ts';
import { HidAnalyzer } from './hid-analyzer.ts';
import { EV_FIELDS, KIND_HID, KIND_KEY, KIND_PAD, hidApi, type HidDeviceLike, type HidReportEvent } from './hid-types.ts';

const RING_CAPACITY = 1024;
const BUSY_SPIN_MS = 30;
const BUSY_IDLE_MS = 5;
const AXIS_THRESHOLD = 0.5;

export type HidMode = 'main' | 'worker';

interface PadState {
  id: string;
  timestamp: number;
  buttons: Uint8Array;
  axes: Int8Array;
}

function sharedBuffer(ring: EventRing): SharedArrayBuffer | null {
  return ring.isShared ? (ring.buffer as SharedArrayBuffer) : null;
}

export class InputLab {
  /** Written by the main thread (keyboard, gamepad, WebHID main mode). */
  readonly ring = EventRing.create(RING_CAPACITY, EV_FIELDS);
  /** Written by the HID worker. Separate because a ring has exactly one producer. */
  readonly workerRing = EventRing.create(RING_CAPACITY, EV_FIELDS);
  /** Timestamp (ms, main timebase) of every "down" from any source. */
  readonly taps: number[] = [];

  busy = false;

  // Keyboard
  private kbdOn = false;
  private kbdDowns = 0;
  private readonly kbdIdle = new Series();
  private readonly kbdBusy = new Series();

  // Gamepad
  private padOn = false;
  private padChannel: MessageChannel | null = null;
  private padPolls = 0;
  private padStart = 0;
  private padStop = 0;
  private padPresses = 0;
  private readonly pads = new Map<number, PadState>();
  private readonly padIntervals = new Series();
  private readonly padLag = new Series();

  // WebHID
  private devices: HidDeviceLike[] = [];
  private hidMode: HidMode | null = null;
  private hid = new HidAnalyzer();
  private hidWorker: Worker | null = null;
  private hidWorkerError = '';
  private hidWorkerDevices: string[] = [];
  private lastWorkerReport: Record<string, unknown> | null = null;
  private workerReportWaiters: ((r: Record<string, unknown> | null) => void)[] = [];

  /** Buffers for the video worker; null entries when shared memory is unavailable. */
  sharedRings(): (SharedArrayBuffer | null)[] {
    return [sharedBuffer(this.ring), sharedBuffer(this.workerRing)];
  }

  // ---------------------------------------------------------------- keyboard

  get keyboardActive(): boolean {
    return this.kbdOn;
  }

  startKeyboard(): void {
    if (this.kbdOn) return;
    this.kbdOn = true;
    this.kbdDowns = 0;
    this.kbdIdle.clear();
    this.kbdBusy.clear();
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
  }

  stopKeyboard(): void {
    this.kbdOn = false;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
  }

  private onKey = (e: KeyboardEvent): void => {
    const tHandler = performance.now();
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab' || e.key === 'Escape' || /^F\d+$/.test(e.key)) return;
    if (isTextEntry(e.target)) return;
    e.preventDefault(); // keep arrows and space from scrolling or pressing buttons
    const down = e.type === 'keydown';
    this.ring.push([KIND_KEY, e.keyCode, down ? 1 : 0, e.timeStamp]);
    if (!down) return;
    this.kbdDowns++;
    (this.busy ? this.kbdBusy : this.kbdIdle).push(tHandler - e.timeStamp);
    this.taps.push(e.timeStamp);
  };

  // ------------------------------------------------------- busy main thread

  /** Keep the main thread busy in 30 ms bursts to show what a loaded page does to input. */
  setBusy(on: boolean): void {
    if (this.busy === on) return;
    this.busy = on;
    this.hidWorker?.postMessage({ type: 'busy', value: on });
    if (on) this.spin();
  }

  private spin = (): void => {
    if (!this.busy) return;
    const end = performance.now() + BUSY_SPIN_MS;
    while (performance.now() < end) {
      // burn
    }
    setTimeout(this.spin, BUSY_IDLE_MS);
  };

  // ----------------------------------------------------------------- gamepad

  get gamepadActive(): boolean {
    return this.padOn;
  }

  /** Poll the Gamepad API as fast as the event loop allows (uses a full core while on). */
  startGamepad(): void {
    if (this.padOn) return;
    this.padOn = true;
    this.padPolls = 0;
    this.padPresses = 0;
    this.padStart = performance.now();
    this.pads.clear();
    this.padIntervals.clear();
    this.padLag.clear();
    const channel = new MessageChannel();
    channel.port1.onmessage = this.pollPads;
    this.padChannel = channel;
    channel.port2.postMessage(0);
  }

  stopGamepad(): void {
    if (!this.padOn) return;
    this.padOn = false;
    this.padStop = performance.now();
    this.padChannel?.port1.close();
    this.padChannel = null;
  }

  private pollPads = (): void => {
    if (!this.padOn || !this.padChannel) return;
    this.padPolls++;
    const now = performance.now();
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      let st = this.pads.get(gp.index);
      if (!st) {
        st = { id: gp.id, timestamp: gp.timestamp, buttons: new Uint8Array(gp.buttons.length), axes: new Int8Array(gp.axes.length) };
        for (let b = 0; b < gp.buttons.length; b++) st.buttons[b] = gp.buttons[b].pressed ? 1 : 0;
        for (let a = 0; a < gp.axes.length; a++) st.axes[a] = digital(gp.axes[a]);
        this.pads.set(gp.index, st);
        continue;
      }
      if (gp.timestamp === st.timestamp) continue;
      this.padIntervals.push(gp.timestamp - st.timestamp);
      this.padLag.push(now - gp.timestamp);
      st.timestamp = gp.timestamp;
      for (let b = 0; b < st.buttons.length && b < gp.buttons.length; b++) {
        const pressed = gp.buttons[b].pressed ? 1 : 0;
        if (pressed === st.buttons[b]) continue;
        st.buttons[b] = pressed;
        this.padEvent(gp.index * 1000 + b, pressed === 1, gp.timestamp);
      }
      // Some pads report the arrows as axes (a hat or a stick).
      for (let a = 0; a < st.axes.length && a < gp.axes.length; a++) {
        const v = digital(gp.axes[a]);
        if (v === st.axes[a]) continue;
        const was = st.axes[a];
        st.axes[a] = v;
        if (was !== 0) this.padEvent(gp.index * 1000 + 500 + a * 2 + (was > 0 ? 1 : 0), false, gp.timestamp);
        if (v !== 0) this.padEvent(gp.index * 1000 + 500 + a * 2 + (v > 0 ? 1 : 0), true, gp.timestamp);
      }
    }
    this.padChannel.port2.postMessage(0);
  };

  private padEvent(code: number, down: boolean, timestamp: number): void {
    this.ring.push([KIND_PAD, code, down ? 1 : 0, timestamp]);
    if (down) {
      this.padPresses++;
      this.taps.push(timestamp);
    }
  }

  // ------------------------------------------------------------------ WebHID

  get hidAvailable(): boolean {
    return hidApi() !== null;
  }

  get hidActive(): boolean {
    return this.hidMode !== null;
  }

  get hidDeviceNames(): string[] {
    return this.devices.map((d) => `${d.productName || 'HID device'} (${hex(d.vendorId)}:${hex(d.productId)})`);
  }

  /** Devices the user already granted in an earlier visit. */
  async knownHidDevices(): Promise<string[]> {
    const api = hidApi();
    if (api && this.devices.length === 0) this.devices = await api.getDevices();
    return this.hidDeviceNames;
  }

  /** Show the browser's device chooser. Must be called from a click handler. */
  async connectHid(): Promise<string[]> {
    const api = hidApi();
    if (!api) throw new Error('WebHID is not available in this browser');
    const picked = await api.requestDevice({ filters: [] });
    for (const d of picked) if (!this.devices.includes(d)) this.devices.push(d);
    return this.hidDeviceNames;
  }

  async startHid(mode: HidMode): Promise<void> {
    if (this.hidMode) return;
    if (this.devices.length === 0) throw new Error('Connect a HID device first');
    this.hid = new HidAnalyzer();
    this.hidWorkerError = '';
    this.lastWorkerReport = null;
    if (mode === 'main') {
      for (const d of this.devices) {
        if (!d.opened) await d.open();
        d.addEventListener('inputreport', this.onHidReport);
      }
      this.hidMode = 'main';
      return;
    }
    for (const d of this.devices) {
      if (d.opened) await d.close();
    }
    const worker = new Worker(new URL('./hid-worker.js', import.meta.url), { type: 'module' });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('HID worker did not start')), 5000);
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'HID worker failed to load'));
        };
        worker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { type: string; message?: string; devices?: string[] };
          if (msg.type === 'started') {
            clearTimeout(timer);
            this.hidWorkerDevices = msg.devices ?? [];
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            reject(new Error(msg.message));
          }
        };
        worker.postMessage({ type: 'start', mainOrigin: performance.timeOrigin, ring: sharedBuffer(this.workerRing), busy: this.busy });
      });
    } catch (err) {
      worker.terminate();
      this.hidWorkerError = err instanceof Error ? err.message : String(err);
      throw err;
    }
    worker.onmessage = this.onWorkerMessage;
    this.hidWorker = worker;
    this.hidMode = 'worker';
  }

  async stopHid(): Promise<void> {
    const mode = this.hidMode;
    this.hidMode = null;
    if (mode === 'main') {
      for (const d of this.devices) {
        d.removeEventListener('inputreport', this.onHidReport);
        try {
          if (d.opened) await d.close();
        } catch {
          // The device may already be gone.
        }
      }
    } else if (mode === 'worker' && this.hidWorker) {
      const worker = this.hidWorker;
      this.lastWorkerReport = await this.workerReport();
      this.hidWorker = null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1000);
        worker.onmessage = (e: MessageEvent) => {
          if ((e.data as { type: string }).type === 'stopped') {
            clearTimeout(timer);
            resolve();
          }
        };
        worker.postMessage({ type: 'stop' });
      });
      worker.terminate();
    }
  }

  private onHidReport = (e: HidReportEvent): void => {
    const tHandler = performance.now();
    const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
    if (this.hid.feed(e.timeStamp, tHandler, e.reportId, bytes, this.busy)) {
      this.ring.push([KIND_HID, e.reportId, 1, e.timeStamp]);
      this.taps.push(e.timeStamp);
    }
  };

  private onWorkerMessage = (e: MessageEvent): void => {
    const msg = e.data as { type: string; t?: number; report?: Record<string, unknown> };
    if (msg.type === 'down' && typeof msg.t === 'number') {
      this.taps.push(msg.t);
    } else if (msg.type === 'report') {
      const waiters = this.workerReportWaiters;
      this.workerReportWaiters = [];
      for (const w of waiters) w(msg.report ?? null);
    }
  };

  private workerReport(): Promise<Record<string, unknown> | null> {
    const worker = this.hidWorker;
    if (!worker) return Promise.resolve(this.lastWorkerReport);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      this.workerReportWaiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ type: 'report' });
    });
  }

  // ------------------------------------------------------------------ report

  async report(): Promise<Record<string, unknown>> {
    const padInterval = summarize(this.padIntervals.values());
    const padSeconds = ((this.padOn ? performance.now() : this.padStop) - this.padStart) / 1000;
    const hidStats = this.hidMode === 'worker' || (this.hidMode === null && this.lastWorkerReport) ? await this.workerReport() : this.hid.report();
    return {
      busyMainThread: this.busy,
      keyboard: {
        active: this.kbdOn,
        keydowns: this.kbdDowns,
        // Handler start minus event.timeStamp: how long the event waited for the main thread.
        dispatchDelayIdleMs: roundSummary(summarize(this.kbdIdle.values())),
        dispatchDelayBusyMs: roundSummary(summarize(this.kbdBusy.values())),
      },
      gamepad: {
        active: this.padOn,
        pads: [...this.pads.values()].map((p) => p.id),
        pollRateHz: padSeconds > 0 ? round(this.padPolls / padSeconds, 0) : null,
        // Spacing of distinct gamepad.timestamp values: the browser's own sampling grid.
        updateIntervalMs: roundSummary(padInterval),
        updateRateHz: padInterval && padInterval.p50 > 0 ? round(1000 / padInterval.p50, 1) : null,
        // Poll time minus gamepad.timestamp when a new state was first seen.
        timestampToPollMs: roundSummary(summarize(this.padLag.values())),
        presses: this.padPresses,
      },
      hid: {
        available: this.hidAvailable,
        devices: this.hidDeviceNames,
        mode: this.hidMode ?? 'stopped',
        workerDevices: this.hidWorkerDevices,
        workerError: this.hidWorkerError || null,
        stats: hidStats,
      },
      ring: {
        shared: this.ring.isShared,
        droppedMain: this.ring.dropped,
        droppedWorker: this.workerRing.dropped,
      },
      downsSeen: this.taps.length,
    };
  }
}

/** True for controls where keys mean typing or choosing, so the test must not swallow them. */
function isTextEntry(target: EventTarget | null): boolean {
  const node = target as (HTMLElement & { type?: string }) | null;
  if (!node || !node.tagName) return false;
  if (node.tagName === 'SELECT' || node.tagName === 'TEXTAREA' || node.isContentEditable) return true;
  return node.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|reset)$/.test(node.type ?? '');
}

function digital(v: number): number {
  return v > AXIS_THRESHOLD ? 1 : v < -AXIS_THRESHOLD ? -1 : 0;
}

function hex(v: number): string {
  return v.toString(16).padStart(4, '0');
}
