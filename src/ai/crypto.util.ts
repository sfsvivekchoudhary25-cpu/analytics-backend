import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';

function getMasterKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'fabroniee-master-encryption-key-32b-secret';
  return createHash('sha256').update(secret).digest();
}

export interface EncryptedResult {
  encrypted: string;
  iv: string;
  tag: string;
  last4: string;
}

export function encryptApiKey(plainKey: string): EncryptedResult {
  const key = getMasterKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plainKey.trim(), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  const last4 = plainKey.trim().slice(-4);

  return {
    encrypted,
    iv: iv.toString('hex'),
    tag,
    last4,
  };
}

export function decryptApiKey(encryptedHex: string, ivHex: string, tagHex: string): string {
  const key = getMasterKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}
