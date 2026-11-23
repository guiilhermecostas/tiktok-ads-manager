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

/**
 * AES-256-GCM para ARQUIVOS (binário). Formato: [1 byte de versão][12 de IV][16 de tag][dados cifrados].
 * `context` (ex.: o ID do dono) entra como dado autenticado: um arquivo copiado para outro dono no banco NÃO decifra.
 */
export function encryptBuffer(plain, key, context) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(context)));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), data]);
}

export function decryptBuffer(raw, key, context) {
  // O driver do banco devolve BYTEA como Buffer (pg) ou Uint8Array (PGlite): os dois valem.
  const payload = raw instanceof Uint8Array ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength) : null;
  if (!payload || payload.length < 30 || payload[0] !== 1) throw new Error('Formato de arquivo criptografado inválido.');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(1, 13));
  decipher.setAAD(Buffer.from(String(context)));
  decipher.setAuthTag(payload.subarray(13, 29));
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
}
