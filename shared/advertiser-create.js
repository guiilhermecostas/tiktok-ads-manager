import { isTikTokLocation } from './tiktok-locations.js';
import { isTikTokTimezone } from './tiktok-timezones.js';

/**
 * Regras da criação de contas de anúncio dentro de uma Business Center ("+ CA"), conforme a documentação OFICIAL do TikTok
 * (`POST /open_api/v1.3/bc/advertiser/create/`). Fonte ÚNICA usada pelo servidor (validação) e pela tela (limites, listas, prévia),
 * para os dois nunca divergirem.
 */

/** Quantas contas podem ser criadas por pedido (cada uma é uma chamada ao TikTok, feitas uma de cada vez: o TikTok não cria várias de uma vez). */
export const MAX_CREATE_ADVERTISERS = 10;

/** Nome da conta no TikTok: até 100 caracteres. Reservamos 4 para o número ("␣10"). */
export const MAX_ACCOUNT_BASE_NAME = 90;

/** Nomes das contas: com uma só, o nome como está; com várias, o nome + número com dois dígitos ("Loja 01", "Loja 02"…). */
export function accountNames(baseName, count) {
  const base = String(baseName ?? '').trim();
  if (count <= 1) return [base];
  return Array.from({ length: count }, (_, i) => `${base} ${String(i + 1).padStart(2, '0')}`);
}

/** Moeda ISO 4217 (3 letras maiúsculas) ou null. O TikTok exige a MESMA moeda da Business Center. */
export function normalizeCurrency(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** País/região de registro: código de 2 letras da tabela oficial de países do TikTok (ex.: US, BR) ou null. */
export function normalizeCountry(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) && isTikTokLocation(code) ? code : null;
}

/** Fuso horário: SÓ os códigos da tabela oficial do TikTok (ex.: America/Sao_Paulo). "Etc/GMT+5" e semelhantes são recusados pelo TikTok. */
export function normalizeTimezone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  return isTikTokTimezone(zone) ? zone : null;
}

/** BCs de agência exigem o site da empresa (`qualification_info.promotion_link`); BCs DIRECT NÃO podem receber `qualification_info`. */
export const requiresPromotionLink = (bcType) => bcType === 'AGENCY' || bcType === 'SELF_SERVICE_AGENCY';
export const forbidsQualification = (bcType) => bcType === 'DIRECT';

/** Endereço do site da empresa (http/https, até 255 caracteres, sem credenciais) ou null. */
export function normalizePromotionLink(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 255) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname.includes('.')) return null;
    return url.toString().slice(0, 255);
  } catch {
    return null;
  }
}

/**
 * Países onde o TikTok exige documentos (licença/CNPJ, imagens de qualificação, e-mail e dados de cobrança) que este sistema ainda não envia.
 * Para esses, a criação é recusada aqui com uma explicação clara, em vez de falhar no TikTok.
 */
export const AREAS_NEEDING_DOCUMENTS = Object.freeze({ CN: 'China continental', HK: 'Hong Kong', BR: 'Brasil', MX: 'México', FR: 'França' });
