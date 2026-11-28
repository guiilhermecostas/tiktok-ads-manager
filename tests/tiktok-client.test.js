import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { HttpError } from '../src/lib/http-error.js';
import { createTiktokClient, usableEmail } from '../src/modules/tiktok/tiktok.client.js';

const config = { tiktok: { apiBase: 'https://business-api.tiktok.com' } };
const TOKEN = 'token-secreto-1234567890';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Cria um cliente cujo "TikTok" responde com `handler(url, init)` e registra as chamadas. */
function setup(handler) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return handler(new URL(url), init, calls.length);
  };
  return { client: createTiktokClient({ config, fetchFn }), calls };
}

const rejectsWith = (promise, { status, code }) =>
  assert.rejects(promise, (err) => err instanceof HttpError && err.status === status && err.code === code, `esperava ${status}/${code}`);

describe('cliente TikTok: formato das requisições', () => {
  it('GET: token só no cabeçalho Access-Token, parâmetros na query (listas em JSON), sem corpo, com timeout', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [] } }));
    await client.getAdvertiserInfo(TOKEN, ['111', '222']);
    const { url, init } = calls[0];
    assert.equal(url.origin, 'https://business-api.tiktok.com');
    assert.equal(url.pathname, '/open_api/v1.3/advertiser/info/');
    assert.equal(url.searchParams.get('advertiser_ids'), '["111","222"]');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['Access-Token'], TOKEN);
    assert.equal(init.body, undefined);
    assert.equal(init.headers['Content-Type'], undefined);
    assert.ok(init.signal instanceof AbortSignal, 'timeout configurado');
    assert.ok(!url.toString().includes(TOKEN), 'o token nunca vai na URL');
  });

  it('POST: corpo JSON + Content-Type, e o token continua só no cabeçalho', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { campaign_id: '123' } }));
    assert.equal(await client.createCampaign(TOKEN, { advertiser_id: '9', campaign_name: 'X', operation_status: 'DISABLE' }), '123');
    const { url, init } = calls[0];
    assert.equal(url.pathname, '/open_api/v1.3/campaign/create/');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { advertiser_id: '9', campaign_name: 'X', operation_status: 'DISABLE' });
    assert.ok(!init.body.includes(TOKEN) && !url.toString().includes(TOKEN));
  });

  it('o relatório envia os parâmetros do contrato oficial (GET, nomes e níveis)', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [] } }));
    await client.getDailyReport(TOKEN, '9001', { startDate: '2026-11-01', endDate: '2026-11-07' });
    const q = Object.fromEntries(calls[0].url.searchParams);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].url.pathname, '/open_api/v1.3/report/integrated/get/');
    assert.deepEqual(
      { advertiser_id: q.advertiser_id, report_type: q.report_type, data_level: q.data_level, start_date: q.start_date, end_date: q.end_date, page: q.page },
      { advertiser_id: '9001', report_type: 'BASIC', data_level: 'AUCTION_ADVERTISER', start_date: '2026-11-01', end_date: '2026-11-07', page: '1' },
    );
    assert.deepEqual(JSON.parse(q.dimensions), ['stat_time_day']);
    assert.ok(JSON.parse(q.metrics).includes('spend'));
    assert.ok(Number(q.page_size) <= 1000);
  });
});

