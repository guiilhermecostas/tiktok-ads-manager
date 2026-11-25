/**
 * Status do TikTok ("secondary_status": tabelas "Ad status", "Ad group status" e "Campaign status - secondary status" da documentação oficial),
 * em português, com o tom visual e se indica problema. Valor desconhecido aparece "humanizado" (nada quebra quando o TikTok cria um status novo).
 * tom: success (rodando) | neutral (pausado/encerrado) | warning (em análise/aguardando) | danger (problema que exige ação).
 */
const S = (label, tone, problem = false) => ({ label, tone, problem });

export const AD_STATUSES = Object.freeze({
  AD_STATUS_DELIVERY_OK: S('Em veiculação', 'success'),
  AD_STATUS_DISABLE: S('Pausado', 'neutral'),
  AD_STATUS_CAMPAIGN_DISABLE: S('Campanha pausada', 'neutral'),
  AD_STATUS_ADGROUP_DISABLE: S('Grupo pausado', 'neutral'),
  AD_STATUS_DONE: S('Concluído', 'neutral'),
  AD_STATUS_NOT_START: S('Aguardando início', 'warning'),
  AD_STATUS_LIVE_OFFLINE: S('Live não iniciada', 'warning'),
  AD_STATUS_AD_PRE_ONLINE: S('Preparando para entrar no ar', 'warning'),
  AD_STATUS_AUDIT: S('Em análise', 'warning'),
  AD_STATUS_REAUDIT: S('Edição em análise', 'warning'),
  AD_STATUS_PROCESS_AUDIO: S('Processando áudio', 'warning'),
  AD_STATUS_AUDIT_DENY: S('Reprovado', 'danger', true),
  AD_STATUS_ADGROUP_AUDIT_DENY: S('Grupo reprovado', 'danger', true),
  AD_STATUS_ADVERTISER_AUDIT_DENY: S('Conta reprovada', 'danger', true),
  AD_STATUS_ADVERTISER_AUDIT: S('Conta em análise', 'warning'),
  AD_STATUS_BALANCE_EXCEED: S('Saldo insuficiente', 'danger', true),
  AD_STATUS_CAMPAIGN_EXCEED: S('Campanha sem orçamento', 'danger', true),
  AD_STATUS_BUDGET_EXCEED: S('Grupo sem orçamento', 'danger', true),
  AD_STATUS_REVIEW_PARTIALLY_APPROVED: S('Criativo reprovado', 'danger', true),
  AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK: S('Em veiculação (análise parcial)', 'warning'),
  AD_STATUS_PARTIAL_AUDIT_NO_DELIVERY: S('Análise parcial, sem veiculação', 'warning'),
  AD_STATUS_ADGROUP_PARTIAL_AUDIT_NO_DELIVERY: S('Análise parcial, sem veiculação', 'warning'),
  AD_STATUS_ADGROUP_INDUSTRY_QUALIFICATION_MISSING: S('Falta qualificação do ramo', 'danger', true),
  AD_STATUS_ADGROUP_INDUSTRY_QUALIFICATION_EXPIRED: S('Qualificação do ramo vencida', 'danger', true),
  AD_STATUS_ADGROUP_INDUSTRY_QUALIFICATION_DENY: S('Qualificação do ramo recusada', 'danger', true),
  AD_STATUS_MUSIC_AUTHORIZATION_MISSING: S('Falta autorização de música', 'danger', true),
  AD_STAUS_PIXEL_UNBIND: S('Pixel desvinculado', 'danger', true),
  AD_STATUS_TRANSCODING_FAIL: S('Falha ao processar o vídeo', 'danger', true),
  AD_STATUS_ADGROUP_ASSET_AUTHORIZATION_LOST: S('Autorização do recurso perdida', 'danger', true),
  AD_STATUS_ASSET_AUTHORIZATION_LOST: S('Autorização do recurso perdida', 'danger', true),
  AD_STATUS_AD_QUOTA_LIMIT: S('Limite de grupos da conta', 'danger', true),
  AD_STATUS_PRODUCT_UNAVAILABLE: S('Produto indisponível', 'danger', true),
  AD_STATUS_ANCHOR_UNAVAILABLE: S('Link do produto indisponível', 'danger', true),
  AD_STATUS_NO_AUTHORIZATION_OF_SHOWCASE: S('Identidade do Showcase indisponível', 'danger', true),
  AD_STATUS_RF_ADGROUP_CLOSED: S('Grupo R&F encerrado', 'neutral'),
  AD_STATUS_PROMOTE_AD_OFFLINE_AUDIT: S('Criativo do Promote reprovado', 'danger', true),
  AD_STATUS_PROMOTE_ADGROUP_CLOSED: S('Grupo Promote encerrado', 'neutral'),
  AD_STATUS_CAMPAIGN_DELETE: S('Campanha excluída', 'neutral'),
  AD_STATUS_ADGROUP_DELETE: S('Grupo excluído', 'neutral'),
  AD_STATUS_DELETE: S('Excluído', 'neutral'),
  // Status da documentação que NÃO têm o prefixo AD_STATUS_ (antes apareciam "crus", ex.: "Advertiser account punish").
  ADVERTISER_ACCOUNT_PUNISH: S('Conta penalizada pelo TikTok', 'danger', true),
  ADVERTISER_ACCOUNT_INVALID: S('Conta inválida', 'danger', true),
  ADVERTISER_ACCOUNT_BALANCE_EXCEED: S('Saldo da conta insuficiente', 'danger', true),
  ADVERTISER_CONTRACT_PENDING: S('Contrato da conta ainda não vigora', 'warning'),
  ADVERTISER_REAUDIT: S('Conta em reanálise', 'warning'),
  // Estados que só aparecem no nível de grupo/campanha, mas o TikTok pode repetir no anúncio.
  ADGROUP_STATUS_DELETE: S('Grupo excluído', 'neutral'),
  ADGROUP_STATUS_CAMPAIGN_DELETE: S('Campanha excluída', 'neutral'),
  CAMPAIGN_STATUS_DELETE: S('Campanha excluída', 'neutral'),
  ADGROUP_STATUS_FROZEN: S('Grupo congelado', 'danger', true),
  AD_STATUS_CREATIVE_ANCHOR_UNAVAILABLE: S('Link do criativo indisponível', 'danger', true),
  AD_STATUS_CREATIVE_PRODUCT_ALL_REJECTED: S('Todos os produtos do criativo reprovados', 'danger', true),
  AD_STATUS_CREATOR_AUTHORIZATION_REVOKED: S('Autorização do criador revogada', 'danger', true),
  AD_STATUS_SHOWCASE_AUTHORIZATION_LOST: S('Autorização do Showcase perdida', 'danger', true),
});

