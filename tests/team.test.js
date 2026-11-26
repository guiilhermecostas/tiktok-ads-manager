import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { ALL_AREAS, MAX_TEAM_SIZE } from '../shared/permissions.js';
import { MAIL_CONFIG, createFakeMailer } from './fake-mailer.js';
import { GOOD_TOKEN, createFakeTiktok, tiktokTestConfig } from './fake-tiktok.js';
import { USER_PASSWORD, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';
import { uploadedId } from './media-fixtures.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, tiktokRead: 1000, tiktokWrite: 1000, campaignPublish: 1000, creativesRead: 1000, creativesWrite: 1000, teamRead: 1000, teamWrite: 1000, teamInvite: 1000, inviteLookup: 1000, inviteAccept: 1000 };
const COLLAB_PASSWORD = 'SenhaDoColaborador-12';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
let counter = 0;
const emailOf = (prefix = 'colab') => `${prefix}${++counter}@example.com`;

function setup(extra = {}) {
  const fake = createFakeTiktok();
  const mailer = createFakeMailer();
  const server = startTestServer({ limits: { ...LIMITS, ...extra.limits }, config: { ...tiktokTestConfig(), mail: MAIL_CONFIG }, fetchFn: fake.fetchFn, mailer });
  return { fake, mailer, server };
}

/** Convida, lê o token do e-mail e aceita: devolve o cliente já logado do colaborador. */
async function addCollaborator(ctx, mailer, owner, areas, { email = emailOf(), name = 'Maria Colaboradora' } = {}) {
  const invited = await owner.client.post('/api/team/invites', { email, name, areas });
  assert.equal(invited.status, 201, invited.text);
  const token = mailer.tokenFrom(mailer.lastTo(email));
  const client = ctx.client();
  const accepted = await client.post('/api/invitations/accept', { token, password: COLLAB_PASSWORD });
  assert.equal(accepted.status, 201, accepted.text);
  client.csrf = accepted.json.csrfToken;
  return { client, email, token, inviteId: invited.json.invite.id, member: (await owner.client.get('/api/team')).json.members.find((m) => m.email === email) };
}

describe('Colaboradores: convites por e-mail', () => {
  let ctx;
  let mailer;
  let fake;
  before(async () => {
    const built = setup();
    ctx = await built.server;
    mailer = built.mailer;
    fake = built.fake;
  });
  after(() => ctx.stop());
  const newOwner = () => createUser(ctx, { approve: true, name: 'Lucas Dono', email: emailOf('dono') });

  it('o dono convida por e-mail; o e-mail traz o link com o token no fragmento; o banco guarda só o hash', async () => {
    const owner = await newOwner();
    const email = emailOf();
    const res = await owner.client.post('/api/team/invites', { email: email.toUpperCase(), name: 'Maria  Silva', areas: ['campaigns', 'creatives'] });
    assert.equal(res.status, 201);
    assert.equal(res.json.emailSent, true);
    assert.deepEqual({ email: res.json.invite.email, name: res.json.invite.name, areas: res.json.invite.areas }, { email, name: 'Maria Silva', areas: ['creatives', 'campaigns'] }, 'e-mail em minúsculas, nome normalizado, áreas na ordem do sistema');

    const sent = mailer.lastTo(email);
    assert.ok(sent, 'e-mail enviado ao convidado');
    assert.match(sent.subject, /Lucas Dono convidou você/);
    assert.match(sent.text, /^.*https:\/\/app\.example\.com\/invite#[A-Za-z0-9_-]{43}$/m);
    assert.ok(sent.html.includes('Criativos') && sent.html.includes('Campanhas') && !sent.html.includes('Relatórios'));
    const token = mailer.tokenFrom(sent);
    assert.ok(token);

    const row = await one(ctx.db, 'SELECT * FROM workspace_invites WHERE lower(email) = $1', [email]);
    assert.equal(row.token_hash, sha256(token), 'só o hash SHA-256 fica no banco');
    assert.ok(!JSON.stringify(row).includes(token), 'o token em si não está em nenhuma coluna');
    const list = await owner.client.get('/api/team');
    assert.ok(!list.text.includes(token) && !list.text.includes(sha256(token)), 'a listagem nunca devolve token nem hash');
    assert.equal(list.json.invites.some((i) => i.email === email), true);
    assert.deepEqual(Object.keys(list.json.invites[0]).sort(), ['areas', 'createdAt', 'email', 'expiresAt', 'id', 'name']);
  });

  it('a pessoa convidada vê o convite, define a PRÓPRIA senha e entra; o convite é de uso único', async () => {
    const owner = await newOwner();
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Ana', areas: ['reports'] });
    const token = mailer.tokenFrom(mailer.lastTo(email));

    const anon = ctx.client();
    const look = await anon.post('/api/invitations/lookup', { token });
    assert.equal(look.status, 200);
    assert.deepEqual(look.json.invitation, { ownerName: 'Lucas Dono', name: 'Ana', email, areas: ['reports'], expiresAt: look.json.invitation.expiresAt });

    assert.equal((await anon.post('/api/invitations/accept', { token, password: 'curta' })).status, 400, 'senha fraca recusa sem gastar o convite');
    assert.equal((await anon.post('/api/invitations/lookup', { token })).status, 200, 'o convite continua valendo');

    const accepted = await anon.post('/api/invitations/accept', { token, name: 'Ana Souza', password: COLLAB_PASSWORD });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.headers.get('cache-control'), 'no-store');
    assert.ok(accepted.setCookies.some((c) => c.startsWith('tt_sid=') && /HttpOnly/i.test(c) && /SameSite=Strict/i.test(c)), 'cookie de sessão seguro');
    assert.deepEqual({ name: accepted.json.user.name, email: accepted.json.user.email, status: accepted.json.user.status, role: accepted.json.user.role }, { name: 'Ana Souza', email, status: 'approved', role: 'user' });
    assert.deepEqual(accepted.json.workspace, { isOwner: false, ownerName: 'Lucas Dono', areas: ['reports'] });
    assert.ok(accepted.json.csrfToken && !('password_hash' in accepted.json.user) && !accepted.text.includes('hash'));

    // uso único
    assert.equal((await ctx.client().post('/api/invitations/accept', { token, password: COLLAB_PASSWORD })).status, 404);
    assert.equal((await ctx.client().post('/api/invitations/lookup', { token })).status, 404);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_invites WHERE lower(email) = $1', [email])).c, 0, 'convite apagado ao aceitar');

    // depois, entra normalmente com o próprio e-mail e senha
    const again = ctx.client();
    const login = await again.login(email, COLLAB_PASSWORD);
    assert.equal(login.status, 200);
    assert.deepEqual(login.json.workspace, { isOwner: false, ownerName: 'Lucas Dono', areas: ['reports'] });
    const me = await again.get('/api/auth/me');
    assert.equal(me.json.user.email, email);
    assert.deepEqual(me.json.workspace.areas, ['reports']);
  });

  it('aceitar o convite estando logado em outra conta encerra a sessão anterior (anti session-fixation)', async () => {
    const owner = await newOwner();
    const someone = await createUser(ctx, { approve: true, email: emailOf('logado') });
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Joana', areas: ['creatives'] });
    const token = mailer.tokenFrom(mailer.lastTo(email));
    const oldCookie = someone.client.cookie;
    assert.ok(oldCookie);
    const res = await someone.client.post('/api/invitations/accept', { token, password: COLLAB_PASSWORD });
    assert.equal(res.status, 201);
    assert.notEqual(someone.client.cookie, oldCookie, 'cookie novo');
    const stale = await fetch(`${ctx.baseUrl}/api/auth/me`, { headers: { cookie: oldCookie } });
    assert.equal((await stale.json()).user, null, 'a sessão anterior não vale mais');
    assert.equal((await someone.client.get('/api/auth/me')).json.user.email, email);
  });

  it('o dono comum tem todas as áreas no /me e nunca aparece como colaborador', async () => {
    const owner = await newOwner();
    const me = await owner.client.get('/api/auth/me');
    assert.deepEqual(me.json.workspace, { isOwner: true, ownerName: null, areas: ALL_AREAS });
    assert.deepEqual((await ctx.client().get('/api/auth/me')).json, { user: null, workspace: null, csrfToken: null });
  });

  it('token inexistente, mal formado ou expirado recebe sempre a mesma resposta; expirado não aceita', async () => {
    const owner = await newOwner();
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Bia', areas: ['creatives'] });
    const token = mailer.tokenFrom(mailer.lastTo(email));
    const anon = ctx.client();
    const unknown = await anon.post('/api/invitations/lookup', { token: 'A'.repeat(43) });
    assert.equal(unknown.status, 404);
    await run(ctx.db, "UPDATE workspace_invites SET expires_at = now() - interval '1 minute' WHERE lower(email) = $1", [email]);
    const expired = await anon.post('/api/invitations/lookup', { token });
    assert.equal(expired.status, 404);
    assert.equal(expired.json.error.message, unknown.json.error.message, 'não revela se o convite existiu');
    assert.equal((await anon.post('/api/invitations/accept', { token, password: COLLAB_PASSWORD })).status, 404);
    for (const bad of [undefined, null, '', 'curto', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, 123, ['A'.repeat(43)], { a: 1 }]) {
      assert.equal((await anon.post('/api/invitations/lookup', { token: bad })).status, 400, JSON.stringify(bad));
    }
    assert.equal((await anon.post('/api/invitations/lookup', [])).status, 400);
    assert.equal((await anon.post('/api/invitations/accept', { password: COLLAB_PASSWORD })).status, 400);
  });

  it('e-mail que já tem conta: o aceite falha com aviso e o convite NÃO é gasto', async () => {
    const owner = await newOwner();
    const existing = await createUser(ctx, { approve: true, email: emailOf('existente') });
    await owner.client.post('/api/team/invites', { email: existing.email, name: 'Já tem conta', areas: ['creatives'] });
    const token = mailer.tokenFrom(mailer.lastTo(existing.email));
    const res = await ctx.client().post('/api/invitations/accept', { token, password: COLLAB_PASSWORD });
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, 'email_taken');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_invites WHERE lower(email) = $1', [existing.email])).c, 1);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_members')).c >= 0, true);
    assert.equal((await existing.client.get('/api/auth/me')).json.workspace.isOwner, true, 'a conta existente não vira colaboradora');
  });

  it('convidar de novo o mesmo e-mail substitui o convite: o link antigo morre e fica um só', async () => {
    const owner = await newOwner();
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Carla', areas: ['creatives'] });
    const first = mailer.tokenFrom(mailer.lastTo(email));
    await owner.client.post('/api/team/invites', { email, name: 'Carla', areas: ['campaigns', 'reports'] });
    const second = mailer.tokenFrom(mailer.lastTo(email));
    assert.notEqual(first, second);
    assert.equal((await ctx.client().post('/api/invitations/lookup', { token: first })).status, 404);
    const look = await ctx.client().post('/api/invitations/lookup', { token: second });
    assert.deepEqual(look.json.invitation.areas, ['campaigns', 'reports']);
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_invites WHERE lower(email) = $1', [email])).c, 1);
  });

  it('reenviar gera link novo (o antigo deixa de valer) e renova a validade; cancelar invalida', async () => {
    const owner = await newOwner();
    const email = emailOf();
    const { json } = await owner.client.post('/api/team/invites', { email, name: 'Duda', areas: ['accounts'] });
    const old = mailer.tokenFrom(mailer.lastTo(email));
    await run(ctx.db, "UPDATE workspace_invites SET expires_at = now() + interval '1 hour' WHERE id = $1", [json.invite.id]);
    const resent = await owner.client.post(`/api/team/invites/${json.invite.id}/resend`, {});
    assert.equal(resent.status, 200);
    assert.equal(resent.json.emailSent, true);
    const fresh = mailer.tokenFrom(mailer.lastTo(email));
    assert.notEqual(old, fresh);
    assert.equal((await ctx.client().post('/api/invitations/lookup', { token: old })).status, 404);
    assert.ok(new Date(resent.json.invite.expiresAt).getTime() > Date.now() + 6 * 24 * 3600 * 1000, 'validade renovada (7 dias)');

    assert.equal((await owner.client.delete(`/api/team/invites/${json.invite.id}`)).status, 204);
    assert.equal((await ctx.client().post('/api/invitations/lookup', { token: fresh })).status, 404);
    assert.equal((await owner.client.delete(`/api/team/invites/${json.invite.id}`)).status, 404);
    assert.equal((await owner.client.post(`/api/team/invites/${json.invite.id}/resend`, {})).status, 404);
  });

  it('se o e-mail falhar o convite fica salvo (emailSent:false) e "Reenviar" resolve quando o serviço volta', async () => {
    const owner = await newOwner();
    const email = emailOf();
    mailer.state.fail = true;
    const res = await owner.client.post('/api/team/invites', { email, name: 'Eva', areas: ['creatives'] });
    assert.equal(res.status, 201);
    assert.equal(res.json.emailSent, false);
    const resendFail = await owner.client.post(`/api/team/invites/${res.json.invite.id}/resend`, {});
    assert.equal(resendFail.status, 502, 'reenvio que falha avisa o dono');
    assert.ok(!resendFail.text.includes('re_'), 'nada da chave no erro');
    mailer.state.fail = false;
    assert.equal((await owner.client.post(`/api/team/invites/${res.json.invite.id}/resend`, {})).json.emailSent, true);
    assert.ok(mailer.tokenFrom(mailer.lastTo(email)));
  });

  it('sem e-mail configurado no servidor: 503 claro e nada é criado', async () => {
    const owner = await newOwner();
    mailer.enabled = false;
    try {
      const res = await owner.client.post('/api/team/invites', { email: emailOf(), name: 'Fábio', areas: ['creatives'] });
      assert.equal(res.status, 503);
      assert.equal(res.json.error.code, 'email_not_configured');
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM workspace_invites WHERE owner_id = $1', [owner.id])).c, 0);
      assert.equal((await owner.client.get('/api/team')).json.emailEnabled, false);
    } finally {
      mailer.enabled = true;
    }
  });

  it('valida o convite: e-mail, nome, áreas; não convida a si mesmo nem o admin nem quem já é colaborador', async () => {
    const owner = await newOwner();
    const post = (body) => owner.client.post('/api/team/invites', body);
    const ok = { email: emailOf(), name: 'Gabi', areas: ['creatives'] };
    for (const bad of [
      { ...ok, email: 'sem-arroba' }, { ...ok, email: undefined }, { ...ok, name: '' }, { ...ok, name: 'A' }, { ...ok, name: 'x\u0000y' },
      { ...ok, areas: [] }, { ...ok, areas: undefined }, { ...ok, areas: 'creatives' }, { ...ok, areas: ['admin'] }, { ...ok, areas: ['creatives', 'admin'] },
      { ...ok, areas: ['__proto__'] }, { ...ok, areas: [1] }, { ...ok, areas: [...ALL_AREAS, 'creatives'] }, { ...ok, areas: { 0: 'creatives' } },
    ]) assert.equal((await post(bad)).status, 400, JSON.stringify(bad));
    assert.equal((await owner.client.post('/api/team/invites', [])).status, 400);
    assert.equal((await post({ ...ok, email: owner.email })).status, 400, 'não convida o próprio e-mail');
    assert.equal((await post({ ...ok, email: 'contato.guilhermecostas@gmail.com' })).status, 400, 'nem o e-mail do admin');
    assert.equal((await post({ ...ok, areas: ['creatives', 'creatives'] })).json.invite.areas.length, 1, 'repetição vira uma só');
    const member = await addCollaborator(ctx, mailer, owner, ['creatives']);
    assert.equal((await post({ ...ok, email: member.email })).status, 409, 'já é colaborador');
    assert.equal((await owner.client.post('/api/team/invites', { ...ok, email: emailOf(), areas: ALL_AREAS })).status, 201, 'acesso total');
  });

  it('limite de colaboradores + convites pendentes por conta', async () => {
    const owner = await newOwner();
    for (let i = 0; i < MAX_TEAM_SIZE; i += 1) {
      await run(ctx.db, "INSERT INTO workspace_invites (owner_id, email, name, areas, token_hash, expires_at) VALUES ($1, $2, 'X', ARRAY['creatives'], $3, now() + interval '1 day')", [owner.id, `lote${i}-${owner.id}@example.com`, `hash-${owner.id}-${i}`]);
    }
    const res = await owner.client.post('/api/team/invites', { email: emailOf(), name: 'Um a mais', areas: ['creatives'] });
    assert.equal(res.status, 400);
    assert.match(res.json.error.message, /Limite/);
    // reconvidar quem já está na lista continua permitido (substitui, não aumenta)
    assert.equal((await owner.client.post('/api/team/invites', { email: `lote0-${owner.id}@example.com`, name: 'Xx', areas: ['reports'] })).status, 201);
  });

  it('aceitar convite de dono bloqueado não funciona', async () => {
    const owner = await newOwner();
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Hugo', areas: ['creatives'] });
    const token = mailer.tokenFrom(mailer.lastTo(email));
    await run(ctx.db, "UPDATE users SET status = 'blocked' WHERE id = $1", [owner.id]);
    assert.equal((await ctx.client().post('/api/invitations/lookup', { token })).status, 404);
    assert.equal((await ctx.client().post('/api/invitations/accept', { token, password: COLLAB_PASSWORD })).status, 404);
  });

  it('dois aceites simultâneos do mesmo convite: só um vence', async () => {
    const owner = await newOwner();
    const email = emailOf();
    await owner.client.post('/api/team/invites', { email, name: 'Iara', areas: ['creatives'] });
    const token = mailer.tokenFrom(mailer.lastTo(email));
    const results = await Promise.all([1, 2, 3].map(() => ctx.client().post('/api/invitations/accept', { token, password: COLLAB_PASSWORD })));
    assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join(','));
    assert.ok(results.every((r) => [201, 404, 409, 500].includes(r.status)));
    assert.equal(results.filter((r) => r.status === 500).length, 0, 'nunca 500');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM users WHERE lower(email) = $1', [email])).c, 1);
  });

  it('o dono só vê e altera a PRÓPRIA equipe', async () => {
    const a = await newOwner();
    const b = await newOwner();
    const member = await addCollaborator(ctx, mailer, a, ['creatives']);
    const invite = (await a.client.post('/api/team/invites', { email: emailOf(), name: 'Pendente', areas: ['reports'] })).json.invite;
    const listB = (await b.client.get('/api/team')).json;
    assert.deepEqual([listB.members, listB.invites], [[], []]);
    assert.equal((await b.client.patch(`/api/team/members/${member.member.id}`, { areas: ALL_AREAS })).status, 404);
    assert.equal((await b.client.delete(`/api/team/members/${member.member.id}`)).status, 404);
    assert.equal((await b.client.delete(`/api/team/invites/${invite.id}`)).status, 404);
    assert.equal((await b.client.post(`/api/team/invites/${invite.id}/resend`, {})).status, 404);
    assert.deepEqual((await a.client.get('/api/team')).json.members[0].areas, ['creatives'], 'nada mudou');
  });

  it('as rotas de equipe exigem login, token CSRF e conta aprovada', async () => {
    const owner = await newOwner();
    const anon = ctx.client();
    assert.equal((await anon.get('/api/team')).status, 401);
    assert.equal((await anon.post('/api/team/invites', { email: emailOf(), name: 'Zé', areas: ['creatives'] })).status, 401);
    const noCsrf = await owner.client.post('/api/team/invites', { email: emailOf(), name: 'Zé', areas: ['creatives'] }, { withCsrf: false });
    assert.equal(noCsrf.status, 403);
    const pending = await createUser(ctx, { approve: false });
    assert.equal((await pending.client.get('/api/team')).status, 403);
  });

  it('sanidade do TikTok falso: o ambiente de teste está isolado (nada foi enviado ao TikTok)', () => {
    assert.equal(fake.state.calls.length, 0);
  });
});

