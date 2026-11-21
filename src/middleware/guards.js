import { timingSafeEqual } from 'node:crypto';
import { forbidden, unauthorized } from '../lib/http-error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const STATUS_MESSAGES = {
  pending: 'Sua conta está pendente de aprovação.',
  rejected: 'Seu cadastro não foi aprovado.',
  blocked: 'Sua conta está bloqueada.',
};

/**
 * Defesa contra CSRF para métodos que alteram estado:
 * 1) Origin/Sec-Fetch-Site precisam indicar o mesmo site;
 * 2) o cookie de sessão é SameSite=Strict (camada adicional).
 */
export function sameOriginOnly(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return next(forbidden('Origem inválida.', 'bad_origin'));
    }
    if (originHost !== req.get('host')) return next(forbidden('Origem inválida.', 'bad_origin'));
  } else if (req.get('sec-fetch-site') === 'cross-site') {
    return next(forbidden('Origem inválida.', 'bad_origin'));
  }
  next();
}

/** Exige sessão válida e, em métodos de escrita, o token CSRF vinculado à sessão. */
export function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  if (!SAFE_METHODS.has(req.method)) {
    const sent = Buffer.from(String(req.get('x-csrf-token') ?? ''));
    const expected = Buffer.from(req.session.csrfToken);
    if (sent.length !== expected.length || !timingSafeEqual(sent, expected)) {
      return next(forbidden('Token CSRF inválido.', 'bad_csrf'));
    }
  }
  next();
}

/** Contas pendentes, rejeitadas ou bloqueadas não acessam nenhuma área do sistema. */
export function requireApproved(req, _res, next) {
  if (req.user.status !== 'approved') {
    const code = `account_${req.user.status}`;
    return next(forbidden(STATUS_MESSAGES[req.user.status] ?? 'Acesso negado.', code));
  }
  next();
}

export function requireAdmin(req, _res, next) {
  if (req.user.role !== 'admin') return next(forbidden('Acesso restrito a administradores.'));
  next();
}
