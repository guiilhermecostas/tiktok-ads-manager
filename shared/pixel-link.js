/**
 * Vínculo de pixel com contas de anúncio (`/bc/pixel/link/update/` do TikTok). Fonte ÚNICA usada pelo servidor (validação) e pela tela
 * (limites e textos): o que a tela mostra é exatamente o que o servidor aceita.
 */

/** Quantas contas de anúncio vão em um pedido de vínculo (o servidor recusa mais que isso). */
export const MAX_LINK_ADVERTISERS = 50;
/** `LINK` vincula o pixel às contas; `UNLINK` desfaz o vínculo (nome oficial do TikTok em `relation_status`). */
export const PIXEL_LINK_ACTIONS = Object.freeze(['LINK', 'UNLINK']);
/** Código do pixel (o que aparece no Gerenciador de Eventos do TikTok): letras e números. */
export const PIXEL_CODE_RE = /^[A-Za-z0-9]{6,40}$/;

/** Código do pixel sem espaços nas pontas, ou null se não tiver o formato do TikTok. */
export function normalizePixelCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  return PIXEL_CODE_RE.test(code) ? code : null;
}
