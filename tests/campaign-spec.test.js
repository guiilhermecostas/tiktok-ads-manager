import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ACCOUNT_FIELDS, COUNTRIES, FIELDS, OBJECTIVES, STEPS, defaultConfig, fieldsOfStep, findField, getOptions, isRequired, isVisible,
  applyAccountOverrides, pruneConfig, reconcileConfig, stepOfPath, summarize, validateConfig,
} from '../shared/campaign-spec.js';
import { completeConfig } from './campaign-fixtures.js';

describe('catálogo da especificação', () => {
  it('cobre todos os 8 objetivos do TikTok e as 5 etapas', () => {
    assert.deepEqual(OBJECTIVES.map((o) => o.value).sort(), ['APP_PROMOTION', 'ENGAGEMENT', 'LEAD_GENERATION', 'PRODUCT_SALES', 'REACH', 'TRAFFIC', 'VIDEO_VIEWS', 'WEB_CONVERSIONS']);
    assert.deepEqual(STEPS.map((s) => s.id), ['objective', 'campaign', 'adGroup', 'ad', 'review']);
  });
  it('todo campo pertence a uma etapa existente e tem rótulo; chaves são únicas por seção', () => {
    const stepIds = new Set(STEPS.map((s) => s.id));
    for (const [section, fields] of Object.entries(FIELDS)) {
      const keys = fields.map((f) => f.key);
      assert.equal(new Set(keys).size, keys.length, `chaves duplicadas em ${section}`);
      for (const f of fields) {
        assert.ok(stepIds.has(f.step), `${section}.${f.key} sem etapa válida`);
        assert.ok(f.label, `${section}.${f.key} sem rótulo`);
        assert.ok(['string', 'advertiser', 'int', 'money', 'bool', 'enum', 'objective', 'enumList', 'stringList', 'datetime', 'url', 'creative', 'creativeList'].includes(f.type), `${section}.${f.key} tipo`);
        if (f.type === 'enum' || f.type === 'enumList') assert.ok(f.options || f.optionsBy, `${section}.${f.key} sem opções`);
      }
    }
  });
  it('toda meta de otimização possível tem pelo menos um evento de cobrança', () => {
    const goal = findField('adGroup', 'optimizationGoal');
    const billing = findField('adGroup', 'billingEvent');
    for (const o of OBJECTIVES) {
      const goals = getOptions(goal, { campaign: { objective: o.value } });
      assert.ok(goals.length > 0, `${o.value} sem metas`);
      for (const g of goals) assert.ok(getOptions(billing, { adGroup: { optimizationGoal: g.value } }).length > 0, `${g.value} sem cobrança`);
    }
  });
  it('IDs de localização são únicos e numéricos', () => {
    assert.equal(new Set(COUNTRIES.map((c) => c.locationId)).size, COUNTRIES.length);
    assert.ok(COUNTRIES.every((c) => /^\d+$/.test(c.locationId) && /^[A-Z]{2}$/.test(c.value)));
  });
  it('fieldsOfStep e stepOfPath são coerentes', () => {
    assert.equal(stepOfPath('adGroup.budget'), 'adGroup');
    assert.equal(stepOfPath('campaign.objective'), 'objective');
    assert.equal(stepOfPath('campanha.xxx'), null);
    assert.ok(fieldsOfStep('ad').every(({ section }) => section === 'ad'));
  });
});

describe('configuração completa válida para cada objetivo', () => {
  for (const { value } of OBJECTIVES) {
    it(`${value} valida sem erros`, () => {
      const { errors } = validateConfig(completeConfig(value), { requireComplete: true });
      assert.deepEqual(errors, []);
    });
  }
});

