/** Configuração completa e válida para um objetivo (base dos testes). */
export function completeConfig(objective = 'TRAFFIC', over = {}) {
  const base = {
    campaign: { name: 'Black Friday', objective },
    adGroup: {
      name: 'Grupo 1', locations: ['BR'], budgetMode: 'BUDGET_MODE_DAY', budget: 5000,
      optimizationGoal: { TRAFFIC: 'CLICK', WEB_CONVERSIONS: 'CONVERT', PRODUCT_SALES: 'CONVERT', LEAD_GENERATION: 'LEAD_GENERATION', APP_PROMOTION: 'INSTALL', REACH: 'REACH', VIDEO_VIEWS: 'VIDEO_VIEW', ENGAGEMENT: 'FOLLOWERS' }[objective],
      billingEvent: { TRAFFIC: 'CPC', WEB_CONVERSIONS: 'OCPM', PRODUCT_SALES: 'OCPM', LEAD_GENERATION: 'OCPM', APP_PROMOTION: 'OCPM', REACH: 'CPM', VIDEO_VIEWS: 'CPV', ENGAGEMENT: 'OCPM' }[objective],
    },
    ad: { name: 'Anúncio 1', identityType: 'CUSTOMIZED_USER', identityId: 'id-123456', displayName: 'Minha Loja', videoCreativeId: 1, text: 'Aproveite agora!', landingPageUrl: 'https://loja.example.com/promo' },
  };
  if (['WEB_CONVERSIONS', 'PRODUCT_SALES'].includes(objective)) Object.assign(base.adGroup, { pixelId: '123456', optimizationEvent: 'SHOPPING' });
  if (objective === 'PRODUCT_SALES') base.adGroup.catalogId = '777';
  if (objective === 'APP_PROMOTION') { base.campaign.appPromotionType = 'APP_INSTALL'; base.adGroup.appPlatform = 'APP_ANDROID'; base.adGroup.appId = '555'; delete base.ad.landingPageUrl; }
  if (objective === 'LEAD_GENERATION') base.adGroup.leadDestination = 'WEBSITE';
  if (['REACH', 'VIDEO_VIEWS', 'ENGAGEMENT'].includes(objective)) delete base.ad.landingPageUrl;
  for (const [section, values] of Object.entries(over)) Object.assign(base[section], values);
  return base;
}
