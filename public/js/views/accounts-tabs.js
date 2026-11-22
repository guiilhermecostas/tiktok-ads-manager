import { h } from '../dom.js';

const TABS = [
  { path: '/business-centers', label: 'Business Centers' },
  { path: '/business-centers/accounts', label: 'Contas de anúncio' },
  { path: '/business-centers/proxy', label: 'Proxy' },
];

/** Sub-abas de "Contas TikTok" (cada uma tem o próprio endereço: dá para favoritar e o botão voltar funciona). */
export function accountsTabs(activePath) {
  return h(
    'nav',
    { class: 'tabs', 'aria-label': 'Seções de Contas TikTok' },
    TABS.map((tab) =>
      h('a', { href: tab.path, 'data-link': '', class: `tab${tab.path === activePath ? ' is-active' : ''}`, 'aria-current': tab.path === activePath ? 'page' : null }, tab.label),
    ),
  );
}
