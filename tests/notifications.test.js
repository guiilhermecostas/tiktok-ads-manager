import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { BADGE_MAX, BODY_MAX, LINK_RE, TITLE_MAX, badgeText, validateNotificationInput } from '../shared/notifications.js';
import { all, createUser, loginAdmin, one, run, startTestServer } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, adminImpersonate: 1000, notificationsSend: 10000, notificationsRead: 10000, notificationsWrite: 10000 };
const valid = (extra = {}) => ({ title: 'Manutenção hoje', body: 'O sistema fica fora do ar das 22h às 23h.', level: 'warning', audience: 'all', ...extra });

describe('Notificações: regras compartilhadas', () => {
  it('aceita o pedido completo e apara os textos', () => {
    const { value, errors } = validateNotificationInput({ title: '  Nova   função  ', body: '  Veja o Saldo.\r\nAgora com transferência.  ', level: 'success', audience: 'user', userId: 7, link: '/balance/accounts', expiresInDays: 7 });
    assert.deepEqual(errors, []);
    assert.deepEqual(value, { title: 'Nova função', body: 'Veja o Saldo.\nAgora com transferência.', level: 'success', audience: 'user', userId: 7, link: '/balance/accounts', expiresInDays: 7 });
  });

  it('padrões: tipo "info", para todos, sem link e sem prazo', () => {
    const { value } = validateNotificationInput({ title: 'Oi', body: 'Olá' });
    assert.deepEqual(value, { title: 'Oi', body: 'Olá', level: 'info', audience: 'all', userId: null, link: null, expiresInDays: null });
  });

  it('recusa título/mensagem vazios ou grandes demais, e caracteres de controle', () => {
    const paths = (raw) => validateNotificationInput(raw).errors.map((e) => e.path).sort();
    assert.deepEqual(paths({ title: '', body: '' }), ['body', 'title']);
    assert.deepEqual(paths({ title: 'x'.repeat(TITLE_MAX + 1), body: 'ok' }), ['title']);
    assert.deepEqual(paths({ title: 'ok', body: 'x'.repeat(BODY_MAX + 1) }), ['body']);
    assert.deepEqual(paths({ title: 'a\u0000b', body: 'ok' }), ['title']);
    assert.deepEqual(paths({ title: 'ok', body: 'a\u0007b' }), ['body']);
    assert.deepEqual(paths({ title: 5, body: null }), ['body', 'title']);
    assert.equal(validateNotificationInput({ title: 'x'.repeat(TITLE_MAX), body: 'x'.repeat(BODY_MAX) }).errors.length, 0);
  });

  it('o link só pode ser um endereço INTERNO (nada de sites externos, javascript: nem "//")', () => {
    for (const link of ['/manager', '/balance/accounts', '/', '/business-centers/proxy', '/a_b-c']) assert.match(link, LINK_RE, link);
    for (const link of ['//evil.com', 'https://evil.com', 'http://x', 'javascript:alert(1)', '/Manager', '/a b', '/a?x=1', '/a#b', '/a\\b', 'manager', '/' + 'a'.repeat(100), 'data:text/html,x']) {
      assert.deepEqual(validateNotificationInput({ title: 't', body: 'b', link }).errors.map((e) => e.path), ['link'], link);
    }
    assert.equal(validateNotificationInput({ title: 't', body: 'b', link: '   ' }).value.link, null);
    assert.deepEqual(validateNotificationInput({ title: 't', body: 'b', link: 5 }).errors.map((e) => e.path), ['link']);
  });

  it('tipo, destino e validade só aceitam valores da lista', () => {
    const paths = (extra) => validateNotificationInput({ title: 't', body: 'b', ...extra }).errors.map((e) => e.path);
    assert.deepEqual(paths({ level: 'critical' }), ['level']);
    assert.deepEqual(paths({ audience: 'admins' }), ['audience']);
    assert.deepEqual(paths({ audience: 'user' }), ['userId']);
    assert.deepEqual(paths({ audience: 'user', userId: '5' }), ['userId']);
    assert.deepEqual(paths({ audience: 'user', userId: -1 }), ['userId']);
    assert.deepEqual(paths({ audience: 'all', userId: 3 }), ['userId']);
    assert.deepEqual(paths({ expiresInDays: 2 }), ['expiresInDays']);
    assert.deepEqual(paths({ expiresInDays: '7' }), ['expiresInDays']);
    assert.deepEqual(paths({ expiresInDays: 30 }), []);
    assert.deepEqual(paths({ expiresInDays: null }), []);
  });

  it('entrada que não é objeto vira erro (sem quebrar)', () => {
    for (const raw of [null, undefined, 'texto', 5, [], true]) assert.ok(validateNotificationInput(raw).errors.length >= 2);
  });

  it('o selo mostra "99+" a partir de 100', () => {
    assert.equal(badgeText(0), '0');
    assert.equal(badgeText(BADGE_MAX), '99');
    assert.equal(badgeText(BADGE_MAX + 1), '99+');
    assert.equal(badgeText(5000), '99+');
  });
});