describe('visibilidade, obrigatoriedade e opções dependentes', () => {
  it('campos específicos aparecem só no objetivo certo', () => {
    const pixel = findField('adGroup', 'pixelId');
    assert.equal(isVisible(pixel, defaultConfig()), false);
    assert.equal(isVisible(pixel, { campaign: { objective: 'WEB_CONVERSIONS' } }), true);
    assert.equal(isRequired(pixel, { campaign: { objective: 'WEB_CONVERSIONS' } }), true);
    assert.equal(isVisible(findField('adGroup', 'catalogId'), { campaign: { objective: 'PRODUCT_SALES' } }), true);
    assert.equal(isVisible(findField('campaign', 'appPromotionType'), { campaign: { objective: 'APP_PROMOTION' } }), true);
    assert.equal(isVisible(findField('adGroup', 'frequency'), { campaign: { objective: 'REACH' } }), true);
    assert.equal(isVisible(findField('adGroup', 'frequency'), { campaign: { objective: 'TRAFFIC' } }), false);
  });
  it('orçamento muda de nível conforme o modo da campanha', () => {
    const groupBudget = findField('adGroup', 'budget');
    assert.equal(isVisible(groupBudget, { campaign: { budgetMode: 'BUDGET_MODE_INFINITE' } }), true);
    assert.equal(isVisible(groupBudget, { campaign: { budgetMode: 'BUDGET_MODE_DAY' } }), false);
    assert.equal(isVisible(findField('campaign', 'budget'), { campaign: { budgetMode: 'BUDGET_MODE_DAY' } }), true);
  });
  it('opções de otimização e cobrança dependem do objetivo e da meta', () => {
    const goal = findField('adGroup', 'optimizationGoal');
    assert.deepEqual(getOptions(goal, { campaign: { objective: 'REACH' } }).map((o) => o.value), ['REACH']);
    assert.deepEqual(getOptions(goal, { campaign: { objective: 'TRAFFIC' } }).map((o) => o.value), ['CLICK', 'LANDING_PAGE_VIEW']);
    assert.deepEqual(getOptions(goal, {}), []);
    const billing = findField('adGroup', 'billingEvent');
    assert.deepEqual(getOptions(billing, { adGroup: { optimizationGoal: 'CLICK' } }).map((o) => o.value), ['CPC', 'OCPM']);
  });
  it('trocar o objetivo descarta valores que deixaram de valer, sem erro', () => {
    const cfg = completeConfig('WEB_CONVERSIONS');
    cfg.campaign.objective = 'REACH';
    const { config, errors } = validateConfig(cfg, { requireComplete: false });
    assert.deepEqual(errors, []);
    assert.equal(config.adGroup.optimizationGoal, undefined, 'CONVERT não existe em REACH');
    assert.equal(config.adGroup.billingEvent, undefined, 'OCPM não existe para (meta removida)');
    assert.equal(config.adGroup.pixelId, undefined, 'pixel só vale em conversões');
    assert.equal(config.adGroup.optimizationEvent, undefined);
    assert.equal(pruneConfig(cfg).adGroup.pixelId, undefined);
  });
});

describe('reconcileConfig (poda leve do formulário)', () => {
  it('remove ocultos/obsoletos mas preserva texto inválido em digitação', () => {
    const cfg = completeConfig('WEB_CONVERSIONS');
    cfg.ad.name = 'a'; // inválido (mín. 2): o usuário ainda está digitando
    cfg.campaign.objective = 'REACH';
    const out = reconcileConfig(cfg);
    assert.equal(out.ad.name, 'a', 'não apaga o que está sendo digitado');
    assert.equal(out.adGroup.pixelId, undefined);
    assert.equal(out.adGroup.optimizationGoal, undefined);
    assert.equal(out.adGroup.billingEvent, undefined);
  });
  it('não altera a entrada e tolera lixo', () => {
    const cfg = completeConfig();
    const before = JSON.stringify(cfg);
    reconcileConfig(cfg);
    assert.equal(JSON.stringify(cfg), before);
    assert.doesNotThrow(() => reconcileConfig(null));
    assert.deepEqual(Object.keys(reconcileConfig(undefined)).sort(), ['ad', 'adGroup', 'campaign']);
  });
});

