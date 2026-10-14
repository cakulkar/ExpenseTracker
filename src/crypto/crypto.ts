/**
 * Client-side encryption (Web Crypto only).
 *
 * - Household Data Key (HDK): random 256-bit AES-GCM key. Stored on devices as a NON-EXTRACTABLE CryptoKey.
 * - Recovery key: 160 random bits shown as 8 groups of 4 Crockford base32 characters. HKDF-SHA-256 turns it into a
 *   key-encryption key that wraps the HDK. Only the wrapped HDK is uploaded (household.key.json).
 * - Envelopes: "PLE1" | 12-byte random IV | AES-GCM ciphertext+tag. Associated data binds each blob to its type and
 *   id, so a file can't be swapped for another without detection.
 * - Password-protected backups: PBKDF2-SHA-256 (600,000 iterations) + AES-GCM.
 *
 * Random 96-bit IVs: NIST SP 800-38D allows up to 2^32 messages per key with random IVs; a household writes far fewer.
 */
import { b64ToBytes, bytesToB64, randomBytes } from '../domain/ids';

const MAGIC = new Uint8Array([0x50, 0x4c, 0x45, 0x31]); // "PLE1"
const IV_LEN = 12;
export const BACKUP_PBKDF2_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class DecryptError extends Error {
  constructor(message = 'Could not decrypt: wrong key or the data was changed') {
    super(message);
    this.name = 'DecryptError';
  }
}

function aadBytes(aad: { type: string; id: string }): Uint8Array {
  return enc.encode(JSON.stringify({ t: aad.type, id: aad.id, f: 1 }));
}

// ---------- Household data key ----------

export async function importHdk(raw: Uint8Array, extractable = false): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

/** Returns raw bytes (caller wraps them, then drops them) and the non-extractable key. */
export async function generateHdk(): Promise<{ raw: Uint8Array; key: CryptoKey }> {
  const raw = randomBytes(32);
  return { raw, key: await importHdk(raw) };
}

// ---------- Envelopes ----------

export async function encryptBytes(key: CryptoKey, plain: Uint8Array, aad: { type: string; id: string }): Promise<Uint8Array> {
  const iv = randomBytes(IV_LEN);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadBytes(aad) as BufferSource }, key, plain as BufferSource),
  );
  const out = new Uint8Array(MAGIC.length + IV_LEN + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + IV_LEN);
  return out;
}

export async function decryptBytes(key: CryptoKey, blob: Uint8Array, aad: { type: string; id: string }): Promise<Uint8Array> {
  if (blob.length < MAGIC.length + IV_LEN + 16 || !MAGIC.every((b, i) => blob[i] === b)) throw new DecryptError('Not an encrypted PocketLedger file');
  const iv = blob.slice(MAGIC.length, MAGIC.length + IV_LEN);
  const ct = blob.slice(MAGIC.length + IV_LEN);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: aadBytes(aad) as BufferSource }, key, ct as BufferSource),
    );
  } catch {
    throw new DecryptError();
  }
}

export async function encryptJson(key: CryptoKey, value: unknown, aad: { type: string; id: string }): Promise<Uint8Array> {
  return encryptBytes(key, enc.encode(JSON.stringify(value)), aad);
}

export async function decryptJson<T>(key: CryptoKey, blob: Uint8Array, aad: { type: string; id: string }): Promise<T> {
  const bytes = await decryptBytes(key, blob, aad);
  try {
    return JSON.parse(dec.decode(bytes)) as T;
  } catch {
    throw new DecryptError('Decrypted data is not valid');
  }
}

// ---------- Recovery key ----------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_KEY_BYTES = 20;

export function encodeRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new RangeError('Recovery key must be 20 bytes');
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.match(/.{4}/g)!.join('-');
}