describe('Colaboradores: permissões por área e isolamento do espaço', () => {
  let ctx;
  let mailer;
  let fake;
  let owner;
  let advertiserId;
  let creativeId;
  before(async () => {
    const built = setup();
    ctx = await built.server;
    mailer = built.mailer;
    fake = built.fake;
    owner = await createUser(ctx, { approve: true, name: 'Lucas Dono', email: emailOf('dono') });
    fake.state.bcs = { 111: ['9001', '9002'] };
    const bc = await owner.client.post('/api/tiktok/business-centers', { name: 'BC do Dono', bcId: '111', accessToken: GOOD_TOKEN });
    assert.equal(bc.status, 201, bc.text);
    advertiserId = '9001';
    creativeId = await uploadedId(owner.client, { type: 'mp4', name: 'Vídeo do dono' });
  });
  after(() => ctx.stop());

  /** [método, caminho, corpo, área exigida para passar (ou 'owner' / 'admin')] */
  const ENDPOINTS = () => [
    ['GET', '/api/creatives', undefined, ['creatives', 'campaigns']],
    ['GET', `/api/creatives/${creativeId}`, undefined, ['creatives', 'campaigns']],
    ['PATCH', `/api/creatives/${creativeId}`, { name: 'Renomeado' }, ['creatives']],
    ['POST', '/api/creatives/tiktok', { name: 'ref', kind: 'video', advertiserId, tiktokId: 'v-1' }, ['creatives']],
    ['GET', '/api/campaigns', undefined, ['campaigns']],
    ['GET', '/api/campaigns/summary', undefined, ['campaigns']],
    ['GET', '/api/tiktok/advertisers', undefined, ['accounts', 'campaigns', 'reports']],
    ['GET', '/api/tiktok/overview?days=7', undefined, ['reports']],
    ['GET', `/api/tiktok/advertisers/${advertiserId}/report?days=7`, undefined, ['reports']],
    ['GET', `/api/tiktok/advertisers/${advertiserId}/campaigns`, undefined, ['reports']],
    ['GET', '/api/tiktok/business-centers', undefined, ['accounts']],
    ['POST', '/api/tiktok/connect', { name: 'Conexão' }, ['accounts']],
    ['PATCH', `/api/tiktok/business-centers/1/advertisers`, { advertiserIds: ['9001'], label: 'agency' }, ['accounts']],
    ['GET', '/api/proxies', undefined, ['accounts']],
    ['GET', '/api/team', undefined, ['owner']],
    ['POST', '/api/team/invites', { email: 'x@example.com', name: 'Xis', areas: ['creatives'] }, ['owner']],
    ['GET', '/api/admin/stats', undefined, ['admin']],
    ['GET', '/api/admin/users', undefined, ['admin']],
  ];

  async function statusOf(client, [method, url, body]) {
    const res = await client.request(method, url, { body });
    return res.status;
  }

  it('cada área libera SÓ as rotas dela (matriz completa); o resto devolve 403 "area_forbidden"', async () => {
    const combos = [['creatives'], ['campaigns'], ['reports'], ['accounts'], ['creatives', 'campaigns'], ['campaigns', 'reports', 'accounts']];
    for (const areas of combos) {
      const { client } = await addCollaborator(ctx, mailer, owner, areas);
      for (const endpoint of ENDPOINTS()) {
        const [method, url, , needs] = endpoint;
        const status = await statusOf(client, endpoint);
        const allowed = needs.some((n) => areas.includes(n));
        if (allowed) assert.ok(![401, 403].includes(status), `${areas} ${method} ${url} deveria passar, deu ${status}`);
        else assert.equal(status, 403, `${areas} ${method} ${url} deveria ser negado, deu ${status}`);
      }
    }
  });

  it('"Acesso total" libera todas as áreas, mas NUNCA a equipe nem a administração', async () => {
    const { client } = await addCollaborator(ctx, mailer, owner, ALL_AREAS);
    for (const endpoint of ENDPOINTS()) {
      const [method, url, , needs] = endpoint;
      const status = await statusOf(client, endpoint);
      if (needs[0] === 'owner' || needs[0] === 'admin') assert.equal(status, 403, `${method} ${url} deveria ser negado a colaborador, deu ${status}`);
      else assert.ok(![401, 403].includes(status), `${method} ${url} deu ${status}`);
    }
    const denied = await client.get('/api/team');
    assert.equal(denied.json.error.code, 'owner_only');
    assert.equal((await client.get('/api/admin/stats')).status, 403);
    assert.equal((await client.get('/api/campaigns')).json.error, undefined);
  });

  it('o colaborador trabalha no espaço do DONO: vê as contas e os criativos dele; o que cria pertence ao dono', async () => {
    const { client } = await addCollaborator(ctx, mailer, owner, ALL_AREAS);
    const seen = (await client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => a.id).sort();
    assert.deepEqual(seen, ['9001', '9002']);
    assert.ok((await client.get('/api/tiktok/advertisers')).json.advertisers.every((a) => a.canLabel === true));
    assert.ok((await client.get('/api/creatives')).json.creatives.some((c) => c.id === creativeId));
    const mine = await uploadedId(client, { type: 'png', name: 'Enviado pelo colaborador' });
    assert.ok((await owner.client.get('/api/creatives')).json.creatives.some((c) => c.id === mine), 'o dono enxerga o criativo enviado pelo colaborador');
    const row = await one(ctx.db, 'SELECT user_id FROM creatives WHERE id = $1', [mine]);
    assert.equal(row.user_id, owner.id, 'dados ficam na conta do dono');
    const draft = await client.post('/api/campaigns', { name: 'Rascunho do colaborador', objective: 'TRAFFIC' });
    if (draft.status === 201) assert.equal((await one(ctx.db, 'SELECT user_id FROM campaigns WHERE id = $1', [draft.json.campaign.id])).user_id, owner.id);
  });

  it('colaborador não enxerga o espaço de OUTRO dono (isolamento total)', async () => {
    const other = await createUser(ctx, { approve: true, email: emailOf('outro') });
    fake.state.bcs = { 111: ['9001', '9002'], 222: ['9101'] };
    await other.client.post('/api/tiktok/business-centers', { name: 'BC de outro', bcId: '222', accessToken: GOOD_TOKEN });
    const { client } = await addCollaborator(ctx, mailer, owner, ALL_AREAS);
    const ids = (await client.get('/api/tiktok/advertisers')).json.advertisers.map((a) => a.id);
    assert.ok(!ids.includes('9101'));
    assert.equal((await client.get('/api/tiktok/advertisers/9101/report?days=7')).status, 404);
    const otherCreative = await uploadedId(other.client, { type: 'png', name: 'Do outro' });
    assert.equal((await client.get(`/api/creatives/${otherCreative}`)).status, 404);
  });

  it('mudar as áreas vale NA HORA, sem novo login; remover a área derruba o acesso', async () => {
    const { client, member } = await addCollaborator(ctx, mailer, owner, ['creatives']);
    assert.equal((await client.get('/api/campaigns')).status, 403);
    const up = await owner.client.patch(`/api/team/members/${member.id}`, { areas: ['creatives', 'campaigns'] });
    assert.equal(up.status, 200);
    assert.deepEqual(up.json.member.areas, ['creatives', 'campaigns']);
    assert.equal((await client.get('/api/campaigns')).status, 200, 'liberado sem sair e entrar');
    assert.equal((await client.get('/api/auth/me')).json.workspace.areas.includes('campaigns'), true);
    await owner.client.patch(`/api/team/members/${member.id}`, { areas: ['creatives'] });
    assert.equal((await client.get('/api/campaigns')).status, 403, 'bloqueado de novo na hora');
    for (const bad of [{ areas: [] }, { areas: ['admin'] }, { areas: 'creatives' }, {}, { areas: undefined }]) assert.equal((await owner.client.patch(`/api/team/members/${member.id}`, bad)).status, 400, JSON.stringify(bad));
  });

  it('remover o colaborador derruba a sessão dele na hora, apaga a conta e libera o e-mail', async () => {
    const { client, member, email } = await addCollaborator(ctx, mailer, owner, ALL_AREAS);
    assert.equal((await client.get('/api/campaigns')).status, 200);
    assert.equal((await owner.client.delete(`/api/team/members/${member.id}`)).status, 204);
    assert.equal((await client.get('/api/campaigns')).status, 401, 'sessão encerrada');
    assert.equal((await ctx.client().login(email, COLLAB_PASSWORD)).status, 401, 'não entra mais');
    assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM users WHERE lower(email) = $1', [email])).c, 0);
    assert.equal((await owner.client.delete(`/api/team/members/${member.id}`)).status, 404);
    assert.equal((await owner.client.post('/api/team/invites', { email, name: 'De volta', areas: ['creatives'] })).status, 201, 'pode convidar de novo');
    // os dados do dono continuam intactos
    assert.ok((await owner.client.get('/api/creatives')).json.creatives.some((c) => c.id === creativeId));
  });

  it('dono bloqueado: o colaborador também perde o acesso (e o /me mostra "bloqueado")', async () => {
    const boss = await createUser(ctx, { approve: true, email: emailOf('chefe') });
    const { client } = await addCollaborator(ctx, mailer, boss, ['creatives']);
    assert.equal((await client.get('/api/creatives')).status, 200);
    await run(ctx.db, "UPDATE users SET status = 'blocked' WHERE id = $1", [boss.id]);
    const denied = await client.get('/api/creatives');
    assert.equal(denied.status, 403);
    assert.equal(denied.json.error.code, 'account_blocked');
    assert.equal((await client.get('/api/auth/me')).json.user.status, 'blocked');
    await run(ctx.db, "UPDATE users SET status = 'approved' WHERE id = $1", [boss.id]);
    assert.equal((await client.get('/api/creatives')).status, 200, 'volta ao normal quando o dono volta');
  });

  it('colaborador de um ADMIN não ganha poderes de admin nem vê as BCs dos outros usuários', async () => {
    const admin = await loginAdmin(ctx);
    fake.state.bcs = { 111: ['9001', '9002'], 333: ['9201'] };
    await admin.post('/api/tiktok/business-centers', { name: 'BC do admin', bcId: '333', accessToken: GOOD_TOKEN });
    const { client } = await addCollaborator(ctx, mailer, { client: admin }, ALL_AREAS);
    assert.equal((await client.get('/api/admin/users')).status, 403);
    assert.equal((await client.get('/api/team')).status, 403);
    const names = (await client.get('/api/tiktok/business-centers')).json.businessCenters.map((b) => b.name);
    assert.deepEqual(names, ['BC do admin'], 'só o espaço do admin, não a supervisão de todas as BCs');
    assert.equal((await admin.get('/api/tiktok/business-centers')).json.businessCenters.length >= 2, true, 'o admin continua vendo todas');
    assert.equal((await client.post('/api/tiktok/business-centers', { name: 'Compartilhar', bcId: '111', accessToken: GOOD_TOKEN, shared: true })).status, 403, 'colaborador não compartilha BC com a equipe');
  });

  it('o colaborador também precisa do token CSRF e da mesma origem para alterar', async () => {
    const { client } = await addCollaborator(ctx, mailer, owner, ['creatives']);
    const noCsrf = await client.request('PATCH', `/api/creatives/${creativeId}`, { body: { name: 'Sem CSRF' }, withCsrf: false });
    assert.equal(noCsrf.status, 403);
    const foreign = await client.request('PATCH', `/api/creatives/${creativeId}`, { body: { name: 'Outra origem' }, headers: { origin: 'https://evil.example' } });
    assert.equal(foreign.status, 403);
  });

  it('um colaborador não consegue se auto-promover trocando o próprio vínculo pela API', async () => {
    const { client, member } = await addCollaborator(ctx, mailer, owner, ['creatives']);
    assert.equal((await client.patch(`/api/team/members/${member.id}`, { areas: ALL_AREAS })).status, 403);
    assert.equal((await client.post('/api/team/invites', { email: emailOf(), name: 'Amigo', areas: ALL_AREAS })).status, 403);
    assert.equal((await client.request('POST', '/api/auth/register', { body: { name: 'Outro', email: emailOf(), password: USER_PASSWORD } })).status, 200, 'registro público segue igual (primeira etapa: manda o código; a conta só nasce ao confirmar)');
    assert.deepEqual((await owner.client.get('/api/team')).json.members.find((m) => m.id === member.id).areas, ['creatives']);
  });
});