/** Estados da CONTA que o TikTok repete em campanhas, grupos e anúncios (não têm prefixo do nível). */
const ACCOUNT_STATUSES = Object.fromEntries(Object.entries(AD_STATUSES).filter(([key]) => key.startsWith('ADVERTISER_')));

export const ADGROUP_STATUSES = Object.freeze({
  ...ACCOUNT_STATUSES,
  ADGROUP_STATUS_DELIVERY_OK: S('Em veiculação', 'success'),
  ADGROUP_STATUS_DISABLE: S('Pausado', 'neutral'),
  ADGROUP_STATUS_CAMPAIGN_DISABLE: S('Campanha pausada', 'neutral'),
  ADGROUP_STATUS_TIME_DONE: S('Concluído', 'neutral'),
  ADGROUP_STATUS_NOT_START: S('Aguardando início', 'warning'),
  ADGROUP_STATUS_LIVE_NOT_START: S('Live não iniciada', 'warning'),
  ADGROUP_STATUS_CREATE: S('Recém-criado', 'warning'),
  ADGROUP_STATUS_AUDIT: S('Em análise', 'warning'),
  ADGROUP_STATUS_REAUDIT: S('Edição em análise', 'warning'),
  ADGROUP_STATUS_SHADOW_ADGROUP_REAUDIT: S('Em nova análise', 'warning'),
  ADGROUP_STATUS_ADVERTISER_AUDIT: S('Conta em análise', 'warning'),
  ADGROUP_STATUS_PARTIAL_AUDIT_DELIVERY_OK: S('Em veiculação (análise parcial)', 'warning'),
  ADGROUP_STATUS_PARTIAL_AUDIT_NO_DELIVERY: S('Análise parcial, sem veiculação', 'warning'),
  ADGROUP_STATUS_AUDIT_DENY: S('Reprovado', 'danger', true),
  ADGROUP_STATUS_ADVERTISER_AUDIT_DENY: S('Conta reprovada', 'danger', true),
  ADGROUP_STATUS_REVIEW_PARTIALLY_APPROVED: S('Anúncio reprovado no grupo', 'danger', true),
  ADGROUP_STATUS_BALANCE_EXCEED: S('Saldo insuficiente', 'danger', true),
  ADGROUP_STATUS_CAMPAIGN_EXCEED: S('Campanha sem orçamento', 'danger', true),
  ADGROUP_STATUS_BUDGET_EXCEED: S('Grupo sem orçamento', 'danger', true),
  ADGROUP_STATUS_FROZEN: S('Grupo congelado', 'danger', true),
  ADGROUP_STATUS_PIXEL_UNBIND: S('Pixel desvinculado', 'danger', true),
  ADGROUP_STATUS_INDUSTRY_QUALIFICATION_MISSING: S('Falta qualificação do ramo', 'danger', true),
  ADGROUP_STATUS_INDUSTRY_QUALIFICATION_EXPIRED: S('Qualificação do ramo vencida', 'danger', true),
  ADGROUP_STATUS_INDUSTRY_QUALIFICATION_DENY: S('Qualificação do ramo recusada', 'danger', true),
  ADGROUP_STATUS_ASSET_AUTHORIZATION_LOST: S('Autorização do recurso perdida', 'danger', true),
  ADGROUP_STATUS_TRANSCODING_FAIL: S('Falha ao processar o vídeo', 'danger', true),
  ADGROUP_STATUS_ADGROUP_QUOTA_LIMIT: S('Limite de grupos da conta', 'danger', true),
  ADGROUP_STATUS_DELETE: S('Excluído', 'neutral'),
  ADGROUP_STATUS_CAMPAIGN_DELETE: S('Campanha excluída', 'neutral'),
});