/** Accepts any spacing/dashes/case; maps O→0, I/L→1 (Crockford). Returns null if malformed. */
export function decodeRecoveryKey(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== 32 || /[^0-9A-HJKMNP-TV-Z]/.test(clean)) return null;
  const out = new Uint8Array(RECOVERY_KEY_BYTES);
  let bits = 0;
  let value = 0;
  let i = 0;
  for (const ch of clean) {
    value = (value << 5) | CROCKFORD.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out[i++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

export function newRecoveryKey(): { bytes: Uint8Array; text: string } {
  const bytes = randomBytes(RECOVERY_KEY_BYTES);
  return { bytes, text: encodeRecoveryKey(bytes) };
}

async function recoveryKek(recovery: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', recovery as BufferSource, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode('pocketledger/recovery-kek/v1') as BufferSource },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export interface KeyFile {
  format: 'pocketledger-key';
  version: 1;
  householdId: string;
  kdf: { name: 'HKDF-SHA-256'; saltB64: string };
  wrappedKeyB64: string;
  createdAt: string;
}

/** Wrap raw HDK bytes under the recovery key. The result contains no plaintext key material. */
export async function makeKeyFile(householdId: string, hdkRaw: Uint8Array, recovery: Uint8Array): Promise<KeyFile> {
  const salt = randomBytes(16);
  const kek = await recoveryKek(recovery, salt);
  const wrapped = await encryptBytes(kek, hdkRaw, { type: 'hdk', id: householdId });
  return {
    format: 'pocketledger-key',
    version: 1,
    householdId,
    kdf: { name: 'HKDF-SHA-256', saltB64: bytesToB64(salt) },
    wrappedKeyB64: bytesToB64(wrapped),
    createdAt: new Date().toISOString(),
  };
}

/** Unwrap the HDK with the recovery key → non-extractable CryptoKey. Throws DecryptError on a wrong key. */
export async function openKeyFile(file: KeyFile, recovery: Uint8Array): Promise<CryptoKey> {
  if (file.format !== 'pocketledger-key' || file.version !== 1) throw new Error('Unsupported key file');
  const kek = await recoveryKek(recovery, b64ToBytes(file.kdf.saltB64));
  let raw: Uint8Array;
  try {
    raw = await decryptBytes(kek, b64ToBytes(file.wrappedKeyB64), { type: 'hdk', id: file.householdId });
  } catch {
    throw new DecryptError("That recovery key doesn't match this household");
  }
  const key = await importHdk(raw);
  raw.fill(0);
  return key;
}

// ---------- Password-protected backups ----------

export interface PasswordEnvelope {
  format: 'pocketledger-encrypted-backup';
  version: 1;
  kdf: { name: 'PBKDF2-SHA-256'; iterations: number; saltB64: string };
  dataB64: string;
}

export const MIN_BACKUP_PASSWORD = 12;

async function passwordKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password) as BufferSource, 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptWithPassword(value: unknown, password: string, iterations = BACKUP_PBKDF2_ITERATIONS): Promise<PasswordEnvelope> {
  if (password.length < MIN_BACKUP_PASSWORD) throw new Error(`Use at least ${MIN_BACKUP_PASSWORD} characters`);
  const salt = randomBytes(16);
  const key = await passwordKey(password, salt, iterations);
  const data = await encryptJson(key, value, { type: 'backup', id: 'v1' });
  return { format: 'pocketledger-encrypted-backup', version: 1, kdf: { name: 'PBKDF2-SHA-256', iterations, saltB64: bytesToB64(salt) }, dataB64: bytesToB64(data) };
}

export async function decryptWithPassword<T>(env: PasswordEnvelope, password: string): Promise<T> {
  if (env.format !== 'pocketledger-encrypted-backup' || env.version !== 1) throw new Error('Not an encrypted PocketLedger backup');
  if (env.kdf.iterations < 100_000 || env.kdf.iterations > 10_000_000) throw new Error('Backup has invalid settings');
  const key = await passwordKey(password, b64ToBytes(env.kdf.saltB64), env.kdf.iterations);
  try {
    return await decryptJson<T>(key, b64ToBytes(env.dataB64), { type: 'backup', id: 'v1' });
  } catch {
    throw new DecryptError('Wrong password, or the file is damaged');
  }
}

// ---------- Hashing ----------

export async function sha256Hex(data: Uint8Array | ArrayBuffer): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data as BufferSource));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}
