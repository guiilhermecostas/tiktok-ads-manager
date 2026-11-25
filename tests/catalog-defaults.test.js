import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CATALOG_DEFAULT_PATHS, catalogPresetConfig, catalogReadiness, defaultCreativeRefs, mergeCatalogDefaults, pickDefaults, validateCatalogDefaults } from '../shared/catalog-defaults.js';
import { validateConfig } from '../shared/campaign-spec.js';
import { createTiktokClient } from '../src/modules/tiktok/tiktok.client.js';
import { buildAdGroupPayload, buildAdPayload, buildCampaignPayload } from '../src/modules/tiktok/tiktok.payloads.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, one, run, startTestServer } from './helpers.js';
import { mp4Bytes, pngBytes, uploadCreative } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, catalogRead: 5000, catalogRefresh: 5000, catalogWrite: 5000, creativesRead: 1000, creativesWrite: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `cdf${++counter}@example.com`;
const messageOf = (res) => res.json?.error?.message ?? res.json?.message ?? res.text;
const catalog = { id: '5001', bcId: '111', name: 'Moda', regionCode: 'BR', currency: 'BRL', connectionId: 1 };
const FULL = (extra = {}) => ({
  adGroup: { optimizationGoal: 'CLICK', billingEvent: 'CPC', budgetMode: 'BUDGET_MODE_DAY', budget: 5000 },
  ad: { text: 'Aproveite agora!', callToAction: 'SHOP_NOW', landingPageUrl: 'https://loja.example.com/promo', identityType: 'CUSTOMIZED_USER', identityId: 'id-123456', ...extra },
});

