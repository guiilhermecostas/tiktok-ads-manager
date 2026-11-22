import net from 'node:net';
import tls from 'node:tls';
import { Agent, ProxyAgent } from 'undici';
import { SocksClient } from 'socks';

/**
 * Dispatcher (para o `fetch`) que leva TODA a conexão para o destino por uma proxy.
 *
 * Tipos: `http` e `https` (túnel HTTP CONNECT; o `https` fala TLS com a própria proxy) e `socks4` e `socks5` (SOCKS4/4a e 5, com
 * usuário/senha no SOCKS5). O destino é sempre HTTPS: o TLS é negociado DE PONTA A PONTA com o TikTok, com verificação do
 * certificado, então a proxy só enxerga bytes cifrados (não consegue ler nem alterar o token ou os dados).
 *
 * O endereço da proxy chega JÁ RESOLVIDO e validado (veja proxy-net.js): aqui nunca se faz nova consulta de DNS do nome dela.
 * O nome do DESTINO é entregue à proxy (resolução remota): nenhum DNS do TikTok sai do servidor.
 */

export const PROXY_KINDS = ['http', 'https', 'socks4', 'socks5'];

/**
 * Compatibilidade (na subida do servidor): o `fetch` do Node usa o undici embutido no Node e o dispatcher vem do pacote `undici`.
 * Confere, no ambiente real, que o `fetch` ACEITA os dois tipos de dispatcher (HTTP e SOCKS): aponta para uma porta local
 * fechada e espera "conexão recusada" (e não um erro de dispatcher incompatível). Nunca lança: { ok } ou { ok: false, error }.
 */
export async function proxyRuntimeSelfCheck() {
  const closedPort = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  }).catch(() => null);
  if (!closedPort) return { ok: false, error: 'não consegui reservar uma porta local para o teste.' };
  for (const kind of ['http', 'socks5']) {
    const dispatcher = createProxyDispatcher({ kind, address: '127.0.0.1', port: closedPort });
    try {
      await fetch('https://example.invalid/', { dispatcher, signal: AbortSignal.timeout(5000) });
      return { ok: false, error: `o ${kind} não falhou como esperado.` };
    } catch (err) {
      const refused = err?.cause?.code === 'ECONNREFUSED' || /ECONNREFUSED/.test(String(err?.cause?.message)); // o SOCKS só traz o código na mensagem
      const code = err?.cause?.code;
      if (!refused) return { ok: false, error: `o fetch não aceitou o dispatcher ${kind} (${code ?? err?.name}: ${String(err?.cause?.message ?? err?.message).slice(0, 120)}).` };
    } finally {
      await dispatcher.close().catch(() => {});
    }
  }
  return { ok: true };
}
export const CONNECT_TIMEOUT_MS = 10_000;

const bracket = (address) => (net.isIPv6(address) ? `[${address}]` : address);
const basicToken = (username, password) => `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`;

/** Conector do undici que abre o túnel por uma proxy SOCKS e, para destino HTTPS, negocia o TLS sobre ele. */
function socksConnector({ kind, address, port, username, password, requestTls }) {
  return (options, callback) => {
    const secure = options.protocol === 'https:';
    const destinationPort = Number(options.port) || (secure ? 443 : 80);
    SocksClient.createConnection({
      proxy: { host: address, port, type: kind === 'socks4' ? 4 : 5, ...(username ? { userId: username, password: password ?? '' } : {}) },
      command: 'connect',
      destination: { host: options.hostname, port: destinationPort },
      timeout: CONNECT_TIMEOUT_MS,
    })
      .then(({ socket }) => {
        if (!secure) return callback(null, socket);
        const servername = options.servername || (net.isIP(options.hostname) ? undefined : options.hostname);
        const secureSocket = tls.connect({ ...requestTls, socket, servername, ALPNProtocols: ['http/1.1'] });
        const onError = (err) => {
          secureSocket.destroy();
          callback(err);
        };
        secureSocket.once('error', onError);
        secureSocket.once('secureConnect', () => {
          secureSocket.removeListener('error', onError);
          callback(null, secureSocket);
        });
        return undefined;
      })
      .catch((err) => callback(err));
  };
}

/**
 * @param {object} options
 * @param {'http'|'https'|'socks4'|'socks5'} options.kind
 * @param {string} options.address   IP da proxy já validado
 * @param {number} options.port
 * @param {string} [options.hostname] nome original da proxy (usado como SNI/identidade do certificado em proxy `https`)
 * @param {string|null} [options.username]
 * @param {string|null} [options.password]
 * @param {object} [options.requestTls] opções TLS do destino (ex.: `ca` nos testes com certificado próprio)
 */
export function createProxyDispatcher({ kind, address, port, hostname, username = null, password = null, requestTls }) {
  if (!PROXY_KINDS.includes(kind)) throw new Error(`Tipo de proxy desconhecido: ${kind}`);
  if (kind === 'socks4' || kind === 'socks5') {
    return new Agent({ connect: socksConnector({ kind, address, port, username, password, requestTls }), allowH2: false });
  }
  return new ProxyAgent({
    uri: `${kind}://${bracket(address)}:${port}`,
    ...(username ? { token: basicToken(username, password) } : {}),
    proxyTunnel: true, // sempre CONNECT: o conteúdo segue cifrado de ponta a ponta
    ...(kind === 'https' ? { proxyTls: { servername: hostname && !net.isIP(hostname) ? hostname : undefined, rejectUnauthorized: true } } : {}),
    ...(requestTls ? { requestTls } : {}),
    allowH2: false,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
}
