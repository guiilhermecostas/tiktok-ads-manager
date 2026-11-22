import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../../lib/http-error.js';

/**
 * Validação do ENDEREÇO da proxy (anti-SSRF).
 *
 * O usuário informa host e porta de um servidor ao qual o NOSSO servidor vai se conectar. Sem controle, isso permitiria
 * apontar para serviços internos (banco, metadados da nuvem, painéis administrativos) e usar "Testar" como sondagem.
 * Por isso o host é resolvido (DNS) e TODOS os endereços devolvidos precisam ser públicos; a conexão usa o IP já validado
 * (nunca o nome de novo), o que também impede "DNS rebinding".
 */

const blocked = new net.BlockList();
const BLOCKED_V4 = [
  ['0.0.0.0', 8], // "esta rede"
  ['10.0.0.0', 8], // privada
  ['100.64.0.0', 10], // CGNAT / alguns provedores de nuvem
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (inclui o endereço de metadados da nuvem, 169.254.169.254)
  ['172.16.0.0', 12], // privada
  ['192.0.0.0', 24], // protocolo IETF
  ['192.168.0.0', 16], // privada
  ['198.18.0.0', 15], // testes de desempenho
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservada (inclui 255.255.255.255)
];
const BLOCKED_V6 = [
  ['::', 128], // não especificado
  ['::1', 128], // loopback
  ['fc00::', 7], // única local (privada)
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['64:ff9b::', 96], // NAT64: embute um IPv4 que poderia ser interno
  ['100::', 64], // descarte
];
for (const [address, prefix] of BLOCKED_V4) blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) blocked.addSubnet(address, prefix, 'ipv6');

/** `::ffff:a.b.c.d` ou `::ffff:7f00:1` -> o IPv4 embutido (ou null). */
function embeddedIPv4(ip) {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

/** true se o endereço IP é interno/reservado (não pode ser usado como destino de uma proxy). */
export function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true; // o que não é IP válido nunca passa
  if (family === 6) {
    const mapped = embeddedIPv4(ip);
    if (mapped) return blocked.check(mapped, 'ipv4');
    return blocked.check(ip, 'ipv6');
  }
  return blocked.check(ip, 'ipv4');
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const NUMERIC_FORM_RE = /^(?:0x[0-9a-f]+|\d+)$/i; // "2130706433", "0x7f000001": formas obscuras de escrever IPs

const invalid = (message, code = 'proxy_host_invalid') => new HttpError(400, message, code);

/** Valida a sintaxe do host (nome ou IP) e devolve em minúsculas, sem colchetes. */
export function normalizeProxyHost(value) {
  if (typeof value !== 'string') throw invalid('Informe o endereço da proxy.');
  const host = value.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!host) throw invalid('Informe o endereço da proxy.');
  if (net.isIP(host)) return host;
  if (NUMERIC_FORM_RE.test(host) || !HOSTNAME_RE.test(host)) {
    throw invalid('Endereço da proxy inválido: use um nome (ex.: proxy.exemplo.com) ou um IP, sem “http://”, porta ou caminho.');
  }
  return host;
}

/**
 * Resolve o host e confere que TODOS os IPs são públicos (a menos que `allowPrivate`, só para desenvolvimento/testes).
 * @returns {Promise<{ address: string, family: 4|6, addresses: string[] }>} o IP a usar na conexão
 */
export async function resolveProxyHost(host, { allowPrivate = false, lookup = (name) => dns.lookup(name, { all: true, verbatim: true }) } = {}) {
  const name = normalizeProxyHost(host);
  let records;
  if (net.isIP(name)) {
    records = [{ address: name, family: net.isIP(name) }];
  } else {
    try {
      records = await lookup(name);
    } catch {
      throw invalid('Não consegui encontrar o endereço da proxy (o nome não existe ou o DNS falhou).', 'proxy_host_unresolved');
    }
  }
  if (!records?.length) throw invalid('Não consegui encontrar o endereço da proxy.', 'proxy_host_unresolved');
  const addresses = records.map((r) => r.address);
  if (!allowPrivate && addresses.some(isBlockedAddress)) {
    throw invalid('Este endereço aponta para uma rede interna ou reservada e não pode ser usado como proxy.', 'proxy_host_not_allowed');
  }
  // Prefere IPv4 (muitas proxies não atendem em IPv6).
  const chosen = records.find((r) => r.family === 4) ?? records[0];
  return { address: chosen.address, family: chosen.family, addresses };
}
