import { sniffCreativeType } from '../creatives/creative-types.js';

/**
 * Tipos de anexo aceitos e conferência pelo CONTEÚDO (a extensão e o Content-Type informados são só dicas). Documentos e
 * imagens apenas: nada executável, HTML, SVG, script nem JSON/XML (que um navegador poderia interpretar). Os arquivos são
 * sempre entregues como DOWNLOAD (nunca abertos no navegador), então um PDF ou DOCX malicioso não roda no site.
 */
export const ATTACHMENT_EXTENSIONS = Object.freeze(['txt', 'csv', 'log', 'md', 'pdf', 'png', 'jpg', 'docx', 'xlsx']);
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_ACCOUNT = 50;
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set(['txt', 'csv', 'log', 'md']);
const TEXT_SCAN_BYTES = 64 * 1024;

/** Texto de verdade: sem byte nulo e UTF-8 válido (aceita um caractere cortado no fim do trecho examinado). */
function looksLikeText(buffer) {
  const head = buffer.subarray(0, TEXT_SCAN_BYTES);
  if (head.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: buffer.length > TEXT_SCAN_BYTES });
    return true;
  } catch {
    return false;
  }
}

/** Extensão (minúscula) do nome, ou null. Só a ÚLTIMA extensão conta: "a.txt.exe" é .exe e é recusado. */
export function extensionOf(filename) {
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(filename);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Confere nome + conteúdo. Devolve a extensão confirmada ou null se o tipo não é aceito ou o conteúdo não bate com ele.
 * `buffer` é o arquivo inteiro (no máximo MAX_FILE_BYTES).
 */
export function detectAttachment(filename, buffer) {
  let ext = extensionOf(filename);
  if (ext === 'jpeg') ext = 'jpg';
  if (!ext || !ATTACHMENT_EXTENSIONS.includes(ext) || buffer.length === 0) return null;
  if (TEXT_EXTENSIONS.has(ext)) return looksLikeText(buffer) ? ext : null;
  if (ext === 'pdf') return buffer.subarray(0, 5).toString('latin1') === '%PDF-' ? ext : null;
  if (ext === 'png' || ext === 'jpg') return sniffCreativeType(buffer.subarray(0, 16))?.ext === ext ? ext : null;
  // docx e xlsx são ZIP (assinatura "PK\x03\x04"); o arquivo nunca é descompactado nem executado pelo sistema.
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04 ? ext : null;
}

/** Nome seguro para guardar e exibir: sem pasta, sem caracteres de controle, espaços normalizados, até 120 caracteres. */
export function sanitizeFilename(raw) {
  // eslint-disable-next-line no-control-regex
  const base = String(raw ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '').replace(/\s+/g, ' ').trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return null;
  if (base.length <= 120) return base;
  const ext = extensionOf(base);
  return ext ? `${base.slice(0, 120 - ext.length - 1)}.${ext}` : base.slice(0, 120);
}
