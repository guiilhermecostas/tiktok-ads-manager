import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, proxiesRead: 1000, proxiesWrite: 1000, proxiesTest: 1000 };
const SECRET = 'S3nh@-da-proxy/çã€';
const input = (over = {}) => ({ name: 'Proxy EUA', kind: 'socks5', host: '203.0.113.10', port: 1080, username: 'resi-us-1', password: SECRET, ...over });

describe('API de proxies', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: tiktokTestConfig(), fetchFn: fake.fetchFn });
  });
  after(() => ctx.stop());
  const reset = async () => {
    await run(ctx.db, 'DELETE FROM proxies');
    fake.state.calls.length = 0;
    Object.assign(fake.state, { exitIp: '198.51.100.23', exitCountry: 'United States', exitCountryCode: 'US', failIpCheck: null, ipifyBody: null, failProxied: false });
  };
  const newUser = () => createUser(ctx, { approve: true });

  it('exige login, conta aprovada e CSRF', async () => {
    await reset();
    assert.equal((await ctx.client().get('/api/proxies')).status, 401);
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await pending.client.get('/api/proxies')).status, 403);
    const { client } = await newUser();
    assert.equal((await client.post('/api/proxies', input(), { withCsrf: false })).json.error.code, 'bad_csrf');
    assert.equal((await client.get('/api/proxies')).status, 200);
  });

  it('cadastra proxies de TODOS os tipos (http, https, socks4, socks5) e a senha NUNCA volta ao navegador', async () => {
    await reset();
    const { client } = await newUser();
    for (const kind of ['http', 'https', 'socks4', 'socks5']) {
      const res = await client.post('/api/proxies', input({ name: `P ${kind}`, kind, password: kind === 'socks4' ? undefined : SECRET }));
      assert.equal(res.status, 201, res.text);
      assert.equal(res.json.proxy.kind, kind);
      assert.equal(res.json.proxy.active, false);
      assert.ok(!res.text.includes(SECRET), 'a senha não aparece na resposta');
      assert.ok(!('password' in res.json.proxy));
    }
    const list = await client.get('/api/proxies');
    assert.equal(list.json.proxies.length, 4);
    assert.ok(!list.text.includes(SECRET));
    const socks5 = list.json.proxies.find((p) => p.kind === 'socks5');
    assert.deepEqual([socks5.username, socks5.hasPassword, socks5.host, socks5.port, socks5.lastTest], ['resi-us-1', true, '203.0.113.10', 1080, null]);
    assert.equal(list.json.configured, true);
  });

  it('usuário e senha ficam CRIPTOGRAFADOS no banco (nem o usuário em texto)', async () => {
    await reset();
    const { client } = await newUser();
    await client.post('/api/proxies', input());
    const row = await one(ctx.db, 'SELECT * FROM proxies');
    assert.match(row.auth_enc, /^v1\./);
    assert.ok(!JSON.stringify(row).includes(SECRET) && !JSON.stringify(row).includes('resi-us-1'), 'nada legível em nenhuma coluna');
  });

  it('sem autenticação também funciona (proxy aberta)', async () => {
    await reset();
    const { client } = await newUser();
    const res = await client.post('/api/proxies', input({ username: undefined, password: undefined }));
    assert.equal(res.status, 201);
    assert.deepEqual([res.json.proxy.username, res.json.proxy.hasPassword], [null, false]);
    assert.equal((await one(ctx.db, 'SELECT auth_enc FROM proxies')).auth_enc, null);
  });

  it('valida cada campo (nome, tipo, endereço, porta, usuário, senha, tipos errados)', async () => {
    await reset();
    const { client } = await newUser();
    const bad = [
      { name: '' }, { name: 'a'.repeat(61) }, { name: 5 }, { name: 'com\u0000controle' },
      { kind: 'ftp' }, { kind: 'SOCKS5' }, { kind: undefined }, { kind: ['http'] },
      { host: '' }, { host: 'http://proxy.com' }, { host: 'proxy.com:8080' }, { host: 'proxy com' }, { host: '2130706433' }, { host: 42 }, { host: undefined },
      { port: 0 }, { port: 65536 }, { port: -1 }, { port: 1.5 }, { port: 'abc' }, { port: '99999' }, { port: null }, { port: undefined },
      { username: 'u'.repeat(129) }, { username: 'a\nb' }, { username: 12 },
      { password: 'p'.repeat(257) }, { password: 'a\u0000b' }, { password: { $ne: 1 } },
      { active: 'sim' }, { clearAuth: 1 },
    ];
    for (const over of bad) {
      const res = await client.post('/api/proxies', input({ name: `n${Math.random()}`, ...over }));
      assert.equal(res.status, 400, JSON.stringify(over));
    }
    assert.equal((await client.post('/api/proxies', 'texto', {})).status, 400);
    assert.equal((await client.post('/api/proxies', input({ kind: 'socks4' }))).json.error.code, 'proxy_socks4_password', 'SOCKS4 não usa senha');
    assert.equal((await client.get('/api/proxies')).json.proxies.length, 0, 'nada inválido foi gravado');
  });

  it('ANTI-SSRF: endereços internos, de metadados da nuvem e nomes que resolvem para eles são recusados', async () => {
    await reset();
    const { client } = await newUser();
    for (const host of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.9', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '[::1]', '::ffff:127.0.0.1', 'localhost', 'fd00::1']) {
      const res = await client.post('/api/proxies', input({ name: `ssrf-${host}`, host }));
      assert.equal(res.status, 400, host);
      assert.equal(res.json.error.code, 'proxy_host_not_allowed', host);
    }
    assert.equal((await client.post('/api/proxies', input({ name: 'dns', host: 'nao-existe.invalid' }))).json.error.code, 'proxy_host_unresolved');
    assert.equal((await client.get('/api/proxies')).json.proxies.length, 0);
    // E o mesmo vale ao EDITAR: não dá para trocar o endereço de uma proxy válida por um interno.
    const { id } = (await client.post('/api/proxies', input())).json.proxy;
    const edit = await client.patch(`/api/proxies/${id}`, input({ host: '169.254.169.254' }));
    assert.equal(edit.status, 400);
    assert.equal((await one(ctx.db, 'SELECT host FROM proxies WHERE id = $1', [id])).host, '203.0.113.10');
  });

  it('nome único por usuário (sem diferenciar maiúsculas) e limite de 20 proxies', async () => {
    await reset();
    const { client } = await newUser();
    assert.equal((await client.post('/api/proxies', input({ name: 'EUA' }))).status, 201);
    assert.equal((await client.post('/api/proxies', input({ name: 'eua' }))).status, 409);
    const other = await newUser();
    assert.equal((await other.client.post('/api/proxies', input({ name: 'EUA' }))).status, 201, 'outro usuário pode usar o mesmo nome');
    for (let i = 2; i <= 20; i += 1) assert.equal((await client.post('/api/proxies', input({ name: `P${i}` }))).status, 201, `P${i}`);
    const res = await client.post('/api/proxies', input({ name: 'P21' }));
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'proxy_limit');
  });

  it('editar: senha em branco MANTÉM a salva; trocar substitui; "remover autenticação" limpa; mudar a conexão apaga o último teste', async () => {
    await reset();
    const { client } = await newUser();
    const { id } = (await client.post('/api/proxies', input())).json.proxy;
    await client.post(`/api/proxies/${id}/test`, {});
    assert.equal((await client.get('/api/proxies')).json.proxies[0].lastTest.ok, true);
    const stored = (await one(ctx.db, 'SELECT auth_enc FROM proxies')).auth_enc;

    // só o nome: credenciais e último teste continuam
    let res = await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', username: undefined, password: undefined }));
    assert.equal(res.status, 200, res.text);
    assert.equal((await one(ctx.db, 'SELECT auth_enc FROM proxies')).auth_enc, stored);
    assert.equal(res.json.proxy.lastTest.ok, true);

    // senha em branco (campo vazio no formulário) mantém a senha
    res = await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', username: 'resi-us-1', password: '' }));
    assert.equal(res.json.proxy.hasPassword, true);

    // senha nova substitui e invalida o teste
    res = await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', password: 'nova-senha-123' }));
    assert.equal(res.status, 200);
    assert.equal(res.json.proxy.lastTest, null, 'credencial nova: o teste antigo não vale mais');
    assert.notEqual((await one(ctx.db, 'SELECT auth_enc FROM proxies')).auth_enc, stored);

    // remover autenticação
    res = await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', clearAuth: true, username: undefined, password: undefined }));
    assert.deepEqual([res.json.proxy.username, res.json.proxy.hasPassword], [null, false]);
    assert.equal((await one(ctx.db, 'SELECT auth_enc FROM proxies')).auth_enc, null);

    // trocar para SOCKS4 mantendo uma senha salva é recusado
    await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', password: 'x-123' }));
    assert.equal((await client.patch(`/api/proxies/${id}`, input({ name: 'Renomeada', kind: 'socks4', username: undefined, password: undefined }))).json.error.code, 'proxy_socks4_password');
  });

  it('só UMA proxy ativa por usuário: ativar outra desativa a anterior; desativar deixa nenhuma; simultâneas nunca deixam duas', async () => {
    await reset();
    const { client } = await newUser();
    const a = (await client.post('/api/proxies', input({ name: 'A' }))).json.proxy.id;
    const b = (await client.post('/api/proxies', input({ name: 'B' }))).json.proxy.id;
    const c = (await client.post('/api/proxies', input({ name: 'C', active: true }))).json.proxy.id;
    const activeIds = async () => (await all(ctx.db, 'SELECT id FROM proxies WHERE active ORDER BY id')).map((r) => r.id);
    assert.deepEqual(await activeIds(), [c], 'criada já ativa');
    assert.equal((await client.post(`/api/proxies/${a}/activate`, {})).json.proxy.active, true);
    assert.deepEqual(await activeIds(), [a]);
    assert.equal((await client.post(`/api/proxies/${a}/deactivate`, {})).json.proxy.active, false);
    assert.deepEqual(await activeIds(), []);
    const results = await Promise.all([a, b, c, a, b, c].map((id) => client.post(`/api/proxies/${id}/activate`, {})));
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join());
    assert.equal((await activeIds()).length, 1, 'no máximo uma ativa mesmo com requisições simultâneas');
  });

  it('remover apaga a proxy; inexistente = 404', async () => {
    await reset();
    const { client } = await newUser();
    const { id } = (await client.post('/api/proxies', input())).json.proxy;
    assert.equal((await client.delete(`/api/proxies/${id}`)).status, 204);
    assert.equal((await client.delete(`/api/proxies/${id}`)).status, 404);
    assert.equal((await client.post(`/api/proxies/${id}/activate`, {})).status, 404);
    for (const bad of ['abc', '0', '-1', '99999999999', '1.5']) assert.equal((await client.delete(`/api/proxies/${bad}`)).status, 400, bad);
  });

  it('isolamento total: outro usuário (e até o admin) não vê, testa, ativa, edita nem remove proxies alheias (404)', async () => {
    await reset();
    const owner = await newUser();
    const stranger = await newUser();
    const admin = await loginAdmin(ctx);
    const { id } = (await owner.client.post('/api/proxies', input())).json.proxy;
    for (const who of [stranger.client, admin]) {
      assert.deepEqual((await who.get('/api/proxies')).json.proxies, []);
      assert.equal((await who.patch(`/api/proxies/${id}`, input({ name: 'Roubada' }))).status, 404);
      assert.equal((await who.post(`/api/proxies/${id}/activate`, {})).status, 404);
      assert.equal((await who.post(`/api/proxies/${id}/deactivate`, {})).status, 404);
      assert.equal((await who.post(`/api/proxies/${id}/test`, {})).status, 404);
      assert.equal((await who.delete(`/api/proxies/${id}`)).status, 404);
    }
    const row = await one(ctx.db, 'SELECT name, active FROM proxies WHERE id = $1', [id]);
    assert.deepEqual([row.name, row.active], ['Proxy EUA', false], 'nada foi alterado');
    assert.equal(fake.state.calls.filter((c) => c.path.startsWith('api.ipify')).length, 0, 'nenhum teste foi disparado para a proxy alheia');
  });

  describe('Testar a proxy', () => {
    it('conecta pela proxy, mostra IP e país de saída, confirma que o TikTok responde e SALVA o resultado', async () => {
      await reset();
      const { client } = await newUser();
      const { id } = (await client.post('/api/proxies', input())).json.proxy;
      const res = await client.post(`/api/proxies/${id}/test`, {});
      assert.equal(res.status, 200, res.text);
      const { result } = res.json;
      assert.deepEqual([result.ok, result.ip, result.country, result.countryCode, result.tiktokReachable], [true, '198.51.100.23', 'United States', 'US', true]);
      assert.ok(Number.isInteger(result.latencyMs) && result.latencyMs >= 0);
      assert.ok(!res.text.includes(SECRET));
      // Todas as chamadas do teste saíram pela proxy (têm dispatcher), inclusive a ao TikTok.
      const calls = fake.state.calls;
      assert.deepEqual(calls.map((c) => c.path).sort(), ['/oauth2/advertiser/get/', 'api.ipify.org/', 'ipwho.is/198.51.100.23'].sort());
      assert.ok(calls.every((c) => c.dispatcher), 'nenhuma chamada do teste saiu direto');
      const saved = (await client.get('/api/proxies')).json.proxies[0].lastTest;
      assert.deepEqual([saved.ok, saved.ip, saved.country, saved.error], [true, '198.51.100.23', 'United States', null]);
    });

    it('falhas viram mensagem clara, são salvas, nunca vazam credenciais e não derrubam o servidor', async () => {
      await reset();
      const { client } = await newUser();
      const { id } = (await client.post('/api/proxies', input())).json.proxy;
      for (const [code, expected] of [['ECONNREFUSED', /conexão recusada/], ['ETIMEDOUT', /não respondeu a tempo/], ['ENOTFOUND', /encontrar o endereço/]]) {
        fake.state.failIpCheck = code;
        const res = await client.post(`/api/proxies/${id}/test`, {});
        assert.equal(res.status, 200);
        assert.equal(res.json.result.ok, false);
        assert.match(res.json.result.error, expected);
        assert.ok(!res.text.includes(SECRET), 'a senha nunca aparece');
        assert.ok(!res.json.result.error.includes(SECRET) && !res.json.result.error.includes('resi-us-1'), 'a mensagem de erro não cita credenciais');
      }
      assert.equal((await client.get('/api/proxies')).json.proxies[0].lastTest.ok, false);
      // O serviço de IP devolve lixo
      fake.state.failIpCheck = null;
      fake.state.ipifyBody = { ip: '<script>alert(1)</script>' };
      assert.match((await client.post(`/api/proxies/${id}/test`, {})).json.result.error, /IP de saída/);
      fake.state.ipifyBody = { ip: 12345 };
      assert.equal((await client.post(`/api/proxies/${id}/test`, {})).json.result.ok, false);
    });

    it('a proxy conecta mas não alcança o TikTok: reprova com a explicação', async () => {
      await reset();
      // O TikTok responde HTML (bloqueio feito pela proxy): não é um envelope JSON do TikTok.
      const srv = await startTestServer({
        limits: LIMITS, config: tiktokTestConfig(), isolated: true,
        fetchFn: async (url, init) => (new URL(url).hostname === 'business-api.tiktok.com' ? new Response('<html>blocked</html>', { status: 403 }) : fake.fetchFn(url, init)),
      });
      try {
        const user = await createUser(srv, { approve: true });
        const created = (await user.client.post('/api/proxies', input())).json.proxy;
        const res = await user.client.post(`/api/proxies/${created.id}/test`, {});
        assert.equal(res.json.result.ok, false);
        assert.equal(res.json.result.tiktokReachable, false);
        assert.match(res.json.result.error, /não consegue acessar a API do TikTok/);
        assert.equal(res.json.result.ip, '198.51.100.23', 'o IP de saída ainda é mostrado');
      } finally {
        await srv.stop();
      }
    });

    it('é limitado por frequência (abre conexões para fora)', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, proxiesTest: 3 }, config: tiktokTestConfig(), fetchFn: fake.fetchFn, isolated: true });
      try {
        const { client } = await createUser(limited, { approve: true });
        const { id } = (await client.post('/api/proxies', input())).json.proxy;
        const statuses = [];
        for (let i = 0; i < 5; i += 1) statuses.push((await client.post(`/api/proxies/${id}/test`, {})).status);
        assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
      } finally {
        await limited.stop();
      }
    });
  });

  it('sem TOKEN_ENCRYPTION_KEY não é possível cadastrar (503) e nada é gravado', async () => {
    const noKey = await startTestServer({ limits: LIMITS, config: { tiktok: { apiBase: 'https://business-api.tiktok.com', encryptionKey: null, configured: false, oauth: { enabled: false } } }, fetchFn: fake.fetchFn, isolated: true });
    try {
      const { client } = await createUser(noKey, { approve: true });
      const res = await client.post('/api/proxies', input());
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'proxy_not_configured');
      assert.equal((await client.get('/api/proxies')).json.configured, false);
    } finally {
      await noKey.stop();
    }
  });
});
