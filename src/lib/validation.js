import { badRequest } from './http-error.js';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/;

export function asObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('Corpo da requisição inválido.');
  }
  return body;
}

export function parseEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !EMAIL_RE.test(email)) throw badRequest('Informe um e-mail válido.');
  return email;
}

export function parseText(value, label, { min = 2, max = 80, required = true } = {}) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text && !required) return null;
  if (text.length < min || text.length > max) {
    throw badRequest(`${label} deve ter entre ${min} e ${max} caracteres.`);
  }
  if (CONTROL_CHARS_RE.test(text)) throw badRequest(`${label} contém caracteres inválidos.`);
  return text;
}

export function parsePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw badRequest('A senha deve ter entre 10 e 128 caracteres.');
  }
  return value;
}

export function parseEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw badRequest(`${label} inválido.`);
  }
  return value;
}

export function parseId(value) {
  const id = Number(value);
  // Limite do int4 do banco: um ID maior que isso nunca existe (e faria o Postgres responder com erro 500).
  if (!Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647) throw badRequest('Identificador inválido.');
  return id;
}

/** Valor monetário em centavos (inteiro, 0 a 100.000.000). */
export function parseCents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100_000_000) {
    throw badRequest(`${label} inválido.`);
  }
  return value;
}
