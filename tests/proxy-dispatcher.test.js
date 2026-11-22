import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createProxyDispatcher } from '../src/modules/proxies/proxy-dispatcher.js';
import { describeProxyError } from '../src/modules/proxies/proxy-errors.js';
import { TEST_CERT, startConnectProxy, startSocksProxy, startTarget } from './proxy-servers.js';

/** Faz uma chamada HTTPS ao "TikTok" local pelo dispatcher (o mesmo mecanismo que o cliente real usa). */
const call = async (dispatcher, target, token = 'tok-secreto-123') => {
  const response = await fetch(`${target.origin}/open_api/v1.3/teste/`, { headers: { 'Access-Token': token }, dispatcher, signal: AbortSignal.timeout(8000) });
  return response.json();
};
const TRUST = { ca: TEST_CERT }; // o certificado do "TikTok" de teste é autoassinado

describe('roteamento por proxy (servidores locais de verdade)', () => {
  let target;
  const closers = [];
  before(async () => {
    target = await startTarget();
  });
  after(async () => {
    await target.close();
    for (const close of closers) await close();
  });
  const start = async (starter, options) => {
    const server = await starter(options);
    closers.push(server.close);
    return server;
  };
  const dispatcherFor = (kind, server, extra = {}) => {
    const dispatcher = createProxyDispatcher({ kind, address: '127.0.0.1', port: server.port, requestTls: TRUST, ...extra });
    closers.push(() => dispatcher.close());
    return dispatcher;
  };
  const targetHits = () => target.requests.length;

  describe('HTTP (túnel CONNECT)', () => {
    it('a chamada passa pela proxy: ela vê só o destino e a requisição chega com o token intacto', async () => {
      const proxy = await start(startConnectProxy);
      const hitsBefore = targetHits();
      const body = await call(dispatcherFor('http', proxy), target);
      assert.deepEqual(body.data.reached, true);
      assert.deepEqual(proxy.seen.map((s) => s.target), [`localhost:${target.port}`], 'a proxy abriu o túnel para o destino');
      assert.equal(targetHits(), hitsBefore + 1);
      assert.equal(target.requests.at(-1).token, 'tok-secreto-123');
    });

    it('com autenticação: usuário e senha corretos entram; errados, ausentes ou de outro usuário são recusados (407) e NADA chega ao destino', async () => {
      const proxy = await start(startConnectProxy, { auth: { username: 'cliente-us', password: 's3nha:com:dois-pontos' } });
      const hitsBefore = targetHits();
      await call(dispatcherFor('http', proxy, { username: 'cliente-us', password: 's3nha:com:dois-pontos' }), target);
      assert.equal(proxy.seen.at(-1).authorized, true);
      assert.equal(targetHits(), hitsBefore + 1);

      for (const wrong of [{ username: 'cliente-us', password: 'errada' }, { username: 'outro', password: 's3nha:com:dois-pontos' }, {}]) {
        await assert.rejects(() => call(dispatcherFor('http', proxy, wrong), target));
      }
      assert.equal(targetHits(), hitsBefore + 1, 'tentativas recusadas nunca chegaram ao destino');
      assert.equal(proxy.seen.filter((s) => !s.authorized).length >= 2, true);
    });
  });

  describe('SOCKS5', () => {
    it('sem autenticação: o NOME do destino vai para a proxy (resolução remota), não um IP', async () => {
      const proxy = await start(startSocksProxy, { version: 5 });
      const hitsBefore = targetHits();
      assert.equal((await call(dispatcherFor('socks5', proxy), target)).data.reached, true);
      assert.deepEqual([proxy.seen[0].host, proxy.seen[0].port, proxy.seen[0].atyp], ['localhost', target.port, 3], 'tipo de endereço 3 = nome de domínio');
      assert.equal(targetHits(), hitsBefore + 1);
    });

    it('com usuário e senha: corretos funcionam; errados são recusados e nada chega ao destino', async () => {
      const proxy = await start(startSocksProxy, { version: 5, auth: { username: 'resi-us-sess1', password: 'pw-ç€' } });
      const hitsBefore = targetHits();
      await call(dispatcherFor('socks5', proxy, { username: 'resi-us-sess1', password: 'pw-ç€' }), target);
      assert.equal(proxy.seen.at(-1).user, 'resi-us-sess1');
      assert.equal(targetHits(), hitsBefore + 1);
      await assert.rejects(() => call(dispatcherFor('socks5', proxy, { username: 'resi-us-sess1', password: 'errada' }), target));
      await assert.rejects(() => call(dispatcherFor('socks5', proxy), target), 'sem credenciais quando a proxy exige');
      assert.equal(targetHits(), hitsBefore + 1);
    });
  });

  describe('SOCKS4', () => {
    it('SOCKS4a: entrega o nome do destino e o identificador de usuário', async () => {
      const proxy = await start(startSocksProxy, { version: 4, userId: 'meu-id' });
      const hitsBefore = targetHits();
      assert.equal((await call(dispatcherFor('socks4', proxy, { username: 'meu-id' }), target)).data.reached, true);
      assert.deepEqual([proxy.seen[0].host, proxy.seen[0].is4a, proxy.seen[0].user], ['localhost', true, 'meu-id']);
      assert.equal(targetHits(), hitsBefore + 1);
    });

    it('identificador de usuário errado é recusado e nada chega ao destino', async () => {
      const proxy = await start(startSocksProxy, { version: 4, userId: 'meu-id' });
      const hitsBefore = targetHits();
      await assert.rejects(() => call(dispatcherFor('socks4', proxy, { username: 'intruso' }), target));
      assert.equal(targetHits(), hitsBefore);
    });
  });

  describe('segurança e falhas (nunca cai para conexão direta)', () => {
    it('o TLS é de PONTA A PONTA: certificado do destino não confiável é recusado mesmo através da proxy (ela não consegue interceptar)', async () => {
      const connect = await start(startConnectProxy);
      const socks = await start(startSocksProxy, { version: 5 });
      const hitsBefore = targetHits();
      for (const dispatcher of [createProxyDispatcher({ kind: 'http', address: '127.0.0.1', port: connect.port }), createProxyDispatcher({ kind: 'socks5', address: '127.0.0.1', port: socks.port })]) {
        await assert.rejects(() => call(dispatcher, target), /fetch failed/);
        closers.push(() => dispatcher.close());
      }
      assert.equal(targetHits(), hitsBefore, 'nenhuma requisição foi entregue sem o TLS verificado');
    });

    it('proxy inacessível (porta fechada): erro imediato, SEM tentar o destino diretamente', async () => {
      const dead = await startConnectProxy();
      const { port } = dead;
      await dead.close();
      const hitsBefore = targetHits();
      for (const kind of ['http', 'socks5', 'socks4']) {
        await assert.rejects(() => call(createProxyDispatcher({ kind, address: '127.0.0.1', port, requestTls: TRUST }), target), /fetch failed/, kind);
      }
      assert.equal(targetHits(), hitsBefore, 'o destino nunca foi alcançado fora da proxy');
    });

    it('proxy que aceita a conexão mas é mal-comportada (fecha sem responder) vira erro, sem travar', async () => {
      const net = await import('node:net');
      const server = net.createServer((socket) => socket.destroy());
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      closers.push(() => new Promise((resolve) => server.close(resolve)));
      for (const kind of ['http', 'socks5']) {
        await assert.rejects(() => call(createProxyDispatcher({ kind, address: '127.0.0.1', port: server.address().port, requestTls: TRUST }), target), /fetch failed/, kind);
      }
    });

    it('tipo desconhecido é recusado; endereço IPv6 da proxy é montado com colchetes', () => {
      assert.throws(() => createProxyDispatcher({ kind: 'ftp', address: '127.0.0.1', port: 21 }), /desconhecido/);
      const v6 = createProxyDispatcher({ kind: 'http', address: '2606:4700:4700::1111', port: 8080 });
      assert.ok(v6);
      return v6.close();
    });
  });

  it('várias chamadas seguidas reaproveitam o dispatcher e todas passam pela proxy', async () => {
    const proxy = await start(startConnectProxy);
    const dispatcher = dispatcherFor('http', proxy);
    const hitsBefore = targetHits();
    for (let i = 0; i < 5; i += 1) await call(dispatcher, target, `t${i}`);
    assert.equal(targetHits(), hitsBefore + 5);
    assert.ok(proxy.seen.length >= 1 && proxy.seen.every((s) => s.target === `localhost:${target.port}`));
    assert.deepEqual(target.requests.slice(-5).map((r) => r.token), ['t0', 't1', 't2', 't3', 't4']);
  });
});

