import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HttpError } from '../src/lib/http-error.js';
import { isBlockedAddress, normalizeProxyHost, resolveProxyHost } from '../src/modules/proxies/proxy-net.js';

const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof HttpError && e.status === 400 && e.code === code, `esperava ${code}`);
const lookupOf = (...addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('proxy: endereços internos/reservados são bloqueados (anti-SSRF)', () => {
  it('bloqueia loopback, redes privadas, link-local (metadados da nuvem), CGNAT, multicast e reservadas (IPv4)', () => {
    for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.255.255', '169.254.169.254', '169.254.0.1', '100.64.0.1', '100.127.255.255', '0.0.0.0', '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '198.18.0.1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it('bloqueia loopback, local única, link-local, multicast e NAT64 (IPv6) e IPv4 interno embutido em IPv6', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '64:ff9b::7f00:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.5', '::ffff:a9fe:a9fe', '::ffff:192.168.1.1']) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
  });

  it('libera endereços públicos (fronteiras das faixas privadas incluídas)', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.113.7', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.255.255', '169.255.0.1', '11.0.0.1', '9.255.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
      assert.equal(isBlockedAddress(ip), false, ip);
    }
  });

  it('o que não é IP nunca passa', () => {
    for (const value of ['', 'localhost', 'abc', '1.2.3', '999.1.1.1', null, undefined]) assert.equal(isBlockedAddress(value), true, String(value));
  });
});

describe('proxy: sintaxe do host', () => {
  it('aceita nomes e IPs (minúsculas, sem colchetes)', () => {
    assert.equal(normalizeProxyHost('  Proxy.Exemplo.COM '), 'proxy.exemplo.com');
    assert.equal(normalizeProxyHost('203.0.113.7'), '203.0.113.7');
    assert.equal(normalizeProxyHost('[2606:4700:4700::1111]'), '2606:4700:4700::1111');
    assert.equal(normalizeProxyHost('us-1.resi-proxy.net'), 'us-1.resi-proxy.net');
    assert.equal(normalizeProxyHost('a'.repeat(63)), 'a'.repeat(63));
  });

  it('recusa URL, porta, caminho, espaços, caracteres de controle, formas numéricas obscuras e tamanhos absurdos', () => {
    for (const bad of ['', '   ', 'http://proxy.com', 'proxy.com:8080', 'proxy.com/path', 'proxy com', 'proxy\n.com', 'pro\u0000xy.com', '-proxy.com', 'proxy-.com', 'proxy..com', '.proxy.com', 'proxy.com.', '2130706433', '0x7f000001', 'user@proxy.com', 'pr%6fxy.com', '<script>', 'a'.repeat(64), `${'a.'.repeat(130)}com`, 'prøxy.com', null, 42, {}, ['x']]) {
      assert.throws(() => normalizeProxyHost(bad), (e) => e instanceof HttpError && e.code === 'proxy_host_invalid', JSON.stringify(bad));
    }
  });
});

describe('proxy: resolução do host', () => {
  it('nome que resolve para IP público: devolve o IP a ser usado (prefere IPv4)', async () => {
    const result = await resolveProxyHost('proxy.exemplo.com', { lookup: lookupOf('2606:4700:4700::1111', '203.0.113.7') });
    assert.deepEqual([result.address, result.family], ['203.0.113.7', 4]);
    assert.equal((await resolveProxyHost('proxy.exemplo.com', { lookup: lookupOf('2606:4700:4700::1111') })).family, 6);
  });

  it('IP literal público passa sem consultar o DNS', async () => {
    const lookup = async () => { throw new Error('não deveria consultar'); };
    assert.equal((await resolveProxyHost('203.0.113.7', { lookup })).address, '203.0.113.7');
  });

  it('IP literal interno é recusado', async () => {
    for (const ip of ['127.0.0.1', '10.0.0.8', '169.254.169.254', '192.168.1.1', '::1', '[::1]', '::ffff:127.0.0.1']) {
      await rejects(resolveProxyHost(ip), 'proxy_host_not_allowed');
    }
  });

  it('nome que resolve para endereço interno é recusado (inclusive se SÓ UM dos endereços for interno)', async () => {
    await rejects(resolveProxyHost('interno.exemplo.com', { lookup: lookupOf('10.1.2.3') }), 'proxy_host_not_allowed');
    await rejects(resolveProxyHost('localhost', { lookup: lookupOf('127.0.0.1', '::1') }), 'proxy_host_not_allowed');
    await rejects(resolveProxyHost('misto.exemplo.com', { lookup: lookupOf('203.0.113.7', '169.254.169.254') }), 'proxy_host_not_allowed');
    await rejects(resolveProxyHost('rebind.exemplo.com', { lookup: lookupOf('::ffff:7f00:1') }), 'proxy_host_not_allowed');
  });

  it('formas obscuras de escrever 127.0.0.1 não passam (recusadas na sintaxe, ou pelo IP resolvido)', async () => {
    await rejects(resolveProxyHost('2130706433'), 'proxy_host_invalid');
    await rejects(resolveProxyHost('0x7f000001'), 'proxy_host_invalid');
    await rejects(resolveProxyHost('0177.0.0.1', { lookup: lookupOf('127.0.0.1') }), 'proxy_host_not_allowed'); // o resolvedor do sistema entende octal
  });

  it('DNS que falha ou não devolve nada vira erro claro', async () => {
    await rejects(resolveProxyHost('nao-existe.exemplo.com', { lookup: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); } }), 'proxy_host_unresolved');
    await rejects(resolveProxyHost('vazio.exemplo.com', { lookup: async () => [] }), 'proxy_host_unresolved');
  });

  it('allowPrivate (só desenvolvimento/testes) libera redes internas, mas a sintaxe continua sendo validada', async () => {
    assert.equal((await resolveProxyHost('127.0.0.1', { allowPrivate: true })).address, '127.0.0.1');
    assert.equal((await resolveProxyHost('local.exemplo.com', { allowPrivate: true, lookup: lookupOf('10.0.0.9') })).address, '10.0.0.9');
    await rejects(resolveProxyHost('http://x', { allowPrivate: true }), 'proxy_host_invalid');
  });
});
