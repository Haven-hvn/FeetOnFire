// Single-producer / single-consumer ring of fixed-size Float64 records.
//
// Backed by a SharedArrayBuffer when one is available, so one thread can push while
// another pops without messages or locks. With a plain ArrayBuffer it still works
// within one thread (used by tests and as a fallback).

const HEADER_BYTES = 16; // Int32 x4: write index, read index, dropped count, reserved
const WRITE = 0;
const READ = 1;
const DROPPED = 2;

export type RingBuffer = SharedArrayBuffer | ArrayBuffer;

function canShareMemory(): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true;
}

export class EventRing {
  readonly buffer: RingBuffer;
  readonly fields: number;
  readonly capacity: number;
  private readonly head: Int32Array;
  private readonly data: Float64Array;
  private readonly mask: number;

  /** Wrap an existing buffer created by `EventRing.create` with the same `fields`. */
  constructor(buffer: RingBuffer, fields: number) {
    const capacity = (buffer.byteLength - HEADER_BYTES) / (fields * 8);
    if (!Number.isInteger(capacity) || capacity < 2 || (capacity & (capacity - 1)) !== 0) {
      throw new Error('EventRing: buffer size does not match a power-of-two capacity');
    }
    this.buffer = buffer;
    this.fields = fields;
    this.capacity = capacity;
    this.mask = capacity - 1;
    this.head = new Int32Array(buffer, 0, 4);
    this.data = new Float64Array(buffer, HEADER_BYTES, capacity * fields);
  }

  static create(capacity: number, fields: number, shared = canShareMemory()): EventRing {
    if (capacity < 2 || (capacity & (capacity - 1)) !== 0) throw new Error('EventRing: capacity must be a power of two');
    const bytes = HEADER_BYTES + capacity * fields * 8;
    return new EventRing(shared ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes), fields);
  }

  get isShared(): boolean {
    return typeof SharedArrayBuffer !== 'undefined' && this.buffer instanceof SharedArrayBuffer;
  }

  get dropped(): number {
    return Atomics.load(this.head, DROPPED);
  }

  /** Producer side. Returns false (and counts a drop) when the ring is full. */
  push(rec: ArrayLike<number>): boolean {
    const w = Atomics.load(this.head, WRITE);
    const r = Atomics.load(this.head, READ);
    if (((w - r) | 0) >= this.capacity) {
      Atomics.add(this.head, DROPPED, 1);
      return false;
    }
    const base = (w & this.mask) * this.fields;
    for (let i = 0; i < this.fields; i++) this.data[base + i] = rec[i];
    Atomics.store(this.head, WRITE, (w + 1) | 0);
    return true;
  }

  /** Consumer side. Fills `out` and returns true when a record was available. */
  pop(out: Float64Array): boolean {
    const r = Atomics.load(this.head, READ);
    const w = Atomics.load(this.head, WRITE);
    if (r === w) return false;
    const base = (r & this.mask) * this.fields;
    for (let i = 0; i < this.fields; i++) out[i] = this.data[base + i];
    Atomics.store(this.head, READ, (r + 1) | 0);
    return true;
  }
}
