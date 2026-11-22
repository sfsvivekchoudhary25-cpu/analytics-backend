import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { ValueTransformer } from 'typeorm';

// AES-256-GCM. Stored as base64(iv | tag | ciphertext).
function key(): Buffer {
  const hex = process.env.TOKEN_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes).');
  }
  return Buffer.from(hex, 'hex');
}

export const encryptedTransformer: ValueTransformer = {
  to(value?: string | null) {
    if (value == null) return value;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key(), iv);
    const enc = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
  },
  from(value?: string | null) {
    if (value == null) return value;
    const buf = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  },
};

// ── Customer message text ──────────────────────────────────────────────────────────────────────────────────────
// Same AES-256-GCM as the tokens above, but values carry a visible marker so rows written BEFORE encryption was
// switched on (plain text) are still read correctly until the one-time backfill has encrypted them.
// NOTE: each encryption uses a fresh random IV, so the same text encrypts differently every time. Never compare or
// search these columns in SQL (WHERE text = ...); read the row and compare in code.
export const ENC_PREFIX = 'enc1:';

export function encryptText(value: string): string {
  if (value === '' || value.startsWith(ENC_PREFIX)) return value;
  return ENC_PREFIX + (encryptedTransformer.to(value) as string);
}

export function decryptText(value: string): string {
  if (!value.startsWith(ENC_PREFIX)) return value; // legacy plain text
  return encryptedTransformer.from(value.slice(ENC_PREFIX.length)) as string;
}

export const encryptedTextTransformer: ValueTransformer = {
  to: (value?: string | null) => (value == null ? value : encryptText(value)),
  from: (value?: string | null) => (value == null ? value : decryptText(value)),
};
