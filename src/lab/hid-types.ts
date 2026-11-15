// Minimal WebHID typings (the DOM library does not ship them). Named locally so they
// cannot collide with official typings if those appear later.

export interface HidDeviceLike {
  readonly opened: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  open(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'inputreport', listener: (event: HidReportEvent) => void): void;
  removeEventListener(type: 'inputreport', listener: (event: HidReportEvent) => void): void;
}

export interface HidReportEvent extends Event {
  readonly reportId: number;
  readonly data: DataView;
  readonly device: HidDeviceLike;
}

export interface HidApi {
  requestDevice(options: { filters: object[] }): Promise<HidDeviceLike[]>;
  getDevices(): Promise<HidDeviceLike[]>;
}

/** WebHID entry point for the current global (window or worker), or null when unavailable. */
export function hidApi(): HidApi | null {
  const nav = (globalThis as unknown as { navigator?: { hid?: HidApi } }).navigator;
  return nav?.hid ?? null;
}

// Record layout shared by every input source that writes into an EventRing.
export const EV_FIELDS = 4; // kind, code, down (1/0), timestamp (ms, main-thread timebase)
export const KIND_KEY = 1;
export const KIND_HID = 2;
export const KIND_PAD = 3;
