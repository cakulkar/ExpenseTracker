/**
 * Hybrid Logical Clock. Produces totally ordered, lexicographically comparable timestamps:
 *   "<wall ms, 15 digits>:<counter, 5 digits>:<deviceId>"
 * Used to version every field edit so the Stage 4 sync engine can detect concurrent edits.
 */

export type Hlc = string;

export interface HlcState {
  wall: number;
  counter: number;
}

const MAX_COUNTER = 99_999;
const MAX_DRIFT_MS = 24 * 60 * 60 * 1000; // reject remote clocks > 1 day in the future

export function encodeHlc(wall: number, counter: number, deviceId: string): Hlc {
  if (counter > MAX_COUNTER) throw new RangeError('HLC counter overflow');
  return `${String(wall).padStart(15, '0')}:${String(counter).padStart(5, '0')}:${deviceId}`;
}

export function decodeHlc(h: Hlc): { wall: number; counter: number; deviceId: string } {
  const m = /^(\d{15}):(\d{5}):(.+)$/.exec(h);
  if (!m) throw new RangeError('Invalid HLC');
  return { wall: Number(m[1]), counter: Number(m[2]), deviceId: m[3]! };
}

export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class HybridClock {
  private state: HlcState;

  constructor(
    private readonly deviceId: string,
    initial: HlcState = { wall: 0, counter: 0 },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.state = { ...initial };
  }

  get snapshot(): HlcState {
    return { ...this.state };
  }

  /** Timestamp for a local event. */
  tick(): Hlc {
    const pt = this.now();
    if (pt > this.state.wall) {
      this.state = { wall: pt, counter: 0 };
    } else {
      this.state = { wall: this.state.wall, counter: this.state.counter + 1 };
    }
    return encodeHlc(this.state.wall, this.state.counter, this.deviceId);
  }

  /** Merge a remote timestamp (on receive) so later local events sort after it. */
  receive(remote: Hlc): Hlc {
    const r = decodeHlc(remote);
    const pt = this.now();
    if (r.wall - pt > MAX_DRIFT_MS) throw new RangeError('Remote clock too far in the future');
    const wall = Math.max(this.state.wall, r.wall, pt);
    let counter: number;
    if (wall === this.state.wall && wall === r.wall) counter = Math.max(this.state.counter, r.counter) + 1;
    else if (wall === this.state.wall) counter = this.state.counter + 1;
    else if (wall === r.wall) counter = r.counter + 1;
    else counter = 0;
    this.state = { wall, counter };
    return encodeHlc(wall, counter, this.deviceId);
  }
}
