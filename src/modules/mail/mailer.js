import { HttpError } from '../../lib/http-error.js';

const RESEND_URL = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 10_000;
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}\.[^\s@<>",;]{2,}$/;
const NO_LINE_BREAKS_RE = /[\r\n\0]/;

const SEND_FAILED = () => new HttpError(502, 'Não foi possível enviar o e-mail agora. Tente novamente em instantes.', 'email_failed');

/**
 * Envio de e-mail pelo Resend (https://resend.com/docs/api-reference/emails/send-email).
 *  - A chave da API fica só no servidor e nunca é registrada nos logs nem devolvida em erros.
 *  - Falhas viram um erro genérico 502 (o motivo real vai só para o log, sem dados do destinatário).
 *  - Destinatário e assunto não podem conter quebra de linha (injeção de cabeçalhos).
 *  - Sem redirecionamentos e com limite de tempo: um servidor lento não prende a requisição.
 * `fetchFn` é injetável para os testes.
 */
export function createMailer({ config, fetchFn = fetch, log = console, timeoutMs = SEND_TIMEOUT_MS }) {
  const { apiKey, from, enabled } = config.mail;
  return {
    enabled,
    /** Devolve `{ id }` do e-mail no Resend. `idempotencyKey` evita enviar duas vezes o mesmo e-mail se a chamada se repetir. */
    async send({ to, subject, html, text, idempotencyKey }) {
      if (!enabled) throw new HttpError(503, 'O envio de e-mails não está configurado neste servidor.', 'email_not_configured');
      if (typeof to !== 'string' || !EMAIL_RE.test(to) || to.length > 254) throw new Error('Destinatário de e-mail inválido.');
      if (typeof subject !== 'string' || !subject || subject.length > 200 || NO_LINE_BREAKS_RE.test(subject)) throw new Error('Assunto de e-mail inválido.');
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'tiktok-ads-manager/1.0' };
      if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 200);

      let response;
      try {
        response = await fetchFn(RESEND_URL, { method: 'POST', headers, body: JSON.stringify({ from, to: [to], subject, html, text }), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        log.error(`[email] falha de rede ao falar com o Resend: ${err?.name ?? 'erro'}`);
        throw SEND_FAILED();
      }
      let body = null;
      try {
        body = await response.json();
      } catch {
        /* corpo não-JSON */
      }
      if (!response.ok) {
        // 401/403 costumam ser chave inválida ou domínio não verificado: dica só no log do servidor.
        log.error(`[email] o Resend recusou o envio (HTTP ${response.status}${body?.name ? `, ${String(body.name).slice(0, 60)}` : ''}).`);
        throw SEND_FAILED();
      }
      return { id: typeof body?.id === 'string' ? body.id : null };
    },
  };
}
