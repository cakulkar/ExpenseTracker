import { describe, expect, it } from 'vitest';
import { HybridClock, compareHlc, decodeHlc } from '../../src/sync/hlc';

describe('HybridClock', () => {
  it('is monotonic even if wall time goes backwards', () => {
    let t = 1000;
    const c = new HybridClock('dev-a', undefined, () => t);
    const a = c.tick();
    t = 500;
    const b = c.tick();
    expect(compareHlc(a, b)).toBeLessThan(0);
    expect(decodeHlc(b).wall).toBe(1000);
  });
  it('orders after a received remote timestamp', () => {
    let t = 1000;
    const a = new HybridClock('dev-a', undefined, () => t);
    const b = new HybridClock('dev-b', undefined, () => 5000);
    const remote = b.tick();
    a.receive(remote);
    const local = a.tick();
    expect(compareHlc(remote, local)).toBeLessThan(0);
    t = 6000;
    expect(compareHlc(local, a.tick())).toBeLessThan(0);
  });
  it('rejects remote clocks far in the future', () => {
    const a = new HybridClock('dev-a', undefined, () => 0);
    const b = new HybridClock('dev-b', undefined, () => 3 * 86_400_000);
    expect(() => a.receive(b.tick())).toThrow();
  });
});
