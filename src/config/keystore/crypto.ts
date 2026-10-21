import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { KeystoreKeyId, SecretEnvelope } from './types';

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

export function encryptSecret(
  key: Buffer,
  plaintext: string,
  keyId: KeystoreKeyId,
): SecretEnvelope {
  assertKeyLength(key);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    keyId,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(key: Buffer, envelope: SecretEnvelope): string {
  assertKeyLength(key);
  const iv = Buffer.from(envelope.iv, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('invalid IV length');
  if (tag.length !== TAG_LEN) throw new Error('invalid auth tag length');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function assertKeyLength(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error(`invalid AES key length: ${key.length}`);
}
