// Which physical control stands for which panel. Pure: no browser dependencies.
//
// A control is named by a string:
//   key:<KeyboardEvent.code>                       key:ArrowLeft
//   pad:<pad index>:b<button>                      pad:0:b3
//   pad:<pad index>:a<axis><+|->                   pad:0:a1-
//   hid:<vendor>:<product>:<report id>:<byte>:<bit>   hid:0079:0011:0:5:4
//
// A panel may have any number of controls; a control stands for one panel.

export type Bindings = Record<string, number>;

/** dance-single: left, down, up, right. */
export const DEFAULT_BINDINGS: Readonly<Bindings> = {
  'key:ArrowLeft': 0,
  'key:ArrowDown': 1,
  'key:ArrowUp': 2,
  'key:ArrowRight': 3,
  'key:KeyD': 0,
  'key:KeyF': 1,
  'key:KeyJ': 2,
  'key:KeyK': 3,
};

export const PANEL_NAMES = ['Left', 'Down', 'Up', 'Right'] as const;

/** A name a person can read. */
export function describeControl(control: string): string {
  const parts = control.split(':');
  if (parts[0] === 'key') return (parts[1] ?? '').replace(/^Key|^Digit/, '').replace(/^Arrow/, 'Arrow ');
  if (parts[0] === 'pad') {
    const what = parts[2] ?? '';
    return what.startsWith('b') ? `Pad ${Number(parts[1]) + 1} button ${what.slice(1)}` : `Pad ${Number(parts[1]) + 1} axis ${what.slice(1)}`;
  }
  if (parts[0] === 'hid') return `HID ${parts[1]}:${parts[2]} byte ${parts[4]} bit ${parts[5]}`;
  return control;
}

/** Keeps only well-formed entries with a panel inside `tracks`. For settings read from storage. */
export function cleanBindings(value: unknown, tracks = 4): Bindings {
  const out: Bindings = {};
  if (typeof value !== 'object' || value === null) return out;
  for (const [control, track] of Object.entries(value as Record<string, unknown>)) {
    if (!/^(key|pad|hid):[\w:+-]+$/.test(control)) continue;
    if (typeof track !== 'number' || !Number.isInteger(track) || track < 0 || track >= tracks) continue;
    out[control] = track;
  }
  return out;
}

/**
 * Follows the reports of one HID device and says which bits changed. Bits that change
 * without anyone pressing anything (analog axes, counters) can be learnt and left out.
 */
export class HidReportDiffer {
  private readonly last = new Map<number, Uint8Array>();
  private readonly noisy = new Set<string>();
  /** While set, every bit that changes is taken to be noise. */
  learningNoise = false;

  /**
   * Feeds a report; calls `changed(byte, bit, down)` for each bit that differs from the
   * report before it with the same id. The first report of an id only sets the baseline.
   */
  feed(reportId: number, bytes: Uint8Array, changed: (byte: number, bit: number, down: boolean) => void): void {
    const before = this.last.get(reportId);
    if (!before || before.length !== bytes.length) {
      this.last.set(reportId, bytes.slice());
      return;
    }
    for (let i = 0; i < bytes.length; i++) {
      const diff = before[i]! ^ bytes[i]!;
      if (diff === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (!(diff & (1 << bit))) continue;
        const name = `${reportId}:${i}:${bit}`;
        if (this.learningNoise) this.noisy.add(name);
        else if (!this.noisy.has(name)) changed(i, bit, (bytes[i]! & (1 << bit)) !== 0);
      }
      before[i] = bytes[i]!;
    }
  }
}
