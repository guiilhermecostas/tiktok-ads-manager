import { COUNTRIES, STEPS, defaultConfig, findField, getPath, isVisible, reconcileConfig, validateConfig } from './campaign-spec.js';

/**
 * "Anúncio padrão" de um catálogo: o que a campanha de catálogo já puxa pronto (criativos da biblioteca, produtos, texto, botão, URL, identidade,
 * conversão, orçamento e público básico). Guarda só campos da própria especificação da campanha, validados por ela: servidor e tela usam as mesmas regras.
 * Módulo isomórfico (sem Node nem DOM).
 */
export const CATALOG_DEFAULT_PATHS = Object.freeze([
  // Criativo e produtos
  'ad.format', 'ad.videoCreativeId', 'ad.coverCreativeId', 'ad.productSpecificType', 'ad.productSetId', 'ad.skuIds',
  // Texto e destino
  'ad.text', 'ad.callToAction', 'ad.landingPageUrl', 'ad.utmParams',
  // Identidade
  'ad.identityType', 'ad.identityId', 'ad.displayName',
  // Conversão e orçamento
  'adGroup.optimizationGoal', 'adGroup.optimizationEvent', 'adGroup.billingEvent', 'adGroup.pixelId', 'adGroup.bidType', 'adGroup.bidPrice', 'adGroup.budgetMode', 'adGroup.budget',
  // Público básico
  'adGroup.locations', 'adGroup.gender', 'adGroup.ageGroups', 'adGroup.languages',
]);
export const CREATIVE_PATHS = Object.freeze({ 'ad.videoCreativeId': 'video', 'ad.coverCreativeId': 'image' });
export const CATALOG_DEFAULT_GROUPS = Object.freeze([
  { title: 'Criativo e produtos', paths: ['ad.format', 'ad.videoCreativeId', 'ad.coverCreativeId', 'ad.productSpecificType', 'ad.productSetId', 'ad.skuIds'] },
  { title: 'Texto e destino', paths: ['ad.text', 'ad.callToAction', 'ad.landingPageUrl', 'ad.utmParams'] },
  { title: 'Identidade do anúncio', paths: ['ad.identityType', 'ad.identityId', 'ad.displayName'] },
  { title: 'Conversão e orçamento', paths: ['adGroup.optimizationGoal', 'adGroup.optimizationEvent', 'adGroup.billingEvent', 'adGroup.pixelId', 'adGroup.bidType', 'adGroup.bidPrice', 'adGroup.budgetMode', 'adGroup.budget'] },
  { title: 'Público', paths: ['adGroup.locations', 'adGroup.gender', 'adGroup.ageGroups', 'adGroup.languages'] },
]);

const isPlain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isBlank = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Só os campos permitidos (e com valor) de uma configuração `{ adGroup, ad }`. */
export function pickDefaults(config) {
  const out = { adGroup: {}, ad: {} };
  for (const path of CATALOG_DEFAULT_PATHS) {
    const [section, key] = path.split('.');
    const value = isPlain(config?.[section]) ? config[section][key] : undefined;
    if (!isBlank(value)) out[section][key] = value;
  }
  return out;
}

/**
 * Valida o "anúncio padrão" recebido (entrada não confiável) com as regras da campanha de catálogo. Devolve `{ defaults, errors }`:
 * `defaults` só tem campos permitidos, válidos e que a pessoa de fato informou (os valores padrão do assistente não entram: nada é "fixado" sem querer).
 */
export function validateCatalogDefaults(raw) {
  const picked = pickDefaults(raw);
  const { config, errors } = validateConfig({ campaign: { objective: 'PRODUCT_SALES' }, adGroup: picked.adGroup, ad: picked.ad });
  const defaults = { adGroup: {}, ad: {} };
  for (const path of CATALOG_DEFAULT_PATHS) {
    const [section, key] = path.split('.');
    if (Object.prototype.hasOwnProperty.call(picked[section], key) && !isBlank(config[section][key])) defaults[section][key] = config[section][key];
  }
  return { defaults, errors: errors.filter((e) => CATALOG_DEFAULT_PATHS.includes(e.path)) };
}

/** Configuração inicial de uma campanha de catálogo: objetivo, o catálogo e a BC dona, o país dele e nomes sugeridos; o anúncio padrão salvo vai por cima. */
export function catalogPresetConfig(catalog, defaults = null) {
  const config = defaultConfig();
  const label = (catalog.name || catalog.id).slice(0, 80);
  config.campaign.objective = 'PRODUCT_SALES';
  config.campaign.name = `Vendas | ${label}`;
  config.adGroup.name = `Grupo | ${label}`;
  config.adGroup.catalogId = catalog.id;
  config.adGroup.catalogBcId = catalog.bcId;
  if (COUNTRIES.some((c) => c.value === catalog.regionCode)) config.adGroup.locations = [catalog.regionCode];
  config.ad.name = `Anúncio | ${label}`;
  config.ad.format = 'CATALOG_VIDEO';
  return mergeCatalogDefaults(config, defaults);
}

/** Aplica o anúncio padrão sobre uma configuração (só os campos permitidos) e poda o que ficou oculto ou inválido. */
export function mergeCatalogDefaults(config, defaults) {
  if (!defaults) return reconcileConfig(config);
  const next = { ...config, adGroup: { ...config.adGroup }, ad: { ...config.ad } };
  const picked = pickDefaults(defaults);
  for (const section of ['adGroup', 'ad']) Object.assign(next[section], picked[section]);
  return reconcileConfig(next);
}

/** Os criativos da biblioteca referenciados pelo anúncio padrão (para conferir o dono e para carregar as miniaturas). */
export function defaultCreativeRefs(defaults) {
  const refs = [];
  for (const [path, kind] of Object.entries(CREATIVE_PATHS)) {
    const [section, key] = path.split('.');
    const id = defaults?.[section]?.[key];
    if (id !== undefined) refs.push({ path, id, kind });
  }
  return refs;
}

/**
 * Quanto falta para a campanha de catálogo sair pronta: confere o que o assistente exigiria (etapas Campanha, Grupo e Anúncio, sem a escolha das
 * contas) e agrupa o que falta por assunto. `{ groups: [{ title, items: [{ path, label, ok }] }], ready, missing }`.
 */
export function catalogReadiness(catalog, defaults) {
  const config = catalogPresetConfig(catalog, defaults);
  const { errors } = validateConfig(config, { requireComplete: true, steps: STEPS.filter((s) => s.id !== 'review').map((s) => s.id) });
  const bad = new Map(errors.map((e) => [e.path, e.message]));
  const groups = CATALOG_DEFAULT_GROUPS.map((group) => ({
    title: group.title,
    items: group.paths
      .filter((path) => { const [section, key] = path.split('.'); return isVisible(findField(section, key), config); })
      .map((path) => { const [section, key] = path.split('.'); return { path, label: findField(section, key).label, ok: !bad.has(path), message: bad.get(path) ?? null, value: getPath(config, path) }; }),
  })).filter((group) => group.items.length);
  const missing = groups.flatMap((g) => g.items).filter((item) => !item.ok);
  return { groups, ready: errors.length === 0, missing };
}
