import { HttpError } from '../lib/http-error.js';

export function apiNotFound(_req, res) {
  res.status(404).json({ error: { message: 'Rota não encontrada.', code: 'not_found' } });
}

export function errorHandler(log = console) {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
      const error = { message: err.message, code: err.code };
      if (err.details) error.details = err.details;
      return res.status(err.status).json({ error });
    }
    // JSON malformado / corpo grande demais (body-parser do Express).
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: { message: 'Corpo da requisição inválido.', code: 'bad_body' } });
    }
    // Erros 4xx do próprio Express/`send` (ex.: Range inválido = 416): o status vale, o texto interno não vai ao cliente.
    if (Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 && err.expose) {
      return res.status(err.status).json({ error: { message: 'Requisição inválida.', code: 'bad_request' } });
    }
    // Nunca vaza detalhes internos ao cliente.
    log.error(`[erro] ${req.method} ${req.path}:`, err);
    res.status(500).json({ error: { message: 'Erro interno do servidor.', code: 'internal_error' } });
  };
}
