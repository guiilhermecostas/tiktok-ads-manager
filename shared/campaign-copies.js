/**
 * Várias campanhas iguais por conta (ex.: 5 campanhas idênticas para testar fatias de público): regras compartilhadas entre o servidor e a tela.
 * Cada cópia é uma campanha própria (rascunho com nome numerado), com o mesmo grupo de anúncios e anúncio, publicada PAUSADA em cada conta escolhida.
 */

/** Quantas campanhas iguais, no máximo, por conta em uma rodada. */
export const MAX_COPIES = 10;
/** Teto de campanhas criadas em uma rodada (cópias × contas): protege o limite de pedidos do TikTok e o tempo de publicação. */
export const MAX_PUBLICATIONS_PER_RUN = 60;
/** Limite do nome da campanha (o mesmo da especificação). */
export const CAMPAIGN_NAME_MAX = 100;

/**
 * Nomes das cópias: com uma só, o nome como está; com várias, o nome + número com dois dígitos ("Black Friday 01", "Black Friday 02"…),
 * sempre dentro do limite de 100 caracteres (corta o começo do nome, nunca o número).
 */
export function copyNames(baseName, count) {
  const base = String(baseName ?? '').trim();
  if (!Number.isInteger(count) || count <= 1) return [base];
  const width = Math.max(2, String(count).length);
  return Array.from({ length: count }, (_, i) => {
    const number = String(i + 1).padStart(width, '0');
    const suffix = base ? ` ${number}` : number; // sem nome base, só o número (sem espaço sobrando no começo)
    return `${base.slice(0, CAMPAIGN_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
  });
}

/** O maior número de cópias que cabe no teto da rodada para esta quantidade de contas (nunca menos que 1, nunca mais que MAX_COPIES). */
export const maxCopiesFor = (accounts) => Math.max(1, Math.min(MAX_COPIES, Math.floor(MAX_PUBLICATIONS_PER_RUN / Math.max(1, accounts))));

/** Quantidade de cópias válida (inteiro de 1 a MAX_COPIES) ou null. */
export const normalizeCopies = (value) => (Number.isInteger(value) && value >= 1 && value <= MAX_COPIES ? value : null);
