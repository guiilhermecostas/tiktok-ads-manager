import { h, icon } from '../dom.js';

/**
 * Grupo do menu lateral ("Ads", "BC e CA", "Gestão", "KPI"): mostra só o título; as opções aparecem logo abaixo quando se passa o mouse.
 *  - Mouse: abre ao passar por cima (com uma pequena pausa para não abrir ao só atravessar) e fecha ao sair (com folga para chegar ao painel).
 *  - Clique/toque ou Enter/Espaço no título: abre e FIXA (fica aberto até clicar fora, apertar Esc ou clicar no título de novo).
 *  - Teclado: ↓ no título abre e vai para a primeira opção; ↑/↓ andam entre as opções; Esc fecha e volta ao título.
 *  - O painel é `position: fixed` (colocado sob o título no momento de abrir): assim a rolagem da lateral nunca o corta e ele não empurra o resto do menu.
 *  - Em tela pequena (menu horizontal) o painel não existe: as opções aparecem direto, em linha (CSS).
 * Todo texto entra como nó de texto (nunca HTML).
 */
const OPEN_DELAY_MS = 70;
const CLOSE_DELAY_MS = 260;
const GAP_PX = 2;
const EDGE_PX = 8;

let current = null; // o grupo aberto agora (só um por vez)
let counter = 0;

const isCompactNav = () => window.matchMedia?.('(max-width: 900px)').matches === true;
const canHover = () => window.matchMedia?.('(hover: hover)').matches === true;

// Um único conjunto de ouvintes no documento atende todos os grupos (a lateral é redesenhada a cada tela).
document.addEventListener('pointerdown', (event) => {
  if (current && !current.root.contains(event.target)) current.close();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && current) current.close({ restoreFocus: true });
});
window.addEventListener('resize', () => current?.close());

/**
 * @param {{ label: string, iconName: string, items: Node[], hasActive: boolean, isSearching: () => boolean }} options
 *   `items`: os links das opções; `hasActive`: a tela atual está neste grupo (o título fica em destaque); `isSearching()`: a busca do menu está em uso
 *   (as opções aparecem em lista, sem abrir painel).
 * @returns {{ element: HTMLElement }}
 */
export function createNavGroup({ label, iconName, items, hasActive, isSearching = () => false }) {
  counter += 1;
  const panelId = `nav-group-${counter}`;
  let open = false;
  let pinned = false;
  let openTimer;
  let closeTimer;

  const header = h(
    'button',
    { type: 'button', class: 'nav-group__header', 'aria-expanded': 'false', 'aria-controls': panelId, 'aria-haspopup': 'true', title: label, onClick: onHeaderClick, onKeydown: onHeaderKey },
    icon(iconName),
    h('span', { class: 'nav-item__label' }, label),
    hasActive ? h('span', { class: 'nav-group__dot', 'aria-hidden': 'true' }) : null,
    h('span', { class: 'nav-group__chevron' }, icon('chevron', 14)),
  );
  const panel = h('div', { id: panelId, class: 'nav-group__panel', role: 'group', 'aria-label': label, onKeydown: onPanelKey, onClick: (event) => { if (event.target.closest('a')) close(); } }, items);
  const root = h('div', { class: `nav-group${hasActive ? ' has-active' : ''}` }, header, panel);

  const links = () => [...panel.querySelectorAll('a')].filter((a) => !a.hidden);

  /** Põe o painel logo abaixo do título (ou ao lado, com a lateral recolhida), sem sair da tela. */
  function place() {
    const rect = header.getBoundingClientRect();
    const sideMode = root.closest('.shell')?.classList.contains('is-collapsed');
    panel.style.width = sideMode ? 'auto' : `${Math.round(rect.width)}px`;
    panel.style.left = `${Math.round(sideMode ? rect.right + GAP_PX + 2 : rect.left)}px`;
    panel.style.top = `${Math.round(sideMode ? rect.top : rect.bottom + GAP_PX - 4)}px`;
    const box = panel.getBoundingClientRect();
    if (box.bottom > window.innerHeight - EDGE_PX) panel.style.top = `${Math.max(EDGE_PX, window.innerHeight - EDGE_PX - box.height)}px`;
    if (box.right > window.innerWidth - EDGE_PX) panel.style.left = `${Math.max(EDGE_PX, window.innerWidth - EDGE_PX - box.width)}px`;
  }

  function show({ pin = false } = {}) {
    clearTimeout(closeTimer);
    clearTimeout(openTimer);
    if (isCompactNav() || isSearching()) return;
    if (current && current !== entry) current.close();
    if (pin) pinned = true;
    if (open) return;
    open = true;
    place();
    root.classList.add('is-open');
    header.setAttribute('aria-expanded', 'true');
    current = entry;
  }

  function close({ restoreFocus = false } = {}) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    pinned = false;
    if (!open) return;
    open = false;
    root.classList.remove('is-open');
    header.setAttribute('aria-expanded', 'false');
    if (current === entry) current = null;
    if (restoreFocus) header.focus();
  }

  function onHeaderClick() {
    if (isCompactNav() || isSearching()) return;
    if (open && pinned) close();
    else show({ pin: true });
  }

  function onHeaderKey(event) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    show({ pin: true });
    links()[0]?.focus();
  }

  function onPanelKey(event) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const list = links();
    const index = list.indexOf(document.activeElement);
    if (index < 0) return;
    event.preventDefault();
    if (event.key === 'ArrowUp' && index === 0) header.focus();
    else list[Math.min(list.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }

  root.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || !canHover() || isCompactNav() || isSearching()) return;
    clearTimeout(closeTimer);
    if (!open) openTimer = setTimeout(() => show(), OPEN_DELAY_MS);
  });
  root.addEventListener('pointerleave', (event) => {
    if (event.pointerType !== 'mouse') return;
    clearTimeout(openTimer);
    if (open && !pinned) closeTimer = setTimeout(() => close(), CLOSE_DELAY_MS);
  });

  const entry = { root, close };
  return { element: root, close };
}
