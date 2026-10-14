import { describe, expect, it } from 'vitest';
import { createLockConfig, lockoutDuration, passcodeProblem, verifyPasscode } from '../../src/lock/passcode';

describe('passcode', () => {
  it('requires 6 non-trivial digits', () => {
    expect(passcodeProblem('12345')).toMatch(/6/);
    expect(passcodeProblem('12a456')).toMatch(/6/);
    expect(passcodeProblem('111111')).toMatch(/repeat/);
    expect(passcodeProblem('123456')).toMatch(/sequence/);
    expect(passcodeProblem('654321')).toMatch(/sequence/);
    expect(passcodeProblem('481937')).toBeNull();
  });

  it('verifies the right code and never stores it in plaintext', async () => {
    const cfg = await createLockConfig('481937', 1000);
    expect(JSON.stringify(cfg)).not.toContain('481937');
    const ok = await verifyPasscode(cfg, '481937');
    expect(ok.ok).toBe(true);
  });

  it('throttles after repeated failures and resets on success', async () => {
    let cfg = await createLockConfig('481937', 1000);
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      const r = await verifyPasscode(cfg, '000001', now);
      expect(r.ok).toBe(false);
      cfg = r.config;
    }
    expect(cfg.lockedUntil).toBe(now + 30_000);
    const blocked = await verifyPasscode(cfg, '481937', now + 1000);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('locked_out');
    const later = await verifyPasscode(cfg, '481937', now + 31_000);
    expect(later.ok).toBe(true);
    expect(later.config.failedAttempts).toBe(0);
  });

  it('caps the lockout duration', () => {
    expect(lockoutDuration(4)).toBe(0);
    expect(lockoutDuration(5)).toBe(30_000);
    expect(lockoutDuration(6)).toBe(60_000);
    expect(lockoutDuration(50)).toBe(3_600_000);
  });
});
