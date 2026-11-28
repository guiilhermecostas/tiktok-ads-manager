import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { accountHealth, isActiveAccount, matchesAccountFilter } from '../shared/account-labels.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { all, createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, assistantRead: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
let counter = 0;
const emailOf = () => `as${++counter}@example.com`;
const account = (extra = {}) => ({ id: '9001', businessCenterStatus: 'active', accountStatus: null, ...extra });

describe('Situação da conta de anúncio (regras compartilhadas)', () => {
  it('juntando o acesso da conexão e a situação da conta no TikTok: selo, tom e se conta como ativa', () => {
    const cases = [
      [account({ accountStatus: 'STATUS_ENABLE' }), ['active', 'Ativa', 'success'], true],
      [account({ accountStatus: 'STATUS_DISABLE' }), ['inactive', 'Encerrada', 'danger'], false],
      [account({ accountStatus: 'STATUS_LIMIT' }), ['inactive', 'Punida pelo TikTok', 'danger'], false],
      [account({ accountStatus: 'STATUS_CONFIRM_FAIL' }), ['inactive', 'Reprovada na análise', 'danger'], false],
      [account({ accountStatus: 'STATUS_PENDING_CONFIRM' }), ['pending', 'Em análise', 'warning'], false],
      [account({ accountStatus: 'STATUS_CONTRACT_PENDING' }), ['pending', 'Contrato ainda não vigora', 'warning'], false],
      [account({ accountStatus: null }), ['unknown', 'Sem informação', 'neutral'], true],
      [account({ businessCenterStatus: 'error', accountStatus: 'STATUS_ENABLE' }), ['error', 'Acesso com erro', 'danger'], false],
      [account({ businessCenterStatus: 'error', accountStatus: 'STATUS_DISABLE' }), ['error', 'Acesso com erro', 'danger'], false],
    ];
    for (const [input, [key, label, tone], active] of cases) {
      const health = accountHealth(input);
      assert.deepEqual([health.key, health.label, health.tone], [key, label, tone], JSON.stringify(input));
      assert.equal(isActiveAccount(input), active, JSON.stringify(input));
    }
  });

  it('um status que o sistema não conhece aparece de forma legível e conta como não ativo (nunca quebra a tela)', () => {
    const health = accountHealth(account({ accountStatus: 'STATUS_ALGO_NOVO' }));
    assert.equal(health.key, 'pending');
    assert.equal(health.label, 'algo novo');
  });

  it('o filtro "ativas/inativas" usa a situação da conta, não só o acesso da conexão', () => {
    const list = [account({ id: '1', accountStatus: 'STATUS_ENABLE' }), account({ id: '2', accountStatus: 'STATUS_DISABLE' }), account({ id: '3' }), account({ id: '4', businessCenterStatus: 'error' }), account({ id: '5', accountStatus: 'STATUS_LIMIT' })];
    const ids = (status) => list.filter((a) => matchesAccountFilter(a, { status })).map((a) => a.id);
    assert.deepEqual(ids('all'), ['1', '2', '3', '4', '5']);
    assert.deepEqual(ids('active'), ['1', '3'], 'ativa + ainda sem situação lida');
    assert.deepEqual(ids('inactive'), ['2', '4', '5'], 'encerrada, conexão com erro e punida');
  });
});

