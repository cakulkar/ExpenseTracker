/**
 * 6-digit app passcode (device-local app lock).
 *
 * What it does: gates the UI on this device, with attempt throttling and auto-lock.
 * What it does NOT do: a 6-digit code has only 1,000,000 combinations, so it is never used to
 * encrypt data that leaves the device. The shared Drive data is protected by a long random
 * household key (Stage 4). Someone who controls the unlocked browser profile can bypass a
 * JavaScript lock; it protects against casual access to an unlocked phone or laptop.
 */
import { b64ToBytes, bytesToB64, randomBytes, timingSafeEqual } from '../domain/ids';

export const PASSCODE_LENGTH = 6;
export const PBKDF2_ITERATIONS = 310_000;
export const FREE_ATTEMPTS = 5;
export const BASE_LOCKOUT_MS = 30_000;
export const MAX_LOCKOUT_MS = 60 * 60_000;

export interface LockConfig {
  saltB64: string;
  hashB64: string;
  iterations: number;
  failedAttempts: number;
  lockedUntil: number; // epoch ms; 0 = not locked out
}

/** Reject non-6-digit codes and trivially guessable ones. Returns an error message or null. */
export function passcodeProblem(code: string): string | null {
  if (!new RegExp(`^\\d{${PASSCODE_LENGTH}}$`).test(code)) return `Enter exactly ${PASSCODE_LENGTH} digits`;
  if (/^(\d)\1{5}$/.test(code)) return 'Avoid repeating the same digit';
  const ascending = '01234567890';
  const descending = '09876543210';
  if (ascending.includes(code) || descending.includes(code)) return 'Avoid simple sequences like 123456';
  return null;
}

async function derive(code: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function createLockConfig(code: string, iterations = PBKDF2_ITERATIONS): Promise<LockConfig> {
  const problem = passcodeProblem(code);
  if (problem) throw new Error(problem);
  const salt = randomBytes(16);
  const hash = await derive(code, salt, iterations);
  return { saltB64: bytesToB64(salt), hashB64: bytesToB64(hash), iterations, failedAttempts: 0, lockedUntil: 0 };
}

export function lockoutDuration(failedAttempts: number): number {
  if (failedAttempts < FREE_ATTEMPTS) return 0;
  const steps = failedAttempts - FREE_ATTEMPTS;
  return Math.min(BASE_LOCKOUT_MS * 2 ** steps, MAX_LOCKOUT_MS);
}

export type VerifyResult =
  | { ok: true; config: LockConfig }
  | { ok: false; reason: 'wrong'; config: LockConfig; remainingFree: number; lockedUntil: number }
  | { ok: false; reason: 'locked_out'; config: LockConfig; lockedUntil: number };

/** Verify a passcode. Returns the updated config, which the caller must persist. */
export async function verifyPasscode(config: LockConfig, code: string, now: number = Date.now()): Promise<VerifyResult> {
  if (config.lockedUntil > now) return { ok: false, reason: 'locked_out', config, lockedUntil: config.lockedUntil };
  const hash = await derive(code, b64ToBytes(config.saltB64), config.iterations);
  if (timingSafeEqual(hash, b64ToBytes(config.hashB64))) {
    return { ok: true, config: { ...config, failedAttempts: 0, lockedUntil: 0 } };
  }
  const failedAttempts = config.failedAttempts + 1;
  const wait = lockoutDuration(failedAttempts);
  const next: LockConfig = { ...config, failedAttempts, lockedUntil: wait ? now + wait : 0 };
  return {
    ok: false,
    reason: 'wrong',
    config: next,
    remainingFree: Math.max(0, FREE_ATTEMPTS - failedAttempts),
    lockedUntil: next.lockedUntil,
  };
}
