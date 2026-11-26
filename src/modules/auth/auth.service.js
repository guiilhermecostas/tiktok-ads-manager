import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { getDummyHash, hashPassword, verifyPassword } from '../../lib/password.js';
import { isUniqueViolation } from '../../db/helpers.js';
import { HttpError, tooMany } from '../../lib/http-error.js';
import { verificationEmail } from '../mail/templates.js';
import { MAX_CODE_ATTEMPTS, sha256 } from './registrations.repository.js';

const INVALID_CREDENTIALS = 'E-mail ou senha incorretos.';

export const CODE_TTL_MS = 10 * 60 * 1000;
export const RESEND_COOLDOWN_MS = 60 * 1000;
export const MAX_SENDS = 5;
const CODE_RE = /^\d{6}$/;
const invalidCode = () => new HttpError(400, 'Código inválido ou vencido. Peça um novo código.', 'invalid_code');

/** Código de 6 dígitos sorteado de forma segura. O hash dele (com o e-mail) é o que fica no banco. */
const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');
const codeHashFor = (email, code) => sha256(`${email}\n${code}`);
const sameHash = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

export function createAuthService({ users, sessions, registrations, mailer, config, now = () => new Date() }) {
  const minutes = CODE_TTL_MS / 60_000;
  const reply = (ticket, email) => ({ ticket, email, expiresInMinutes: minutes, resendAfterSeconds: RESEND_COOLDOWN_MS / 1000 });

  return {
    /**
     * Cadastro público, em duas etapas. ETAPA 1: valida, guarda o cadastro em andamento (senha já em hash) e envia o código de 6 dígitos para o e-mail;
     * devolve um `ticket` secreto (só o navegador de quem se cadastrou o tem, e ele liga o código a ESTE cadastro). Nada de conta ainda.
     * O e-mail do admin e e-mails já cadastrados recebem a MESMA resposta (com ticket falso), sem enviar nada (sem enumeração de contas).
     */
    async startRegistration({ email, name, company, password }) {
      if (!mailer?.enabled) throw new HttpError(503, 'O cadastro está indisponível agora porque o envio de e-mails não está configurado. Avise o administrador.', 'email_not_configured');
      const ticket = randomBytes(32).toString('base64url');
      const passwordHash = await hashPassword(password); // mesmo custo de CPU para todos os casos
      if (email === config.adminEmail || (await users.findByEmail(email))) return reply(ticket, email);
      const code = generateCode();
      const ticketHash = sha256(ticket);
      await registrations.create({ ticketHash, email, name, company, passwordHash, codeHash: codeHashFor(email, code), expiresAt: new Date(now().getTime() + CODE_TTL_MS) });
      try {
        await mailer.send({ to: email, ...verificationEmail({ name, code, expiresInMinutes: minutes }), idempotencyKey: `register-${ticketHash.slice(0, 32)}-1` });
      } catch (err) {
        await registrations.remove(ticketHash); // sem e-mail não há como confirmar: não deixa o cadastro pendurado
        throw err;
      }
      return reply(ticket, email);
    },

    /**
     * ETAPA 2: confere o código. Só 5 tentativas por código e 10 minutos de validade; acertando, a conta é criada PENDENTE de aprovação do admin, já com o
     * plano padrão (US$ 0 + 10% do gasto). Qualquer falha devolve mensagens que não revelam se um e-mail já tem conta.
     */
    async verifyRegistration({ ticket, code }) {
      if (typeof code !== 'string' || !CODE_RE.test(code)) throw new HttpError(400, 'Digite os 6 números do código.', 'invalid_code');
      const ticketHash = sha256(ticket);
      const taken = await registrations.takeAttempt(ticketHash, now());
      if (!taken) throw invalidCode();
      if (!sameHash(taken.codeHash, codeHashFor(taken.email, code))) {
        const left = MAX_CODE_ATTEMPTS - taken.attempts;
        if (left <= 0) {
          await registrations.remove(ticketHash);
          throw new HttpError(400, 'Código incorreto e as tentativas acabaram. Volte e peça um novo código.', 'invalid_code');
        }
        throw new HttpError(400, `Código incorreto. Você ainda tem ${left} ${left === 1 ? 'tentativa' : 'tentativas'}.`, 'invalid_code');
      }
      try {
        if (!(await registrations.complete(ticketHash, now()))) throw invalidCode();
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await registrations.remove(ticketHash); // o e-mail virou conta enquanto isso (cadastro simultâneo)
        throw invalidCode();
      }
    },

    /** Reenvia um código novo para o mesmo cadastro: 1 por minuto, no máximo 5 por cadastro. Ticket falso ou vencido: mesma resposta, sem enviar. */
    async resendCode({ ticket }) {
      const ticketHash = sha256(ticket);
      const row = await registrations.find(ticketHash, now());
      if (!row) return { resendAfterSeconds: RESEND_COOLDOWN_MS / 1000 };
      const wait = row.lastSentAt.getTime() + RESEND_COOLDOWN_MS - now().getTime();
      if (wait > 0) throw tooMany(Math.ceil(wait / 1000));
      if (row.sends >= MAX_SENDS) throw new HttpError(429, 'Você pediu códigos demais. Volte e faça o cadastro de novo em alguns minutos.', 'rate_limited');
      const code = generateCode();
      const renewed = await registrations.renewCode(ticketHash, { codeHash: codeHashFor(row.email, code), expiresAt: new Date(now().getTime() + CODE_TTL_MS), now: now() });
      if (!renewed) return { resendAfterSeconds: RESEND_COOLDOWN_MS / 1000 };
      await mailer.send({ to: row.email, ...verificationEmail({ name: row.name, code, expiresInMinutes: minutes }), idempotencyKey: `register-${ticketHash.slice(0, 32)}-${row.sends + 1}` });
      return { resendAfterSeconds: RESEND_COOLDOWN_MS / 1000 };
    },

    async login({ email, password }) {
      const user = await users.findByEmail(email);
      const valid = await verifyPassword(password, user ? user.password_hash : await getDummyHash());
      if (!user || !valid) throw new HttpError(401, INVALID_CREDENTIALS, 'invalid_credentials');
      return { user, session: await sessions.create(user.id) };
    },

    /**
     * Garante a conta de administrador definida em ADMIN_EMAIL.
     * - Senha vem de ADMIN_PASSWORD; sem ela, uma senha aleatória é gerada e exibida uma única vez.
     * - Reexecutar com outra ADMIN_PASSWORD redefine a senha (recuperação) e encerra as sessões.
     */
    async ensureAdmin(log = console) {
      const existing = await users.findByEmail(config.adminEmail);
      let password = config.adminPassword;

      if (password && password.length < 10) {
        throw new Error('ADMIN_PASSWORD deve ter pelo menos 10 caracteres.');
      }

      if (!existing) {
        let generated = false;
        if (!password) {
          password = randomBytes(12).toString('base64url');
          generated = true;
        }
        await users.create({
          email: config.adminEmail,
          name: 'Administrador',
          company: null,
          passwordHash: await hashPassword(password),
          role: 'admin',
          status: 'approved',
        });
        log.info(`[admin] Conta de administrador criada: ${config.adminEmail}`);
        if (generated) log.info(`[admin] Senha gerada (exibida uma única vez): ${password}`);
        return;
      }

      const needsPromotion = existing.role !== 'admin' || existing.status !== 'approved';
      const passwordChanged = password && !(await verifyPassword(password, existing.password_hash));
      if (needsPromotion || passwordChanged) {
        const hash = passwordChanged ? await hashPassword(password) : existing.password_hash;
        await users.promoteToAdmin(existing.id, hash);
        await sessions.destroyAllForUser(existing.id);
        log.info('[admin] Conta de administrador sincronizada com o ambiente.');
      }
    },
  };
}