describe('cliente TikTok: envelope e erros', () => {
  const call = (handler) => setup(handler).client.getAdvertiserInfo(TOKEN, ['1']);

  it('aceita code 0 e também envelope sem `code` mas com `data` (SDK oficial: code só em erros)', async () => {
    assert.deepEqual(await call(() => json({ code: 0, message: 'OK', data: { list: [{ advertiser_id: 1, name: 'A' }] } })), [{ id: '1', name: 'A', currency: null, timezone: null, ownerBcId: null, status: null }]);
    assert.equal((await call(() => json({ data: { list: [{ advertiser_id: 2, name: 'B' }] } })))[0].id, '2');
  });

  it('envelope sem code e sem data, ou JSON estranho, é erro (nunca "sucesso" silencioso)', async () => {
    await rejectsWith(call(() => json({ message: 'algo' })), { status: 502, code: 'tiktok_error' });
    await rejectsWith(call(() => json(null)), { status: 502, code: 'tiktok_error' });
    await rejectsWith(call(() => json([])), { status: 502, code: 'tiktok_error' });
  });

  it('resposta que não é JSON e falha de rede viram 502 sem vazar detalhes', async () => {
    await rejectsWith(call(() => new Response('<html>erro</html>', { status: 502 })), { status: 502, code: 'tiktok_bad_response' });
    const boom = () => { throw new Error('ECONNRESET token-secreto-1234567890'); };
    await assert.rejects(call(boom), (err) => err.code === 'tiktok_unreachable' && !err.message.includes('ECONNRESET') && !err.message.includes(TOKEN));
  });

  it('token inválido/revogado vira 409 tiktok_reauth (por código e por mensagem)', async () => {
    await rejectsWith(call(() => json({ code: 40105, message: 'x' })), { status: 409, code: 'tiktok_reauth' });
    await rejectsWith(call(() => json({ code: 40104, message: 'x' })), { status: 409, code: 'tiktok_reauth' });
    await rejectsWith(call(() => json({ code: 40001, message: 'Access token is incorrect or has been revoked.' })), { status: 409, code: 'tiktok_reauth' });
  });

  it('limite de requisições do TikTok vira 429 com Retry-After (por código, mensagem ou status HTTP)', async () => {
    for (const handler of [
      () => json({ code: 40100, message: 'x' }),
      () => json({ code: 51021, message: 'Too many requests, please slow down' }),
      () => json({ code: 1, message: 'rate limit exceeded' }),
      () => json({ message: 'x' }, 429),
    ]) {
      await assert.rejects(call(handler), (err) => err.status === 429 && err.code === 'tiktok_rate_limited' && err.retryAfterSec > 0);
    }
  });

  it('outros erros mostram a mensagem do TikTok (limitada) como 502', async () => {
    await assert.rejects(call(() => json({ code: 40002, message: 'Invalid parameter: budget' })), (err) => err.status === 502 && err.message === 'TikTok: Invalid parameter: budget');
    await assert.rejects(call(() => json({ code: 40002, message: 'x'.repeat(500) })), (err) => err.message.length <= 'TikTok: '.length + 200);
  });
});