describe('Colaboradores: limites de uso (anti-abuso)', () => {
  let ctx;
  let mailer;
  before(async () => {
    const built = setup({ limits: { teamInvite: 2, inviteLookup: 3, inviteAccept: 2 } });
    ctx = await built.server;
    mailer = built.mailer;
  });
  after(() => ctx.stop());

  it('limita quantos e-mails de convite cada conta envia por hora', async () => {
    const owner = await createUser(ctx, { approve: true, email: emailOf('dono') });
    const sentBefore = mailer.state.sent.length; // (o código de verificação do cadastro do dono já foi enviado)
    const send = () => owner.client.post('/api/team/invites', { email: emailOf(), name: 'Pessoa', areas: ['creatives'] });
    assert.equal((await send()).status, 201);
    assert.equal((await send()).status, 201);
    const third = await send();
    assert.equal(third.status, 429);
    assert.ok(third.headers.get('retry-after'));
    assert.equal(mailer.state.sent.length - sentBefore, 2, 'o 3º não gerou e-mail');
  });

  it('limita consultas e aceites por IP (tentativa de adivinhar token)', async () => {
    const anon = ctx.client();
    const guess = () => anon.post('/api/invitations/lookup', { token: 'B'.repeat(43) });
    for (let i = 0; i < 3; i += 1) assert.equal((await guess()).status, 404);
    assert.equal((await guess()).status, 429);
    const accept = () => anon.post('/api/invitations/accept', { token: 'C'.repeat(43), password: COLLAB_PASSWORD });
    assert.equal((await accept()).status, 404);
    assert.equal((await accept()).status, 404);
    assert.equal((await accept()).status, 429);
  });
});
