// Statistics over a stream of HID input reports. Pure, so it runs on the main thread,
// in a worker, and under Node for tests.

import { Series, roundSummary, summarize, round } from '../shared/stats.ts';

const DOWN_REFRACTORY_MS = 40;

export class HidAnalyzer {
  readonly intervals = new Series();
  readonly delayIdle = new Series();
  readonly delayBusy = new Series();
  reports = 0;
  changed = 0;
  downs = 0;

  private readonly last = new Map<number, Uint8Array>();
  private readonly toggles = new Map<string, number>();
  private lastStamp = -1;
  private lastDown = -1e9;

  /**
   * Feed one report.
   * @param tStamp event timestamp (ms, main-thread timebase)
   * @param tHandler time the handler ran (same timebase)
   * @param busy whether the main thread was being kept busy on purpose
   * @returns true when the report looks like a button going down
   */
  feed(tStamp: number, tHandler: number, reportId: number, bytes: Uint8Array, busy: boolean): boolean {
    this.reports++;
    if (this.lastStamp >= 0) this.intervals.push(tStamp - this.lastStamp);
    this.lastStamp = tStamp;
    (busy ? this.delayBusy : this.delayIdle).push(tHandler - tStamp);

    let prev = this.last.get(reportId);
    if (!prev || prev.length !== bytes.length) {
      prev = new Uint8Array(bytes.length);
      prev.set(bytes);
      this.last.set(reportId, prev);
      return false; // first report of this kind: nothing to compare against
    }

    let anyChange = false;
    let anySet = false;
    for (let i = 0; i < bytes.length; i++) {
      const diff = bytes[i] ^ prev[i];
      if (diff === 0) continue;
      anyChange = true;
      if (diff & bytes[i]) anySet = true;
      for (let bit = 0; bit < 8; bit++) {
        if (diff & (1 << bit)) {
          const key = `${reportId}:${i}:${bit}`;
          this.toggles.set(key, (this.toggles.get(key) ?? 0) + 1);
        }
      }
      prev[i] = bytes[i];
    }
    if (anyChange) this.changed++;
    if (anySet && tStamp - this.lastDown >= DOWN_REFRACTORY_MS) {
      this.lastDown = tStamp;
      this.downs++;
      return true;
    }
    return false;
  }

  report(): Record<string, unknown> {
    const interval = summarize(this.intervals.values());
    const toggled = [...this.toggles.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 16)
      .map(([bit, count]) => ({ bit, count }));
    return {
      reports: this.reports,
      changedReports: this.changed,
      downs: this.downs,
      intervalMs: roundSummary(interval),
      reportRateHz: interval && interval.p50 > 0 ? round(1000 / interval.p50, 1) : null,
      dispatchDelayIdleMs: roundSummary(summarize(this.delayIdle.values())),
      dispatchDelayBusyMs: roundSummary(summarize(this.delayBusy.values())),
      toggledBits: toggled,
    };
  }
}
