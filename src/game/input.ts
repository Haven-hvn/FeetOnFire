// Input on the page's side: keyboard, Gamepad API and WebHID, turned into panel presses by
// the bindings and stamped into the game's input ring with each event's own timestamp.
//
// All three are listened to on the main thread, so the ring has one producer.
//
//   keyboard   event.timeStamp
//   WebHID     event.timeStamp of the input report
//   Gamepad    gamepad.timestamp of the state in which the change was first seen. The API is
//              polled, so a press is only known to the browser's own sampling interval: the
//              degraded path (docs/LATENCY.md section 4). Polling runs only while a pad is
//              connected and bound.
//
// The pad paths are written against the specifications and synthetic reports: no pad has
// been plugged in during development.

import { HidReportDiffer, type Bindings } from './bindings.ts';
import { INPUT_HID, INPUT_KEY, INPUT_PAD, INPUT_TOUCH } from './protocol.ts';

/** Where stamped panel presses go while a game is running. */
export interface InputSink {
  push(rec: ArrayLike<number>): boolean;
}

interface HidDevice extends EventTarget {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
}
interface HidReportEvent extends Event {
  readonly device: HidDevice;
  readonly reportId: number;
  readonly data: DataView;
}
interface Hid {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(options: { filters: object[] }): Promise<HidDevice[]>;
}

const AXIS_THRESHOLD = 0.5;
const hex = (v: number): string => v.toString(16).padStart(4, '0');

export function hidApi(): Hid | null {
  return (navigator as unknown as { hid?: Hid }).hid ?? null;
}

interface PadState {
  timestamp: number;
  buttons: Uint8Array;
  axes: Int8Array;
}

export class InputRouter {
  /** Called for every control that goes down, bound or not (the mapping screen listens). */
  onControl: ((control: string, down: boolean, timeStamp: number) => void) | null = null;

  private bindings: Bindings;
  private ring: InputSink | null = null;
  /** Controls that are down, and how many hold each panel. */
  private readonly down = new Set<string>();
  private readonly panelDown = new Int32Array(16);
  private listening = false;
  private readonly pads = new Map<number, PadState>();
  private padChannel: MessageChannel | null = null;
  private readonly hid = new Map<HidDevice, HidReportDiffer>();

  constructor(bindings: Bindings) {
    this.bindings = bindings;
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings;
    this.updatePadPolling();
  }

  /** Where panel presses go; null: nowhere (menus). */
  setRing(ring: InputSink | null): void {
    this.ring = ring;
  }

  start(): void {
    if (this.listening) return;
    this.listening = true;
    window.addEventListener('keydown', this.onKey, true);
    window.addEventListener('keyup', this.onKey, true);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('gamepadconnected', this.updatePadPolling);
    window.addEventListener('gamepaddisconnected', this.updatePadPolling);
    this.updatePadPolling();
  }

  stop(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener('keydown', this.onKey, true);
    window.removeEventListener('keyup', this.onKey, true);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('gamepadconnected', this.updatePadPolling);
    window.removeEventListener('gamepaddisconnected', this.updatePadPolling);
    this.updatePadPolling();
  }

  /** True while any control bound to `track` is down. */
  isPanelDown(track: number): boolean {
    return this.panelDown[track]! > 0;
  }

  /** A touch press straight on a panel, no binding needed. Fingers on one panel act as one switch. */
  touch(track: number, down: boolean, timeStamp: number): void {
    if (track < 0 || track >= this.panelDown.length) return;
    const before = this.panelDown[track]!;
    this.panelDown[track] = Math.max(0, before + (down ? 1 : -1));
    if ((before === 0) !== (this.panelDown[track] === 0)) this.ring?.push([INPUT_TOUCH, track, down ? 1 : 0, timeStamp]);
  }

  /** One control changed. Returns true when it is bound to a panel. */
  private control(kind: number, control: string, isDown: boolean, timeStamp: number): boolean {
    if (isDown === this.down.has(control)) return this.bindings[control] !== undefined;
    if (isDown) this.down.add(control);
    else this.down.delete(control);
    this.onControl?.(control, isDown, timeStamp);
    const track = this.bindings[control];
    if (track === undefined) return false;
    // Two controls on one panel act as one switch: down with the first, up with the last.
    const before = this.panelDown[track]!;
    this.panelDown[track] = Math.max(0, before + (isDown ? 1 : -1));
    if ((before === 0) !== (this.panelDown[track] === 0)) this.ring?.push([kind, track, isDown ? 1 : 0, timeStamp]);
    return true;
  }

  /** Lets go of everything that is down (focus lost, pause): no "up" may ever come. */
  releaseAll(timeStamp = performance.now()): void {
    for (const control of [...this.down]) this.control(INPUT_KEY, control, false, timeStamp);
  }

  // ---------------------------------------------------------------- keyboard