describe('Anúncio padrão do catálogo: regras compartilhadas', () => {
  it('só os campos permitidos entram (nunca o catálogo, a BC, nomes, rastreamento ou campos desconhecidos)', () => {
    const picked = pickDefaults({
      campaign: { name: 'x', objective: 'TRAFFIC' },
      adGroup: { catalogId: '999', catalogBcId: '888', name: 'Grupo', budget: 5000, locations: ['BR'], hack: 1 },
      ad: { name: 'Anúncio', text: 'Oi', impressionTrackingUrl: 'https://t.example.com/i', clickTrackingUrl: 'https://t.example.com/c', videoCreativeId: 7, x: 1 },
    });
    assert.deepEqual(picked, { adGroup: { budget: 5000, locations: ['BR'] }, ad: { text: 'Oi', videoCreativeId: 7 } });
    assert.deepEqual(pickDefaults(null), { adGroup: {}, ad: {} });
    assert.deepEqual(pickDefaults({ ad: 'x', adGroup: [] }), { adGroup: {}, ad: {} });
    for (const forbidden of ['adGroup.catalogId', 'adGroup.catalogBcId', 'ad.name', 'adGroup.name', 'ad.impressionTrackingUrl', 'ad.clickTrackingUrl', 'campaign.objective']) assert.equal(CATALOG_DEFAULT_PATHS.includes(forbidden), false, forbidden);
  });

  it('valida com as regras da campanha de catálogo e SÓ guarda o que a pessoa informou (os padrões do assistente não ficam fixados)', () => {
    const { defaults, errors } = validateCatalogDefaults(FULL());
    assert.deepEqual(errors, []);
    assert.deepEqual(Object.keys(defaults.ad).sort(), ['callToAction', 'identityId', 'identityType', 'landingPageUrl', 'text']);
    assert.equal('format' in defaults.ad, false, 'o formato padrão do assistente não é "fixado" sem querer');
    assert.equal('productSpecificType' in defaults.ad, false);
    assert.deepEqual(defaults.adGroup, { optimizationGoal: 'CLICK', billingEvent: 'CPC', budgetMode: 'BUDGET_MODE_DAY', budget: 5000 });
  });

  it('recusa valores inválidos com o campo certo (URL, botão, SKU, texto longo, identidade, meta incompatível)', () => {
    const bad = (extra, section = 'ad') => validateCatalogDefaults(section === 'ad' ? FULL(extra) : { ...FULL(), adGroup: { ...FULL().adGroup, ...extra } }).errors.map((e) => e.path);
    assert.deepEqual(bad({ landingPageUrl: 'javascript:alert(1)' }), ['ad.landingPageUrl']);
    assert.deepEqual(bad({ landingPageUrl: 'loja.com' }), ['ad.landingPageUrl']);
    assert.deepEqual(bad({ callToAction: 'HACK' }), ['ad.callToAction']);
    assert.deepEqual(bad({ text: 'x'.repeat(101) }), ['ad.text']);
    assert.deepEqual(bad({ productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['camisa 😀'] }), ['ad.skuIds']);
    assert.deepEqual(bad({ productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: Array.from({ length: 21 }, (_, i) => `S${i}`) }), ['ad.skuIds']);
    assert.deepEqual(bad({ productSetId: 'abc', productSpecificType: 'PRODUCT_SET' }), ['ad.productSetId']);
    assert.deepEqual(bad({ identityId: 'a b!' }), ['ad.identityId']);
    assert.deepEqual(bad({ videoCreativeId: -1 }), ['ad.videoCreativeId']);
    assert.deepEqual(bad({ budget: 0 }, 'adGroup'), ['adGroup.budget']);
    assert.deepEqual(bad({ locations: ['XX'] }, 'adGroup'), ['adGroup.locations']);
    assert.deepEqual(validateCatalogDefaults(null).errors, [], 'entrada nula = padrão vazio');
    assert.deepEqual(validateCatalogDefaults({ ad: 'x' }).defaults, { adGroup: {}, ad: {} });
  });

  it('o anúncio padrão vai por cima do catálogo: nomes, catálogo, BC e país sugeridos; os campos escolhidos prevalecem; campos ocultos são podados', () => {
    const base = catalogPresetConfig(catalog, null);
    assert.deepEqual([base.campaign.objective, base.campaign.name, base.adGroup.catalogId, base.adGroup.catalogBcId, base.adGroup.locations, base.ad.format], ['PRODUCT_SALES', 'Vendas | Moda', '5001', '111', ['BR'], 'CATALOG_VIDEO']);
    const merged = catalogPresetConfig(catalog, { adGroup: { locations: ['US'], budget: 9000, catalogId: '777' }, ad: { text: 'Oferta', format: 'SINGLE_VIDEO', videoCreativeId: 3, coverCreativeId: 4, productSpecificType: 'PRODUCT_SET', productSetId: '42' } });
    assert.deepEqual([merged.adGroup.locations, merged.adGroup.budget, merged.adGroup.catalogId, merged.ad.text, merged.ad.format, merged.ad.videoCreativeId, merged.ad.productSetId], [['US'], 9000, '5001', 'Oferta', 'SINGLE_VIDEO', 3, '42'], 'o catálogo escolhido NUNCA é trocado pelo padrão');
    const catalogVideo = mergeCatalogDefaults(base, { ad: { format: 'CATALOG_VIDEO', videoCreativeId: 3, skuIds: ['A'] } });
    assert.equal(catalogVideo.ad.videoCreativeId, undefined, 'vídeo do catálogo não usa vídeo do usuário');
    assert.equal(catalogVideo.ad.skuIds, undefined, 'SKUs só valem com "produtos específicos"');
    assert.deepEqual(defaultCreativeRefs({ ad: { videoCreativeId: 3, coverCreativeId: 4, text: 'x' } }).map((r) => [r.path, r.id, r.kind]), [['ad.videoCreativeId', 3, 'video'], ['ad.coverCreativeId', 4, 'image']]);
  });

  it('"quanto falta": sem padrão lista o que a campanha exige; com tudo preenchido fica pronto (por grupo)', () => {
    const empty = catalogReadiness(catalog, null);
    assert.equal(empty.ready, false);
    assert.ok(['Texto do anúncio', 'Botão de chamada para ação', 'URL de destino', 'ID da identidade'].every((l) => empty.missing.some((m) => m.label === l)), JSON.stringify(empty.missing.map((m) => m.label)));
    assert.deepEqual(empty.groups.map((g) => g.title), ['Criativo e produtos', 'Texto e destino', 'Identidade do anúncio', 'Conversão e orçamento', 'Público']);
    const full = catalogReadiness(catalog, validateCatalogDefaults(FULL()).defaults);
    assert.equal(full.ready, true, JSON.stringify(full.missing));
    assert.deepEqual(full.missing, []);
    // vídeo único exige o vídeo e a capa
    const single = catalogReadiness(catalog, { ...FULL(), ad: { ...FULL().ad, format: 'SINGLE_VIDEO' } });
    assert.deepEqual(single.missing.map((m) => m.path).sort(), ['ad.coverCreativeId', 'ad.videoCreativeId']);
    // meta de conversão exige o pixel
    const convert = catalogReadiness(catalog, { adGroup: { optimizationGoal: 'CONVERT', billingEvent: 'OCPM', optimizationEvent: 'SHOPPING', budgetMode: 'BUDGET_MODE_DAY', budget: 5000 }, ad: FULL().ad });
    assert.deepEqual(convert.missing.map((m) => m.path), ['adGroup.pixelId']);
  });

  it('"pronto" de verdade: a configuração montada com o padrão completo é aceita pelo assistente e pelo TikTok (simulado estrito)', async () => {
    const config = validateConfig(catalogPresetConfig(catalog, validateCatalogDefaults(FULL()).defaults), { requireComplete: true });
    assert.deepEqual(config.errors, []);
    const fake = createFakeTiktok();
    const api = createTiktokClient({ config: { tiktok: { apiBase: 'https://business-api.tiktok.com' } }, fetchFn: fake.fetchFn });
    const campaignId = await api.createCampaign(GOOD_TOKEN, buildCampaignPayload('9001', config.config));
    const adGroupId = await api.createAdGroup(GOOD_TOKEN, buildAdGroupPayload('9001', campaignId, config.config, { timezone: 'America/Sao_Paulo' }));
    assert.match(String(await api.createAd(GOOD_TOKEN, buildAdPayload('9001', adGroupId, config.config))), /^\d+$/);
  });
});

