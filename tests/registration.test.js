import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { DEFAULT_PLAN } from '../shared/billing.js';
import { MAX_SENDS } from '../src/modules/auth/auth.service.js';
import { MAX_CODE_ATTEMPTS, sha256 } from '../src/modules/auth/registrations.repository.js';
import { ADMIN_EMAIL, USER_PASSWORD, all, loginAdmin, one, run, startTestServer, uniqueEmail } from './helpers.js';

const LIMITS = { register: 1000, loginIp: 1000, loginAccount: 1000, adminImpersonate: 1000 };

describe('Cadastro com verificação do e-mail por código de 6 dígitos e plano padrão', () => {
  let ctx;
  before(async () => {
    ctx = await startTestServer({ limits: LIMITS });
  });
  after(() => ctx.stop());

  const start = (extra = {}) => ctx.client().post('/api/auth/register', { name: 'Maria Silva', company: 'Loja X', email: uniqueEmail('reg'), password: USER_PASSWORD, ...extra });
  const codeOf = (email) => ctx.mailer.codeFrom(ctx.mailer.lastTo(email));
  const users = async (email) => (await one(ctx.db, 'SELECT COUNT(*)::int c FROM users WHERE lower(email) = lower($1)', [email])).c;
  const rowOf = (ticket) => one(ctx.db, 'SELECT * FROM registration_codes WHERE ticket_hash = $1', [sha256(ticket)]);
  const verify = (ticket, code) => ctx.client().post('/api/auth/register/verify', { ticket, code });

  describe('etapa 1: pedir o código', () => {
    it('guarda o cadastro, envia o código por e-mail e NÃO cria a conta ainda', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      assert.equal(res.status, 200);
      assert.equal(res.json.email, email);
      assert.match(res.json.ticket, /^[A-Za-z0-9_-]{43}$/);
      assert.deepEqual([res.json.expiresInMinutes, res.json.resendAfterSeconds], [10, 60]);
      assert.equal(await users(email), 0, 'nenhuma conta antes de confirmar o e-mail');
      const mail = ctx.mailer.lastTo(email);
      assert.ok(mail, 'o e-mail com o código foi enviado');
      const code = ctx.mailer.codeFrom(mail);
      assert.match(code, /^\d{6}$/);
      assert.ok(mail.subject.startsWith(code));
      assert.ok(!JSON.stringify(res.json).includes(code), 'o código nunca vai na resposta do servidor');
    });

    it('no banco ficam só o HASH do código e da senha (nunca em texto puro)', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const code = codeOf(email);
      const row = await rowOf(res.json.ticket);
      assert.notEqual(row.code_hash, code);
      assert.equal(row.code_hash.length, 64);
      assert.match(row.password_hash, /^scrypt\$/);
      assert.equal(row.attempts, 0);
      assert.ok(new Date(row.expires_at).getTime() - Date.now() > 9 * 60_000 && new Date(row.expires_at).getTime() - Date.now() <= 10 * 60_000);
      assert.equal((await all(ctx.db, 'SELECT ticket_hash FROM registration_codes')).some((r) => r.ticket_hash === res.json.ticket), false, 'o ticket em texto puro também não é guardado');
    });

    it('o nome vai escapado no e-mail (HTML nunca vira HTML)', async () => {
      const email = uniqueEmail('reg');
      await start({ email, name: '<img src=x onerror=alert(1)>' });
      const mail = ctx.mailer.lastTo(email);
      assert.ok(!mail.html.includes('<img'));
      assert.ok(mail.html.includes('&lt;img'));
    });

    it('e-mail que já tem conta e o e-mail do admin recebem a MESMA resposta, e nada é enviado nem guardado', async () => {
      const email = uniqueEmail('reg');
      const first = await start({ email });
      await verify(first.json.ticket, codeOf(email));
      const sentBefore = ctx.mailer.state.sent.length;
      const rowsBefore = (await one(ctx.db, 'SELECT COUNT(*)::int c FROM registration_codes')).c;
      for (const target of [email, email.toUpperCase(), ADMIN_EMAIL]) {
        const res = await start({ email: target });
        assert.equal(res.status, 200);
        assert.deepEqual(Object.keys(res.json).sort(), Object.keys(first.json).sort());
        assert.equal(res.json.ticket.length, 43);
      }
      assert.equal(ctx.mailer.state.sent.length, sentBefore);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM registration_codes')).c, rowsBefore);
    });

    it('valida os dados antes de enviar qualquer e-mail', async () => {
      const sentBefore = ctx.mailer.state.sent.length;
      for (const extra of [{ name: 'A' }, { email: 'invalido' }, { password: 'curta' }, { name: { $ne: 1 } }, { password: 123456789012 }]) assert.equal((await start(extra)).status, 400, JSON.stringify(extra));
      assert.equal(ctx.mailer.state.sent.length, sentBefore);
    });

    it('se o e-mail não puder ser enviado: 502 e nada fica guardado', async () => {
      const email = uniqueEmail('reg');
      ctx.mailer.state.fail = true;
      try {
        const res = await start({ email });
        assert.equal(res.status, 502);
        assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM registration_codes WHERE lower(email) = $1', [email])).c, 0);
      } finally {
        ctx.mailer.state.fail = false;
      }
    });

    it('sem e-mail configurado no servidor: 503 claro (o cadastro não pula a verificação)', async () => {
      const rowsBefore = (await one(ctx.db, 'SELECT COUNT(*)::int c FROM registration_codes')).c;
      ctx.mailer.enabled = false;
      try {
        const res = await start();
        assert.equal(res.status, 503);
        assert.equal(res.json.error.code, 'email_not_configured');
        assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM registration_codes')).c, rowsBefore, 'nada foi guardado');
      } finally {
        ctx.mailer.enabled = true;
      }
    });
  });

  describe('etapa 2: confirmar o código e criar a conta', () => {
    it('código certo: cria a conta PENDENTE (sem privilégios) com o plano padrão US$ 0 + 10% e apaga o cadastro em andamento', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email, role: 'admin', status: 'approved' });
      const done = await verify(res.json.ticket, codeOf(email));
      assert.equal(done.status, 201);
      assert.match(done.json.message, /pendente até a aprovação/);
      const user = await one(ctx.db, 'SELECT id, role, status, company, password_hash FROM users WHERE email = $1', [email]);
      assert.deepEqual([user.role, user.status, user.company], ['user', 'pending', 'Loja X']);
      assert.match(user.password_hash, /^scrypt\$/);
      const plan = await one(ctx.db, "SELECT monthly_fee_cents, percent_bp, to_char(effective_month, 'YYYY-MM-DD') AS month, note, created_by FROM billing_plans WHERE user_id = $1", [user.id]);
      assert.deepEqual([plan.monthly_fee_cents, plan.percent_bp, plan.note, plan.created_by], [DEFAULT_PLAN.monthlyFeeCents, DEFAULT_PLAN.percentBp, 'Plano padrão do cadastro', null]);
      assert.deepEqual([plan.monthly_fee_cents, plan.percent_bp], [0, 1000], 'US$ 0 de mensalidade + 10% do gasto');
      assert.equal(plan.month, `${new Date().toISOString().slice(0, 7)}-01`);
      assert.equal(await rowOf(res.json.ticket), undefined);
      assert.equal((await ctx.client().login(email, USER_PASSWORD)).status, 200);
    });

    it('o plano padrão aparece para a pessoa (Plano e cobrança) e para o admin (Assinaturas)', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email, name: 'Cliente Novo' });
      await verify(res.json.ticket, codeOf(email));
      const id = (await one(ctx.db, 'SELECT id FROM users WHERE email = $1', [email])).id;
      const admin = await loginAdmin(ctx);
      assert.equal((await admin.patch(`/api/admin/users/${id}/status`, { status: 'approved' })).status, 200);
      const me = ctx.client();
      await me.login(email, USER_PASSWORD);
      const mine = (await me.get('/api/billing/me')).json;
      assert.deepEqual([mine.plan.monthlyFeeCents, mine.plan.percentBp], [0, 1000]);
      const row = (await admin.get('/api/admin/billing')).json.users.find((u) => u.id === id);
      assert.deepEqual([row.plan.monthlyFeeCents, row.plan.percentBp], [0, 1000]);
      assert.equal((await admin.put(`/api/admin/billing/users/${id}/plan`, { monthlyFee: '99,90', percent: '5' })).status, 200, 'o admin muda o plano normalmente');
    });

    it('o código vale UMA vez: repetir devolve erro e não cria outra conta', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const code = codeOf(email);
      assert.equal((await verify(res.json.ticket, code)).status, 201);
      const again = await verify(res.json.ticket, code);
      assert.equal(again.status, 400);
      assert.equal(again.json.error.code, 'invalid_code');
      assert.equal(await users(email), 1);
    });

    it('aceita o código com espaços ("123 456") e recusa formato errado', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const code = codeOf(email);
      for (const bad of ['12345', '1234567', 'abcdef', '12 34', '', null, 123456, ['123456']]) {
        const r = await verify(res.json.ticket, bad);
        assert.equal(r.status, 400, JSON.stringify(bad));
      }
      assert.equal((await rowOf(res.json.ticket)).attempts, 0, 'formato errado não gasta tentativa');
      assert.equal((await verify(res.json.ticket, `${code.slice(0, 3)} ${code.slice(3)}`)).status, 201);
    });

    it('ticket inválido, falso ou de outro formato: erro genérico, sem revelar nada', async () => {
      const fake = await verify('A'.repeat(43), '123456');
      assert.equal(fake.status, 400);
      assert.equal(fake.json.error.code, 'invalid_code');
      for (const ticket of ['curto', 'x'.repeat(100), 123, null, undefined, '../../etc/passwd']) {
        const r = await ctx.client().post('/api/auth/register/verify', { ticket, code: '123456' });
        assert.equal(r.status, 400, String(ticket));
        assert.equal(r.json.error.code, 'invalid_ticket');
      }
      assert.equal((await ctx.client().request('POST', '/api/auth/register/verify', { raw: '[1]' })).status, 400);
    });

    it('código errado: conta a tentativa, diz quantas restam e, na 5ª, apaga o cadastro (nem o código certo vale mais)', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const right = codeOf(email);
      const wrong = right === '000000' ? '111111' : '000000';
      for (let i = 1; i < MAX_CODE_ATTEMPTS; i += 1) {
        const r = await verify(res.json.ticket, wrong);
        assert.equal(r.status, 400);
        assert.match(r.json.error.message, new RegExp(`${MAX_CODE_ATTEMPTS - i} (tentativa|tentativas)`));
      }
      const last = await verify(res.json.ticket, wrong);
      assert.match(last.json.error.message, /tentativas acabaram/);
      assert.equal(await rowOf(res.json.ticket), undefined);
      assert.equal((await verify(res.json.ticket, right)).status, 400);
      assert.equal(await users(email), 0);
    });

    it('palpites ao mesmo tempo não passam do limite de tentativas', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const right = codeOf(email);
      const guesses = Array.from({ length: 40 }, (_, i) => String(100000 + i)).filter((g) => g !== right);
      const results = await Promise.all(guesses.slice(0, 30).map((g) => verify(res.json.ticket, g)));
      assert.ok(results.every((r) => r.status === 400));
      assert.equal(await users(email), 0);
      const row = await rowOf(res.json.ticket);
      assert.ok(row === undefined || row.attempts <= MAX_CODE_ATTEMPTS, 'no máximo 5 tentativas foram contadas');
    });

    it('código vencido (10 minutos): erro claro, e a conta não é criada', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      await run(ctx.db, "UPDATE registration_codes SET expires_at = now() - interval '1 second' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      const r = await verify(res.json.ticket, codeOf(email));
      assert.equal(r.status, 400);
      assert.match(r.json.error.message, /vencido/);
      assert.equal(await users(email), 0);
    });
  });

  describe('reenviar o código', () => {
    it('só depois de 1 minuto: antes disso 429 com Retry-After; depois, código novo e o antigo deixa de valer', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      const oldCode = codeOf(email);
      const early = await ctx.client().post('/api/auth/register/resend', { ticket: res.json.ticket });
      assert.equal(early.status, 429);
      assert.ok(early.headers.get('retry-after'));
      assert.equal(ctx.mailer.state.sent.filter((m) => m.to === email).length, 1, 'não reenviou antes da hora');
      await run(ctx.db, "UPDATE registration_codes SET last_sent_at = now() - interval '2 minutes' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      const ok = await ctx.client().post('/api/auth/register/resend', { ticket: res.json.ticket });
      assert.equal(ok.status, 200);
      assert.equal(ctx.mailer.state.sent.filter((m) => m.to === email).length, 2);
      const newCode = codeOf(email);
      await run(ctx.db, "UPDATE registration_codes SET attempts = 3 WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      if (newCode !== oldCode) assert.equal((await verify(res.json.ticket, oldCode)).status, 400, 'o código antigo não vale mais');
      await run(ctx.db, 'UPDATE registration_codes SET attempts = 0 WHERE ticket_hash = $1', [sha256(res.json.ticket)]);
      assert.equal((await verify(res.json.ticket, newCode)).status, 201);
    });

    it('no máximo 5 envios por cadastro', async () => {
      const email = uniqueEmail('reg');
      const res = await start({ email });
      for (let i = 1; i < MAX_SENDS; i += 1) {
        await run(ctx.db, "UPDATE registration_codes SET last_sent_at = now() - interval '2 minutes' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
        assert.equal((await ctx.client().post('/api/auth/register/resend', { ticket: res.json.ticket })).status, 200);
      }
      await run(ctx.db, "UPDATE registration_codes SET last_sent_at = now() - interval '2 minutes' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      const over = await ctx.client().post('/api/auth/register/resend', { ticket: res.json.ticket });
      assert.equal(over.status, 429);
      assert.equal(ctx.mailer.state.sent.filter((m) => m.to === email).length, MAX_SENDS);
    });

    it('ticket falso ou vencido: mesma resposta de sucesso, sem enviar nada', async () => {
      const sentBefore = ctx.mailer.state.sent.length;
      const fake = await ctx.client().post('/api/auth/register/resend', { ticket: 'B'.repeat(43) });
      assert.equal(fake.status, 200);
      const email = uniqueEmail('reg');
      const res = await start({ email });
      await run(ctx.db, "UPDATE registration_codes SET expires_at = now() - interval '1 second' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      assert.equal((await ctx.client().post('/api/auth/register/resend', { ticket: res.json.ticket })).status, 200);
      assert.equal(ctx.mailer.state.sent.length, sentBefore + 1, 'só o envio do cadastro novo');
      assert.equal((await ctx.client().post('/api/auth/register/resend', { ticket: 'curto' })).status, 400);
    });
  });

  describe('segurança do cadastro', () => {
    it('ninguém troca os dados do cadastro de outra pessoa: cada pedido tem o próprio ticket e o próprio código', async () => {
      const email = uniqueEmail('reg');
      const victim = await start({ email, name: 'Vítima', password: 'SenhaDaVitima-12345' });
      const victimCode = codeOf(email);
      const attacker = await start({ email, name: 'Atacante', password: 'SenhaDoAtacante-12345' });
      const attackerCode = codeOf(email); // (o e-mail do atacante também vai para a CAIXA DA VÍTIMA: ele não tem como ler)
      assert.notEqual(victim.json.ticket, attacker.json.ticket);
      if (victimCode !== attackerCode) assert.equal((await verify(attacker.json.ticket, victimCode)).status, 400, 'o código da vítima não confirma o cadastro do atacante');
      assert.equal((await verify(victim.json.ticket, victimCode)).status, 201);
      assert.equal((await one(ctx.db, 'SELECT name FROM users WHERE email = $1', [email])).name, 'Vítima');
      assert.equal((await ctx.client().login(email, 'SenhaDoAtacante-12345')).status, 401);
      assert.equal((await ctx.client().login(email, 'SenhaDaVitima-12345')).status, 200);
      // e o cadastro pendente do atacante não vira uma segunda conta
      const late = await verify(attacker.json.ticket, attackerCode);
      assert.equal(late.status, 400);
      assert.equal(await users(email), 1);
    });

    it('dois cadastros do mesmo e-mail confirmados ao mesmo tempo: só uma conta nasce', async () => {
      const email = uniqueEmail('reg');
      const a = await start({ email, name: 'Primeira' });
      const codeA = codeOf(email);
      const b = await start({ email, name: 'Segunda' });
      const codeB = codeOf(email);
      const results = await Promise.all([verify(a.json.ticket, codeA), verify(b.json.ticket, codeB)]);
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(await users(email), 1);
      assert.equal((await one(ctx.db, 'SELECT COUNT(*)::int c FROM billing_plans bp JOIN users u ON u.id = bp.user_id WHERE u.email = $1', [email])).c, 1, 'um plano só');
    });

    it('limpa os cadastros vencidos', async () => {
      const res = await start();
      await run(ctx.db, "UPDATE registration_codes SET expires_at = now() - interval '1 minute' WHERE ticket_hash = $1", [sha256(res.json.ticket)]);
      assert.ok((await ctx.registrations.purgeExpired(new Date())) >= 1);
      assert.equal(await rowOf(res.json.ticket), undefined);
    });

    it('o banco recusa cadastro em andamento com hashes inválidos', async () => {
      const ok = 'a'.repeat(64);
      for (const sql of [
        `INSERT INTO registration_codes (ticket_hash, email, name, password_hash, code_hash, expires_at) VALUES ('curto', 'a@b.co', 'x', 'h', '${ok}', now())`,
        `INSERT INTO registration_codes (ticket_hash, email, name, password_hash, code_hash, expires_at) VALUES ('${ok}', 'a@b.co', 'x', 'h', '123456', now())`,
        `INSERT INTO registration_codes (ticket_hash, email, name, password_hash, code_hash, attempts, expires_at) VALUES ('${'b'.repeat(64)}', 'a@b.co', 'x', 'h', '${ok}', -1, now())`,
      ]) await assert.rejects(() => run(ctx.db, sql), sql);
    });
  });

  describe('limites contra abuso', () => {
    it('por e-mail: poucos códigos por hora, contados também para e-mails que já têm conta (ninguém enche a caixa de outra pessoa)', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, registerEmail: 2 }, isolated: true });
      try {
        const email = uniqueEmail('lim');
        const send = (target) => limited.client().post('/api/auth/register', { name: 'Maria Silva', email: target, password: USER_PASSWORD });
        assert.equal((await send(email)).status, 200);
        assert.equal((await send(email)).status, 200);
        assert.equal((await send(email)).status, 429);
        assert.equal(limited.mailer.state.sent.filter((m) => m.to === email).length, 2);
        const admin = [await send(ADMIN_EMAIL), await send(ADMIN_EMAIL), await send(ADMIN_EMAIL)];
        assert.deepEqual(admin.map((r) => r.status), [200, 200, 429], 'e-mail que já tem conta é limitado do mesmo jeito');
      } finally {
        await limited.stop();
      }
    });

    it('por IP: confirmar e reenviar têm limite', async () => {
      const limited = await startTestServer({ limits: { ...LIMITS, registerVerify: 3, registerResend: 2 }, isolated: true });
      try {
        const verifyStatuses = [];
        for (let i = 0; i < 4; i += 1) verifyStatuses.push((await limited.client().post('/api/auth/register/verify', { ticket: 'A'.repeat(43), code: '123456' })).status);
        assert.deepEqual(verifyStatuses, [400, 400, 400, 429]);
        const resendStatuses = [];
        for (let i = 0; i < 3; i += 1) resendStatuses.push((await limited.client().post('/api/auth/register/resend', { ticket: 'A'.repeat(43) })).status);
        assert.deepEqual(resendStatuses, [200, 200, 429]);
      } finally {
        await limited.stop();
      }
    });
  });
});