describe('cliente TikTok: paginação e limites', () => {
  it('BC: usa page_size ≤ 50 (limite do SDK), percorre as páginas e remove IDs duplicados/inválidos', async () => {
    const pages = {
      1: { list: [{ asset_id: '1' }, { asset_id: '2' }, { asset_id: 'abc' }], page_info: { total_page: 3 } },
      2: { list: [{ asset_id: '2' }, { advertiser_id: '3' }], page_info: { total_page: 3 } },
      3: { list: [{ asset_id: '4' }], page_info: { total_page: 3 } },
    };
    const { client, calls } = setup((url) => json({ code: 0, data: pages[url.searchParams.get('page')] }));
    assert.deepEqual(await client.listBusinessCenterAdvertiserIds(TOKEN, '111'), ['1', '2', '3', '4']);
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.ok(Number(c.url.searchParams.get('page_size')) <= 50);
      assert.equal(c.url.searchParams.get('asset_type'), 'ADVERTISER');
      assert.equal(c.url.searchParams.get('bc_id'), '111');
    }
  });

  it('BC: para sozinha se a lista vier vazia e tem teto de páginas (sem loop infinito)', async () => {
    const empty = setup(() => json({ code: 0, data: { list: [], page_info: { total_page: 99 } } }));
    assert.deepEqual(await empty.client.listBusinessCenterAdvertiserIds(TOKEN, '1'), []);
    assert.equal(empty.calls.length, 1);

    let n = 0;
    const endless = setup(() => json({ code: 0, data: { list: [{ asset_id: String(++n) }], page_info: { total_page: 9999 } } }));
    await endless.client.listBusinessCenterAdvertiserIds(TOKEN, '1');
    assert.equal(endless.calls.length, 10, 'teto de 10 páginas');
  });

  it('informações das contas são pedidas em blocos de 100', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => String(i + 1));
    const { client, calls } = setup((url) => json({ code: 0, data: { list: JSON.parse(url.searchParams.get('advertiser_ids')).map((id) => ({ advertiser_id: id, name: `C${id}`, currency: 'BRL', timezone: 'America/Sao_Paulo' })) } }));
    const result = await client.getAdvertiserInfo(TOKEN, ids);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map((c) => JSON.parse(c.url.searchParams.get('advertiser_ids')).length), [100, 100, 50]);
    assert.equal(result.length, 250);
    assert.deepEqual(result[0], { id: '1', name: 'C1', currency: 'BRL', timezone: 'America/Sao_Paulo', ownerBcId: null, status: null });
    const none = setup(() => json({ code: 0, data: {} }));
    assert.deepEqual(await none.client.getAdvertiserInfo(TOKEN, []), []);
    assert.equal(none.calls.length, 0, 'lista vazia não chama a API');
  });

  it('campanhas: pagina de 100 em 100 até o fim e informa o total real', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({ campaign_id: String(i + 1), campaign_name: `C${i + 1}`, objective_type: 'TRAFFIC', operation_status: 'ENABLE', budget: '12.5' }));
    const { client, calls } = setup((url) => {
      const page = Number(url.searchParams.get('page'));
      const size = Number(url.searchParams.get('page_size'));
      return json({ code: 0, data: { list: all.slice((page - 1) * size, page * size), page_info: { total_number: 230, total_page: Math.ceil(230 / size) } } });
    });
    const result = await client.getCampaigns(TOKEN, '9001');
    assert.equal(calls.length, 3);
    assert.equal(result.campaigns.length, 230);
    assert.equal(result.total, 230);
    assert.equal(result.campaigns[0].budget, 12.5);
    assert.equal(result.campaigns[0].status, 'ENABLE');
    assert.ok(calls.every((c) => c.url.searchParams.get('advertiser_id') === '9001'));
  });

  it('campanhas: teto de 5 páginas, mas o total continua sendo o real', async () => {
    const { client, calls } = setup((url) => {
      const page = Number(url.searchParams.get('page'));
      return json({ code: 0, data: { list: Array.from({ length: 100 }, (_, i) => ({ campaign_id: String((page - 1) * 100 + i + 1) })), page_info: { total_number: 2000, total_page: 20 } } });
    });
    const result = await client.getCampaigns(TOKEN, '9001');
    assert.equal(calls.length, 5);
    assert.equal(result.campaigns.length, 500);
    assert.equal(result.total, 2000);
  });

  it('campanhas: sem dados devolve lista vazia', async () => {
    const { client } = setup(() => json({ code: 0, data: {} }));
    assert.deepEqual(await client.getCampaigns(TOKEN, '1'), { campaigns: [], total: 0 });
  });
});