describe('validação de valores', () => {
  const run = (over, opts = { requireComplete: true }, objective = 'TRAFFIC') => validateConfig(completeConfig(objective, over), opts);
  const has = (errors, path) => errors.some((e) => e.path === path);

  it('campos obrigatórios faltando são reportados por caminho (e só no modo completo)', () => {
    const empty = validateConfig({}, { requireComplete: true });
    for (const p of ['campaign.objective', 'campaign.name', 'adGroup.name', 'adGroup.locations', 'ad.name', 'ad.identityId', 'ad.text']) {
      assert.ok(has(empty.errors, p), p);
    }
    assert.deepEqual(validateConfig({}, { requireComplete: false }).errors, []);
    assert.deepEqual(validateConfig(undefined, { requireComplete: false }).errors, []);
  });
  it('a conta de anúncio não faz parte da configuração (é escolhida ao publicar): seção antiga é ignorada', () => {
    const cfg = completeConfig();
    assert.equal('account' in cfg, false);
    const withLegacy = { ...cfg, account: { advertiserId: '9001' } };
    const { config, errors } = validateConfig(withLegacy, { requireComplete: true });
    assert.deepEqual(errors, []);
    assert.equal('account' in config, false, 'rascunhos antigos com account não quebram nem carregam o campo');
  });
  it('limita o escopo dos erros às etapas pedidas', () => {
    const { errors } = validateConfig({ campaign: { objective: 'TRAFFIC' } }, { requireComplete: true, steps: ['campaign'] });
    assert.deepEqual(errors.map((e) => e.path), ['campaign.name']);
  });
  it('tipos inválidos viram erro (texto, número, lista, booleano, enum)', () => {
    const bad = {
      campaign: { name: 123, budgetMode: 'XYZ' },
      adGroup: { name: ['a'], locations: 'BR', budget: '50', commentDisabled: 'sim', gender: 5 },
      ad: { text: { a: 1 }, format: 'GIF' },
    };
    const { errors } = validateConfig(bad, { requireComplete: false });
    for (const p of ['campaign.name', 'campaign.budgetMode', 'adGroup.name', 'adGroup.locations', 'adGroup.commentDisabled', 'adGroup.gender', 'ad.text', 'ad.format']) assert.ok(has(errors, p), p);
  });
  it('limites: tamanhos, números inteiros e listas', () => {
    assert.ok(has(run({ campaign: { name: 'x'.repeat(101) } }).errors, 'campaign.name'));
    assert.ok(has(run({ campaign: { name: 'a' } }).errors, 'campaign.name'));
    assert.ok(has(run({ adGroup: { budget: 0 } }).errors, 'adGroup.budget'));
    assert.ok(has(run({ adGroup: { budget: 10.5 } }).errors, 'adGroup.budget'));
    assert.ok(has(run({ adGroup: { budget: 1e12 } }).errors, 'adGroup.budget'));
    assert.ok(has(run({ adGroup: { locations: ['BR', 'XX'] } }).errors, 'adGroup.locations'));
    assert.ok(has(run({ adGroup: { ageGroups: ['AGE_1_2'] } }).errors, 'adGroup.ageGroups'));
    assert.ok(has(run({ adGroup: { interestCategoryIds: ['abc'] } }).errors, 'adGroup.interestCategoryIds'));
    assert.ok(has(run({ adGroup: { interestCategoryIds: Array.from({ length: 51 }, (_, i) => String(i + 1)) } }).errors, 'adGroup.interestCategoryIds'));
    assert.ok(has(run({ ad: { text: 'x'.repeat(101) } }).errors, 'ad.text'));
  });
  it('caracteres de controle e espaços extras', () => {
    assert.ok(has(run({ campaign: { name: 'Ab\u0000cd' } }).errors, 'campaign.name'));
    assert.equal(run({ campaign: { name: '  Minha   campanha  ' } }).config.campaign.name, 'Minha campanha');
  });
  it('deduplica listas', () => {
    assert.deepEqual(run({ adGroup: { locations: ['BR', 'BR', 'PT'] } }).config.adGroup.locations, ['BR', 'PT']);
  });
  it('URLs: só http(s), sem credenciais e sem esquemas perigosos', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.com', 'https://user:pw@x.com', 'https://', 'loja.com', 'https://a b.com', 'vbscript:x', 'file:///etc/passwd', 'https://x.com/' + 'a'.repeat(2100)]) {
      assert.ok(has(run({ ad: { landingPageUrl: url } }).errors, 'ad.landingPageUrl'), url);
    }
    assert.ok(!has(run({ ad: { landingPageUrl: 'https://loja.com/a?x=1#y' } }).errors, 'ad.landingPageUrl'));
    assert.ok(has(run({ ad: { impressionTrackingUrl: 'http://tracker.com/x' } }).errors, 'ad.impressionTrackingUrl'), 'rastreamento exige https');
    const app = completeConfig('APP_PROMOTION', { ad: { deeplinkUrl: 'myapp://produto/1' } });
    assert.ok(!has(validateConfig(app, { requireComplete: true }).errors, 'ad.deeplinkUrl'), 'deeplink aceita esquema do app');
    app.ad.deeplinkUrl = 'javascript:alert(1)';
    assert.ok(has(validateConfig(app, { requireComplete: true }).errors, 'ad.deeplinkUrl'));
  });
  it('UTM só aceita caracteres seguros', () => {
    assert.ok(has(run({ ad: { utmParams: 'utm_source=<script>' } }).errors, 'ad.utmParams'));
    assert.ok(!has(run({ ad: { utmParams: 'utm_source=tiktok&utm_medium=cpc' } }).errors, 'ad.utmParams'));
  });
  it('datetime precisa ser uma data real', () => {
    const start = { scheduleType: 'SCHEDULE_START_END', scheduleEnd: '2026-12-31T10:00' };
    assert.ok(has(run({ adGroup: { ...start, scheduleStart: '2026-02-30T10:00' } }).errors, 'adGroup.scheduleStart'));
    assert.ok(has(run({ adGroup: { ...start, scheduleStart: 'ontem' } }).errors, 'adGroup.scheduleStart'));
    assert.deepEqual(run({ adGroup: { ...start, scheduleStart: '2026-12-01T10:00' } }).errors, []);
  });
});

