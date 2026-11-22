/**
 * Entende uma proxy colada em texto e devolve { kind?, host, port, username?, password? } (ou null se não reconhecer).
 * Formatos aceitos (os que os provedores costumam entregar):
 *   socks5://usuario:senha@host:porta   http://host:porta   https://...   socks4://...   socks4a://...   socks5h://...
 *   usuario:senha@host:porta            host:porta          host:porta:usuario:senha
 * Usuário e senha em URL podem vir com %-escapes (ex.: %40 para @). Só interpreta o texto: nada é enviado a lugar nenhum.
 */
const KIND_BY_SCHEME = { http: 'http', https: 'https', socks4: 'socks4', socks4a: 'socks4', socks5: 'socks5', socks5h: 'socks5' };
const HOST = String.raw`(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)`;
const PORT = String.raw`(\d{1,5})`;

const decode = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value; // % solto: usa como veio
  }
};

const validPort = (value) => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
};

export function parseProxyUrl(input) {
  const text = String(input ?? '').trim();
  if (!text || text.length > 600 || /\s/.test(text)) return null;
  let kind;
  let rest = text;
  const scheme = /^([a-z0-9]+):\/\//i.exec(text);
  if (scheme) {
    kind = KIND_BY_SCHEME[scheme[1].toLowerCase()];
    if (!kind) return null;
    rest = text.slice(scheme[0].length).replace(/\/+$/, '');
  }

  // [usuario[:senha]@]host[:porta]  (o "@" da senha pode vir como %40; usa o ÚLTIMO "@" como separador)
  const at = rest.lastIndexOf('@');
  if (at !== -1 || scheme) {
    const auth = at === -1 ? '' : rest.slice(0, at);
    const hostPort = at === -1 ? rest : rest.slice(at + 1);
    const m = new RegExp(`^${HOST}(?::${PORT})?$`).exec(hostPort);
    if (!m) return null;
    const colon = auth.indexOf(':');
    const username = auth ? decode(colon === -1 ? auth : auth.slice(0, colon)) : undefined;
    const password = colon === -1 ? undefined : decode(auth.slice(colon + 1));
    return { ...(kind ? { kind } : {}), host: m[1].replace(/^\[(.*)\]$/, '$1'), port: m[2] ? validPort(m[2]) : null, ...(username ? { username } : {}), ...(password ? { password } : {}) };
  }

  // host:porta  ou  host:porta:usuario:senha  (a senha pode conter ":")
  const parts = rest.split(':');
  if (parts.length >= 2 && new RegExp(`^${HOST}$`).test(parts[0]) && /^\d{1,5}$/.test(parts[1])) {
    const port = validPort(parts[1]);
    if (port === null) return null;
    const result = { host: parts[0], port };
    if (parts.length >= 3 && parts[2]) result.username = parts[2];
    if (parts.length >= 4) result.password = parts.slice(3).join(':');
    return result;
  }
  return null;
}

export const PROXY_KIND_LABELS = { http: 'HTTP', https: 'HTTPS', socks4: 'SOCKS4', socks5: 'SOCKS5' };
