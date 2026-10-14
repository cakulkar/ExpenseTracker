import { describe, expect, it } from 'vitest';
import {
  DecryptError, decodeRecoveryKey, decryptBytes, decryptJson, decryptWithPassword, encodeRecoveryKey, encryptBytes,
  encryptJson, encryptWithPassword, generateHdk, makeKeyFile, newRecoveryKey, openKeyFile, sha256Hex,
} from '../../src/crypto/crypto';

describe('envelopes', () => {
  it('round-trips and uses a fresh IV every time', async () => {
    const { key } = await generateHdk();
    const plain = new TextEncoder().encode('Kroger 45.10');
    const a = await encryptBytes(key, plain, { type: 'ops', id: 'x' });
    const b = await encryptBytes(key, plain, { type: 'ops', id: 'x' });
    expect(a.slice(4, 16)).not.toEqual(b.slice(4, 16));
    expect(new TextDecoder().decode(await decryptBytes(key, a, { type: 'ops', id: 'x' }))).toBe('Kroger 45.10');
    // ciphertext must not contain the plaintext
    expect(new TextDecoder('latin1').decode(a)).not.toContain('Kroger');
  });

  it('detects tampering and wrong associated data', async () => {
    const { key } = await generateHdk();
    const blob = await encryptJson(key, { total: 4510 }, { type: 'ops', id: 'dev-1' });
    const tampered = blob.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(decryptJson(key, tampered, { type: 'ops', id: 'dev-1' })).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptJson(key, blob, { type: 'ops', id: 'dev-2' })).rejects.toBeInstanceOf(DecryptError);
    await expect(decryptJson(key, blob, { type: 'snapshot', id: 'dev-1' })).rejects.toBeInstanceOf(DecryptError);
  });

  it('rejects data encrypted with another key', async () => {
    const a = await generateHdk();
    const b = await generateHdk();
    const blob = await encryptJson(a.key, 1, { type: 't', id: 'i' });
    await expect(decryptJson(b.key, blob, { type: 't', id: 'i' })).rejects.toBeInstanceOf(DecryptError);
  });

  it('household key cannot be exported', async () => {
    const { key } = await generateHdk();
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
  });
});

describe('recovery key', () => {
  it('encodes 160 bits as 8 groups of 4 and decodes leniently', () => {
    const { bytes, text } = newRecoveryKey();
    expect(text).toMatch(/^([0-9A-Z]{4}-){7}[0-9A-Z]{4}$/);
    expect(decodeRecoveryKey(text)).toEqual(bytes);
    expect(decodeRecoveryKey(text.toLowerCase().replace(/-/g, ' '))).toEqual(bytes);
    expect(decodeRecoveryKey('too-short')).toBeNull();
  });
  it('maps confusable characters', () => {
    const bytes = new Uint8Array(20);
    const text = encodeRecoveryKey(bytes); // all zeros
    expect(decodeRecoveryKey(text.replace(/0/g, 'O'))).toEqual(bytes);
  });
  it('wraps and unwraps the household key; wrong key fails', async () => {
    const { raw, key } = await generateHdk();
    const rk = newRecoveryKey();
    const file = await makeKeyFile('hh-1', raw, rk.bytes);
    expect(JSON.stringify(file)).not.toContain(rk.text);
    const opened = await openKeyFile(file, rk.bytes);
    const blob = await encryptJson(key, { ok: true }, { type: 't', id: '1' });
    expect(await decryptJson(opened, blob, { type: 't', id: '1' })).toEqual({ ok: true });
    await expect(openKeyFile(file, newRecoveryKey().bytes)).rejects.toThrow(/doesn't match/);
  });
});

describe('password backups', () => {
  it('round-trips and rejects wrong passwords and short passwords', async () => {
    const env = await encryptWithPassword({ expenses: [1, 2] }, 'correct horse battery', 100_000);
    expect(await decryptWithPassword(env, 'correct horse battery')).toEqual({ expenses: [1, 2] });
    await expect(decryptWithPassword(env, 'wrong password!!')).rejects.toThrow(/Wrong password/);
    await expect(encryptWithPassword({}, 'short')).rejects.toThrow(/12/);
  });
});

describe('hashing', () => {
  it('computes SHA-256', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});