describe('regras entre campos', () => {
  const run = (over, objective = 'TRAFFIC') => validateConfig(completeConfig(objective, over), { requireComplete: true });
  const has = (errors, path) => errors.some((e) => e.path === path);

  it('fim depois do início; agenda exigida com orçamento total', () => {
    assert.ok(has(run({ adGroup: { scheduleType: 'SCHEDULE_START_END', scheduleStart: '2026-12-10T10:00', scheduleEnd: '2026-12-01T10:00' } }).errors, 'adGroup.scheduleEnd'));
    assert.ok(has(run({ adGroup: { budgetMode: 'BUDGET_MODE_TOTAL' } }).errors, 'adGroup.scheduleType'));
    assert.deepEqual(run({ adGroup: { budgetMode: 'BUDGET_MODE_TOTAL', scheduleType: 'SCHEDULE_START_END', scheduleStart: '2026-12-01T10:00', scheduleEnd: '2026-12-10T10:00' } }).errors, []);
  });
  it('orçamento no nível da campanha torna o do grupo oculto (e descartado)', () => {
    const { config, errors } = run({ campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 9000 }, adGroup: { budget: undefined } });
    assert.deepEqual(errors, []);
    assert.equal(config.campaign.budget, 9000);
    assert.equal(config.adGroup.budget, undefined);
    assert.ok(has(run({ campaign: { budgetMode: 'BUDGET_MODE_DAY' } }).errors, 'campaign.budget'));
  });
  it('lance manual exige valor; sem lance manual o valor é descartado', () => {
    assert.ok(has(run({ adGroup: { bidType: 'BID_TYPE_CUSTOM' } }).errors, 'adGroup.bidPrice'));
    assert.deepEqual(run({ adGroup: { bidType: 'BID_TYPE_CUSTOM', bidPrice: 250 } }).errors, []);
    assert.equal(run({ adGroup: { bidType: 'BID_TYPE_NO_BID', bidPrice: 250 } }).config.adGroup.bidPrice, undefined);
  });
  it('posicionamento manual exige ao menos um', () => {
    assert.ok(has(run({ adGroup: { placementType: 'PLACEMENT_TYPE_NORMAL' } }).errors, 'adGroup.placements'));
    assert.deepEqual(run({ adGroup: { placementType: 'PLACEMENT_TYPE_NORMAL', placements: ['PLACEMENT_TIKTOK'] } }).errors, []);
    assert.equal(run({ adGroup: { placementType: 'PLACEMENT_TYPE_AUTOMATIC', placements: ['PLACEMENT_TIKTOK'] } }).config.adGroup.placements, undefined);
  });
  it('conversões exigem pixel e evento; produtos exigem catálogo; app exige app; lead por formulário exige o ID', () => {
    let cfg = completeConfig('WEB_CONVERSIONS'); delete cfg.adGroup.pixelId; delete cfg.adGroup.optimizationEvent;
    let { errors } = validateConfig(cfg, { requireComplete: true });
    assert.ok(has(errors, 'adGroup.pixelId') && has(errors, 'adGroup.optimizationEvent'));
    cfg = completeConfig('PRODUCT_SALES'); delete cfg.adGroup.catalogId;
    assert.ok(has(validateConfig(cfg, { requireComplete: true }).errors, 'adGroup.catalogId'));
    cfg = completeConfig('APP_PROMOTION'); delete cfg.adGroup.appId; delete cfg.campaign.appPromotionType; delete cfg.adGroup.appPlatform;
    ({ errors } = validateConfig(cfg, { requireComplete: true }));
    assert.ok(has(errors, 'adGroup.appId') && has(errors, 'campaign.appPromotionType') && has(errors, 'adGroup.appPlatform'));
    cfg = completeConfig('LEAD_GENERATION', { adGroup: { leadDestination: 'INSTANT_FORM' } });
    assert.ok(has(validateConfig(cfg, { requireComplete: true }).errors, 'adGroup.leadFormId'));
  });
  it('frequência: ambos ou nenhum', () => {
    assert.ok(has(run({ adGroup: { frequency: 3 } }, 'REACH').errors, 'adGroup.frequencyDays'));
    assert.deepEqual(run({ adGroup: { frequency: 3, frequencyDays: 7 } }, 'REACH').errors, []);
    assert.ok(has(run({ adGroup: { frequency: 3, frequencyDays: 9 } }, 'REACH').errors, 'adGroup.frequencyDays'));
  });
  it('formatos de anúncio: vídeo, imagem única e carrossel', () => {
    assert.ok(has(run({ ad: { videoCreativeId: undefined } }).errors, 'ad.videoCreativeId'));
    assert.ok(has(run({ ad: { format: 'SINGLE_IMAGE' } }).errors, 'ad.imageCreativeIds'));
    assert.ok(has(run({ ad: { format: 'SINGLE_IMAGE', imageCreativeIds: [11, 12] } }).errors, 'ad.imageCreativeIds'));
    assert.deepEqual(run({ ad: { format: 'SINGLE_IMAGE', imageCreativeIds: [11] } }).errors, []);
    assert.ok(has(run({ ad: { format: 'CAROUSEL_ADS', imageCreativeIds: [11] } }).errors, 'ad.imageCreativeIds'));
    assert.deepEqual(run({ ad: { format: 'CAROUSEL_ADS', imageCreativeIds: [11, 12, 13] } }).errors, []);
    assert.equal(run({ ad: { format: 'SINGLE_IMAGE', imageCreativeIds: [11] } }).config.ad.videoCreativeId, undefined, 'vídeo descartado no formato imagem');
  });
  it('URL de destino é obrigatória em tráfego/conversões e oculta em app', () => {
    assert.ok(has(run({ ad: { landingPageUrl: undefined } }).errors, 'ad.landingPageUrl'));
    assert.equal(validateConfig(completeConfig('APP_PROMOTION', { ad: { landingPageUrl: 'https://x.com' } }), { requireComplete: true }).config.ad.landingPageUrl, undefined);
  });
});

