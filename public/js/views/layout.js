import { post } from '../api.js';
import { h, icon } from '../dom.js';
import { can, isWorkspaceOwner, setSession, state } from '../state.js';
import { openCampaignWizard } from './campaign-wizard/index.js';
import { avatarEl } from './avatar.js';
import { createNavGroup } from './nav-groups.js';
import { createBell } from './notifications-bell.js';
import { openProfile } from './profile.js';

// `areas`: o item aparece para quem tem ao menos uma destas áreas (o dono da conta tem todas); `ownerOnly`: só o dono do espaço.
// Ordem do menu: Início (sem título, é a porta de entrada) → Ads → BC e CA → Gestão → KPI. O título de cada grupo só aparece se a pessoa vê algum item dele.
const NAV = [
  { path: '/', label: 'Início', icon: 'home' },
  { path: '/manager', label: 'Gerenciador', icon: 'sliders', areas: ['campaigns', 'reports'], section: 'Ads' },
  { path: '/creatives', label: 'Criativos', icon: 'image', areas: ['creatives'], section: 'Ads' },
  { path: '/catalog', label: 'Catálogo', icon: 'box', areas: ['campaigns'], section: 'Ads' },
  { path: '/business-centers', label: 'Contas TikTok', icon: 'building', areas: ['accounts'], section: 'BC e CA' },
  { path: '/balance', label: 'Saldo', icon: 'wallet', areas: ['accounts'], section: 'BC e CA' },
  { path: '/team', label: 'Colaboradores', icon: 'users', ownerOnly: true, section: 'Gestão' },
  { path: '/billing', label: 'Plano e cobrança', icon: 'wallet', ownerOnly: true, section: 'Gestão' },
  { path: '/admin', label: 'Administração', icon: 'shield', adminOnly: true, section: 'Gestão' },
  { path: '/reports', label: 'Relatórios', icon: 'chart', areas: ['reports'], section: 'KPI' },
];

// Ícone do título de cada grupo do menu (as opções de dentro aparecem ao passar o mouse).
const SECTION_ICONS = { Ads: 'megaphone', 'BC e CA': 'building', Gestão: 'users', KPI: 'chart' };

const COLLAPSE_KEY = 'tt.sidebar.collapsed';
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
};

// Atalho ⌘K / Ctrl+K para focar a busca (registrado uma única vez).
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    const input = document.getElementById('nav-search');
    if (input) {
      event.preventDefault();
      input.focus();
      input.select();
    }
  }
});

/**
 * Shell do painel no estilo Shopify Admin:
 * lateral escura (busca + navegação + conta) e área de trabalho em painel branco arredondado.
 */
