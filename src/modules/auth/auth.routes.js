import { Router } from 'express';
import { RateLimiter } from '../../lib/rate-limit.js';
import { badRequest, tooMany } from '../../lib/http-error.js';
import { asObject, parseEmail, parsePassword, parseText } from '../../lib/validation.js';
import { requireAuth } from '../../middleware/guards.js';
import { sessionCookieOptions } from '../../middleware/session.js';
import { presentSession } from './session-view.js';

export function createAuthRouter({ authService, sessions, impersonation, config, limits = {} }) {
  const router = Router();
  const registerLimiter = new RateLimiter({ max: limits.register ?? 10, windowMs: 60 * 60 * 1000 });
  const emailSendLimiter = new RateLimiter({ max: limits.registerEmail ?? 5, windowMs: 60 * 60 * 1000 });
  const verifyLimiter = new RateLimiter({ max: limits.registerVerify ?? 30, windowMs: 15 * 60 * 1000 });
  const resendLimiter = new RateLimiter({ max: limits.registerResend ?? 10, windowMs: 60 * 60 * 1000 });
  const loginIpLimiter = new RateLimiter({ max: limits.loginIp ?? 30, windowMs: 15 * 60 * 1000 });
  const loginAccountLimiter = new RateLimiter({ max: limits.loginAccount ?? 5, windowMs: 15 * 60 * 1000 });

  const enforce = (limiter, key) => {
    const result = limiter.consume(key);
    if (!result.allowed) throw tooMany(result.retryAfterSec);
  };

  const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
  const ticketOf = (body) => {
    if (typeof body.ticket !== 'string' || !TICKET_RE.test(body.ticket)) throw badRequest('Cadastro não encontrado. Volte e preencha o formulário de novo.', 'invalid_ticket');
    return body.ticket;
  };

  // Etapa 1: valida, guarda o cadastro e envia o código de 6 dígitos por e-mail. A conta ainda NÃO existe.
  router.post('/register', async (req, res) => {
    enforce(registerLimiter, req.ip);
    const body = asObject(req.body);
    const input = {
      name: parseText(body.name, 'Nome'),
      company: parseText(body.company, 'Empresa', { min: 2, max: 100, required: false }),
      email: parseEmail(body.email),
      password: parsePassword(body.password),
    };
    enforce(emailSendLimiter, input.email); // contado mesmo para e-mails que já têm conta: ninguém usa isto para encher a caixa de entrada de outra pessoa
    const started = await authService.startRegistration(input);
    res.json({ ...started, message: `Enviamos um código de 6 dígitos para ${started.email}. Digite-o para confirmar o e-mail e criar a conta.` });
  });

  // Etapa 2: confere o código. Acertando, cria a conta PENDENTE (aprovação do admin) com o plano padrão.
  router.post('/register/verify', async (req, res) => {
    enforce(verifyLimiter, req.ip);
    const body = asObject(req.body);
    const ticket = ticketOf(body);
    await authService.verifyRegistration({ ticket, code: typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : body.code });
    res.status(201).json({
      message: 'E-mail confirmado! Sua conta foi criada e ficará pendente até a aprovação do administrador.',
    });
  });

  router.post('/register/resend', async (req, res) => {
    enforce(resendLimiter, req.ip);
    res.json({ ...(await authService.resendCode({ ticket: ticketOf(asObject(req.body)) })), sent: true });
  });

  router.post('/login', async (req, res) => {
    enforce(loginIpLimiter, req.ip);
    const body = asObject(req.body);
    const email = parseEmail(body.email);
    if (typeof body.password !== 'string' || !body.password || body.password.length > 128) {
      parsePassword(body.password); // lança 400 padronizado
    }
    const accountKey = `${req.ip}|${email}`;
    enforce(loginAccountLimiter, accountKey);

    const { user, session } = await authService.login({ email, password: body.password });
    loginAccountLimiter.clear(accountKey);

    // Anti session-fixation: descarta a sessão anterior e emite um token novo.
    if (req.sessionToken) await sessions.destroy(req.sessionToken);
    res.cookie(config.cookieName, session.token, sessionCookieOptions(config, session.expiresAt));
    const found = await sessions.resolve(session.token); // inclui o espaço de trabalho (colaborador ou dono)
    res.json({ ...presentSession(found?.user ?? user, found?.member ?? null), csrfToken: session.csrfToken });
  });

  router.get('/me', (req, res) => {
    // Visitante não é erro: responde 200 com user nulo (evita ruído de 401 no console do navegador).
    if (!req.user) return res.json({ user: null, workspace: null, csrfToken: null });
    res.json({ ...presentSession(req.user, req.member), impersonation: req.impersonation ? { adminName: req.impersonation.adminName } : null, csrfToken: req.session.csrfToken });
  });

  // Sai da conta que o admin está vendo e volta para a SUA conta de admin (sessão nova). Se ele já não for admin aprovado, cai no login.
  router.post('/impersonation/exit', requireAuth, async (req, res) => {
    if (!req.impersonation) throw badRequest('Você não está na conta de outra pessoa.');
    const { session } = await impersonation.stop({ adminId: req.impersonation.adminId, targetId: req.user.id }, { ip: req.ip });
    await sessions.destroy(req.sessionToken);
    if (!session) {
      res.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure });
      return res.json({ user: null, workspace: null, csrfToken: null });
    }
    res.cookie(config.cookieName, session.token, sessionCookieOptions(config, session.expiresAt));
    const found = await sessions.resolve(session.token);
    return res.json({ ...presentSession(found.user, found.member), impersonation: null, csrfToken: session.csrfToken });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    if (req.impersonation) await impersonation.stop({ adminId: req.impersonation.adminId, targetId: req.user.id }, { ip: req.ip, reopen: false });
    await sessions.destroy(req.sessionToken);
    res.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure });
    res.status(204).end();
  });

  router.stop = () => [registerLimiter, emailSendLimiter, verifyLimiter, resendLimiter, loginIpLimiter, loginAccountLimiter].forEach((l) => l.stop());
  return router;
}
