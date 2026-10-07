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
