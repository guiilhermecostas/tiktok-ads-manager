import { post } from '../api.js';
import { h, icon } from '../dom.js';
import { state } from '../state.js';
import { button } from '../ui.js';
import { authShell } from './auth-shell.js';

const COPY = {
  pending: {
    icon: 'clock',
    title: 'Conta pendente de aprovação',
    text: 'Recebemos seu cadastro. Assim que o administrador aprovar, você poderá acessar o painel. Esta página verifica a aprovação automaticamente.',
  },
  rejected: {
    icon: 'ban',
    title: 'Cadastro não aprovado',
    text: 'Seu cadastro não foi aprovado pelo administrador. Em caso de dúvida, entre em contato com a equipe.',
  },
  blocked: {
    icon: 'ban',
    title: 'Conta bloqueada',
    text: 'O acesso desta conta foi bloqueado pelo administrador. Entre em contato com a equipe para mais informações.',
  },
};

/** Tela exibida no lugar de TODO o sistema enquanto a conta não está aprovada. */
export function statusView(ctx) {
  const copy = COPY[state.user.status] ?? COPY.pending;
  const check = button('Verificar novamente', { onClick: () => ctx.refreshSession() });

  return authShell(
    h(
      'div',
      { class: 'status' },
      h('span', { class: `status__icon status__icon--${state.user.status}` }, icon(copy.icon, 28)),
      h('h1', { class: 'auth__title' }, copy.title),
      h('p', { class: 'muted' }, copy.text),
      h('p', { class: 'status__who' }, state.user.email),
      h(
        'div',
        { class: 'status__actions' },
        state.user.status === 'pending' ? check : null,
        button('Sair', {
          onClick: async () => {
            try {
              await post('/auth/logout');
            } catch {
              /* ignora */
            }
            await ctx.refreshSession();
          },
        }),
      ),
    ),
  );
}