describe('Atualizar a conexão lê e mostra a situação das contas (API)', () => {
  let ctx;
  let fake;
  before(async () => {
    fake = createFakeTiktok();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer: createFakeMailer(), monitorStatuses: true });
  });
  after(() => ctx.stop());

  async function owner() {
    const user = await createUser(ctx, { approve: true, email: emailOf() });
    fake.state.bcs = { 111: ['9001', '9002', '9003'], 222: ['9101'] };
    fake.state.advertiserStatus = {};
    fake.state.rejectFields = false;
    fake.state.calls.length = 0;
    return user;
  }
  const connect = async (user, bcId = '111') => (await user.client.post('/api/tiktok/business-centers', { name: `BC ${bcId}`, bcId, accessToken: GOOD_TOKEN })).json.businessCenter;
  const advertisers = async (user) => Object.fromEntries((await user.client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => [a.id, a]));
  const sync = (user, bc) => user.client.post(`/api/tiktok/business-centers/${bc.id}/sync`, {});

  it('ao conectar, a situação de cada conta já vem junto (nada de "sem informação" até a coleta por hora)', async () => {
    const user = await owner();
    fake.state.advertiserStatus = { 9002: 'STATUS_DISABLE' };
    const bc = await connect(user);
    assert.equal(bc.inactiveCount, 1);
    const list = await advertisers(user);
    assert.deepEqual([list[9001].accountStatus, list[9002].accountStatus, list[9003].accountStatus], ['STATUS_ENABLE', 'STATUS_DISABLE', 'STATUS_ENABLE']);
    assert.ok(list[9002].accountStatusSince && list[9002].accountStatusCheckedAt, 'desde quando e quando foi lida');
  });

  it('"Atualizar" (sync) relê a situação: a conta que caiu aparece, a que voltou deixa de aparecer, e o cartão conta as inativas', async () => {
    const user = await owner();
    const bc = await connect(user);
    assert.equal(bc.inactiveCount, 0);
    fake.state.advertiserStatus = { 9001: 'STATUS_LIMIT', 9003: 'STATUS_PENDING_CONFIRM' };
    const res = await sync(user, bc);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.businessCenter.inactiveCount, 2, 'a resposta já traz a contagem (a tela mostra no aviso)');
    let list = await advertisers(user);
    assert.deepEqual([list[9001].accountStatus, list[9002].accountStatus, list[9003].accountStatus], ['STATUS_LIMIT', 'STATUS_ENABLE', 'STATUS_PENDING_CONFIRM']);
    const card = (await user.client.get('/api/tiktok/business-centers')).json.businessCenters.find((b) => b.id === bc.id);
    assert.equal(card.inactiveCount, 2, 'o cartão da conexão traz a contagem');
    fake.state.advertiserStatus = {};
    await sync(user, bc);
    list = await advertisers(user);
    assert.equal(list[9001].accountStatus, 'STATUS_ENABLE', 'voltou a ativa');
    assert.equal((await user.client.get('/api/tiktok/business-centers')).json.businessCenters[0].inactiveCount, 0);
  });

  it('a data "desde" só muda quando a situação muda; "lida em" muda a cada leitura', async () => {
    const user = await owner();
    const bc = await connect(user);
    const first = (await advertisers(user))[9001];
    await new Promise((resolve) => { setTimeout(resolve, 30); });
    await sync(user, bc);
    const second = (await advertisers(user))[9001];
    assert.equal(second.accountStatusSince, first.accountStatusSince, 'continua ativa: mesma data de início');
    assert.notEqual(second.accountStatusCheckedAt, first.accountStatusCheckedAt, 'foi lida de novo');
  });

  it('a queda vista ao atualizar vira evento para o assistente ("contas que caíram"), sem esperar a coleta de 30 minutos', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.advertiserStatus = { 9002: 'STATUS_DISABLE' };
    await sync(user, bc);
    const range = `from=${encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3_600_000).toISOString())}`;
    const res = await user.client.get(`/api/assistant/accounts-down?${range}`);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.current.map((c) => [c.advertiserId, c.status]), [['9002', 'STATUS_DISABLE']]);
  });

  it('status inválido ou ausente é ignorado (nada fora do padrão entra no banco) e não impede a atualização', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.advertiserStatus = { 9001: 'banida!', 9002: '', 9003: 'STATUS_LIMIT' };
    assert.equal((await sync(user, bc)).status, 200);
    const list = await advertisers(user);
    assert.equal(list[9001].accountStatus, 'STATUS_ENABLE', 'a leitura inválida não apagou nem trocou o que já se sabia');
    assert.equal(list[9003].accountStatus, 'STATUS_LIMIT');
    const stored = await all(ctx.db, "SELECT DISTINCT status FROM advertiser_status WHERE status !~ '^STATUS_[A-Z_]+$'");
    assert.equal(stored.length, 0);
  });

  it('se o TikTok recusar o pedido com campos, a leitura sem campos ainda traz a situação', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.rejectFields = true;
    fake.state.advertiserStatus = { 9001: 'STATUS_DISABLE' };
    assert.equal((await sync(user, bc)).status, 200);
    assert.equal((await advertisers(user))[9001].accountStatus, 'STATUS_DISABLE');
    fake.state.rejectFields = false;
  });

  it('cada pessoa vê só a situação das próprias contas; BC compartilhada mostra a situação lida pelo dono', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.advertiserStatus = { 9001: 'STATUS_DISABLE' };
    await sync(user, bc);
    const stranger = await createUser(ctx, { approve: true, email: emailOf() });
    assert.deepEqual(await advertisers(stranger), {}, 'quem não tem acesso não vê nada');
    await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = true WHERE id = $1', [bc.id]);
    try {
      const seen = await advertisers(stranger);
      assert.equal(seen[9001].accountStatus, 'STATUS_DISABLE', 'compartilhada: mesma situação');
      assert.equal((await stranger.client.get('/api/tiktok/business-centers')).json.businessCenters[0].inactiveCount, 1);
    } finally {
      await run(ctx.db, 'UPDATE tiktok_business_centers SET shared = false WHERE id = $1', [bc.id]); // não deixa a BC compartilhada para os outros testes
    }
  });

  it('removendo a conexão a lista some; reconectar começa de novo sem herdar o status antigo errado', async () => {
    const user = await owner();
    const bc = await connect(user);
    fake.state.advertiserStatus = { 9001: 'STATUS_DISABLE' };
    await sync(user, bc);
    await user.client.delete(`/api/tiktok/business-centers/${bc.id}`);
    assert.deepEqual(await advertisers(user), {});
    fake.state.advertiserStatus = {};
    await connect(user);
    assert.equal((await advertisers(user))[9001].accountStatus, 'STATUS_ENABLE', 'a leitura nova vale');
  });

  it('exige login', async () => {
    assert.equal((await ctx.client().get('/api/tiktok/advertisers')).status, 401);
  });
});
