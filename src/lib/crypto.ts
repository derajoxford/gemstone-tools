import crypto from 'node:crypto';

const keyFromEnv = () => {
  const raw = process.env.ENCRYPTION_KEY || '';
  if (!raw.startsWith('base64:')) throw new Error('ENCRYPTION_KEY must be base64:...');
  const key = Buffer.from(raw.slice(7), 'base64');
  if (key.length !== 32) throw new Error('ENCRYPTION_KEY must decode to 32 bytes');
  return key;
};

export function seal(plaintext: string) {
  const key = keyFromEnv();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ciphertext: Buffer.concat([enc, tag]), iv };
}

export function open(ciphertext: Buffer, iv: Buffer) {
  const key = keyFromEnv();
  const data = ciphertext.subarray(0, ciphertext.length - 16);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return dec.toString('utf8');
}
