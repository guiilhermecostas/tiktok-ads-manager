import { h, icon } from '../dom.js';
import { state } from '../state.js';
import { authShell } from './auth-shell.js';

const RESULTS = {
  connected: {
    icon: 'link',
    tone: 'pending',
    title: 'Acesso liberado',
    text: 'Sua Business Center foi conectada. Volte para a aba do sistema: ela já foi atualizada.',
  },
  denied: {
    icon: 'ban',
    tone: 'blocked',
    title: 'Autorização cancelada',
    text: 'O acesso não foi liberado no TikTok. Volte ao sistema e gere um novo link para tentar de novo.',
  },
  error: {
    icon: 'ban',
    tone: 'blocked',
    title: 'Não foi possível conectar',
    text: 'Algo deu errado ao concluir a autorização. Volte ao sistema: a tela mostra o motivo e permite gerar um novo link.',
  },
  expired: {
    icon: 'clock',
    tone: 'pending',
    title: 'Link expirado ou já usado',
    text: 'Este link não vale mais (ele expira em 15 minutos e só funciona uma vez). Volte ao sistema e gere um novo link.',
  },
};

/**
 * Página aberta pelo TikTok ao fim da autorização. É PÚBLICA: pode abrir em outro navegador/perfil, sem sessão.
 * Só exibe um de quatro resultados fixos (nada vem da URL além do nome do resultado) e nunca mostra dados da conta.
 */
export function tiktokConnectedView() {
  const requested = new URLSearchParams(location.search).get('status');
  const result = RESULTS[requested] ?? RESULTS.expired;
  const action = state.user?.status === 'approved'
    ? h('a', { class: 'btn btn--primary', href: '/business-centers', 'data-link': '' }, 'Ir para Contas TikTok')
    : h('p', { class: 'muted' }, 'Você já pode fechar esta aba.');
  return authShell(
    h('div', { class: 'status' }, h('span', { class: `status__icon status__icon--${result.tone}` }, icon(result.icon, 28)), h('h1', { class: 'auth__title' }, result.title), h('p', { class: 'muted' }, result.text), action),
  );
}
