import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createLevelService } from '../src/modules/profile/level.service.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { tiktokTestConfig } from './fake-tiktok.js';
import { createUser, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000, profileRead: 1000, tiktokRead: 1000 };
let counter = 0;
const emailOf = () => `lvl${++counter}@example.com`;
const silent = { warn() {}, error() {}, info() {}, log() {} };

/** Cobrança falsa: dólar vale 1, EUR vale 2, qualquer outra moeda não tem cotação. */
const fakeBilling = (ledger = []) => {
  const convert = (rows) => {
    let cents = 0;
    const unconverted = [];
    for (const r of rows) {
      const rate = { USD: 1, EUR: 2 }[r.currency];
      if (rate === undefined) unconverted.push({ currency: r.currency, spend: r.spend });
      else cents += Math.round(r.spend * rate * 100);
    }
    return { spendCents: cents, unconverted };
  };
  return { toUsd: async (rows) => convert(rows), lifetimeSpend: async () => convert(ledger) };
};

describe('Nível de gasto: o serviço soma o relatório do TikTok e o livro permanente (vale o maior)', () => {
  const account = (spend, currency = 'USD') => ({ spend, currency });
  const make = ({ accounts = {}, ledger = [], fail = false } = {}) =>
    createLevelService({ spend: async () => { if (fail) throw new Error('TikTok fora do ar'); return { accounts }; }, billing: fakeBilling(ledger), log: silent });

  it('soma as contas do relatório em dólar e converte as outras moedas pela cotação', async () => {
    const out = await make({ accounts: { '1:100': account(600), '1:101': account(200), '2:102': account(100, 'EUR') } }).forOwner({ id: 1 });
    assert.equal(out.spendUsd, 1000);
    assert.equal(out.level, 2, 'US$ 1.000 já é o nível 2');
    assert.equal(out.progress, 0);
    assert.equal(out.partial, false);
  });

  it('a mesma conta conectada por duas BCs conta uma vez só (vale o maior valor)', async () => {
    const out = await make({ accounts: { '1:100': account(400), '2:100': account(500), '2:200': account(10) } }).forOwner({ id: 1 });
    assert.equal(out.spendUsd, 510);
    assert.equal(out.level, 1);
  });

  it('o livro permanente segura o nível quando a BC foi removida (relatório vazio)', async () => {
    const out = await make({ ledger: [{ currency: 'USD', spend: 12_000 }] }).forOwner({ id: 1 });
    assert.deepEqual([out.spendUsd, out.level], [12_000, 3]);
  });

  it('nunca soma as duas fontes (seria contar o mesmo gasto duas vezes): vale a maior', async () => {
    const out = await make({ accounts: { '1:100': account(5_000) }, ledger: [{ currency: 'USD', spend: 4_000 }] }).forOwner({ id: 1 });
    assert.equal(out.spendUsd, 5_000);
  });

  it('TikTok fora do ar: o nível sai do livro e avisa que está parcial, sem quebrar', async () => {
    const out = await make({ fail: true, ledger: [{ currency: 'USD', spend: 2_000 }] }).forOwner({ id: 1 });
    assert.deepEqual([out.spendUsd, out.level, out.partial], [2_000, 2, true]);
  });

  it('moeda sem cotação não entra na conta e é avisada', async () => {
    const out = await make({ accounts: { '1:100': account(300), '1:101': account(9_000, 'BRL') } }).forOwner({ id: 1 });
    assert.equal(out.spendUsd, 300);
    assert.deepEqual(out.unconverted, [{ currency: 'BRL', spend: 9_000 }]);
  });

  it('ignora contas com erro, sem moeda ou com valor estranho', async () => {
    const out = await make({ accounts: { '1:1': { error: 'x', spend: 9_999_999, currency: 'USD' }, '1:2': { spend: 9_999_999 }, '1:3': { spend: 'abc', currency: 'USD' }, '1:4': null, '1:5': account(50) } }).forOwner({ id: 1 });
    assert.equal(out.spendUsd, 50);
  });

  it('vai ao último nível e para nele', async () => {
    const out = await make({ ledger: [{ currency: 'USD', spend: 300_000_000 }] }).forOwner({ id: 1 });
    assert.deepEqual([out.level, out.progress, out.isMax, out.remaining], [13, 1, true, 0]);
  });
});

describe('GET /api/profile/level: só o dono do espaço, com o gasto vindo do servidor', () => {
  let ctx;
  let mailer;
  before(async () => {
    mailer = createFakeMailer();
    ctx = await startTestServer({ limits: LIMITS, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, mailer });
  });
  after(() => ctx.stop());
  const seed = (who, hour, spend, currency = 'USD') => run(ctx.db, 'INSERT INTO spend_ledger (owner_id, advertiser_id, hour_start, currency, spend) VALUES ($1, $2, $3, $4, $5)', [who.id, '9001', hour, currency, spend]);

  it('exige login', async () => {
    assert.equal((await ctx.client().get('/api/profile/level')).status, 401);
  });

  it('dono sem gasto: nível 1, barra vazia', async () => {
    const owner = await createUser(ctx, { approve: true, name: 'Ana', email: emailOf() });
    const res = await owner.client.get('/api/profile/level');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.level, { spendUsd: 0, level: 1, progress: 0, remaining: 1000, isMax: false, unconverted: [], partial: false });
  });

  it('dono com gasto no livro: o nível sobe (US$ 25 mil = nível 3, metade da faixa não, 37,5%)', async () => {
    const owner = await createUser(ctx, { approve: true, name: 'Bia', email: emailOf() });
    await seed(owner, '2026-01-01T10:00:00Z', 25_000);
    const { level } = (await owner.client.get('/api/profile/level')).json;
    assert.deepEqual([level.spendUsd, level.level, level.isMax], [25_000, 3, false]);
    assert.equal(level.progress, 0.375);
  });

  it('cada dono vê só o próprio gasto', async () => {
    const a = await createUser(ctx, { approve: true, name: 'Cris', email: emailOf() });
    const b = await createUser(ctx, { approve: true, name: 'Davi', email: emailOf() });
    await seed(a, '2026-01-01T10:00:00Z', 60_000);
    assert.equal((await a.client.get('/api/profile/level')).json.level.level, 4);
    assert.equal((await b.client.get('/api/profile/level')).json.level.level, 1);
  });

  it('colaborador NÃO vê o gasto do dono: recebe level nulo', async () => {
    const owner = await createUser(ctx, { approve: true, name: 'Eva', email: emailOf() });
    await seed(owner, '2026-01-01T10:00:00Z', 80_000);
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Fábio Colaborador', areas: ['creatives'] });
    const client = ctx.client();
    const accepted = await client.post('/api/invitations/accept', { token: mailer.tokenFrom(mailer.lastTo(email)), password: 'SenhaDoColaborador-12' });
    client.csrf = accepted.json.csrfToken;
    const res = await client.get('/api/profile/level');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { level: null });
    assert.doesNotMatch(JSON.stringify(res.json), /80000/);
  });
});