describe('cliente TikTok: envio de mídia (multipart)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-upload-'));
  const file = path.join(dir, 'arquivo.bin');
  fs.writeFileSync(file, Buffer.from('conteudo-do-arquivo-de-teste'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('imagem: campos do contrato, token só no cabeçalho, sem Content-Type manual (o boundary é do fetch) e timeout longo', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { image_id: 'ad-site-i18n/2026/abc123', width: 1, height: 1 } }));
    const id = await client.uploadImage(TOKEN, { advertiserId: '9001', filePath: file, fileName: '7.png', md5: 'd41d8cd98f00b204e9800998ecf8427e' });
    assert.equal(id, 'ad-site-i18n/2026/abc123');
    const { url, init } = calls[0];
    assert.equal(url.pathname, '/open_api/v1.3/file/image/ad/upload/');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Access-Token'], TOKEN);
    assert.equal(init.headers['Content-Type'], undefined, 'multipart: o fetch define Content-Type com o boundary');
    assert.ok(init.body instanceof FormData);
    const form = Object.fromEntries([...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : { name: v.name, size: v.size }]));
    assert.deepEqual(form, { advertiser_id: '9001', upload_type: 'UPLOAD_BY_FILE', image_signature: 'd41d8cd98f00b204e9800998ecf8427e', file_name: '7.png', image_file: { name: '7.png', size: 28 } });
    assert.ok(!url.toString().includes(TOKEN));
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('vídeo: campos do contrato e IDs em qualquer formato de resposta (objeto, lista, array)', async () => {
    for (const data of [{ video_id: 'v10033g50000abc' }, { list: [{ video_id: 'v10033g50000abc' }] }, [{ video_id: 'v10033g50000abc' }]]) {
      const { client, calls } = setup(() => json({ code: 0, data }));
      assert.equal(await client.uploadVideo(TOKEN, { advertiserId: '9001', filePath: file, fileName: '8.mp4', md5: 'abc' }), 'v10033g50000abc');
      const form = Object.fromEntries([...calls[0].init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : v.name]));
      assert.deepEqual(form, { advertiser_id: '9001', upload_type: 'UPLOAD_BY_FILE', video_signature: 'abc', file_name: '8.mp4', video_file: '8.mp4' });
      assert.equal(calls[0].url.pathname, '/open_api/v1.3/file/video/ad/upload/');
    }
  });

  it('erros do TikTok no envio: token revogado, limite de requisições e rejeição do arquivo', async () => {
    const upload = (handler) => setup(handler).client.uploadImage(TOKEN, { advertiserId: '1', filePath: file, fileName: 'a.png', md5: 'm' });
    await rejectsWith(upload(() => json({ code: 40105, message: 'x' })), { status: 409, code: 'tiktok_reauth' });
    await rejectsWith(upload(() => json({ code: 40100, message: 'x' })), { status: 429, code: 'tiktok_rate_limited' });
    await assert.rejects(upload(() => json({ code: 40002, message: 'Image size is too large' })), (e) => e.status === 502 && e.message === 'TikTok: Image size is too large');
  });

  it('ID de mídia devolvido é validado (sem "..", sem barras duplas, tamanho e caracteres)', async () => {
    for (const bad of [undefined, '', 'ab', '../../x', 'a..b', 'a//b', '/abc', 'abc/', 'com espaço', "v1';DROP", 'x'.repeat(201)]) {
      const { client } = setup(() => json({ code: 0, data: { image_id: bad } }));
      await rejectsWith(client.uploadImage(TOKEN, { advertiserId: '1', filePath: file, fileName: 'a.png', md5: 'm' }), { status: 502, code: 'tiktok_bad_response' });
    }
  });

  it('arquivo inexistente no disco falha de forma controlada (sem enviar nada)', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { image_id: 'abcd1234' } }));
    await assert.rejects(client.uploadImage(TOKEN, { advertiserId: '1', filePath: path.join(dir, 'nao-existe.bin'), fileName: 'a.png', md5: 'm' }));
    assert.equal(calls.length, 0);
  });
});

