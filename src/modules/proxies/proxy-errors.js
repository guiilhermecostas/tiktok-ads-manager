/**
 * Traduz falhas de conexão por proxy em um motivo curto e SEGURO para o usuário (nunca inclui usuário, senha ou o texto bruto
 * da biblioteca de rede).
 */
export function describeProxyError(err) {
  const text = `${err?.cause?.message ?? ''} ${err?.message ?? ''}`;
  // Erros do SOCKS não preenchem `code`: o código vem só na mensagem ("connect ECONNREFUSED 1.2.3.4:1080").
  const inText = /\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EPIPE|UND_ERR_CONNECT_TIMEOUT)\b/.exec(text)?.[1];
  const code = err?.cause?.code ?? err?.code ?? inText ?? '';
  if (/407|Proxy Authentication|Authentication failed|auth(?:orization)? failed|Socks5 Authentication/i.test(text)) return 'usuário ou senha da proxy recusados';
  if (/no accepted authentication type/i.test(text)) return 'a proxy exige usuário e senha';
  if (/RejectedIdent|RejectedBadIdent/i.test(text)) return 'usuário (identificador) recusado pela proxy';
  if (/\(ConnectionRefused\)/i.test(text)) return 'o TikTok recusou a conexão vinda da proxy';
  if (/HostUnreachable|NetworkUnreachable|TTLExpired|ConnectionNotAllowed/i.test(text)) return 'a proxy não conseguiu alcançar o TikTok';
  // O undici devolve "Request was cancelled" quando a proxy HTTP recusa o túnel (ex.: 407): não diz o motivo.
  if (/Request was cancelled/i.test(text)) return 'a proxy HTTP recusou a conexão (confira usuário, senha e se o IP deste servidor tem permissão nela)';
  if (code === 'ECONNREFUSED') return 'conexão recusada pela proxy';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'não foi possível encontrar o endereço da proxy';
  if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ABORT_ERR'].includes(code) || err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timed? ?out|timeout/i.test(text)) return 'a proxy não respondeu a tempo';
  if (/certificate|CERT_|self.signed|TLS|SSL/i.test(`${code} ${text}`)) return 'falha de segurança (TLS) na conexão com o TikTok pela proxy';
  if (['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'SocketError'].includes(code) || /socket|closed|reset/i.test(text)) return 'a proxy encerrou a conexão';
  if (/Socks|proxy/i.test(text)) return 'a proxy recusou a conexão';
  return 'falha na conexão pela proxy';
}
