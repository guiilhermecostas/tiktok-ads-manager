export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (msg, code = 'bad_request') => new HttpError(400, msg, code);
export const unauthorized = (msg = 'Não autenticado.') => new HttpError(401, msg, 'unauthorized');
export const forbidden = (msg = 'Acesso negado.', code = 'forbidden') => new HttpError(403, msg, code);
export const notFound = (msg = 'Recurso não encontrado.') => new HttpError(404, msg, 'not_found');
export const tooMany = (retryAfterSec) => {
  const err = new HttpError(429, 'Muitas tentativas. Aguarde e tente novamente.', 'rate_limited');
  err.retryAfterSec = retryAfterSec;
  return err;
};

/** Erro de validação com a lista de campos inválidos ({ path, message }) para o formulário destacar. */
export const validationError = (details) => {
  const first = details[0];
  const err = new HttpError(400, first?.message ? `Revise os campos: ${first.message}` : 'Revise os campos informados.', 'validation_error');
  err.details = details.slice(0, 50);
  return err;
};