describe('cliente TikTok: criação e relatório', () => {
  it('extrai o ID de cada nível em todos os formatos conhecidos', async () => {
    const make = (data) => setup(() => json({ code: 0, data })).client;
    assert.equal(await make({ campaign_id: 55 }).createCampaign(TOKEN, {}), '55');
    assert.equal(await make({ adgroup_id: '66' }).createAdGroup(TOKEN, {}), '66');
    assert.equal(await make({ ad_ids: ['77', '78'] }).createAd(TOKEN, {}), '77');
    assert.equal(await make({ ad_id: '88' }).createAd(TOKEN, {}), '88');
    assert.equal(await make({ creatives: [{ ad_id: '99' }] }).createAd(TOKEN, {}), '99');
  });

  it('ID ausente ou inválido é erro (não deixa registrar publicação sem ID)', async () => {
    const make = (data) => setup(() => json({ code: 0, data })).client;
    await rejectsWith(make({}).createCampaign(TOKEN, {}), { status: 502, code: 'tiktok_bad_response' });
    await rejectsWith(make({ campaign_id: 'abc' }).createCampaign(TOKEN, {}), { status: 502, code: 'tiktok_bad_response' });
    await rejectsWith(make({ ad_ids: [] }).createAd(TOKEN, {}), { status: 502, code: 'tiktok_bad_response' });
    await rejectsWith(make({ adgroup_id: "1; DROP TABLE x" }).createAdGroup(TOKEN, {}), { status: 502, code: 'tiktok_bad_response' });
  });

  it('relatório: ordena por data, trata métricas ausentes/strings e calcula totais', async () => {
    const { client } = setup(() =>
      json({
        code: 0,
        data: {
          list: [
            { dimensions: { stat_time_day: '2026-11-03 00:00:00' }, metrics: { spend: '3.00', impressions: '300', clicks: '3', conversion: '1' } },
            { dimensions: { stat_time_day: '2026-11-01 00:00:00' }, metrics: { spend: '1.50', impressions: '100' } },
            { dimensions: { stat_time_day: '2026-11-02 00:00:00' }, metrics: { spend: 'lixo', impressions: null, clicks: '5' } },
          ],
        },
      }),
    );
    const { days, totals } = await client.getDailyReport(TOKEN, '9', { startDate: '2026-11-01', endDate: '2026-11-03' });
    assert.deepEqual(days.map((d) => d.date), ['2026-11-01', '2026-11-02', '2026-11-03']);
    assert.deepEqual(days[1], { date: '2026-11-02', spend: 0, impressions: 0, clicks: 5, conversions: 0 });
    assert.equal(totals.spend, 4.5);
    assert.equal(totals.clicks, 8);
    assert.equal(totals.ctr, (8 / 400) * 100);
    const empty = await setup(() => json({ code: 0, data: {} })).client.getDailyReport(TOKEN, '9', { startDate: 'a', endDate: 'b' });
    assert.deepEqual(empty.days, []);
    assert.equal(empty.totals.ctr, 0);
  });
});

describe('cliente TikTok: autorização por link (OAuth)', () => {
  const APP = { appId: '7123456789012345678', appSecret: 'segredo-do-app-1234' };
  const ACCESS = 'oauth-access-token-0123456789';

  it('troca o código por token: POST JSON sem cabeçalho de token, credenciais do app só no corpo', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { access_token: ACCESS, advertiser_ids: ['9001', 7002, 'abc', '../x'] } }));
    const result = await client.exchangeAuthCode({ ...APP, authCode: 'codigo-1234567890' });
    assert.deepEqual(result, { accessToken: ACCESS, advertiserIds: ['9001', '7002'] }, 'ids não numéricos são descartados');
    const { url, init } = calls[0];
    assert.equal(url.pathname, '/open_api/v1.3/oauth2/access_token/');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { app_id: APP.appId, secret: APP.appSecret, auth_code: 'codigo-1234567890' });
    assert.equal(init.headers['Access-Token'], undefined);
    assert.ok(!url.search.includes(APP.appSecret) && !url.search.includes('codigo-1234567890'), 'segredo e código nunca vão na URL');
  });

  it('resposta sem token utilizável é rejeitada (502) e erros do TikTok viram erro de integração', async () => {
    for (const data of [{}, { access_token: '' }, { access_token: 'curto' }, { access_token: 'tem espaço no meio do token 123' }, { access_token: 123 }, { access_token: `${'a'.repeat(600)}` }]) {
      const { client } = setup(() => json({ code: 0, data }));
      await rejectsWith(client.exchangeAuthCode({ ...APP, authCode: 'c' }), { status: 502, code: 'tiktok_bad_response' });
    }
    const refused = setup(() => json({ code: 40002, message: 'auth_code is invalid' }));
    await rejectsWith(refused.client.exchangeAuthCode({ ...APP, authCode: 'c' }), { status: 502, code: 'tiktok_error' });
  });

  it('lista as contas autorizadas: token no cabeçalho, app na query, sem repetidos', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [{ advertiser_id: '9001' }, { advertiser_id: 9001 }, { advertiser_id: '9002' }, { advertiser_id: 'x' }] } }));
    assert.deepEqual(await client.listAuthorizedAdvertiserIds(ACCESS, APP), ['9001', '9002']);
    const { url, init } = calls[0];
    assert.equal(url.pathname, '/open_api/v1.3/oauth2/advertiser/get/');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['Access-Token'], ACCESS);
    assert.equal(url.searchParams.get('app_id'), APP.appId);
    assert.equal(url.searchParams.get('secret'), APP.appSecret);
    assert.ok(!url.toString().includes(ACCESS));
    const empty = setup(() => json({ code: 0, data: {} }));
    assert.deepEqual(await empty.client.listAuthorizedAdvertiserIds(ACCESS, APP), []);
  });

  it('token revogado ao listar contas pede nova autorização (409)', async () => {
    const { client } = setup(() => json({ code: 40105, message: 'Access token is incorrect or has been revoked.' }));
    await rejectsWith(client.listAuthorizedAdvertiserIds(ACCESS, APP), { status: 409, code: 'tiktok_reauth' });
  });
});

