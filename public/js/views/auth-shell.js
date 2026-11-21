import { h } from '../dom.js';

/** Layout de telas públicas (login/cadastro/status): painel de marca + cartão. */
export function authShell(...cardChildren) {
  return h(
    'div',
    { class: 'auth' },
    h(
      'aside',
      { class: 'auth__hero' },
      h('p', { class: 'auth__byline' }, 'by Caju'),
      h(
        'div',
        { class: 'auth__pitch' },
        h('h2', null, 'Toda a sua operação de ', h('span', { class: 'accent-cyan' }, 'TikTok Ads'), ' em ', h('span', { class: 'accent-red' }, 'um só lugar'), '.'),
        h('p', null, 'Gerencie campanhas, orçamentos e contas de anúncio com uma interface simples e segura.'),
      ),
      h('p', { class: 'auth__foot' }, 'Acesso mediante aprovação do administrador.'),
    ),
    h('main', { class: 'auth__panel' }, h('div', { class: 'auth__card' }, ...cardChildren)),
  );
}