describe('segurança da entrada', () => {
  it('ignora chaves desconhecidas, __proto__ e seções fora do esquema', () => {
    const raw = JSON.parse('{"__proto__":{"admin":true},"constructor":{"x":1},"campaign":{"name":"Teste","objective":"TRAFFIC","__proto__":{"polluted":1},"role":"admin"},"extra":{"a":1},"adGroup":{"hack":1}}');
    const { config, errors } = validateConfig(raw);
    assert.deepEqual(errors, []);
    assert.equal(Object.keys(config).sort().join(), 'ad,adGroup,campaign');
    assert.equal(config.campaign.role, undefined);
    assert.equal(config.adGroup.hack, undefined);
    assert.equal({}.polluted, undefined);
    assert.equal({}.admin, undefined);
  });
  it('seções que não são objetos não quebram', () => {
    for (const raw of [null, 'x', 42, [], { campaign: 'x', adGroup: [], ad: null, account: 5 }]) assert.doesNotThrow(() => validateConfig(raw));
    assert.ok(validateConfig('x').errors.some((e) => e.path === ''));
  });
  it('é idempotente: validar a saída não altera o resultado', () => {
    const first = validateConfig(completeConfig('WEB_CONVERSIONS'), { requireComplete: true });
    const second = validateConfig(first.config, { requireComplete: true });
    assert.deepEqual(second.config, first.config);
    assert.deepEqual(second.errors, []);
  });
});