describe('cliente TikTok: Business Center dona da conta (owner_bc_id)', () => {
  const info = (list) => json({ code: 0, data: { list } });

  it('pede owner_bc_id junto com nome, moeda e fuso e devolve o ID da BC (só dígitos)', async () => {
    const { client, calls } = setup(() => info([{ advertiser_id: 9001, name: 'A', currency: 'BRL', timezone: 'X', owner_bc_id: '7000000000000000001' }, { advertiser_id: '9002', name: 'B', owner_bc_id: 'abc' }, { advertiser_id: '9003', name: 'C' }, { advertiser_id: '9004', name: 'D', owner_bc_id: '1; DROP TABLE' }]));
    const result = await client.getAdvertiserInfo(TOKEN, ['9001', '9002', '9003', '9004']);
    assert.deepEqual(result.map((a) => [a.id, a.ownerBcId]), [['9001', '7000000000000000001'], ['9002', null], ['9003', null], ['9004', null]], 'valor que não é número do TikTok nunca é guardado');
    assert.deepEqual(JSON.parse(calls[0].url.searchParams.get('fields')), ['advertiser_id', 'name', 'currency', 'timezone', 'owner_bc_id', 'status']);
  });

  it('lê a situação da conta (`status`): só valores no formato do TikTok (STATUS_…); qualquer outra coisa vira nulo', async () => {
    const { client } = setup(() => info([
      { advertiser_id: '9001', name: 'A', status: 'STATUS_ENABLE' }, { advertiser_id: '9002', name: 'B', status: 'STATUS_DISABLE' }, { advertiser_id: '9003', name: 'C', status: 'banida!' },
      { advertiser_id: '9004', name: 'D', status: 42 }, { advertiser_id: '9005', name: 'E' }, { advertiser_id: '9006', name: 'F', status: 'status_enable' },
    ]));
    const result = await client.getAdvertiserInfo(TOKEN, ['9001', '9002', '9003', '9004', '9005', '9006']);
    assert.deepEqual(result.map((a) => a.status), ['STATUS_ENABLE', 'STATUS_DISABLE', null, null, null, null]);
  });

  it('se o TikTok recusar o parâmetro `fields`, repete SEM ele (a sincronização nunca quebra por causa do ID da BC) e não insiste nas páginas seguintes', async () => {
    const { client, calls } = setup((url) => (url.searchParams.has('fields') ? json({ code: 40002, message: 'fields invalid' }) : info(JSON.parse(url.searchParams.get('advertiser_ids')).map((id) => ({ advertiser_id: id, name: `Conta ${id}` })))));
    const ids = Array.from({ length: 150 }, (_, i) => String(1000 + i));
    const result = await client.getAdvertiserInfo(TOKEN, ids);
    assert.equal(result.length, 150);
    assert.ok(result.every((a) => a.ownerBcId === null));
    assert.deepEqual(calls.map((c) => c.url.searchParams.has('fields')), [true, false, false], '1ª página tenta com fields; as outras já vão sem');
  });

  it('erro de token, limite de requisições e queda de rede NÃO são repetidos sem `fields` (são erros de verdade)', async () => {
    const reauth = setup(() => json({ code: 40105, message: 'Access token is incorrect' }));
    await rejectsWith(reauth.client.getAdvertiserInfo(TOKEN, ['1']), { status: 409, code: 'tiktok_reauth' });
    assert.equal(reauth.calls.length, 1);
    const limited = setup(() => json({ code: 40100, message: 'Too many requests' }));
    await rejectsWith(limited.client.getAdvertiserInfo(TOKEN, ['1']), { status: 429, code: 'tiktok_rate_limited' });
    assert.equal(limited.calls.length, 1);
    const down = setup(() => { throw new TypeError('fetch failed'); });
    await rejectsWith(down.client.getAdvertiserInfo(TOKEN, ['1']), { status: 502, code: 'tiktok_unreachable' });
    assert.equal(down.calls.length, 1);
  });

  it('lista as Business Centers do token (formatos bc_info.bc_id e bc_id), sem repetidos e ignorando o que não é ID', async () => {
    const { client, calls } = setup(() => json({ code: 0, data: { list: [{ bc_info: { bc_id: '111', name: 'Loja' } }, { bc_id: '222', name: 'Outra' }, { bc_info: { bc_id: '111', name: 'Repetida' } }, { bc_info: { bc_id: 'x' } }, {}, null], page_info: { total_page: 1 } } }));
    assert.deepEqual(await client.listBusinessCenters(TOKEN), [{ id: '111', name: 'Repetida' }, { id: '222', name: 'Outra' }]);
    assert.equal(calls[0].url.pathname, '/open_api/v1.3/bc/get/');
    assert.equal(calls[0].init.headers['Access-Token'], TOKEN);
    const empty = setup(() => json({ code: 0, data: {} }));
    assert.deepEqual(await empty.client.listBusinessCenters(TOKEN), []);
  });

  it('sem permissão para listar BCs é erro do TikTok (quem chama trata como "sem ID")', async () => {
    const { client } = setup(() => json({ code: 40001, message: 'No permission' }));
    await rejectsWith(client.listBusinessCenters(TOKEN), { status: 502, code: 'tiktok_error' });
  });
});