export const CAMPAIGN_STATUSES = Object.freeze({
  ...ACCOUNT_STATUSES,
  CAMPAIGN_STATUS_ENABLE: S('Em veiculação', 'success'),
  CAMPAIGN_STATUS_DISABLE: S('Pausada', 'neutral'),
  CAMPAIGN_STATUS_BUDGET_EXCEED: S('Sem orçamento', 'danger', true),
  CAMPAIGN_STATUS_AWAITING_RELEASE: S('Aguardando liberação', 'warning'),
  CAMPAIGN_STATUS_ADVERTISER_AUDIT: S('Conta em análise', 'warning'),
  CAMPAIGN_STATUS_ADVERTISER_AUDIT_DENY: S('Conta reprovada', 'danger', true),
  CAMPAIGN_STATUS_REVIEW_DISAPPROVED: S('Reprovada', 'danger', true),
  CAMPAIGN_STATUS_PRODUCT_UNAVAILABLE: S('Produto indisponível', 'danger', true),
  CAMPAIGN_STATUS_AD_UNAVAILABLE: S('Sem anúncio disponível', 'danger', true),
  CAMPAIGN_STATUS_TIKTOK_SHOP_UNAVAILABLE: S('TikTok Shop desconectada', 'danger', true),
  CAMPAIGN_STATUS_DELETE: S('Excluída', 'neutral'),
});

const TABLES = Object.freeze({ ads: AD_STATUSES, adgroups: ADGROUP_STATUSES, campaigns: CAMPAIGN_STATUSES });

/** Informações de exibição de um status (conhecido ou não). */
export function adStatusInfo(status) {
  if (!status) return S('Sem status', 'neutral');
  const known = AD_STATUSES[status];
  if (known) return known;
  const text = String(status).replace(/^(AD_STAT?US_|ADGROUP_STATUS_|CAMPAIGN_STATUS_|ADVERTISER_)/, '').replace(/_/g, ' ').toLowerCase();
  return S(text.charAt(0).toUpperCase() + text.slice(1), 'neutral');
}

export const isAdProblem = (status) => Boolean(AD_STATUSES[status]?.problem);

/** Informações de exibição do status em um nível ('campaigns' | 'adgroups' | 'ads'); sem tabela conhecida, humaniza. */
export function statusInfo(level, status) {
  if (!status) return S('Sem status', 'neutral');
  return (TABLES[level] ?? AD_STATUSES)[status] ?? adStatusInfo(status);
}
export const isProblem = (level, status) => Boolean((TABLES[level] ?? AD_STATUSES)[status]?.problem);
