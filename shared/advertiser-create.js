/**
 * Regras da criação de contas de anúncio dentro de uma Business Center ("+ CA"). Fonte ÚNICA usada pelo servidor (validação)
 * e pela tela (limites, prévia dos nomes), para os dois nunca divergirem.
 */

/** Quantas contas podem ser criadas por pedido (cada uma é uma chamada ao TikTok, feitas uma de cada vez). */
export const MAX_CREATE_ADVERTISERS = 10;

/** Nome da conta no TikTok: até 100 caracteres. Reservamos 4 para o número ("␣10"). */
export const MAX_ACCOUNT_BASE_NAME = 90;

/** Nomes das contas: com uma só, o nome como está; com várias, o nome + número com dois dígitos ("Loja 01", "Loja 02"…). */
export function accountNames(baseName, count) {
  const base = String(baseName ?? '').trim();
  if (count <= 1) return [base];
  return Array.from({ length: count }, (_, i) => `${base} ${String(i + 1).padStart(2, '0')}`);
}

/** Moeda ISO 4217 (3 letras maiúsculas) ou null. */
export function normalizeCurrency(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** País/região de registro: código de 2 letras maiúsculas (ex.: BR) ou null. */
export function normalizeCountry(value) {
  const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Fuso no formato do TikTok (nome IANA, ex.: America/Sao_Paulo) ou null. Só aceita o que o ambiente reconhece como fuso real. */
export function normalizeTimezone(value) {
  const zone = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}
