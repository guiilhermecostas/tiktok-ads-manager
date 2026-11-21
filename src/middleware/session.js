import { parseCookies } from '../lib/cookies.js';

/**
 * Carrega a sessão a partir do cookie. O usuário é relido do banco a cada requisição,
 * portanto aprovar, rejeitar ou bloquear uma conta tem efeito imediato.
 */
export function loadSession({ sessions, config }) {
  return async (req, res, next) => {
    req.user = null;
    req.session = null;
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    if (token) {
      const found = await sessions.resolve(token);
      if (found) {
        req.user = found.user;
        req.session = found.session;
        req.sessionToken = token;
      }
    }
    next();
  };
}

export function sessionCookieOptions(config, expiresAt) {
  return {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.cookieSecure,
    path: '/',
    expires: new Date(expiresAt),
  };
}
