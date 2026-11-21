import { state } from './state.js';

export class ApiError extends Error {
  constructor(status, message, code, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // lista { path, message } de campos inválidos (erros de validação)
  }
}

let sessionInvalidHandler = () => {};
/** Chamado quando o servidor indica que a sessão caiu ou o status da conta mudou. */
export function onSessionInvalid(handler) {
  sessionInvalidHandler = handler;
}

async function request(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  let response;
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor. Tente novamente.', 'network');
  }

  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* corpo não-JSON */
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error?.message ?? 'Erro inesperado.', data?.error?.code, data?.error?.details);
  }
  return data;
}

export async function api(method, path, body) {
  try {
    return await request(method, path, body);
  } catch (err) {
    const authEndpoint = path.startsWith('/auth/login') || path.startsWith('/auth/register');
    const lostSession = err.status === 401 && !authEndpoint;
    const statusChanged = typeof err.code === 'string' && err.code.startsWith('account_');
    if (lostSession || statusChanged) sessionInvalidHandler();
    throw err;
  }
}

export const get = (path) => api('GET', path);
export const post = (path, body) => api('POST', path, body ?? {});
export const put = (path, body) => api('PUT', path, body);
export const patch = (path, body) => api('PATCH', path, body);
export const del = (path) => api('DELETE', path);

/**
 * Envia um arquivo (corpo binário) com progresso. XMLHttpRequest porque o `fetch` não informa o progresso do envio.
 * @returns {{ promise: Promise<object>, abort: () => void }}
 */
export function uploadFile(path, file, { onProgress } = {}) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', `/api${path}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', file.type);
    if (state.csrfToken) xhr.setRequestHeader('X-CSRF-Token', state.csrfToken);
    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    });
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* corpo não-JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
      const err = new ApiError(xhr.status, data?.error?.message ?? 'Não foi possível enviar o arquivo.', data?.error?.code, data?.error?.details);
      if (xhr.status === 401 || (typeof err.code === 'string' && err.code.startsWith('account_'))) sessionInvalidHandler();
      reject(err);
    });
    xhr.addEventListener('error', () => reject(new ApiError(0, 'Sem conexão com o servidor. Tente novamente.', 'network')));
    xhr.addEventListener('abort', () => reject(new ApiError(0, 'Envio cancelado.', 'aborted')));
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}
