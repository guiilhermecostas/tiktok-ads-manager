import { h } from '../dom.js';

/** Abas da Administração: "Contas" (aprovar, bloquear, acessar), "Assinaturas" (planos e cobrança em dólar) e "Notificações" (o sino dos usuários). */
export function adminNav(active) {
  const tab = (path, text) => h('a', { href: path, 'data-link': '', class: `tab${path === active ? ' is-active' : ''}`, 'aria-current': path === active ? 'page' : null }, text);
  return h('nav', { class: 'tabs tabs--hub tabs--left', 'aria-label': 'Seções da Administração' }, tab('/admin', 'Contas'), tab('/admin/billing', 'Assinaturas'), tab('/admin/notifications', 'Notificações'));
}
