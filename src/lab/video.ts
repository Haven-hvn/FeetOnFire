// Main-thread side of the video section: owns the canvas element and talks to the render worker.

export class VideoLab {
  /** Result of the worker/main clock comparison from the most recent start. */
  clock: Record<string, unknown> | string = 'not run (start the video test)';
  lastReport: Record<string, unknown> | null = null;

  private worker: Worker | null = null;
  private host: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private probe: Float64Array | null = null;
  private waiters: ((r: Record<string, unknown> | null) => void)[] = [];

  get running(): boolean {
    return this.worker !== null;
  }

  async start(host: HTMLElement, desync: boolean, rings: (SharedArrayBuffer | null)[]): Promise<void> {
    if (this.worker) return;
    if (!('transferControlToOffscreen' in HTMLCanvasElement.prototype)) throw new Error('OffscreenCanvas is not available');
    const canvas = document.createElement('canvas'); // a canvas can be transferred only once
    const size = pixelSize(host);
    canvas.width = size.width;
    canvas.height = size.height;
    host.replaceChildren(canvas);
    const offscreen = canvas.transferControlToOffscreen();

    const probeBuffer = typeof SharedArrayBuffer !== 'undefined' && window.crossOriginIsolated ? new SharedArrayBuffer(8) : null;
    this.probe = probeBuffer ? new Float64Array(probeBuffer) : null;

    const worker = new Worker(new URL('./video-worker.js', import.meta.url), { type: 'module' });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Render worker did not start')), 5000);
        worker.onerror = (e) => {
          clearTimeout(timer);
          reject(new Error(e.message || 'Render worker failed to load'));
        };
        worker.onmessage = (e: MessageEvent) => {
          const msg = e.data as { type: string; message?: string };
          if (msg.type === 'started') {
            clearTimeout(timer);
            resolve();
          } else if (msg.type === 'error') {
            clearTimeout(timer);
            reject(new Error(msg.message));
          } else {
            this.onMessage(e);
          }
        };
        worker.postMessage({ type: 'init', canvas: offscreen, mainOrigin: performance.timeOrigin, rings, desync, probe: probeBuffer }, [offscreen]);
      });
    } catch (err) {
      worker.terminate();
      host.replaceChildren();
      throw err;
    }
    worker.onmessage = this.onMessage;
    this.worker = worker;
    this.host = host;
    this.observer = new ResizeObserver(() => {
      const s = pixelSize(host);
      worker.postMessage({ type: 'resize', width: s.width, height: s.height });
    });
    this.observer.observe(host);
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker) return;
    this.observer?.disconnect();
    this.observer = null;
    this.lastReport = await this.request('stop');
    this.worker = null;
    worker.terminate();
    this.host?.replaceChildren();
    this.host = null;
  }

  /** Flash the patch at these times (ms, main timebase, ascending). */
  flashAt(times: number[]): void {
    this.worker?.postMessage({ type: 'flashes', times });
  }

  async report(): Promise<Record<string, unknown> | null> {
    if (!this.worker) return this.lastReport;
    const r = await this.request('report');
    if (r) this.lastReport = r;
    return r ?? this.lastReport;
  }

  private request(type: 'report' | 'stop'): Promise<Record<string, unknown> | null> {
    const worker = this.worker;
    if (!worker) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 1000);
      this.waiters.push((r) => {
        clearTimeout(timer);
        resolve(r);
      });
      worker.postMessage({ type });
    });
  }

  private onMessage = (e: MessageEvent): void => {
    const msg = e.data as { type: string; clock?: Record<string, unknown> | string; report?: Record<string, unknown> };
    if (msg.type === 'clock-ready') {
      // Feed the worker's clock comparison: publish our clock for 25 ms.
      const probe = this.probe;
      if (!probe) return;
      const end = performance.now() + 25;
      let t = performance.now();
      while (t < end) {
        probe[0] = t;
        t = performance.now();
      }
    } else if (msg.type === 'clock') {
      this.clock = msg.clock ?? 'unavailable';
    } else if (msg.type === 'report') {
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w(msg.report ?? null);
    }
  };
}

function pixelSize(host: HTMLElement): { width: number; height: number } {
  const dpr = window.devicePixelRatio || 1;
  return {
    width: Math.max(1, Math.round(host.clientWidth * dpr)),
    height: Math.max(1, Math.round(host.clientHeight * dpr)),
  };
}
