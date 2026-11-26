import { parseCookies } from '../lib/cookies.js';

/**
 * Carrega a sessão a partir do cookie. O usuário é relido do banco a cada requisição,
 * portanto aprovar, rejeitar ou bloquear uma conta tem efeito imediato.
 */
export function loadSession({ sessions, config }) {
  return async (req, res, next) => {
    req.user = null;
    req.session = null;
    req.member = null;
    req.impersonation = null; // { adminId, adminName } quando um admin está vendo a conta de outra pessoa (somente leitura)
    const token = parseCookies(req.headers.cookie)[config.cookieName];
    if (token) {
      let found = await sessions.resolve(token);
      // Sessão aberta por um admin só vale enquanto ele continuar sendo admin aprovado (rebaixar/bloquear o admin a encerra na hora).
      if (found?.impersonator && !(found.impersonator.role === 'admin' && found.impersonator.status === 'approved')) {
        await sessions.destroy(token);
        found = null;
      }
      if (found) {
        if (found.impersonator) req.impersonation = { adminId: found.impersonator.id, adminName: found.impersonator.name };
        req.member = found.member;
        // Se o dono do espaço foi bloqueado/rejeitado, o acesso dos colaboradores dele cai junto.
        req.user = found.member && found.member.ownerStatus !== 'approved' && found.user.status === 'approved' ? { ...found.user, status: 'blocked' } : found.user;
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