  private onKey = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) return;
    if (e.type === 'keydown' && e.repeat) {
      if (this.bindings[`key:${e.code}`] !== undefined && this.ring) e.preventDefault();
      return;
    }
    // The event's own time, not the time this handler runs.
    const bound = this.control(INPUT_KEY, `key:${e.code}`, e.type === 'keydown', e.timeStamp);
    if (bound && this.ring) e.preventDefault(); // keep the arrows from scrolling during play
  };

  private onBlur = (): void => this.releaseAll();

  // ----------------------------------------------------------------- gamepad

  private hasPadBinding(): boolean {
    for (const control in this.bindings) if (control.startsWith('pad:')) return true;
    return false;
  }

  private updatePadPolling = (): void => {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads().some((p) => p !== null) : false;
    // Poll when there is a pad and either it is bound or someone is listening (mapping).
    const want = this.listening && pads && (this.hasPadBinding() || this.onControl !== null);
    if (want && !this.padChannel) {
      const channel = new MessageChannel();
      channel.port1.onmessage = this.pollPads;
      this.padChannel = channel;
      channel.port2.postMessage(0);
    } else if (!want && this.padChannel) {
      this.padChannel.port1.close();
      this.padChannel = null;
      this.pads.clear();
    }
  };

  /** Call when onControl is set or cleared, so that pads are polled for the mapping screen. */
  refresh(): void {
    this.updatePadPolling();
  }

  private pollPads = (): void => {
    const channel = this.padChannel;
    if (!channel) return;
    for (const gp of navigator.getGamepads()) {
      if (!gp) continue;
      let st = this.pads.get(gp.index);
      if (!st) {
        st = { timestamp: gp.timestamp, buttons: new Uint8Array(gp.buttons.length), axes: new Int8Array(gp.axes.length) };
        this.pads.set(gp.index, st);
        // What is down when the pad is first seen counts as pressed now.
      } else if (gp.timestamp === st.timestamp) {
        continue;
      }
      st.timestamp = gp.timestamp;
      for (let b = 0; b < st.buttons.length && b < gp.buttons.length; b++) {
        const pressed = gp.buttons[b]!.pressed ? 1 : 0;
        if (pressed === st.buttons[b]) continue;
        st.buttons[b] = pressed;
        this.control(INPUT_PAD, `pad:${gp.index}:b${b}`, pressed === 1, gp.timestamp);
      }
      // Some pads report the arrows as axes (a hat or a stick).
      for (let a = 0; a < st.axes.length && a < gp.axes.length; a++) {
        const value = gp.axes[a]!;
        const v = value > AXIS_THRESHOLD ? 1 : value < -AXIS_THRESHOLD ? -1 : 0;
        const was = st.axes[a]!;
        if (v === was) continue;
        st.axes[a] = v;
        if (was !== 0) this.control(INPUT_PAD, `pad:${gp.index}:a${a}${was > 0 ? '+' : '-'}`, false, gp.timestamp);
        if (v !== 0) this.control(INPUT_PAD, `pad:${gp.index}:a${a}${v > 0 ? '+' : '-'}`, true, gp.timestamp);
      }
    }
    // As fast as the event loop allows, but behind anything else that is waiting.
    setTimeout(() => this.padChannel?.port2.postMessage(0), 0);
  };

  // ------------------------------------------------------------------ WebHID

  get hidDevices(): string[] {
    return [...this.hid.keys()].map((d) => `${d.productName || 'HID device'} (${hex(d.vendorId)}:${hex(d.productId)})`);
  }

  /** Opens the devices the user allowed on an earlier visit. */
  async openKnownHid(): Promise<void> {
    const api = hidApi();
    if (!api) return;
    for (const device of await api.getDevices()) await this.addHid(device);
  }

  /** Shows the browser's device chooser. Call from a click. */
  async requestHid(): Promise<void> {
    const api = hidApi();
    if (!api) throw new Error('WebHID is not available in this browser');
    for (const device of await api.requestDevice({ filters: [] })) await this.addHid(device);
  }

  private async addHid(device: HidDevice): Promise<void> {
    if (this.hid.has(device)) return;
    try {
      if (!device.opened) await device.open();
    } catch {
      return; // in use elsewhere, or gone
    }
    const differ = new HidReportDiffer();
    this.hid.set(device, differ);
    // Bits that move by themselves in the first half second (axes, counters) are not buttons.
    differ.learningNoise = true;
    setTimeout(() => (differ.learningNoise = false), 500);
    const prefix = `hid:${hex(device.vendorId)}:${hex(device.productId)}`;
    device.addEventListener('inputreport', (event) => {
      const e = event as HidReportEvent;
      const bytes = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
      differ.feed(e.reportId, bytes, (byte, bit, down) => this.control(INPUT_HID, `${prefix}:${e.reportId}:${byte}:${bit}`, down, e.timeStamp));
    });
  }
}