describe('Anúncio padrão do catálogo: API', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer() });
  });
  after(() => ctx.stop());

  async function setup() {
    fake.state.bcs = { 111: ['9001', '9002'] };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.catalogs = {}; fake.state.catalogProducts = {};
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    const res = await user.client.post('/api/tiktok/business-centers', { name: 'BC 111', bcId: '111', accessToken: GOOD_TOKEN });
    assert.equal(res.status, 201, res.text);
    const connectionId = res.json.businessCenter?.id ?? res.json.id;
    const made = await user.client.post('/api/tiktok/catalogs', { connectionId, bcId: '111', name: 'Loja', regionCode: 'BR', currency: 'BRL' });
    assert.equal(made.status, 201, made.text);
    return { user, connectionId, catalogId: made.json.catalog.id };
  }
  const url = (catalogId, id) => `/api/tiktok/catalogs/${catalogId}/defaults${id === undefined ? '' : `?connectionId=${id}&bcId=111`}`;
  const put = (user, catalogId, connectionId, body) => user.client.put(`/api/tiktok/catalogs/${catalogId}/defaults`, { connectionId, bcId: '111', ...body });
  const upload = async (user, kind) => {
    const res = await uploadCreative(user.client, kind === 'video' ? { type: 'mp4', bytes: mp4Bytes(), name: 'Vídeo da loja', filename: 'v.mp4' } : { type: 'png', bytes: pngBytes(), name: 'Capa', filename: 'c.png' });
    assert.equal(res.status, 201, res.text);
    return res.json.creative.id;
  };

  it('exige login e começa vazio', async () => {
    const { user, connectionId, catalogId } = await setup();
    assert.equal((await ctx.client().get(url(catalogId, connectionId))).status, 401);
    assert.equal((await ctx.client().put(url(catalogId), {})).status, 401);
    const res = await user.client.get(url(catalogId, connectionId));
    assert.deepEqual([res.status, res.json], [200, { defaults: null, updatedAt: null }]);
  });

  it('SALVAR e LER: guarda os campos validados e os criativos da biblioteca (vídeo e capa) e devolve tudo junto', async () => {
    const { user, connectionId, catalogId } = await setup();
    const video = await upload(user, 'video');
    const cover = await upload(user, 'image');
    const saved = await put(user, catalogId, connectionId, { ...FULL({ format: 'SINGLE_VIDEO', videoCreativeId: video, coverCreativeId: cover, productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['A-1', 'B 2'] }) });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual([saved.json.defaults.ad.videoCreativeId, saved.json.defaults.ad.coverCreativeId, saved.json.defaults.ad.skuIds, saved.json.defaults.ad.text, saved.json.defaults.adGroup.budget], [video, cover, ['A-1', 'B 2'], 'Aproveite agora!', 5000]);
    assert.ok(saved.json.updatedAt);
    const read = await user.client.get(url(catalogId, connectionId));
    assert.deepEqual(read.json.defaults, saved.json.defaults);
    const row = await one(ctx.db, 'SELECT video_creative_id, cover_creative_id, config FROM catalog_defaults WHERE catalog_id = $1', [catalogId]);
    assert.deepEqual([row.video_creative_id, row.cover_creative_id], [video, cover], 'os criativos ficam em colunas com chave estrangeira');
    assert.equal('videoCreativeId' in row.config.ad, false);
  });

  it('salvar de novo SUBSTITUI (um por pessoa e catálogo) e criativo omitido limpa o vínculo', async () => {
    const { user, connectionId, catalogId } = await setup();
    const video = await upload(user, 'video');
    await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: video, coverCreativeId: await upload(user, 'image') }));
    const second = await put(user, catalogId, connectionId, FULL({ text: 'Novo texto' }));
    assert.equal(second.json.defaults.ad.text, 'Novo texto');
    assert.equal('videoCreativeId' in second.json.defaults.ad, false);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS n FROM catalog_defaults WHERE catalog_id = $1', [catalogId])).n, 1);
  });

  it('só campos permitidos: o catálogo, a BC e o rastreamento enviados à força são IGNORADOS', async () => {
    const { user, connectionId, catalogId } = await setup();
    const res = await put(user, catalogId, connectionId, { adGroup: { ...FULL().adGroup, catalogId: '999', catalogBcId: '888', name: 'x' }, ad: { ...FULL().ad, name: 'y', impressionTrackingUrl: 'https://t.example.com/i' }, campaign: { objective: 'TRAFFIC' }, extra: 1 });
    assert.equal(res.status, 200, res.text);
    const stored = (await one(ctx.db, 'SELECT config FROM catalog_defaults WHERE catalog_id = $1', [catalogId])).config;
    assert.equal(JSON.stringify(stored).includes('999'), false);
    assert.equal(JSON.stringify(stored).includes('888'), false);
    assert.equal(JSON.stringify(stored).includes('t.example.com'), false);
    assert.deepEqual(Object.keys(stored).sort(), ['ad', 'adGroup']);
  });

  it('valida no servidor (400 com a mensagem do campo) e não grava nada', async () => {
    const { user, connectionId, catalogId } = await setup();
    for (const [extra, pattern] of [[{ landingPageUrl: 'javascript:alert(1)' }, /endereço não é permitido/i], [{ callToAction: 'HACK' }, /inválid/i], [{ text: 'x'.repeat(101) }, /caracteres/i], [{ productSpecificType: 'CUSTOMIZED_PRODUCTS', skuIds: ['😀'] }, /formato inválido|inválid/i]]) {
      const res = await put(user, catalogId, connectionId, FULL(extra));
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(messageOf(res), pattern, JSON.stringify(extra));
    }
    assert.equal((await user.client.put(url(catalogId), [1])).status, 400, 'o corpo precisa ser um objeto');
    assert.equal((await user.client.put(`/api/tiktok/catalogs/${catalogId}/defaults`, { bcId: '111', ...FULL() })).status, 400, 'sem connectionId');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int AS n FROM catalog_defaults')).n >= 0, true);
    assert.equal((await user.client.get(url(catalogId, connectionId))).json.defaults, null);
  });

  it('os criativos precisam ser da PRÓPRIA pessoa e do tipo certo (vídeo no vídeo, imagem na capa)', async () => {
    const { user, connectionId, catalogId } = await setup();
    const stranger = await createUser(ctx, { approve: true, email: emailOf() });
    const theirs = await upload(stranger, 'video');
    const mine = await upload(user, 'video');
    const image = await upload(user, 'image');
    assert.equal((await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: theirs, coverCreativeId: image }))).status, 404, 'criativo de outra pessoa não existe para você');
    assert.equal((await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: 999999, coverCreativeId: image }))).status, 404);
    const wrongKind = await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: image, coverCreativeId: image }));
    assert.equal(wrongKind.status, 400);
    assert.match(messageOf(wrongKind), /vídeo/);
    const wrongCover = await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: mine, coverCreativeId: mine }));
    assert.equal(wrongCover.status, 400);
    assert.match(messageOf(wrongCover), /capa/);
  });

  it('apagar o criativo da biblioteca limpa o vínculo sozinho (o resto do padrão fica)', async () => {
    const { user, connectionId, catalogId } = await setup();
    const video = await upload(user, 'video');
    const cover = await upload(user, 'image');
    await put(user, catalogId, connectionId, FULL({ format: 'SINGLE_VIDEO', videoCreativeId: video, coverCreativeId: cover }));
    assert.equal((await user.client.delete(`/api/creatives/${video}`)).status, 204);
    const read = (await user.client.get(url(catalogId, connectionId))).json.defaults;
    assert.equal('videoCreativeId' in read.ad, false);
    assert.equal(read.ad.coverCreativeId, cover);
    assert.equal(read.ad.text, 'Aproveite agora!');
  });

  it('REMOVER apaga o padrão (os criativos da biblioteca continuam)', async () => {
    const { user, connectionId, catalogId } = await setup();
    const cover = await upload(user, 'image');
    await put(user, catalogId, connectionId, FULL({ coverCreativeId: cover }));
    assert.equal((await user.client.delete(url(catalogId, connectionId))).status, 204);
    assert.equal((await user.client.get(url(catalogId, connectionId))).json.defaults, null);
    assert.equal((await user.client.get(`/api/creatives/${cover}`)).status, 200);
    assert.equal((await user.client.delete(url(catalogId, connectionId))).status, 204, 'remover de novo não é erro');
  });

  it('isolamento: cada pessoa tem o próprio padrão; ninguém acessa o catálogo/conexão de outra; BC compartilhada não mistura os padrões', async () => {
    const { user, connectionId, catalogId } = await setup();
    await put(user, catalogId, connectionId, FULL({ text: 'Texto da dona' }));
    const intruder = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await intruder.client.get(url(catalogId, connectionId))).status, 404);
    assert.equal((await put(intruder, catalogId, connectionId, FULL())).status, 404);
    assert.equal((await intruder.client.delete(url(catalogId, connectionId))).status, 404);
    await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [connectionId]);
    const viewer = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await viewer.client.get(url(catalogId, connectionId))).json.defaults, null, 'não enxerga o padrão da dona');
    assert.equal((await put(viewer, catalogId, connectionId, FULL({ text: 'Texto do colega' }))).status, 200, 'pode ter o próprio (é só preferência, não altera o TikTok)');
    assert.equal((await user.client.get(url(catalogId, connectionId))).json.defaults.ad.text, 'Texto da dona');
    assert.equal((await viewer.client.get(url(catalogId, connectionId))).json.defaults.ad.text, 'Texto do colega');
    assert.equal(fake.state.calls.filter((c) => c.path.includes('defaults')).length, 0);
  });

  it('IDs inválidos: catálogo não numérico e BC que não é da conexão', async () => {
    const { user, connectionId, catalogId } = await setup();
    assert.equal((await user.client.get(`/api/tiktok/catalogs/abc/defaults?connectionId=${connectionId}&bcId=111`)).status, 400);
    assert.equal((await user.client.get(`/api/tiktok/catalogs/${catalogId}/defaults?connectionId=${connectionId}&bcId=999`)).status, 400);
    assert.equal((await put(user, catalogId, connectionId, FULL())).status, 200);
  });

  it('o banco recusa lixo: ID não numérico e configuração que não é objeto', async () => {
    const { user, connectionId, catalogId } = await setup();
    await put(user, catalogId, connectionId, FULL());
    for (const sql of ["UPDATE catalog_defaults SET catalog_id = 'abc'", "UPDATE catalog_defaults SET bc_id = '1; DROP'", "UPDATE catalog_defaults SET config = '[]'::jsonb", `UPDATE catalog_defaults SET config = jsonb_build_object('x', repeat('a', 9000))`]) {
      await assert.rejects(run(ctx.db, sql), (e) => e.code === '23514', sql);
    }
  });
});