describe('compatibilidade do fetch com os dispatchers (checagem da subida do servidor)', () => {
  it('o fetch deste ambiente aceita os dispatchers HTTP e SOCKS', async () => {
    const { proxyRuntimeSelfCheck } = await import('../src/modules/proxies/proxy-dispatcher.js');
    assert.deepEqual(await proxyRuntimeSelfCheck(), { ok: true });
  });
});

describe('mensagens de erro do usuário (traduzidas a partir dos erros REAIS de cada tipo de proxy)', () => {
  let target;
  const closers = [];
  before(async () => {
    target = await startTarget();
  });
  after(async () => {
    await target.close();
    for (const close of closers) await close();
  });
  const failure = async (kind, server, extra = {}, trusted = true) => {
    const dispatcher = createProxyDispatcher({ kind, address: '127.0.0.1', port: server.port, requestTls: trusted ? TRUST : undefined, ...extra });
    closers.push(() => dispatcher.close());
    try {
      await call(dispatcher, target);
    } catch (err) {
      return describeProxyError(err);
    }
    return 'NÃO FALHOU';
  };

  it('usuário/senha recusados (HTTP 407, SOCKS5 e SOCKS4) viram mensagens claras', async () => {
    const http = await startConnectProxy({ auth: { username: 'u', password: 'p' } });
    const socks5 = await startSocksProxy({ version: 5, auth: { username: 'u', password: 'p' } });
    const socks4 = await startSocksProxy({ version: 4, userId: 'certo' });
    closers.push(http.close, socks5.close, socks4.close);
    assert.match(await failure('http', http, { username: 'u', password: 'errada' }), /usuário, senha/, 'HTTP: o undici só informa que o túnel foi recusado');
    assert.equal(await failure('socks5', socks5, { username: 'u', password: 'errada' }), 'usuário ou senha da proxy recusados');
    assert.equal(await failure('socks5', socks5), 'a proxy exige usuário e senha', 'sem credenciais');
    assert.equal(await failure('socks4', socks4, { username: 'errado' }), 'usuário (identificador) recusado pela proxy');
  });

  it('porta fechada (HTTP, SOCKS5, SOCKS4) -> "conexão recusada pela proxy"', async () => {
    const dead = await startConnectProxy();
    const { port } = dead;
    await dead.close();
    for (const kind of ['http', 'socks5', 'socks4']) assert.equal(await failure(kind, { port }), 'conexão recusada pela proxy', kind);
  });

  it('certificado do TikTok não confiável através da proxy -> falha de segurança (TLS)', async () => {
    const http = await startConnectProxy();
    const socks = await startSocksProxy({ version: 5 });
    closers.push(http.close, socks.close);
    assert.match(await failure('http', http, {}, false), /TLS/);
    assert.match(await failure('socks5', socks, {}, false), /TLS/);
  });

  it('nenhuma mensagem traduzida vaza usuário, senha ou o texto bruto da biblioteca', async () => {
    const http = await startConnectProxy({ auth: { username: 'usuario-secreto', password: 'senha-secreta' } });
    closers.push(http.close);
    const message = await failure('http', http, { username: 'usuario-secreto', password: 'errada-senha-xyz' });
    assert.ok(!/usuario-secreto|errada-senha-xyz|senha-secreta|undici|UND_ERR|Basic /i.test(message), message);
  });
});