describe('Notificações: API (sino e painel do admin)', () => {
  let ctx;
  let admin;
  let a;
  let b;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS });
    admin = await loginAdmin(ctx);
    a = await createUser(ctx, { approve: true, name: 'Pessoa A' });
    b = await createUser(ctx, { approve: true, name: 'Pessoa B' });
  });
  after(() => ctx.stop());

  const send = async (extra = {}) => {
    const res = await admin.post('/api/admin/notifications', valid(extra));
    assert.equal(res.status, 201, res.text);
    return res.json.id;
  };
  const bell = async (client) => (await client.get('/api/notifications')).json;
  const ids = async (client) => (await bell(client)).notifications.map((n) => n.id);
  const reset = () => run(ctx.db, 'DELETE FROM notifications');

  describe('permissões', () => {
    it('só o admin gerencia: usuário comum recebe 403, visitante 401', async () => {
      const visitor = ctx.client();
      for (const [method, path, body] of [['get', '/api/admin/notifications'], ['post', '/api/admin/notifications', valid()], ['patch', '/api/admin/notifications/1', { active: false }], ['delete', '/api/admin/notifications/1']]) {
        assert.equal((await a.client[method](path, body)).status, 403, `usuário ${method} ${path}`);
        assert.equal((await visitor[method](path, body)).status, 401, `visitante ${method} ${path}`);
      }
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notifications')).c, 0);
    });

    it('exige o token CSRF para enviar', async () => {
      assert.equal((await admin.post('/api/admin/notifications', valid(), { withCsrf: false })).status, 403);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notifications')).c, 0);
    });

    it('conta pendente NÃO vê notificações (acesso só para conta aprovada) e visitante recebe 401', async () => {
      const pending = await createUser(ctx);
      const res = await pending.client.get('/api/notifications');
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'account_pending');
      assert.equal((await ctx.client().get('/api/notifications')).status, 401);
    });
  });

  describe('envio e visibilidade', () => {
    it('"para todos" aparece no sino de todo mundo, não lida, com o selo certo', async () => {
      await reset();
      const id = await send({ title: 'Novidade no Saldo', link: '/balance' });
      for (const who of [a, b]) {
        const data = await bell(who.client);
        assert.equal(data.unread, 1);
        assert.deepEqual(data.notifications.map((n) => ({ id: n.id, title: n.title, link: n.link, level: n.level, read: n.read })), [{ id, title: 'Novidade no Saldo', link: '/balance', level: 'warning', read: false }]);
        assert.ok(data.notifications[0].createdAt);
        assert.ok(!('targetUserId' in data.notifications[0]) && !('audience' in data.notifications[0]), 'não vaza dados do envio');
      }
    });

    it('"para uma pessoa" só chega nela', async () => {
      await reset();
      const id = await send({ audience: 'user', userId: a.id, title: 'Só para A' });
      assert.deepEqual(await ids(a.client), [id]);
      assert.deepEqual(await ids(b.client), []);
      assert.equal((await bell(b.client)).unread, 0);
    });

    it('não envia para conta inexistente, pendente ou bloqueada (400) nem com dados inválidos', async () => {
      await reset();
      const pending = await createUser(ctx);
      for (const userId of [999999, pending.id]) {
        const res = await admin.post('/api/admin/notifications', valid({ audience: 'user', userId }));
        assert.equal(res.status, 400, `userId ${userId}`);
        assert.equal(res.json.error.code, 'validation_error');
      }
      const bad = await admin.post('/api/admin/notifications', valid({ title: '', link: 'https://evil.com' }));
      assert.equal(bad.status, 400);
      assert.deepEqual(bad.json.error.details.map((d) => d.path).sort(), ['link', 'title']);
      assert.equal((await admin.post('/api/admin/notifications', [1, 2])).status, 400);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notifications')).c, 0);
    });

    it('as mais recentes vêm primeiro e o sino mostra no máximo 30 (o selo conta todas as não lidas)', async () => {
      await reset();
      for (let i = 1; i <= 33; i += 1) await send({ title: `N${i}` });
      const data = await bell(a.client);
      assert.equal(data.notifications.length, 30);
      assert.equal(data.notifications[0].title, 'N33');
      assert.equal(data.notifications.at(-1).title, 'N4');
      assert.equal(data.unread, 33);
    });

    it('texto com HTML/script é guardado e devolvido como texto puro (a tela só usa nós de texto)', async () => {
      await reset();
      const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      await send({ title: evil.slice(0, 70), body: evil });
      const [n] = (await bell(a.client)).notifications;
      assert.equal(n.body, evil);
      assert.match((await a.client.get('/api/notifications')).headers.get('content-type'), /application\/json/);
    });

    it('a validade em dias vira a data de expiração', async () => {
      await reset();
      const startedAt = Date.now();
      const id = await send({ expiresInDays: 7 });
      const row = await one(ctx.db, 'SELECT expires_at FROM notifications WHERE id = $1', [id]);
      const delta = new Date(row.expires_at).getTime() - startedAt;
      assert.ok(Math.abs(delta - 7 * 86_400_000) < 10_000, `delta ${delta}`);
      assert.deepEqual(await ids(a.client), [id]);
    });

    it('notificação vencida some do sino e do selo', async () => {
      await reset();
      const id = await send({ expiresInDays: 1 });
      await run(ctx.db, "UPDATE notifications SET expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
      assert.deepEqual(await bell(a.client), { notifications: [], unread: 0 });
    });
  });

  describe('leitura', () => {
    it('marcar como lida vale só para a pessoa (B continua com a dela como não lida)', async () => {
      await reset();
      const id = await send();
      const res = await a.client.post('/api/notifications/read', { ids: [id] });
      assert.equal(res.status, 200);
      assert.equal(res.json.unread, 0);
      assert.equal((await bell(a.client)).notifications[0].read, true);
      assert.equal((await bell(b.client)).unread, 1);
      assert.equal((await bell(b.client)).notifications[0].read, false);
    });

    it('marcar de novo não duplica nem dá erro', async () => {
      await reset();
      const id = await send();
      for (let i = 0; i < 3; i += 1) assert.equal((await a.client.post('/api/notifications/read', { ids: [id] })).status, 200);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notification_reads WHERE user_id = $1', [a.id])).c, 1);
    });

    it('"marcar todas" marca todas as visíveis (e só as visíveis)', async () => {
      await reset();
      await send();
      await send();
      await send({ audience: 'user', userId: b.id });
      const res = await a.client.post('/api/notifications/read', { all: true });
      assert.equal(res.json.unread, 0);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notification_reads WHERE user_id = $1', [a.id])).c, 2, 'a de B não entra para A');
      assert.equal((await bell(b.client)).unread, 3);
    });

    it('não dá para marcar (nem descobrir) a notificação de outra pessoa pelo id (IDOR)', async () => {
      await reset();
      const forB = await send({ audience: 'user', userId: b.id });
      const res = await a.client.post('/api/notifications/read', { ids: [forB, 999999] });
      assert.equal(res.status, 200);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notification_reads')).c, 0);
      assert.equal((await bell(b.client)).unread, 1);
    });

    it('valida o corpo: lista vazia, grande, ids ruins ou sem nada são 400', async () => {
      for (const body of [{}, { ids: [] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }, { ids: ['x'] }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: 'abc' }, { all: 'sim' }]) {
        assert.equal((await a.client.post('/api/notifications/read', body)).status, 400, JSON.stringify(body).slice(0, 40));
      }
      assert.equal((await a.client.post('/api/notifications/read', [1])).status, 400);
    });

    it('marcar como lida exige o CSRF', async () => {
      await reset();
      const id = await send();
      assert.equal((await a.client.post('/api/notifications/read', { ids: [id] }, { withCsrf: false })).status, 403);
      assert.equal((await bell(a.client)).unread, 1);
    });
  });

  describe('gerenciar (admin)', () => {
    it('desativar tira do sino de todos; reativar devolve; excluir apaga junto as leituras', async () => {
      await reset();
      const id = await send();
      await a.client.post('/api/notifications/read', { ids: [id] });
      assert.equal((await admin.patch(`/api/admin/notifications/${id}`, { active: false })).status, 200);
      assert.deepEqual(await bell(a.client), { notifications: [], unread: 0 });
      assert.deepEqual(await bell(b.client), { notifications: [], unread: 0 });
      assert.equal((await admin.patch(`/api/admin/notifications/${id}`, { active: true })).status, 200);
      assert.equal((await bell(a.client)).notifications[0].read, true, 'a leitura é lembrada');
      assert.equal((await admin.delete(`/api/admin/notifications/${id}`)).status, 204);
      assert.deepEqual(await bell(b.client), { notifications: [], unread: 0 });
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notification_reads')).c, 0);
    });

    it('id que não existe é 404; corpo inválido é 400', async () => {
      assert.equal((await admin.patch('/api/admin/notifications/999999', { active: false })).status, 404);
      assert.equal((await admin.delete('/api/admin/notifications/999999')).status, 404);
      assert.equal((await admin.patch('/api/admin/notifications/abc', { active: false })).status, 400);
      const id = await send();
      assert.equal((await admin.patch(`/api/admin/notifications/${id}`, { active: 'sim' })).status, 400);
      assert.equal((await admin.patch(`/api/admin/notifications/${id}`, {})).status, 400);
    });

    it('a lista do admin mostra o destino, a validade e quantas pessoas já leram', async () => {
      await reset();
      const all1 = await send({ title: 'Para todos', expiresInDays: 30 });
      const one1 = await send({ title: 'Para A', audience: 'user', userId: a.id });
      await a.client.post('/api/notifications/read', { ids: [all1, one1] });
      await b.client.post('/api/notifications/read', { ids: [all1] });
      const list = (await admin.get('/api/admin/notifications')).json.notifications;
      assert.deepEqual(list.map((n) => n.title), ['Para A', 'Para todos']);
      const [forA, forAll] = list;
      assert.equal(forA.targetName, 'Pessoa A');
      assert.equal(forA.readCount, 1);
      assert.equal(forA.recipients, 1);
      assert.equal(forAll.audience, 'all');
      assert.equal(forAll.readCount, 2);
      assert.ok(forAll.recipients >= 3, 'todas as contas aprovadas (admin, A e B)');
      assert.ok(forAll.expiresAt);
      assert.equal(forAll.active, true);
      assert.equal(forAll.createdByName, 'Administrador');
    });

    it('envio e mudanças ficam no registro de auditoria do admin', async () => {
      await reset();
      await run(ctx.db, 'DELETE FROM admin_audit_log');
      const id = await send({ title: 'Auditada' });
      await admin.patch(`/api/admin/notifications/${id}`, { active: false });
      await admin.delete(`/api/admin/notifications/${id}`);
      const log = await all(ctx.db, 'SELECT action, detail FROM admin_audit_log ORDER BY id');
      assert.deepEqual(log.map((r) => r.action), ['notification_send', 'notification_change', 'notification_change']);
      assert.match(log[0].detail, /Auditada/);
      assert.match(log[1].detail, /Desativou/);
      assert.match(log[2].detail, /Excluiu/);
    });

    it('tem limite de envios por hora', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, notificationsSend: 2 }, isolated: true });
      try {
        const boss = await loginAdmin(limited);
        const statuses = [];
        for (let i = 0; i < 3; i += 1) statuses.push((await boss.post('/api/admin/notifications', valid())).status);
        assert.deepEqual(statuses, [201, 201, 429]);
      } finally {
        await limited.stop();
      }
    });
  });

  describe('integração com o resto do sistema', () => {
    it('o admin vendo a conta de A (somente leitura) enxerga o sino de A, mas não marca nada como lido', async () => {
      await reset();
      const id = await send({ audience: 'user', userId: a.id });
      const watcher = await loginAdmin(ctx);
      const entered = await watcher.post(`/api/admin/users/${a.id}/impersonate`);
      assert.equal(entered.status, 200);
      watcher.csrf = entered.json.csrfToken;
      assert.deepEqual((await bell(watcher)).notifications.map((n) => n.id), [id]);
      const res = await watcher.post('/api/notifications/read', { ids: [id] });
      assert.equal(res.status, 403);
      assert.equal(res.json.error.code, 'impersonation_read_only');
      assert.equal((await bell(a.client)).unread, 1, 'A continua com a notificação não lida');
    });

    it('colaborador recebe as notificações DELE (pessoa), não as do dono do espaço', async () => {
      await reset();
      const owner = await createUser(ctx, { approve: true, name: 'Dono' });
      const member = await createUser(ctx, { approve: true, name: 'Colaborador' });
      await run(ctx.db, "INSERT INTO workspace_members (owner_id, user_id, areas) VALUES ($1, $2, ARRAY['reports'])", [owner.id, member.id]);
      const forOwner = await send({ audience: 'user', userId: owner.id, title: 'Do dono' });
      const forMember = await send({ audience: 'user', userId: member.id, title: 'Do colaborador' });
      assert.deepEqual(await ids(member.client), [forMember]);
      assert.deepEqual(await ids(owner.client), [forOwner]);
    });

    it('apagar a conta da pessoa apaga as notificações dela e as leituras (cascata)', async () => {
      await reset();
      const temp = await createUser(ctx, { approve: true });
      const id = await send({ audience: 'user', userId: temp.id });
      await temp.client.post('/api/notifications/read', { ids: [id] });
      await run(ctx.db, 'DELETE FROM users WHERE id = $1', [temp.id]);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notifications')).c, 0);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM notification_reads')).c, 0);
    });

    it('o banco recusa dados incoerentes mesmo fora da API', async () => {
      const bad = [
        ["INSERT INTO notifications (title, body, audience) VALUES ('t', 'b', 'user')"], // pessoa obrigatória
        ["INSERT INTO notifications (title, body, audience, target_user_id) SELECT 't', 'b', 'all', id FROM users LIMIT 1"], // "todos" sem pessoa
        ["INSERT INTO notifications (title, body, audience, level) VALUES ('t', 'b', 'all', 'critical')"],
        ["INSERT INTO notifications (title, body, audience, link) VALUES ('t', 'b', 'all', 'https://evil.com')"],
        ["INSERT INTO notifications (title, body, audience, link) VALUES ('t', 'b', 'all', '//evil.com')"],
        ["INSERT INTO notifications (title, body, audience) VALUES ('', 'b', 'all')"],
        [`INSERT INTO notifications (title, body, audience) VALUES ('${'x'.repeat(81)}', 'b', 'all')`],
      ];
      for (const [sql] of bad) await assert.rejects(() => run(ctx.db, sql), sql);
    });
  });
});
