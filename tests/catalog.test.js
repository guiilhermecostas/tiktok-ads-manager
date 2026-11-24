import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  CATALOG_NAME_MAX, MAX_PRODUCTS_PER_REQUEST, buildSetConditions, csvTemplate, csvToProducts, normalizeCatalogInput, normalizeProduct, normalizeProductSetName, parseCsv, parsePrice, toBatches,
} from '../shared/catalog.js';
import { HttpError } from '../src/lib/http-error.js';
import { toTikTokProduct } from '../src/modules/catalog/catalog.payloads.js';
import { createTiktokClient } from '../src/modules/tiktok/tiktok.client.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, catalogRead: 5000, catalogRefresh: 5000, catalogWrite: 5000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `cat${++counter}@example.com`;
const messageOf = (res) => res.json?.error?.message ?? res.json?.message ?? res.text;
const product = (n = 1, extra = {}) => ({
  skuId: `SKU-${n}`, title: `Camiseta ${n}`, description: 'Camiseta de algodão.', availability: 'IN_STOCK', brand: 'Marca', imageUrl: `https://loja.example/img/${n}.jpg`,
  condition: 'NEW', price: 79.9, landingPageUrl: `https://loja.example/p/${n}`, ...extra,
});

describe('Catálogo: regras compartilhadas (documentação oficial)', () => {
  it('catálogo novo: nome de 2 a 128 caracteres, país de 2 letras e moeda de 3 letras (tipo E-commerce)', () => {
    const ok = normalizeCatalogInput({ name: '  Loja   Principal ', regionCode: 'br', currency: 'brl' });
    assert.deepEqual(ok, { value: { name: 'Loja Principal', regionCode: 'BR', currency: 'BRL', catalogType: 'ECOM' }, errors: [] });
    for (const bad of [{}, null, [], { name: 'x', regionCode: 'BR', currency: 'BRL' }, { name: 'a'.repeat(CATALOG_NAME_MAX + 1), regionCode: 'BR', currency: 'BRL' }, { name: 'Loja', regionCode: 'BRA', currency: 'BRL' }, { name: 'Loja', regionCode: 'BR', currency: 'BR' }, { name: 'Lo\u0000ja', regionCode: 'BR', currency: 'BRL' }]) {
      assert.ok(normalizeCatalogInput(bad).errors.length > 0, JSON.stringify(bad));
    }
    assert.equal(normalizeCatalogInput({ name: 'a'.repeat(CATALOG_NAME_MAX), regionCode: 'BR', currency: 'BRL' }).errors.length, 0, '128 é o limite');
  });

  it('produto: os 9 campos obrigatórios da API (sku, título, descrição, disponibilidade, marca, imagem, condição, preço, página)', () => {
    const { value, errors } = normalizeProduct(product());
    assert.deepEqual(errors, []);
    assert.equal(value.price, 79.9);
    const { errors: empty } = normalizeProduct({});
    assert.deepEqual(empty.map((e) => e.path).sort(), ['availability', 'brand', 'condition', 'description', 'imageUrl', 'landingPageUrl', 'price', 'skuId', 'title']);
  });

  it('produto: limites oficiais (SKU 100 sem emoji, título 500, descrição 10.000, marca 150), enumerações e preços', () => {
    const bad = (extra) => normalizeProduct(product(1, extra)).errors.map((e) => e.path);
    assert.deepEqual(bad({ skuId: 'a'.repeat(101) }), ['skuId']);
    assert.deepEqual(bad({ skuId: 'camisa 😀' }), ['skuId'], 'emoji no SKU');
    assert.deepEqual(bad({ title: 'x'.repeat(501) }), ['title']);
    assert.deepEqual(bad({ title: 'Camisa 🔥' }), ['title']);
    assert.deepEqual(bad({ description: 'x'.repeat(10_001) }), ['description']);
    assert.deepEqual(bad({ brand: 'x'.repeat(151) }), ['brand']);
    assert.deepEqual(bad({ availability: 'MAYBE' }), ['availability']);
    assert.deepEqual(bad({ condition: 'BROKEN' }), ['condition']);
    assert.deepEqual(bad({ gender: 'X' }), ['gender']);
    assert.deepEqual(bad({ price: 0 }), ['price']);
    assert.deepEqual(bad({ price: -5 }), ['price']);
    assert.deepEqual(bad({ price: 'grátis' }), ['price']);
    assert.deepEqual(bad({ salePrice: 100 }), ['salePrice'], 'promocional maior que o preço');
    assert.deepEqual(bad({ salePrice: 79.9 }), ['salePrice'], 'promocional igual ao preço');
    assert.deepEqual(bad({ imageUrl: 'ftp://x.com/a.jpg' }), ['imageUrl']);
    assert.deepEqual(bad({ imageUrl: 'javascript:alert(1)' }), ['imageUrl']);
    assert.deepEqual(bad({ imageUrl: 'https://user:pw@x.com/a.jpg' }), ['imageUrl'], 'sem credenciais na URL');
    assert.deepEqual(bad({ landingPageUrl: 'loja.com/p' }), ['landingPageUrl']);
    assert.deepEqual(bad({ additionalImageUrls: Array.from({ length: 11 }, (_, i) => `https://x.com/${i}.jpg`) }), ['additionalImageUrls'], 'até 10 imagens adicionais');
    assert.deepEqual(bad({ additionalImageUrls: ['nao-e-url'] }), ['additionalImageUrls']);
    assert.deepEqual(bad({ skuId: 'a'.repeat(100), title: 'x'.repeat(500), brand: 'x'.repeat(150), additionalImageUrls: Array.from({ length: 10 }, (_, i) => `https://x.com/${i}.jpg`), salePrice: 50 }), [], 'os limites exatos valem');
  });

  it('produto: descarta campos desconhecidos e normaliza valores (caixa das listas, espaços, preço com vírgula)', () => {
    const { value } = normalizeProduct(product(1, { hack: 'x', availability: ' in_stock ', title: '  Camiseta   azul  ', price: '1.234,56', salePrice: '999,90' }));
    assert.equal(value.hack, undefined);
    assert.deepEqual([value.availability, value.title, value.price, value.salePrice], ['IN_STOCK', 'Camiseta azul', 1234.56, 999.9]);
  });

  it('preços: aceita número, "29,90", "29.90", "1.234,56", "1,234.56" e código de moeda; recusa o resto', () => {
    assert.equal(parsePrice(29.9), 29.9);
    for (const [text, expected] of [['29,90', 29.9], ['29.90', 29.9], ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['79.90 BRL', 79.9], ['USD 15', 15], ['1,000', 1000]]) assert.equal(parsePrice(text), expected, text);
    for (const bad of ['', 'abc', '0', '-3', NaN, Infinity, null, undefined, {}, 1e12]) assert.equal(parsePrice(bad), null, String(bad));
  });

  it('produto → corpo do TikTok: product_detail, price_info e landing_page aninhados, sem chaves vazias nem moeda', () => {
    const body = toTikTokProduct(normalizeProduct(product(1, { color: 'Azul', size: 'M', salePrice: 59.9, additionalImageUrls: ['https://loja.example/img/1b.jpg'], itemGroupId: 'G1', gender: 'unisex' })).value);
    assert.deepEqual(body, {
      sku_id: 'SKU-1', title: 'Camiseta 1', description: 'Camiseta de algodão.', availability: 'IN_STOCK', brand: 'Marca', image_url: 'https://loja.example/img/1.jpg',
      additional_image_urls: ['https://loja.example/img/1b.jpg'], item_group_id: 'G1',
      product_detail: { condition: 'NEW', color: 'Azul', gender: 'UNISEX', size: 'M' },
      price_info: { price: 79.9, sale_price: 59.9 },
      landing_page: { landing_page_url: 'https://loja.example/p/1' },
    });
    assert.equal(JSON.stringify(toTikTokProduct(normalizeProduct(product()).value)).includes('currency'), false);
  });

  it('CSV: lê aspas, aspas duplas, vírgulas e quebras de linha dentro do campo e detecta o separador', () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","z ""q"""\n'), [['a', 'b'], ['x, y', 'z "q"']]);
    assert.deepEqual(parseCsv('a;b\r\n1;2\r\n'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
    assert.deepEqual(parseCsv('a,b\n"linha 1\nlinha 2",x'), [['a', 'b'], ['linha 1\nlinha 2', 'x']]);
    assert.deepEqual(parseCsv('﻿a,b\n\n1,2\n\n'), [['a', 'b'], ['1', '2']], 'BOM e linhas vazias');
  });

  it('CSV: o modelo para baixar é válido e vira um produto correto (aceita as colunas do Google/Meta e valores como "in stock")', () => {
    const parsed = csvToProducts(csvTemplate());
    assert.equal(parsed.fatal, null);
    assert.equal(parsed.products.length, 1, JSON.stringify(parsed.rows));
    assert.deepEqual([parsed.products[0].skuId, parsed.products[0].availability, parsed.products[0].condition, parsed.products[0].price, parsed.products[0].salePrice], ['CAMISETA-AZUL-M', 'IN_STOCK', 'NEW', 79.9, 59.9]);
    assert.deepEqual(parsed.products[0].additionalImageUrls, ['https://exemplo.com/img/camiseta-azul-2.jpg']);
  });

  it('CSV: aponta a linha de cada erro, não deixa SKU repetido e avisa das colunas que faltam ou não são conhecidas', () => {
    const header = 'sku_id,title,description,availability,condition,price,brand,image_link,link,extra';
    const ok = 'A1,Camisa,Desc,in stock,new,10,Marca,https://x.com/a.jpg,https://x.com/p,foo';
    const bad = 'A2,Camisa,Desc,talvez,new,10,Marca,https://x.com/a.jpg,https://x.com/p,foo';
    const dup = 'A1,Outra,Desc,in stock,new,10,Marca,https://x.com/a.jpg,https://x.com/p,foo';
    const parsed = csvToProducts([header, ok, bad, dup].join('\n'));
    assert.deepEqual(parsed.unknownColumns, ['extra']);
    assert.equal(parsed.products.length, 1);
    assert.deepEqual(parsed.rows.map((r) => [r.line, r.errors.map((e) => e.path)]), [[2, []], [3, ['availability']], [4, ['skuId']]]);
    const missing = csvToProducts('sku_id,title\nA,B');
    assert.ok(/Faltam colunas obrigatórias/.test(missing.fatal) && missing.missingColumns.includes('Preço'));
    assert.ok(csvToProducts('').fatal && csvToProducts('sku_id,title').fatal);
    assert.ok(/produtos demais/.test(csvToProducts(`${header}\n${ok}\n${ok}`, { maxRows: 1 }).fatal));
  });

  it('envio em lotes: no máximo 500 produtos e ~1,5 MB por pedido, na mesma ordem, sem perder nenhum', () => {
    const many = Array.from({ length: 1201 }, (_, i) => product(i + 1));
    const batches = toBatches(many);
    assert.deepEqual(batches.map((b) => b.length), [500, 500, 201]);
    assert.deepEqual(batches.flat().map((p) => p.skuId), many.map((p) => p.skuId));
    const heavy = Array.from({ length: 10 }, (_, i) => product(i + 1, { description: 'x'.repeat(400_000) }));
    const byBytes = toBatches(heavy);
    assert.ok(byBytes.length >= 3 && byBytes.every((b) => JSON.stringify(b).length <= 1_500_000 + 400_100), 'o tamanho segura antes da contagem');
    assert.equal(byBytes.flat().length, 10);
    assert.deepEqual(toBatches([]), []);
    assert.deepEqual(toBatches([product(1)]).map((b) => b.length), [1], 'um produto maior que o limite ainda vai sozinho');
    assert.deepEqual(toBatches(many.slice(0, 5), { maxCount: 2 }).map((b) => b.length), [2, 2, 1]);
  });

  it('conjunto de produtos: filtros viram as condições oficiais (campo + operador da tabela) e exigem ao menos um', () => {
    const { conditions, errors } = buildSetConditions({ brands: ['Nike', ' nike ', 'Adidas'], titleContains: ['camisa'], priceMin: '50', priceMax: '200,5', availability: 'IN_STOCK', condition: 'NEW' });
    assert.deepEqual(errors, []);
    assert.deepEqual(conditions, { and: [
      { field: 'brand', operation: 'I_CONTAIN', value: ['Nike', 'nike', 'Adidas'] },
      { field: 'title', operation: 'I_WILDCARD', value: ['camisa'] },
      { field: 'price', operation: 'GTE', value: '50' },
      { field: 'price', operation: 'LTE', value: '200.5' },
      { field: 'availability', operation: 'EQUAL', value: 'IN_STOCK' },
      { field: 'condition', operation: 'EQUAL', value: 'NEW' },
    ] });
    for (const bad of [{}, null, { priceMin: '300', priceMax: '100' }, { availability: 'X' }, { condition: 'X' }, { brands: ['a'.repeat(151)] }, { priceMin: 'abc' }]) assert.ok(buildSetConditions(bad).errors.length > 0, JSON.stringify(bad));
    assert.equal(normalizeProductSetName('  Verão   2026 ').name, 'Verão 2026');
    assert.ok(normalizeProductSetName('x').error && normalizeProductSetName('a'.repeat(129)).error);
  });
});

describe('Catálogo: cliente do TikTok (contrato oficial)', () => {
  let fake;
  let api;
  before(() => {
    fake = createFakeTiktok();
    api = createTiktokClient({ config: { tiktok: { apiBase: 'https://business-api.tiktok.com' } }, fetchFn: fake.fetchFn });
  });
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);
  const reset = () => {
    fake.state.calls.length = 0;
    fake.state.catalogs = {}; fake.state.catalogProducts = {}; fake.state.catalogFeedLogs = {}; fake.state.catalogSets = {};
    fake.state.failCatalogFor = new Set(); fake.state.rejectProductSkus = new Set();
  };

  it('criar catálogo: POST /catalog/create/ com bc_id (texto), name, catalog_type ECOM e catalog_conf { region_code, currency }', async () => {
    reset();
    const id = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'BR', currency: 'BRL' });
    assert.match(id, /^\d+$/);
    assert.deepEqual(callsOf('/catalog/create/')[0].body, { bc_id: '111', name: 'Loja', catalog_type: 'ECOM', catalog_conf: { region_code: 'BR', currency: 'BRL' } });
    assert.equal(callsOf('/catalog/create/')[0].method, 'POST');
  });

  it('listar catálogos: GET /catalog/get/ com bc_id, paginado (page_size 100), e lê os campos oficiais', async () => {
    reset();
    await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    const list = await api.listCatalogs(GOOD_TOKEN, '111');
    assert.equal(list.length, 1);
    assert.deepEqual({ name: list[0].name, type: list[0].type, region: list[0].regionCode, currency: list[0].currency, bcId: list[0].bcId, eligible: list[0].adCreationEligible }, { name: 'Loja', type: 'ECOM', region: 'US', currency: 'USD', bcId: '111', eligible: false });
    assert.deepEqual([callsOf('/catalog/get/')[0].query.bc_id, callsOf('/catalog/get/')[0].query.page_size], ['111', '100']);
    assert.deepEqual(await api.listCatalogs(GOOD_TOKEN, '222'), []);
  });

  it('países e moedas: /catalog/available_country/get/ (region_codes) e /catalog/location_currency/get/ (location → currency[])', async () => {
    reset();
    assert.deepEqual(await api.getCatalogRegions(GOOD_TOKEN, '111'), ['US', 'BR', 'GB']);
    assert.deepEqual(await api.getCatalogLocationCurrencies(GOOD_TOKEN), { US: ['USD'], BR: ['BRL'], GB: ['GBP'] });
    assert.equal(callsOf('/catalog/available_country/get/')[0].query.bc_id, '111');
  });

  it('enviar produtos: POST /catalog/product/upload/ devolve o feed_log_id e o log mostra o processamento', async () => {
    reset();
    const catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    const feedLogId = await api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [toTikTokProduct(normalizeProduct(product(1)).value), toTikTokProduct(normalizeProduct(product(2)).value)] });
    assert.match(feedLogId, /^\w+$/);
    const sent = callsOf('/catalog/product/upload/')[0].body;
    assert.deepEqual([sent.bc_id, sent.catalog_id, sent.products.length], ['111', catalogId, 2]);
    const log = await api.getCatalogProductLog(GOOD_TOKEN, { bcId: '111', catalogId, feedLogId });
    assert.deepEqual([log.status, log.addCount, log.updateCount, log.errorCount], ['SUCCESS', 2, 0, 0]);
    // o mesmo SKU de novo = atualização (envio incremental)
    const again = await api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [toTikTokProduct(normalizeProduct(product(1, { price: 10 })).value)] });
    assert.deepEqual((await api.getCatalogProductLog(GOOD_TOKEN, { bcId: '111', catalogId, feedLogId: again })).updateCount, 1);
  });

  it('o TikTok recusa produto sem campo obrigatório e SKU repetido (o cliente repassa o erro)', async () => {
    reset();
    const catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    const sku = toTikTokProduct(normalizeProduct(product(1)).value);
    delete sku.brand;
    await assert.rejects(api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [sku] }), (e) => e instanceof HttpError && e.code === 'tiktok_error' && /brand/.test(e.message));
    const ok = toTikTokProduct(normalizeProduct(product(1)).value);
    await assert.rejects(api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [ok, ok] }), (e) => /Duplicate SKU/.test(e.message));
    await assert.rejects(api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [] }), (e) => e.status === 400);
    await assert.rejects(api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: Array.from({ length: 5001 }, () => ok) }), (e) => e.status === 400, 'o máximo da API é 5.000');
  });

  it('processamento com erro: o log traz a contagem, o campo, o problema, a sugestão e os primeiros itens', async () => {
    reset();
    const catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    fake.state.rejectProductSkus.add('SKU-2');
    const feedLogId = await api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [1, 2].map((n) => toTikTokProduct(normalizeProduct(product(n)).value)) });
    const log = await api.getCatalogProductLog(GOOD_TOKEN, { bcId: '111', catalogId, feedLogId });
    assert.deepEqual([log.addCount, log.errorCount], [1, 1]);
    assert.deepEqual([log.errors[0].field, log.errors[0].issue, log.errors[0].count, log.errors[0].items[0].skuId], ['image_url', 'Image is too small', 1, 'SKU-2']);
    assert.ok(log.errors[0].suggestion.includes('500x500'));
  });

  it('listar produtos: page_size até 500, aprovação, elegibilidade para anúncios e busca por SKU', async () => {
    reset();
    const catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    await api.uploadCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, products: [toTikTokProduct(normalizeProduct(product(1)).value), toTikTokProduct(normalizeProduct(product(2, { availability: 'OUT_OF_STOCK' })).value)] });
    const all = await api.listCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, pageSize: 9999 });
    assert.equal(callsOf('/catalog/product/get/')[0].query.page_size, '500', 'limitado a 500');
    assert.equal(all.total, 2);
    assert.deepEqual(all.products.map((p) => [p.skuId, p.auditStatus, p.adCreationEligible]), [['SKU-1', 'approved', true], ['SKU-2', 'approved', false]]);
    assert.deepEqual((await api.listCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, skuIds: ['SKU-2'] })).products.map((p) => p.skuId), ['SKU-2']);
    assert.deepEqual((await api.listCatalogProducts(GOOD_TOKEN, { bcId: '111', catalogId, availableOnly: true })).products.map((p) => p.skuId), ['SKU-1']);
    assert.deepEqual(await api.getCatalogOverview(GOOD_TOKEN, { bcId: '111', catalogId }), { approved: 2, rejected: 0, processing: 0 });
  });

  it('conjuntos de produtos: cria com as condições oficiais e lista', async () => {
    reset();
    const catalogId = await api.createCatalog(GOOD_TOKEN, { bcId: '111', name: 'Loja', regionCode: 'US', currency: 'USD' });
    const { conditions } = buildSetConditions({ brands: ['Marca'], priceMin: 10 });
    const set = await api.createProductSet(GOOD_TOKEN, { bcId: '111', catalogId, name: 'Marca X', conditions });
    assert.deepEqual([set.name, typeof set.id], ['Marca X', 'string']);
    assert.deepEqual(callsOf('/catalog/set/create/')[0].body.conditions, conditions);
    assert.deepEqual((await api.listProductSets(GOOD_TOKEN, { bcId: '111', catalogId })).map((s) => s.name), ['Marca X']);
    await assert.rejects(api.createProductSet(GOOD_TOKEN, { bcId: '111', catalogId, name: 'x', conditions: { and: [{ field: 'brand', operation: 'EQUAL', value: 'x' }] } }), (e) => /invalid condition/.test(e.message), 'operador que a tabela oficial não permite para "brand"');
  });

  it('token inválido vira tiktok_reauth e falta de permissão vira erro do TikTok', async () => {
    reset();
    await assert.rejects(api.listCatalogs('token-errado-xxxxxxxxxxxxxxxx', '111'), (e) => e.code === 'tiktok_reauth');
    fake.state.failCatalogFor.add('111');
    await assert.rejects(api.listCatalogs(GOOD_TOKEN, '111'), (e) => e.code === 'tiktok_error' && /permission/i.test(e.message));
  });
});

describe('Catálogo: API do sistema', () => {
  let ctx;
  let fake;
  let mailer;
  before(async () => {
    fake = createFakeTiktok();
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  });
  after(() => ctx.stop());

  async function setup() {
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    fake.state.validTokens.add(GOOD_TOKEN);
    fake.state.validTokens.add(OTHER_TOKEN);
    fake.state.catalogs = {}; fake.state.catalogProducts = {}; fake.state.catalogFeedLogs = {}; fake.state.catalogSets = {};
    fake.state.failCatalogFor = new Set(); fake.state.rejectProductSkus = new Set();
    fake.state.calls.length = 0;
    return createUser(ctx, { approve: true, email: emailOf() });
  }
  const connect = async (user, bcId = '111', token = GOOD_TOKEN) => {
    const res = await user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: token });
    assert.equal(res.status, 201, res.text);
    return res.json.businessCenter?.id ?? res.json.id;
  };
  const callsOf = (path) => fake.state.calls.filter((c) => c.path === path);
  const base = (connectionId, bcId = '111') => `connectionId=${connectionId}&bcId=${bcId}`;
  const createCatalog = async (user, connectionId, extra = {}) => (await user.client.post('/api/tiktok/catalogs', { connectionId, bcId: '111', name: 'Loja Principal', regionCode: 'BR', currency: 'BRL', ...extra }));

  it('exige login, conta aprovada e a área "Campanhas"', async () => {
    const anon = ctx.client();
    assert.equal((await anon.get('/api/tiktok/catalogs')).status, 401);
    assert.equal((await anon.post('/api/tiktok/catalogs', {})).status, 401);
    const pending = await createUser(ctx, { approve: false, email: emailOf() });
    assert.equal((await pending.client.get('/api/tiktok/catalogs')).status, 403);
  });

  it('lista os catálogos de TODAS as BCs da conexão, com a BC, o país, a moeda e se já servem para anúncios', async () => {
    const user = await setup();
    const id = await connect(user, '111');
    fake.state.catalogs['111'] = [{ catalog_id: '5001', catalog_name: 'Moda', catalog_type: 'ECOM', ad_creation_eligible: 'AVAILABLE', create_time: '2026-11-20 10:00:00', update_time: '2026-11-21 10:00:00', bc_info: { bc_id: '111', bc_name: 'Minha BC' }, catalog_conf: { country: 'BR', currency: 'BRL', channel: 'CLIENT' } }];
    const res = await user.client.get('/api/tiktok/catalogs');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.catalogs.length, 1);
    assert.deepEqual(
      { id: res.json.catalogs[0].id, name: res.json.catalogs[0].name, bcId: res.json.catalogs[0].bcId, bcName: res.json.catalogs[0].bcName, region: res.json.catalogs[0].regionCode, currency: res.json.catalogs[0].currency, eligible: res.json.catalogs[0].adCreationEligible, connectionId: res.json.catalogs[0].connectionId, canManage: res.json.catalogs[0].canManage },
      { id: '5001', name: 'Moda', bcId: '111', bcName: 'Minha BC', region: 'BR', currency: 'BRL', eligible: true, connectionId: id, canManage: true },
    );
    assert.equal(res.json.businessCenters[0].status, 'ok');
    assert.equal(JSON.stringify(res.json).includes(GOOD_TOKEN), false, 'o token nunca sai');
  });

  it('falha em uma BC não derruba a lista; a BC aparece com o erro e a mensagem explica a permissão', async () => {
    const user = await setup();
    await connect(user, '111');
    await connect(user, '222', OTHER_TOKEN);
    fake.state.catalogs['222'] = [{ catalog_id: '6001', catalog_name: 'Outra', catalog_type: 'ECOM', ad_creation_eligible: 'NOT_AVAILABLE', bc_info: { bc_id: '222' }, catalog_conf: { country: 'US', currency: 'USD' } }];
    fake.state.failCatalogFor.add('111');
    const res = await user.client.get('/api/tiktok/catalogs?refresh=1');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.catalogs.map((c) => c.id), ['6001']);
    const failed = res.json.businessCenters.find((b) => b.bcId === '111');
    assert.equal(failed.status, 'error');
    assert.ok(/permissão para gerenciar catálogos/.test(failed.error), failed.error);
  });

  it('sem conexão a lista vem vazia (a tela convida a conectar)', async () => {
    const user = await setup();
    const res = await user.client.get('/api/tiktok/catalogs');
    assert.deepEqual([res.status, res.json.catalogs, res.json.totalConnections], [200, [], 0]);
  });

  it('conectar uma BC logo depois de ver a lista vazia mostra os catálogos na hora (o cache muda com as conexões)', async () => {
    const user = await setup();
    assert.deepEqual((await user.client.get('/api/tiktok/catalogs')).json.catalogs, []);
    fake.state.catalogs['111'] = [{ catalog_id: '5001', catalog_name: 'Moda', catalog_type: 'ECOM', ad_creation_eligible: 'AVAILABLE', bc_info: { bc_id: '111' }, catalog_conf: { country: 'BR', currency: 'BRL' } }];
    await connect(user, '111');
    const listed = (await user.client.get('/api/tiktok/catalogs')).json;
    assert.deepEqual([listed.totalConnections, listed.catalogs.map((c) => c.id)], [1, ['5001']]);
  });

  it('países e moedas para criar: só os que o TikTok aceita, cada um com suas moedas', async () => {
    const user = await setup();
    const id = await connect(user);
    const res = await user.client.get(`/api/tiktok/catalogs/meta?${base(id)}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.regions, [{ code: 'US', currencies: ['USD'] }, { code: 'BR', currencies: ['BRL'] }, { code: 'GB', currencies: ['GBP'] }]);
  });

  it('CRIAR catálogo: envia ao TikTok exatamente o contrato oficial, devolve o catálogo e ele aparece na lista', async () => {
    const user = await setup();
    const id = await connect(user);
    const res = await createCatalog(user, id);
    assert.equal(res.status, 201, res.text);
    assert.deepEqual({ name: res.json.catalog.name, type: res.json.catalog.type, region: res.json.catalog.regionCode, currency: res.json.catalog.currency, bcId: res.json.catalog.bcId }, { name: 'Loja Principal', type: 'ECOM', region: 'BR', currency: 'BRL', bcId: '111' });
    assert.deepEqual(callsOf('/catalog/create/').at(-1).body, { bc_id: '111', name: 'Loja Principal', catalog_type: 'ECOM', catalog_conf: { region_code: 'BR', currency: 'BRL' } });
    const list = await user.client.get('/api/tiktok/catalogs');
    assert.deepEqual(list.json.catalogs.map((c) => [c.name, c.regionCode, c.currency]), [['Loja Principal', 'BR', 'BRL']], 'a lista já mostra o catálogo novo (cache renovado)');
  });

  it('criar: valida nome, país e moeda ANTES de chamar o TikTok (país não aceito e moeda de outro país)', async () => {
    const user = await setup();
    const id = await connect(user);
    fake.state.calls.length = 0;
    for (const [extra, pattern] of [[{ name: 'x' }, /nome do catálogo/], [{ regionCode: 'JP' }, /não é aceito/], [{ currency: 'USD' }, /moeda do catálogo precisa ser: BRL/], [{ regionCode: 'brasil' }, /país/], [{ currency: '' }, /moeda/]]) {
      const res = await createCatalog(user, id, extra);
      assert.equal(res.status, 400, JSON.stringify(extra));
      assert.match(messageOf(res), pattern);
    }
    assert.equal(callsOf('/catalog/create/').length, 0, 'nada foi criado no TikTok');
  });

  it('criar: a BC precisa ser da conexão, a conexão do usuário, e o corpo bem formado', async () => {
    const owner = await setup();
    const id = await connect(owner);
    const intruder = await createUser(ctx, { approve: true, email: emailOf() });
    assert.equal((await createCatalog(owner, id, { bcId: '999' })).status, 400, 'BC que não é da conexão');
    assert.equal((await createCatalog(intruder, id)).status, 404, 'conexão de outro usuário não existe para você');
    assert.equal((await owner.client.post('/api/tiktok/catalogs', { bcId: '111', name: 'x', regionCode: 'BR', currency: 'BRL' })).status, 400, 'sem connectionId');
    assert.equal((await owner.client.post('/api/tiktok/catalogs', { connectionId: 'abc', bcId: '111' })).status, 400);
    assert.equal((await owner.client.post('/api/tiktok/catalogs', [1])).status, 400);
    assert.equal(callsOf('/catalog/create/').length, 0);
  });

  it('isolamento: um usuário não vê os catálogos de outro nem mexe neles', async () => {
    const owner = await setup();
    const id = await connect(owner);
    const created = (await createCatalog(owner, id)).json.catalog;
    const other = await createUser(ctx, { approve: true, email: emailOf() });
    assert.deepEqual((await other.client.get('/api/tiktok/catalogs')).json.catalogs, []);
    const q = base(id);
    assert.equal((await other.client.get(`/api/tiktok/catalogs/${created.id}/overview?${q}`)).status, 404);
    assert.equal((await other.client.get(`/api/tiktok/catalogs/${created.id}/products?${q}`)).status, 404);
    assert.equal((await other.client.post(`/api/tiktok/catalogs/${created.id}/products`, { connectionId: id, bcId: '111', products: [product()] })).status, 404);
    assert.equal((await other.client.post(`/api/tiktok/catalogs/${created.id}/sets`, { connectionId: id, bcId: '111', name: 'x', filters: { brands: ['a'] } })).status, 404);
    assert.equal((await other.client.get(`/api/tiktok/catalogs/meta?${q}`)).status, 404);
  });

  it('ENVIAR produtos: valida tudo no servidor, manda no formato oficial e devolve o feed_log_id; o log mostra o resultado', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    const url = `/api/tiktok/catalogs/${catalog.id}/products`;
    const res = await user.client.post(url, { connectionId: id, bcId: '111', products: [product(1, { color: 'Azul' }), product(2)] });
    assert.equal(res.status, 202, res.text);
    assert.equal(res.json.count, 2);
    const sent = callsOf('/catalog/product/upload/').at(-1).body;
    assert.deepEqual([sent.bc_id, sent.catalog_id, sent.products.map((p) => p.sku_id)], ['111', catalog.id, ['SKU-1', 'SKU-2']]);
    assert.deepEqual(sent.products[0].product_detail, { condition: 'NEW', color: 'Azul' });
    assert.deepEqual(sent.products[0].price_info, { price: 79.9 });
    const log = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/logs/${res.json.feedLogId}?${base(id)}`);
    assert.deepEqual([log.status, log.json.status, log.json.addCount], [200, 'SUCCESS', 2]);
    const products = await user.client.get(`${url}?${base(id)}`);
    assert.deepEqual(products.json.products.map((p) => [p.skuId, p.adCreationEligible]), [['SKU-1', true], ['SKU-2', true]]);
    const overview = await user.client.get(`/api/tiktok/catalogs/${catalog.id}/overview?${base(id)}`);
    assert.deepEqual(overview.json, { approved: 2, rejected: 0, processing: 0 });
    // com produtos disponíveis o catálogo passa a servir para anúncios
    assert.equal((await user.client.get('/api/tiktok/catalogs?refresh=1')).json.catalogs[0].adCreationEligible, true);
  });

  it('enviar: lote inválido é recusado INTEIRO e nada vai ao TikTok (campo obrigatório, emoji, SKU repetido, tamanho, formato)', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    const url = `/api/tiktok/catalogs/${catalog.id}/products`;
    fake.state.calls.length = 0;
    const send = (products, extra = {}) => user.client.post(url, { connectionId: id, bcId: '111', products, ...extra });
    const noBrand = product(2); delete noBrand.brand;
    for (const [products, pattern] of [
      [[], /ao menos um/], [null, /ao menos um/], ['x', /ao menos um/],
      [[product(1), noBrand], /Produto 2.*brand/], [[product(1, { skuId: 'camisa 😀' })], /skuId/], [[product(1), product(1)], /SKU repetido/],
      [[product(1, { price: 0 })], /price/], [[product(1, { imageUrl: 'ftp://a/b.jpg' })], /imageUrl/], [Array.from({ length: MAX_PRODUCTS_PER_REQUEST + 1 }, (_, i) => product(i)), /no máximo 500/],
    ]) {
      const res = await send(products);
      assert.equal(res.status, 400, JSON.stringify(products)?.slice(0, 60));
      assert.match(messageOf(res), pattern);
    }
    assert.equal((await user.client.post(url, { connectionId: id, products: [product()] })).status, 400, 'sem bcId');
    assert.equal((await user.client.post('/api/tiktok/catalogs/abc/products', { connectionId: id, bcId: '111', products: [product()] })).status, 400, 'catálogo não numérico');
    assert.equal(callsOf('/catalog/product/upload/').length, 0, 'nada foi enviado ao TikTok');
  });

  it('enviar: produtos que o TikTok reprova no processamento aparecem no log com o motivo e a sugestão', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    fake.state.rejectProductSkus.add('SKU-2');
    const res = await user.client.post(`/api/tiktok/catalogs/${catalog.id}/products`, { connectionId: id, bcId: '111', products: [product(1), product(2)] });
    const log = (await user.client.get(`/api/tiktok/catalogs/${catalog.id}/logs/${res.json.feedLogId}?${base(id)}`)).json;
    assert.deepEqual([log.addCount, log.errorCount, log.errors[0].field, log.errors[0].items[0].skuId], [1, 1, 'image_url', 'SKU-2']);
    assert.equal((await user.client.get(`/api/tiktok/catalogs/${catalog.id}/logs/../x?${base(id)}`)).status, 404);
    assert.equal((await user.client.get(`/api/tiktok/catalogs/${catalog.id}/logs/${encodeURIComponent('a b')}?${base(id)}`)).status, 400, 'id de processamento inválido');
  });

  it('produtos: paginação, busca por SKU, só os disponíveis e limite de navegação do TikTok (10.000)', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    await user.client.post(`/api/tiktok/catalogs/${catalog.id}/products`, { connectionId: id, bcId: '111', products: [product(1), product(2, { availability: 'OUT_OF_STOCK' }), product(3)] });
    const url = `/api/tiktok/catalogs/${catalog.id}/products?${base(id)}`;
    assert.equal((await user.client.get(`${url}&pageSize=2`)).json.products.length, 2);
    assert.equal((await user.client.get(`${url}&pageSize=2&page=2`)).json.products.length, 1);
    assert.deepEqual((await user.client.get(`${url}&sku=SKU-3`)).json.products.map((p) => p.skuId), ['SKU-3']);
    assert.deepEqual((await user.client.get(`${url}&available=1`)).json.products.map((p) => p.skuId), ['SKU-1', 'SKU-3']);
    const beyond = await user.client.get(`${url}&pageSize=100&page=101`);
    assert.equal(beyond.status, 400, 'o TikTok só deixa navegar pelos primeiros 10.000 produtos');
    assert.match(messageOf(beyond), /10\.000/);
    assert.equal((await user.client.get(`${url}&page=999999`)).status, 200, 'página absurda volta ao padrão');
    assert.equal(callsOf('/catalog/product/get/').at(-1).query.page, '1');
    assert.equal((await user.client.get(`${url}&productSetId=abc`)).status, 400);
  });

  it('CONJUNTOS de produtos: cria pelas condições oficiais e lista; filtro vazio ou inválido é recusado', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    const url = `/api/tiktok/catalogs/${catalog.id}/sets`;
    const res = await user.client.post(url, { connectionId: id, bcId: '111', name: 'Camisas baratas', filters: { titleContains: ['camisa'], priceMax: 100 } });
    assert.equal(res.status, 201, res.text);
    assert.equal(res.json.set.name, 'Camisas baratas');
    assert.deepEqual(callsOf('/catalog/set/create/').at(-1).body.conditions, { and: [{ field: 'title', operation: 'I_WILDCARD', value: ['camisa'] }, { field: 'price', operation: 'LTE', value: '100' }] });
    assert.deepEqual((await user.client.get(`${url}?${base(id)}`)).json.sets.map((s) => s.name), ['Camisas baratas']);
    for (const [name, filters] of [['Vazio', {}], ['Ruim', { availability: 'X' }], ['x', { brands: ['a'] }]]) assert.equal((await user.client.post(url, { connectionId: id, bcId: '111', name, filters })).status, 400, name);
  });

  it('só o DONO da conexão (ou admin) altera: um usuário comum só LÊ catálogos de uma BC compartilhada', async () => {
    const owner = await setup();
    const id = await connect(owner);
    const catalog = (await createCatalog(owner, id)).json.catalog;
    await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [id]);
    const viewer = await createUser(ctx, { approve: true, email: emailOf() });
    const list = (await viewer.client.get('/api/tiktok/catalogs')).json;
    assert.deepEqual(list.catalogs.map((c) => [c.id, c.canManage]), [[catalog.id, false]], 'enxerga, sem poder gerenciar');
    assert.equal((await viewer.client.get(`/api/tiktok/catalogs/${catalog.id}/products?${base(id)}`)).status, 200);
    assert.equal((await createCatalog(viewer, id)).status, 403);
    assert.equal((await viewer.client.post(`/api/tiktok/catalogs/${catalog.id}/products`, { connectionId: id, bcId: '111', products: [product()] })).status, 403);
    assert.equal((await viewer.client.post(`/api/tiktok/catalogs/${catalog.id}/sets`, { connectionId: id, bcId: '111', name: 'Conjunto', filters: { brands: ['a'] } })).status, 403);
    assert.equal((await viewer.client.get(`/api/tiktok/catalogs/meta?${base(id)}`)).status, 403);
  });

  it('conexão com erro de acesso: mensagem clara (409) em vez de tentar o TikTok', async () => {
    const user = await setup();
    const id = await connect(user);
    await run(ctx.db, "UPDATE tiktok_business_centers SET status = 'error', last_error = 'x' WHERE id = $1", [id]);
    const res = await createCatalog(user, id);
    assert.equal(res.status, 409);
    assert.match(messageOf(res), /erro de acesso/);
    const list = (await user.client.get('/api/tiktok/catalogs?refresh=1')).json;
    assert.equal(list.businessCenters[0].status, 'error');
  });

  it('o corpo do envio de produtos aceita lotes grandes (até 2 MB) e o resto da API continua com limite pequeno', async () => {
    const user = await setup();
    const id = await connect(user);
    const catalog = (await createCatalog(user, id, { regionCode: 'US', currency: 'USD' })).json.catalog;
    const big = Array.from({ length: 200 }, (_, i) => product(i + 1, { description: 'x'.repeat(5000) })); // ~1 MB
    const res = await user.client.post(`/api/tiktok/catalogs/${catalog.id}/products`, { connectionId: id, bcId: '111', products: big });
    assert.equal(res.status, 202, res.text);
    const tooBig = await user.client.post('/api/tiktok/catalogs', { connectionId: id, bcId: '111', name: 'x'.repeat(200_000), regionCode: 'US', currency: 'USD' });
    assert.ok([400, 413].includes(tooBig.status));
  });
});