describe('summarize', () => {
  it('deriva nome, objetivo e orçamento diário', () => {
    assert.deepEqual(summarize(validateConfig(completeConfig('TRAFFIC')).config), { name: 'Black Friday', objective: 'TRAFFIC', dailyBudget: 5000 });
    const campaignLevel = validateConfig(completeConfig('TRAFFIC', { campaign: { budgetMode: 'BUDGET_MODE_DAY', budget: 7000 } })).config;
    assert.equal(summarize(campaignLevel).dailyBudget, 7000);
    const total = validateConfig(completeConfig('TRAFFIC', { adGroup: { budgetMode: 'BUDGET_MODE_TOTAL' } })).config;
    assert.equal(summarize(total).dailyBudget, 0);
  });
});

describe('ajustes por conta de anúncio (publicar a mesma campanha em contas diferentes)', () => {
  it('só os IDs que dependem da conta podem ser ajustados', () => {
    assert.deepEqual([...ACCOUNT_FIELDS].sort(), ['ad.identityId', 'ad.identityType', 'adGroup.appId', 'adGroup.catalogId', 'adGroup.leadFormId', 'adGroup.pixelId', 'adGroup.productSetId']);
  });

  it('aplica o ajuste só na cópia: a campanha base nunca muda', () => {
    const base = completeConfig('WEB_CONVERSIONS');
    const snapshot = JSON.stringify(base);
    const { config, overrides, errors } = applyAccountOverrides(base, { adGroup: { pixelId: '999000' }, ad: { identityId: 'id-outra-conta' } });
    assert.deepEqual(errors, []);
    assert.equal(config.adGroup.pixelId, '999000');
    assert.equal(config.ad.identityId, 'id-outra-conta');
    assert.deepEqual(overrides, { adGroup: { pixelId: '999000' }, ad: { identityId: 'id-outra-conta' } });
    assert.equal(JSON.stringify(base), snapshot, 'a base não foi alterada');
    assert.equal(base.adGroup.pixelId, '123456');
  });

  it('recusa qualquer campo que não seja por conta (orçamento, nome, público…) sem alterar nada', () => {
    const base = completeConfig();
    const { config, overrides, errors } = applyAccountOverrides(base, { campaign: { name: 'Hack' }, adGroup: { budget: 1, name: 'x', locations: ['US'] }, ad: { landingPageUrl: 'https://evil.example', videoCreativeId: 99 } });
    assert.equal(errors.length, 6);
    assert.ok(errors.every((e) => e.path.startsWith('overrides.')));
    assert.deepEqual(overrides, {});
    assert.deepEqual(config, base);
  });

  it('valor vazio ou só espaços = sem ajuste; tipos inválidos são erro; espaços nas pontas são removidos', () => {
    const base = completeConfig('WEB_CONVERSIONS');
    const blank = applyAccountOverrides(base, { adGroup: { pixelId: '' }, ad: { identityId: '   ' } });
    assert.deepEqual(blank.errors, []);
    assert.deepEqual(blank.overrides, {});
    assert.equal(blank.config.adGroup.pixelId, '123456');
    assert.equal(applyAccountOverrides(base, { adGroup: { pixelId: 123 } }).errors.length, 1);
    assert.equal(applyAccountOverrides(base, { adGroup: { pixelId: { $ne: 1 } } }).errors.length, 1);
    assert.equal(applyAccountOverrides(base, { adGroup: { pixelId: '  777  ' } }).config.adGroup.pixelId, '777');
  });

  it('entrada malformada não quebra e não permite poluir protótipos', () => {
    const base = completeConfig();
    for (const raw of [undefined, null]) assert.deepEqual(applyAccountOverrides(base, raw).errors, []);
    for (const raw of ['x', 42, [], [1]]) assert.equal(applyAccountOverrides(base, raw).errors.length, 1);
    assert.equal(applyAccountOverrides(base, { adGroup: 'x' }).errors.length, 1);
    const evil = JSON.parse('{"__proto__":{"polluted":1},"constructor":{"prototype":{"p":1}},"adGroup":{"__proto__":{"q":1}}}');
    const result = applyAccountOverrides(base, evil);
    assert.ok(result.errors.length >= 1);
    assert.equal({}.polluted, undefined);
    assert.equal({}.q, undefined);
    assert.equal({}.p, undefined);
  });

  it('o resultado passa pela validação normal: ID inválido do ajuste vira erro no caminho do campo', () => {
    const { config } = applyAccountOverrides(completeConfig('WEB_CONVERSIONS'), { adGroup: { pixelId: 'abc' } });
    const { errors } = validateConfig(config, { requireComplete: true });
    assert.ok(errors.some((e) => e.path === 'adGroup.pixelId'));
  });
});
