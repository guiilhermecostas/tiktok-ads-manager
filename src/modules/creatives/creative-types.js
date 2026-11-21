/**
 * Tipos de criativo aceitos e detecção pelo CONTEÚDO real do arquivo (primeiros bytes).
 * O tipo declarado pelo navegador (Content-Type) é só uma dica: ele nunca decide o que é guardado ou servido.
 * SVG, HTML, GIF animado, HEIC etc. não são aceitos (SVG/HTML poderiam executar script ao serem exibidos).
 */

/** Tipo declarado (Content-Type do envio) -> categoria esperada. */
export const DECLARED_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'video/mp4': 'video',
  'video/quicktime': 'video',
};

/** Quantos bytes iniciais são necessários para identificar o tipo. */
export const SNIFF_BYTES = 16;

// Marcas ("brands") do contêiner ISO-BMFF que são VÍDEO. Imagens HEIC/AVIF também usam "ftyp", por isso a lista é explícita.
const VIDEO_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VH', 'M4VP', 'MSNV', 'dash', 'f4v ', '3gp4', '3gp5', '3gp6']);

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, i) => buffer[offset + i] === byte);

/**
 * @param {Buffer} head primeiros bytes do arquivo
 * @returns {{ kind: 'image'|'video', mime: string, ext: string } | null}
 */
export function sniffCreativeType(head) {
  if (head.length >= 3 && startsWith(head, [0xff, 0xd8, 0xff])) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (head.length >= 8 && startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (head.length >= 12 && head.toString('latin1', 4, 8) === 'ftyp') {
    const brand = head.toString('latin1', 8, 12);
    if (brand === 'qt  ') return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (VIDEO_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  return null;
}

/** Extensões e tipos que o sistema serve de volta (apenas os que ele mesmo gravou). */
export const MIME_BY_EXT = { jpg: 'image/jpeg', png: 'image/png', mp4: 'video/mp4', mov: 'video/quicktime' };
