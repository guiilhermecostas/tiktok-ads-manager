import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseProxyUrl } from '../public/js/proxy-url.js';

describe('colar proxy: reconhece os formatos que os provedores entregam', () => {
  it('URL com esquema: tipo, usuário, senha, host e porta', () => {
    assert.deepEqual(parseProxyUrl('socks5://usuario:senha@proxy.exemplo.com:1080'), { kind: 'socks5', host: 'proxy.exemplo.com', port: 1080, username: 'usuario', password: 'senha' });
    assert.deepEqual(parseProxyUrl('http://203.0.113.7:8080'), { kind: 'http', host: '203.0.113.7', port: 8080 });
    assert.deepEqual(parseProxyUrl('HTTPS://u:p@h.example.com:443/'), { kind: 'https', host: 'h.example.com', port: 443, username: 'u', password: 'p' });
    assert.equal(parseProxyUrl('socks4://1.2.3.4:1080').kind, 'socks4');
    assert.equal(parseProxyUrl('socks4a://1.2.3.4:1080').kind, 'socks4', 'socks4a vira socks4');
    assert.equal(parseProxyUrl('socks5h://1.2.3.4:1080').kind, 'socks5', 'socks5h vira socks5');
  });

  it('sem esquema: usuario:senha@host:porta, host:porta e host:porta:usuario:senha (senha pode ter ":")', () => {
    assert.deepEqual(parseProxyUrl('user:pw@203.0.113.7:3128'), { host: '203.0.113.7', port: 3128, username: 'user', password: 'pw' });
    assert.deepEqual(parseProxyUrl('203.0.113.7:3128'), { host: '203.0.113.7', port: 3128 });
    assert.deepEqual(parseProxyUrl('203.0.113.7:3128:cliente-us:abc:def'), { host: '203.0.113.7', port: 3128, username: 'cliente-us', password: 'abc:def' });
    assert.deepEqual(parseProxyUrl('us.resi.net:9000:customer-x-cc-us:senha'), { host: 'us.resi.net', port: 9000, username: 'customer-x-cc-us', password: 'senha' });
  });

  it('decodifica %-escapes, usa o último "@" como separador e aceita IPv6 entre colchetes', () => {
    assert.deepEqual(parseProxyUrl('socks5://me%40mail.com:p%3Aw%40ss@h.example.com:1080'), { kind: 'socks5', host: 'h.example.com', port: 1080, username: 'me@mail.com', password: 'p:w@ss' });
    assert.equal(parseProxyUrl('http://a@b:c@h.example.com:80').username, 'a@b');
    assert.deepEqual(parseProxyUrl('http://[2606:4700:4700::1111]:8080'), { kind: 'http', host: '2606:4700:4700::1111', port: 8080 });
    assert.equal(parseProxyUrl('http://u:100%@h.example.com:80').password, '100%', '% solto não quebra');
  });

  it('esquema sem porta devolve porta nula (o formulário pede)', () => {
    assert.deepEqual(parseProxyUrl('socks5://proxy.exemplo.com'), { kind: 'socks5', host: 'proxy.exemplo.com', port: null });
  });

  it('não reconhece o que não é proxy (e nunca lança)', () => {
    for (const bad of ['', '   ', null, undefined, 42, 'ftp://x.com:21', 'javascript:alert(1)', 'http://', 'host', 'host:abc', 'host:99999', 'a b:80', 'http://host:port', 'socks5://:1080', 'x'.repeat(700), '<script>:80', 'http://h.example.com:0']) {
      const result = parseProxyUrl(bad);
      assert.ok(result === null || result.port === null, `${JSON.stringify(bad)} -> ${JSON.stringify(result)}`);
    }
    assert.equal(parseProxyUrl('host:99999'), null);
  });
});
