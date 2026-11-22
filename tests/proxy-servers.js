import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Servidores locais para testar o roteamento por proxy de verdade:
 *  - `startTarget`: um "TikTok" em HTTPS (certificado de teste) que diz por qual conexão a requisição chegou;
 *  - `startConnectProxy`: proxy HTTP (túnel CONNECT) com autenticação opcional;
 *  - `startSocksProxy`: proxy SOCKS5 (usuário/senha) ou SOCKS4/4a.
 * Todos registram o que viram, para os testes provarem que o tráfego PASSOU pela proxy.
 */
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
export const TEST_CERT = fs.readFileSync(path.join(FIXTURES, 'localhost-cert.pem'));
const TEST_KEY = fs.readFileSync(path.join(FIXTURES, 'localhost-key.pem'));

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const closeAll = (server, sockets) => new Promise((resolve) => {
  for (const socket of sockets) socket.destroy();
  server.close(() => resolve());
});

function trackSockets(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return sockets;
}

/** "TikTok" local em HTTPS. Responde no formato do TikTok e informa o IP de origem e o token recebido. */
export async function startTarget() {
  const requests = [];
  const server = https.createServer({ key: TEST_KEY, cert: TEST_CERT }, (req, res) => {
    requests.push({ url: req.url, method: req.method, remote: req.socket.remoteAddress, token: req.headers['access-token'] ?? null, host: req.headers.host });
    req.resume();
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: 0, message: 'OK', data: { reached: true, list: [] } }));
  });
  const sockets = trackSockets(server);
  const port = await listen(server);
  return { port, origin: `https://localhost:${port}`, requests, close: () => closeAll(server, sockets) };
}

/** Proxy HTTP com túnel CONNECT. `auth` = { username, password } exige Proxy-Authorization (Basic). */
export async function startConnectProxy({ auth = null } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    res.writeHead(405);
    res.end(); // só aceita túnel
  });
  const sockets = trackSockets(server);
  server.on('connect', (req, clientSocket, head) => {
    const header = req.headers['proxy-authorization'];
    const expected = auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` : null;
    const entry = { target: req.url, authorized: !expected || header === expected, authHeader: header ?? null };
    seen.push(entry);
    if (!entry.authorized) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="proxy"\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  const port = await listen(server);
  return { port, seen, close: () => closeAll(server, sockets) };
}

/** Proxy SOCKS. `version` 5 (com `auth` opcional) ou 4 (SOCKS4/4a, `userId` opcional). */
export async function startSocksProxy({ version = 5, auth = null, userId = null } = {}) {
  const seen = [];
  const server = net.createServer((client) => {
    client.on('error', () => client.destroy());
    const finish = (host, port, entry, reply) => {
      seen.push(entry);
      const upstream = net.connect(port, host, () => {
        client.write(reply);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
    };

    if (version === 4) {
      client.once('data', (data) => {
        // 04 01 PORT(2) IP(4) USERID 00 [HOST 00 se IP = 0.0.0.x (SOCKS4a)]
        const port = data.readUInt16BE(2);
        const ip = [...data.subarray(4, 8)];
        const end = data.indexOf(0, 8);
        const user = data.toString('utf8', 8, end);
        const is4a = ip[0] === 0 && ip[1] === 0 && ip[2] === 0 && ip[3] !== 0;
        const host = is4a ? data.toString('utf8', end + 1, data.indexOf(0, end + 1)) : ip.join('.');
        const authorized = userId === null || user === userId;
        if (!authorized) {
          seen.push({ host, port, authorized: false, version: 4 });
          client.end(Buffer.from([0, 0x5d, 0, 0, 0, 0, 0, 0]));
          return;
        }
        finish(host === 'localhost' ? '127.0.0.1' : host, port, { host, port, authorized: true, version: 4, is4a, user }, Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
      });
      return;
    }

    let stage = 'greeting';
    let user = null;
    client.on('data', (data) => {
      if (stage === 'greeting') {
        const methods = [...data.subarray(2, 2 + data[1])];
        const wanted = auth ? 0x02 : 0x00;
        if (!methods.includes(wanted)) {
          client.end(Buffer.from([5, 0xff]));
          return;
        }
        client.write(Buffer.from([5, wanted]));
        stage = auth ? 'auth' : 'request';
      } else if (stage === 'auth') {
        const ulen = data[1];
        user = data.toString('utf8', 2, 2 + ulen);
        const plen = data[2 + ulen];
        const pass = data.toString('utf8', 3 + ulen, 3 + ulen + plen);
        if (user === auth.username && pass === auth.password) {
          client.write(Buffer.from([1, 0]));
          stage = 'request';
        } else {
          seen.push({ authorized: false, user, version: 5 });
          client.end(Buffer.from([1, 1]));
        }
      } else if (stage === 'request') {
        stage = 'tunnel';
        const atyp = data[3];
        let host;
        let offset;
        if (atyp === 1) {
          host = [...data.subarray(4, 8)].join('.');
          offset = 8;
        } else if (atyp === 3) {
          const len = data[4];
          host = data.toString('utf8', 5, 5 + len);
          offset = 5 + len;
        } else {
          client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const port = data.readUInt16BE(offset);
        client.removeAllListeners('data');
        finish(host === 'localhost' ? '127.0.0.1' : host, port, { host, port, atyp, authorized: true, user, version: 5 }, Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
      }
    });
  });
  const sockets = trackSockets(server);
  const port = await listen(server);
  return { port, seen, close: () => closeAll(server, sockets) };
}
