/** E-mail falso para os testes: guarda o que seria enviado, sem falar com o Resend. */
export const MAIL_CONFIG = { apiKey: 're_TESTE_chave_falsa_1234567890', from: 'TikTok Ads Manager <convites@payfac.dev>', appUrl: 'https://app.example.com', enabled: true };

export function createFakeMailer({ enabled = true } = {}) {
  const state = { sent: [], fail: false };
  return {
    state,
    enabled,
    async send(message) {
      if (!enabled) throw Object.assign(new Error('desligado'), { status: 503, code: 'email_not_configured' });
      if (state.fail) {
        const { HttpError } = await import('../src/lib/http-error.js');
        throw new HttpError(502, 'Não foi possível enviar o e-mail agora.', 'email_failed');
      }
      state.sent.push(message);
      return { id: `email_${state.sent.length}` };
    },
    /** Último e-mail enviado para o endereço. */
    lastTo: (to) => [...state.sent].reverse().find((m) => m.to === to) ?? null,
    /** Token do convite extraído do link do e-mail (vem no fragmento "#"). */
    tokenFrom(message) {
      const match = /\/invite#([A-Za-z0-9_-]{43})/.exec(message.text);
      return match ? match[1] : null;
    },
  };
}