export function renderLayout(ctx, currentPath, content) {
  const { user } = state;
  const isActive = (itemPath) => currentPath === itemPath || (itemPath !== '/' && currentPath.startsWith(`${itemPath}/`));
  const visibleItems = NAV.filter((item) => (!item.adminOnly || (user.role === 'admin' && isWorkspaceOwner())) && (!item.ownerOnly || isWorkspaceOwner()) && (!item.areas || can(...item.areas)));

  async function logout() {
    try {
      await post('/auth/logout');
    } catch {
      /* mesmo com erro, limpamos a sessão local */
    }
    await ctx.refreshSession();
  }

  // ----- navegação + busca -----
  // Início fica solto; as demais opções ficam em grupos (Ads, BC e CA, Gestão, KPI) que abrem ao passar o mouse.
  const navEntries = []; // cada opção do menu (para a busca): { node, label, path }
  const groupEntries = []; // cada grupo: { node, entries, close } (some inteiro na busca se nenhuma opção bate)
  const navChildren = [];
  let searching = false;

  // 1) um link por opção
  const built = new Map(); // opção de NAV -> { link, active, entry }
  for (const item of visibleItems) {
    const active = isActive(item.path);
    const link = h(
      'a',
      {
        href: item.path,
        'data-link': true,
        title: item.label,
        class: `nav-item${active ? ' is-active' : ''}`,
        'aria-current': active ? 'page' : null,
      },
      icon(item.icon),
      h('span', { class: 'nav-item__label' }, item.label),
    );
    const entry = { node: link, label: item.label.toLowerCase(), path: item.path };
    navEntries.push(entry);
    built.set(item, { link, active, entry });
  }
  // 2) na ordem do menu: itens soltos entram direto; as opções de uma seção entram juntas, num grupo, na posição da primeira delas
  const placedSections = new Set();
  for (const item of visibleItems) {
    if (!item.section) {
      navChildren.push(built.get(item).link);
      continue;
    }
    if (placedSections.has(item.section)) continue;
    placedSections.add(item.section);
    const members = visibleItems.filter((other) => other.section === item.section).map((other) => built.get(other));
    const group = createNavGroup({ label: item.section, iconName: SECTION_ICONS[item.section] ?? 'panel', items: members.map((m) => m.link), hasActive: members.some((m) => m.active), isSearching: () => searching });
    groupEntries.push({ node: group.element, entries: members.map((m) => m.entry), close: group.close });
    navChildren.push(group.element);
  }
  const noResults = h('p', { class: 'nav-empty', hidden: true }, 'Nenhum resultado');
  navChildren.push(noResults);
  const navEl = h('nav', { class: 'nav', 'aria-label': 'Navegação principal' }, navChildren);

  function applyFilter(term) {
    const query = term.trim().toLowerCase();
    searching = query !== '';
    navEl.classList.toggle('nav--searching', searching);
    let matches = 0;
    for (const entry of navEntries) {
      const match = !query || entry.label.includes(query);
      entry.node.hidden = !match;
      if (match) matches += 1;
    }
    for (const group of groupEntries) {
      if (searching) group.close();
      group.node.hidden = searching && !group.entries.some((e) => !e.node.hidden); // sem opção que bata: o grupo inteiro some
    }
    noResults.hidden = matches > 0;
  }

  const search = h('input', {
    id: 'nav-search',
    class: 'search__input',
    type: 'search',
    placeholder: 'Pesquisar',
    autocomplete: 'off',
    'aria-label': 'Pesquisar no menu',
    maxlength: 40,
    onInput: (e) => applyFilter(e.target.value),
    onKeydown: (e) => {
      if (e.key === 'Escape') {
        e.target.value = '';
        applyFilter('');
        e.target.blur();
      }
      if (e.key === 'Enter') {
        const first = navEntries.find((entry) => entry.path && !entry.node.hidden);
        if (first) {
          e.target.value = '';
          applyFilter('');
          ctx.navigate(first.path);
        }
      }
    },
  });

  const shell = h('div', { class: `shell${readCollapsed() ? ' is-collapsed' : ''}` });

  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'sidebar__toggle',
      'aria-label': 'Recolher ou expandir menu',
      onClick: () => {
        const collapsed = shell.classList.toggle('is-collapsed');
        try {
          localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
        } catch {
          /* armazenamento indisponível */
        }
      },
    },
    icon('panel', 18),
  );

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'div',
      { class: 'sidebar__top' },
      h('a', { href: '/', 'data-link': true, class: 'sidebar__logo', 'aria-label': 'Ir para o início' }, h('img', { class: 'sidebar__logo-img', src: '/tiktokas.png', alt: 'TikTok Ads Manager', width: 32, height: 32, decoding: 'async' })),
      toggle,
    ),
    h('label', { class: 'search' }, icon('search', 16), search, h('kbd', { class: 'search__kbd' }, '⌘K')),
    navEl,
    h(
      'div',
      { class: 'sidebar__bottom' },
      // Clicar na conta abre "Minha conta" (foto e nome). Os nós com data-account-* são atualizados sem recarregar a página.
      h(
        'button',
        { type: 'button', class: 'account account--button', title: 'Minha conta', 'aria-label': 'Abrir minha conta (foto e nome)', onClick: () => openProfile(ctx) },
        h('span', { class: 'account__avatar', 'data-account-avatar': true }, avatarEl(user, { size: 'sm' })),
        h('div', { class: 'account__text' }, h('span', { class: 'account__name', 'data-account-name': true }, user.name), h('span', { class: 'account__sub' }, !isWorkspaceOwner() ? `Equipe de ${state.workspace.ownerName}` : user.role === 'admin' ? user.email : (user.company ?? user.email))),
      ),
      h('button', { type: 'button', class: 'logout', title: 'Sair', onClick: logout }, icon('logout', 18), h('span', { class: 'logout__label' }, 'Sair')),
    ),
  );

  async function leaveImpersonation(e) {
    const trigger = e.currentTarget;
    trigger.disabled = true;
    try {
      setSession(await post('/auth/impersonation/exit'));
      ctx.navigate('/admin', { replace: true });
    } catch {
      trigger.disabled = false;
      await ctx.refreshSession(); // a sessão pode já ter caído (ex.: a conta foi bloqueada): a tela vai para o lugar certo
    }
  }
  // Faixa fixa no topo enquanto um administrador vê a conta de outra pessoa: deixa claro onde está e dá a saída em um clique.
  const impersonationBar = state.impersonation
    ? h(
        'div',
        { class: 'impersonation-bar', role: 'status' },
        h('span', { class: 'impersonation-bar__text' }, h('strong', null, `Você está na conta de ${user.name}`), ' · modo somente leitura (nada é alterado)'),
        h('button', { type: 'button', class: 'btn btn--sm impersonation-bar__exit', onClick: leaveImpersonation }, 'Voltar ao admin'),
      )
    : null;

  const workspace = h(
    'div',
    { class: 'workspace' },
    h(
      'div',
      { class: 'frame' },
      impersonationBar,
      h(
        'header',
        { class: 'appbar' },
        h('span', { class: 'appbar__title' }, 'TikTok Ads Manager'),
        createBell(ctx), // o sino fica no canto direito do topo
      ),
      h('main', { class: 'main', id: 'main' }, content),
    ),
  );

  // Botão flutuante: abre o assistente de campanha em pop-up, de qualquer tela.
  const fab = h(
    'button',
    { type: 'button', class: 'fab', 'aria-label': 'Publicar campanha', title: 'Publicar campanha', onClick: () => openCampaignWizard(ctx) },
    'Publicar campanha',
  );

  shell.append(sidebar, workspace);
  if (can('campaigns') && currentPath !== '/') shell.append(fab); // no Início (chat) o botão fica de fora para não cobrir o campo de mensagem // (append nativo imprimiria "null")
  return shell;
}

export function pageHeader(title, subtitle, actions) {
  return h(
    'div',
    { class: 'page-header' },
    h('div', null, h('h1', { class: 'page-title' }, title), subtitle ? h('p', { class: 'muted' }, subtitle) : null),
    actions ? h('div', { class: 'page-header__actions' }, actions) : null,
  );
}
