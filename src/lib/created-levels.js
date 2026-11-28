/**
 * O que fazer com os IDs de uma publicação quando a conferência no TikTok diz que algum nível NÃO existe: o ID dele sai (para a próxima tentativa recriar), e o dos níveis que
 * dependem dele também (sem campanha o grupo não vale; sem grupo o anúncio não vale). Função pura: devolve uma cópia nova.
 * @param {{ campaignId: string|null, adGroupId: string|null, adId: string|null }} ids
 * @param {('campaign'|'adGroup'|'ad')[]} missing
 */
export function dropMissing(ids, missing) {
  const next = { campaignId: ids.campaignId ?? null, adGroupId: ids.adGroupId ?? null, adId: ids.adId ?? null };
  if (missing.includes('campaign')) return { campaignId: null, adGroupId: null, adId: null };
  if (missing.includes('adGroup')) return { ...next, adGroupId: null, adId: null };
  if (missing.includes('ad')) return { ...next, adId: null };
  return next;
}