describe('ritmo e repetição diante do limite de frequência do TikTok (documentação: 10/s e 600/min por endpoint e por app; código 40100)', () => {
  const limited = { code: 40100, message: 'Too many requests' };
  const ok = { code: 0, data: { list: [], page_info: { total_page: 1 } } };
  const pacedConfig = (extra) => ({ tiktok: { apiBase: 'https://business-api.tiktok.com', ...extra } });
  const make = (handler, extra) => {
    const calls = [];
    const fetchFn = async (url) => {
      calls.push({ url: new URL(url), at: Date.now() });
      return handler(calls.length);
    };
    return { client: createTiktokClient({ config: pacedConfig(extra), fetchFn }), calls };
  };

  it('consulta (GET) limitada é repetida e, se o limite passar, dá certo', async () => {
    const { client, calls } = make((n) => json(n <= 2 ? limited : ok), { rateLimitRetries: 2, retryDelayMs: 5 });
    const result = await client.listAds(TOKEN, '1');
    assert.deepEqual(result, { ads: [], truncated: false });
    assert.equal(calls.length, 3, 'duas recusas e uma resposta');
  });

  it('se o limite continuar, desiste depois das repetições e devolve 429 tiktok_rate_limited', async () => {
    const { client, calls } = make(() => json(limited), { rateLimitRetries: 2, retryDelayMs: 5 });
    await rejectsWith(client.listAds(TOKEN, '1'), { status: 429, code: 'tiktok_rate_limited' });
    assert.equal(calls.length, 3, '1 tentativa + 2 repetições');
  });

  it('sem configuração de repetição (padrão dos testes e do contrato) não repete', async () => {
    const { client, calls } = make(() => json(limited));
    await rejectsWith(client.listAds(TOKEN, '1'), { status: 429, code: 'tiktok_rate_limited' });
    assert.equal(calls.length, 1);
  });

  it('criação (POST que não se repete com segurança) NUNCA é repetida; ativar/pausar (idempotente) é', async () => {
    const created = make(() => json(limited), { rateLimitRetries: 2, retryDelayMs: 5 });
    await rejectsWith(created.client.createCampaign(TOKEN, { advertiser_id: '1', campaign_name: 'x', objective_type: 'TRAFFIC', operation_status: 'DISABLE' }), { status: 429, code: 'tiktok_rate_limited' });
    assert.equal(created.calls.length, 1, 'criar campanha duas vezes duplicaria');
    const toggled = make((n) => json(n === 1 ? limited : { code: 0, data: { ad_ids: ['7'] } }), { rateLimitRetries: 2, retryDelayMs: 5 });
    assert.deepEqual(await toggled.client.updateAdStatus(TOKEN, '1', ['7'], 'DISABLE'), ['7']);
    assert.equal(toggled.calls.length, 2);
  });

  it('o ritmo por endpoint vale para todos os clientes: chamadas simultâneas ao mesmo endpoint saem espaçadas', async () => {
    const a = make(() => json(ok), { minIntervalMs: 40 });
    const b = make(() => json(ok), { minIntervalMs: 40 });
    await Promise.all([a.client.listAds(TOKEN, '1'), b.client.listAds(TOKEN, '2'), a.client.listAds(TOKEN, '3'), b.client.listAds(TOKEN, '4')]);
    const starts = [...a.calls, ...b.calls].map((c) => c.at).sort((x, y) => x - y);
    assert.ok(starts[3] - starts[0] >= 100, `4 chamadas simultâneas levam ao menos ~120 ms (3 intervalos de 40 ms; foram ${starts[3] - starts[0]} ms)`);
  });
});

