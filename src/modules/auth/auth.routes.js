import { Router } from 'express';
import { RateLimiter } from '../../lib/rate-limit.js';
import { tooMany } from '../../lib/http-error.js';
import { asObject, parseEmail, parsePassword, parseText } from '../../lib/validation.js';
import { requireAuth } from '../../middleware/guards.js';
import { sessionCookieOptions } from '../../middleware/session.js';
import { toPublicUser } from '../users/users.repository.js';

export function createAuthRouter({ authService, sessions, config, limits = {} }) {
  const router = Router();
  const registerLimiter = new RateLimiter({ max: limits.register ?? 10, windowMs: 60 * 60 * 1000 });
  const loginIpLimiter = new RateLimiter({ max: limits.loginIp ?? 30, windowMs: 15 * 60 * 1000 });
  const loginAccountLimiter = new RateLimiter({ max: limits.loginAccount ?? 5, windowMs: 15 * 60 * 1000 });

  const enforce = (limiter, key) => {
    const result = limiter.consume(key);
    if (!result.allowed) throw tooMany(result.retryAfterSec);
  };

  router.post('/register', async (req, res) => {
    enforce(registerLimiter, req.ip);
    const body = asObject(req.body);
    const input = {
      name: parseText(body.name, 'Nome'),
      company: parseText(body.company, 'Empresa', { min: 2, max: 100, required: false }),
      email: parseEmail(body.email),
      password: parsePassword(body.password),
    };
    await authService.register(input);
    res.status(201).json({
      message:
        'Cadastro recebido! Sua conta ficará pendente até a aprovação do administrador. ' +
        'Se o e-mail já estiver em uso, nenhuma nova conta será criada.',
    });
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
    res.json({ user: toPublicUser(user), csrfToken: session.csrfToken });
  });

  router.get('/me', (req, res) => {
    // Visitante não é erro: responde 200 com user nulo (evita ruído de 401 no console do navegador).
    if (!req.user) return res.json({ user: null, csrfToken: null });
    res.json({ user: toPublicUser(req.user), csrfToken: req.session.csrfToken });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    await sessions.destroy(req.sessionToken);
    res.clearCookie(config.cookieName, { path: '/', httpOnly: true, sameSite: 'strict', secure: config.cookieSecure });
    res.status(204).end();
  });

  router.stop = () => [registerLimiter, loginIpLimiter, loginAccountLimiter].forEach((l) => l.stop());
  return router;
}
