import { randomBytes } from 'node:crypto';

/**
 * Arquivos de mídia mínimos para teste: cabeçalhos REAIS (é o que o servidor confere) + um corpo único por `seed`
 * (o mesmo conteúdo não entra duas vezes na biblioteca do mesmo usuário).
 */
const body = (seed, size = 64) => Buffer.concat([Buffer.from(`seed:${seed}:`), randomBytes(size)]);

export const pngBytes = (seed = Math.random(), size) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), body(seed, size)]);
export const jpegBytes = (seed = Math.random(), size) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), body(seed, size)]);
const ftyp = (brand, seed, size) => Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.from('ftyp'), Buffer.from(brand), Buffer.from([0, 0, 0, 0]), body(seed, size)]);
export const mp4Bytes = (seed = Math.random(), size) => ftyp('isom', seed, size);
export const movBytes = (seed = Math.random(), size) => ftyp('qt  ', seed, size);

export const MIME = { png: 'image/png', jpg: 'image/jpeg', mp4: 'video/mp4', mov: 'video/quicktime' };
const MAKERS = { png: pngBytes, jpg: jpegBytes, mp4: mp4Bytes, mov: movBytes };

/** Envia um criativo pelo cliente de teste. Retorna a resposta HTTP (use `.json.creative`). */
export async function uploadCreative(client, { type = 'png', name, filename, bytes, contentType, seed, headers = {}, withCsrf = true } = {}) {
  const data = bytes ?? MAKERS[type](seed);
  const query = new URLSearchParams();
  if (name !== undefined) query.set('name', name);
  query.set('filename', filename ?? `arquivo.${type}`);
  return client.request('POST', `/api/creatives?${query}`, { raw: data, headers: { 'content-type': contentType ?? MIME[type], ...headers }, withCsrf });
}

/** Envia e devolve só o ID (falha o teste se não for 201). */
export async function uploadedId(client, options = {}) {
  const res = await uploadCreative(client, options);
  if (res.status !== 201) throw new Error(`upload falhou: ${res.status} ${res.text}`);
  return res.json.creative.id;
}

/** PNG mínimo com a largura e a altura pedidas no cabeçalho (assinatura + IHDR): o que o servidor lê para conferir a forma da imagem. */
export function pngWithSize(width, height) {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(width, 16);
  head.writeUInt32BE(height, 20);
  return head;
}

/** JPEG mínimo (SOI + APP0 + quadro SOF) com a largura e a altura pedidas; `sof` troca o tipo do quadro (0xc0 baseline, 0xc2 progressivo). */
export function jpegWithSize(width, height, { sof = 0xc0 } = {}) {
  const app = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const frame = Buffer.alloc(19);
  frame[0] = 0xff;
  frame[1] = sof;
  frame.writeUInt16BE(17, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app, frame, Buffer.from([0xff, 0xd9])]);
}