describe('e-mail de contato mascarado pelo TikTok (documentação de /advertiser/info/: "l***********@*************")', () => {
  it('só um e-mail completo e sem máscara serve para pré-preencher', () => {
    assert.equal(usableEmail('ads@empresa.com'), 'ads@empresa.com');
    assert.equal(usableEmail('  ads@empresa.com '), 'ads@empresa.com');
    for (const bad of ['l***********@*************', 'l***@gmail.com', 'ads@***.com', '', null, undefined, 42, 'sem-arroba', 'a b@c.com', `${'a'.repeat(250)}@x.com`]) assert.equal(usableEmail(bad), null, String(bad));
  });

  it('getAdvertiserProfile NÃO devolve o e-mail mascarado (o formulário de "+ CA" ficaria com um valor que o servidor recusa)', async () => {
    const info = (email) => json({ code: 0, data: { list: [{ advertiser_id: '1', company: 'Acme', country: 'us', currency: 'usd', timezone: 'America/New_York', email, industry: '290216' }] } });
    const masked = setup(() => info('l***********@*************'));
    const profile = await masked.client.getAdvertiserProfile(TOKEN, '1');
    assert.equal(profile.contactEmail, null);
    assert.deepEqual([profile.company, profile.country, profile.currency, profile.industry], ['Acme', 'US', 'USD', '290216'], 'o resto do perfil continua vindo');
    assert.equal((await setup(() => info('ads@acme.com')).client.getAdvertiserProfile(TOKEN, '1')).contactEmail, 'ads@acme.com');
    assert.equal((await setup(() => info(null)).client.getAdvertiserProfile(TOKEN, '1')).contactEmail, null);
  });
});

