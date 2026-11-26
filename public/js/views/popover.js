import { h } from '../dom.js';

/**
 * Painel que abre ao clicar num botão (filtros, menu de visualizações…): fecha ao clicar fora e com Esc (devolvendo o foco ao botão), com
 * `aria-expanded` e `aria-controls` corretos. Quem usa guarda se está aberto (`open`) e é avisado a cada mudança (`onToggle`): assim a tela pode
 * ser redesenhada sem fechar o painel. Todo conteúdo é montado pelo chamador (nós de texto, nunca HTML).
 */
let counter = 0;
const registry = new Set(); // um único par de ouvintes no documento atende todos os painéis

function closeOthers(except, event) {
  for (const entry of registry) {
    if (!entry.root.isConnected) {
      registry.delete(entry);
    } else if (entry !== except && entry.isOpen()) {
      if (!event || !entry.root.contains(event.target)) entry.close({ restoreFocus: false });
    }
  }
}
document.addEventListener('click', (event) => closeOthers(null, event), true);
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const entry of registry) if (entry.root.isConnected && entry.isOpen()) entry.close({ restoreFocus: true });
});

/** `label`: conteúdo do botão; `content`: nó do painel; `open`/`onToggle`: estado de fora; `align`: 'left' | 'right'. */
export function popover({ label, content, ariaLabel, title, buttonClass = 'btn btn--secondary btn--sm', open = false, onToggle = () => {}, align = 'left', panelClass = '' }) {
  counter += 1;
  const id = `popover-${counter}`;
  let isOpen = open;
  const button = h('button', { type: 'button', class: `${buttonClass} popover__btn`, 'aria-haspopup': 'true', 'aria-expanded': String(isOpen), 'aria-controls': id, 'aria-label': ariaLabel, title, onClick: () => (isOpen ? entry.close({ restoreFocus: false }) : show()) }, label);
  const panel = h('div', { id, class: `popover__panel popover__panel--${align} ${panelClass}`.trim(), hidden: !isOpen }, content);
  const root = h('div', { class: 'popover' }, button, panel);
  const entry = {
    root,
    isOpen: () => isOpen,
    close({ restoreFocus }) {
      if (!isOpen) return;
      isOpen = false;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      onToggle(false);
      if (restoreFocus) button.focus();
    },
  };
  function show() {
    closeOthers(entry, null);
    isOpen = true;
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    onToggle(true);
  }
  registry.add(entry);
  return root;
}
