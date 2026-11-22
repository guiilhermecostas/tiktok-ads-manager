import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { completeConfig } from './campaign-fixtures.js';
import { GOOD_TOKEN, OTHER_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, proxiesRead: 1000, proxiesWrite: 1000, proxiesTest: 1000, campaignPublish: 1000, tiktokCallback: 1000 };
const proxyInput = (name, host) => ({ name, kind: 'socks5', host, port: 1080, username: 'user', password: 'pw-secreta' });

/**
 * REGRA: com proxy ativa, TODA chamada à API do TikTok sai por ela (o fetch recebe o `dispatcher` da proxy); a proxy usada é a
 * do DONO da Business Center; e se a proxy falhar a chamada FALHA (nunca há conexão direta de reserva).
 */
describe('toda chamada ao TikTok sai pela proxy do dono da Business Center', () => {
  let ctx;
  let fake;
  let admin;
  let bia; // BC privada 222 (conta 9101)
  let zed; // BC privada 333 (contas 9201, 9202), sem proxy
  let sharedBcId;
  let biaBcId;
  let zedBcId;
  const tiktokCalls = () => fake.state.calls.filter((c) => c.path.startsWith('/'));
  const viaProxyOnly = () => tiktokCalls().every((c) => c.dispatcher);
  const direct = () => tiktokCalls().every((c) => !c.dispatcher);

  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
    admin = await loginAdmin(ctx);
    sharedBcId = (await admin.post('/api/tiktok/business-centers', { name: 'Loja Matriz', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).json.businessCenter.id;
    bia = await createUser(ctx, { approve: true });
    zed = await createUser(ctx, { approve: true });
    biaBcId = (await bia.client.post('/api/tiktok/business-centers', { name: 'Agência Bia', bcId: '222', accessToken: OTHER_TOKEN })).json.businessCenter.id;
    zedBcId = (await zed.client.post('/api/tiktok/business-centers', { name: 'Loja Zed', bcId: '333', accessToken: GOOD_TOKEN })).json.businessCenter.id;
  });
  after(() => ctx.stop());

  const reset = async () => {
    await run(ctx.db, 'DELETE FROM proxies');
    fake.state.calls.length = 0;
    fake.state.failProxied = false;
    fake.state.validTokens = new Set([GOOD_TOKEN, OTHER_TOKEN]);
    fake.state.failCreate.clear();
    await run(ctx.db, "UPDATE tiktok_business_centers SET status = 'active', last_error = NULL");
  };
  /** Cria e ativa uma proxy; devolve o id. */
  const activate = async (client, name, host) => (await client.post('/api/proxies', { ...proxyInput(name, host), active: true })).json.proxy.id;
  const hit = async (client, path) => client.get(path);
  /** O cache de dados do TikTok (60 s) serviria a resposta sem chamar a API: sincronizar invalida tudo antes de cada sondagem. */
  const fresh = async () => {
    await admin.post(`/api/tiktok/business-centers/${sharedBcId}/sync`, {});
    fake.state.calls.length = 0;
  };
  /** Faz UMA chamada ao TikTok em nome do usuário e devolve a chamada registrada (com o dispatcher usado). */
  const probe = async (client, advertiserId) => {
    await fresh();
    assert.equal((await client.get(`/api/tiktok/advertisers/${advertiserId}/report?days=7`)).status, 200);
    return tiktokCalls().at(-1);
  };

  it('sem proxy ativa: tudo sai direto (comportamento de antes, nada muda)', async () => {
    await reset();
    await bia.client.post('/api/proxies', proxyInput('Inativa', '203.0.113.20')); // cadastrada, mas NÃO ativa
    assert.equal((await hit(bia.client, '/api/tiktok/advertisers/9101/campaigns')).status, 200);
    assert.equal((await hit(bia.client, '/api/tiktok/advertisers/9101/report?days=7')).status, 200);
    assert.equal((await bia.client.post(`/api/tiktok/business-centers/${biaBcId}/sync`, {})).status, 200);
    assert.ok(tiktokCalls().length >= 3 && direct(), 'nenhuma chamada usou proxy');
  });

  it('com proxy ativa: sincronizar, relatório, campanhas e visão geral saem TODOS pela proxy, reaproveitando a mesma conexão', async () => {
    await reset();
    await activate(bia.client, 'EUA', '203.0.113.20');
    assert.equal((await bia.client.post(`/api/tiktok/business-centers/${biaBcId}/sync`, {})).status, 200);
    assert.equal((await hit(bia.client, '/api/tiktok/advertisers/9101/campaigns')).status, 200);
    assert.equal((await hit(bia.client, '/api/tiktok/advertisers/9101/report?days=14')).status, 200);
    assert.equal((await hit(bia.client, '/api/tiktok/overview?days=7')).status, 200);
    const calls = tiktokCalls();
    assert.ok(calls.length >= 5, `chamadas: ${calls.length}`);
    const mine = calls.filter((c) => c.token === OTHER_TOKEN); // a BC da Bia
    const shared = calls.filter((c) => c.token === GOOD_TOKEN); // contas da BC compartilhada do admin (que não tem proxy)
    assert.ok(mine.length >= 4 && mine.every((c) => c.dispatcher), 'NENHUMA chamada da BC da Bia saiu direto');
    assert.equal(new Set(mine.map((c) => c.dispatcher)).size, 1, 'a mesma conexão (cache) serve todas as chamadas');
    assert.ok(shared.length > 0 && shared.every((c) => !c.dispatcher), 'BC do admin (sem proxy): vale a regra do DONO e sai direto');
  });

  it('desativar volta ao direto; reativar cria uma conexão nova; editar a proxy ativa também renova a conexão', async () => {
    await reset();
    const id = await activate(bia.client, 'EUA', '203.0.113.20');
    const first = (await probe(bia.client, '9101')).dispatcher;
    assert.ok(first);
    assert.equal((await probe(bia.client, '9101')).dispatcher, first, 'sem mudanças, a conexão é reaproveitada');

    await bia.client.post(`/api/proxies/${id}/deactivate`, {});
    assert.equal((await probe(bia.client, '9101')).dispatcher, null, 'desativada: volta a sair direto');

    await bia.client.post(`/api/proxies/${id}/activate`, {});
    const second = (await probe(bia.client, '9101')).dispatcher;
    assert.ok(second && second !== first, 'reativada: conexão nova');

    await bia.client.patch(`/api/proxies/${id}`, { ...proxyInput('EUA', '203.0.113.99'), username: undefined, password: undefined });
    const third = (await probe(bia.client, '9101')).dispatcher;
    assert.ok(third && third !== second, 'editada: a conexão é refeita com o endereço novo');

    await bia.client.delete(`/api/proxies/${id}`);
    assert.equal((await probe(bia.client, '9101')).dispatcher, null, 'removida: direto');
  });

  it('PUBLICAR: envio dos criativos (multipart) e criação de campanha, grupo e anúncio saem todos pela proxy', async () => {
    await reset();
    await activate(bia.client, 'EUA', '203.0.113.20');
    const video = await uploadedId(bia.client, { type: 'mp4' });
    const cover = await uploadedId(bia.client, { type: 'png' });
    const campaign = (await bia.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: video, coverCreativeId: cover } }) })).json.campaign;
    fake.state.calls.length = 0;
    const res = await bia.client.post(`/api/campaigns/${campaign.id}/publish`, { confirm: true, advertiserId: '9101' });
    assert.equal(res.status, 200, res.text);
    const paths = tiktokCalls().map((c) => c.path);
    for (const needed of ['/file/video/ad/upload/', '/file/image/ad/upload/', '/campaign/create/', '/adgroup/create/', '/ad/create/']) assert.ok(paths.includes(needed), needed);
    assert.ok(viaProxyOnly(), 'upload e criações: nenhuma saiu direto');
    assert.equal(new Set(tiktokCalls().map((c) => c.dispatcher)).size, 1);
  });

  it('FALHA FECHADA: se a proxy cai, a chamada FALHA (502 proxy_error, citando a proxy) e NADA é tentado direto; a BC não é marcada com erro', async () => {
    await reset();
    await activate(bia.client, 'EUA', '203.0.113.20');
    fake.state.failProxied = true;
    for (const path of ['/api/tiktok/advertisers/9101/campaigns', '/api/tiktok/advertisers/9101/report?days=7']) {
      const res = await hit(bia.client, path);
      assert.equal(res.status, 502, path);
      assert.equal(res.json.error.code, 'proxy_error');
      assert.match(res.json.error.message, /pela proxy "EUA"/);
      assert.match(res.json.error.message, /conexão recusada/);
      assert.match(res.json.error.message, /Nada foi enviado fora da proxy/);
      assert.ok(!res.text.includes('pw-secreta'));
    }
    assert.equal((await bia.client.post(`/api/tiktok/business-centers/${biaBcId}/sync`, {})).json.error.code, 'proxy_error');
    assert.deepEqual(tiktokCalls().filter((c) => !c.dispatcher), [], 'nenhuma tentativa direta, nem de reserva');
    assert.equal((await one(ctx.db, 'SELECT status FROM tiktok_business_centers WHERE id = $1', [biaBcId])).status, 'active', 'falha de proxy não é falha de token');

    fake.state.failProxied = false;
    assert.equal((await hit(bia.client, '/api/tiktok/advertisers/9101/campaigns')).status, 200, 'proxy de volta: volta a funcionar sozinho');
  });

  it('FALHA FECHADA na publicação: nada é criado nem enviado fora da proxy e o motivo fica registrado', async () => {
    await reset();
    await activate(bia.client, 'EUA', '203.0.113.20');
    const video = await uploadedId(bia.client, { type: 'mp4' });
    const campaign = (await bia.client.post('/api/campaigns', { config: completeConfig('TRAFFIC', { ad: { videoCreativeId: video } }) })).json.campaign;
    fake.state.calls.length = 0;
    fake.state.failProxied = true;
    const res = await bia.client.post(`/api/campaigns/${campaign.id}/publish`, { confirm: true, advertiserId: '9101' });
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'proxy_error');
    assert.deepEqual(tiktokCalls().filter((c) => !c.dispatcher), []);
    assert.deepEqual(tiktokCalls().filter((c) => c.path.endsWith('/create/')), [], 'nada foi criado');
    const detail = (await bia.client.get(`/api/campaigns/${campaign.id}`)).json.campaign;
    assert.match(detail.publications[0].error, /proxy/);
    fake.state.failProxied = false;
    assert.equal((await bia.client.post(`/api/campaigns/${campaign.id}/publish`, { confirm: true, advertiserId: '9101' })).status, 200, 'tenta de novo com a proxy de volta');
  });

  it('proxy ativa com endereço que virou interno/inválido: 502 proxy_error SEM fazer nenhuma chamada (nem direta)', async () => {
    await reset();
    const id = await activate(bia.client, 'EUA', '203.0.113.20');
    await run(ctx.db, "UPDATE proxies SET host = '127.0.0.1' WHERE id = $1", [id]); // ex.: DNS reapontado para a rede interna
    const res = await hit(bia.client, '/api/tiktok/advertisers/9101/campaigns');
    assert.equal(res.status, 502);
    assert.equal(res.json.error.code, 'proxy_error');
    assert.match(res.json.error.message, /não pôde ser usada/);
    assert.equal(fake.state.calls.length, 0, 'nenhuma chamada saiu');
  });

  it('a proxy usada é a do DONO da BC: BC compartilhada do admin usa a proxy do admin (mesmo para quem tem outra ou nenhuma)', async () => {
    await reset();
    await activate(admin, 'Admin US', '203.0.113.30');
    await activate(bia.client, 'Bia US', '203.0.113.20');

    const adminDispatcher = (await probe(admin, '9001')).dispatcher; // referência: a conexão do admin
    assert.ok(adminDispatcher);
    assert.equal((await probe(bia.client, '9001')).dispatcher, adminDispatcher, 'Bia na BC do admin: proxy do admin, NÃO a da Bia');

    const biaDispatcher = (await probe(bia.client, '9101')).dispatcher; // BC da própria Bia
    assert.ok(biaDispatcher && biaDispatcher !== adminDispatcher, 'BC da Bia: proxy da Bia');

    assert.equal((await probe(zed.client, '9001')).dispatcher, adminDispatcher, 'Zed (sem proxy) na BC do admin: também pela proxy do dono da BC');
    assert.equal((await probe(zed.client, '9201')).dispatcher, null, 'BC do Zed, que não tem proxy: direto');
  });

  it('o admin mexendo na BC de um usuário usa a proxy DESSE usuário (o IP da BC não muda)', async () => {
    await reset();
    await activate(admin, 'Admin US', '203.0.113.30');
    await activate(bia.client, 'Bia US', '203.0.113.20');
    await hit(bia.client, '/api/tiktok/advertisers/9101/campaigns');
    const biaDispatcher = tiktokCalls().at(-1).dispatcher;
    fake.state.calls.length = 0;
    assert.equal((await admin.post(`/api/tiktok/business-centers/${biaBcId}/sync`, {})).status, 200);
    assert.ok(tiktokCalls().length > 0);
    assert.ok(tiktokCalls().every((c) => c.dispatcher === biaDispatcher), 'sincronizar a BC da Bia pelo admin sai pela proxy da Bia');
  });

  it('cadastrar/validar o token de uma BC também sai pela proxy do usuário; se ela cai, a BC não é criada', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await activate(user.client, 'EUA', '203.0.113.40');
    fake.state.failProxied = true;
    const failed = await user.client.post('/api/tiktok/business-centers', { name: 'Nova', bcId: '222', accessToken: OTHER_TOKEN });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error.code, 'proxy_error');
    assert.equal((await all(ctx.db, 'SELECT id FROM tiktok_business_centers WHERE owner_id = $1', [user.id])).length, 0);
    assert.deepEqual(tiktokCalls().filter((c) => !c.dispatcher), []);

    fake.state.failProxied = false;
    fake.state.calls.length = 0;
    assert.equal((await user.client.post('/api/tiktok/business-centers', { name: 'Nova', bcId: '222', accessToken: OTHER_TOKEN })).status, 201);
    assert.ok(tiktokCalls().length > 0 && viaProxyOnly(), 'validação do token e leitura das contas saíram pela proxy');
  });

  it('conexão por link (OAuth): a troca do código e a leitura das contas saem pela proxy do usuário', async () => {
    await reset();
    const user = await createUser(ctx, { approve: true });
    await activate(user.client, 'EUA', '203.0.113.50');
    const start = (await user.client.post('/api/tiktok/connect', { name: 'Por link' })).json;
    fake.grantAuthCode('code-proxy-oauth-xxxxxx', { advertisers: ['9301'] });
    fake.state.calls.length = 0;
    const state = new URL(start.url).searchParams.get('state');
    const back = await ctx.client().get(`/api/tiktok/callback?auth_code=code-proxy-oauth-xxxxxx&state=${encodeURIComponent(state)}`);
    assert.equal(back.headers.get('location'), '/tiktok/connected?status=connected');
    const paths = tiktokCalls().map((c) => c.path);
    assert.ok(paths.includes('/oauth2/access_token/'));
    assert.ok(viaProxyOnly(), 'troca do código (com o App Secret) e leitura das contas: tudo pela proxy');

    // Proxy fora do ar durante a autorização: erro seguro e NENHUMA chamada direta.
    const second = (await user.client.post('/api/tiktok/connect', { name: 'Outra' })).json;
    fake.grantAuthCode('code-proxy-oauth-yyyyyy', { advertisers: ['9302'] });
    fake.state.failProxied = true;
    fake.state.calls.length = 0;
    await ctx.client().get(`/api/tiktok/callback?auth_code=code-proxy-oauth-yyyyyy&state=${encodeURIComponent(new URL(second.url).searchParams.get('state'))}`);
    const status = (await user.client.get(`/api/tiktok/connect/${second.attemptId}`)).json;
    assert.equal(status.status, 'error');
    assert.match(status.message, /proxy/i);
    assert.deepEqual(tiktokCalls().filter((c) => !c.dispatcher), []);
  });

  it('a lista sinaliza "via proxy" por BC sem revelar nome ou endereço da proxy a ninguém', async () => {
    await reset();
    await activate(admin, 'Admin US Secreta', '203.0.113.31');
    const biaList = (await bia.client.get('/api/tiktok/business-centers')).json.businessCenters;
    assert.deepEqual(biaList.map((b) => [b.name, b.viaProxy]).sort(), [['Agência Bia', false], ['Loja Matriz', true]]);
    const accounts = (await bia.client.get('/api/tiktok/advertisers')).json.advertisers;
    assert.deepEqual([...new Set(accounts.map((a) => `${a.businessCenterName}:${a.businessCenterViaProxy}`))].sort(), ['Agência Bia:false', 'Loja Matriz:true']);
    const texts = [JSON.stringify(biaList), JSON.stringify(accounts)].join('');
    assert.ok(!texts.includes('Admin US Secreta') && !texts.includes('203.0.113.31'), 'nome e endereço da proxy do admin não vazam');
    assert.deepEqual((await zed.client.get('/api/tiktok/business-centers')).json.businessCenters.find((b) => b.name === 'Loja Zed').viaProxy, false);
    assert.ok(sharedBcId && zedBcId);
  });
});
