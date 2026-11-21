import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Converte a chave base64 em Buffer de 32 bytes (AES-256). */
export function parseEncryptionKey(base64) {
  const key = Buffer.from(String(base64 ?? ''), 'base64');
  if (key.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY deve ser uma chave de 32 bytes em base64.');
  }
  return key;
}

/** AES-256-GCM (autenticado). Formato: v1.<iv>.<tag>.<texto cifrado>, tudo em base64url. */
export function encrypt(plaintext, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, data].map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part)).join('.');
}

export function decrypt(payload, key) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Formato de dado criptografado inválido.');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
