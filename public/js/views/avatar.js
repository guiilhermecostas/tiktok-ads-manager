import { h } from '../dom.js';
import { state } from '../state.js';

/** Iniciais do nome (até 2 letras), usadas quando a pessoa ainda não tem foto. */
export function initials(name) {
  return String(name ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('') || '?';
}

/** Endereço da foto: `v` é a versão (muda quando a pessoa troca a foto), então o navegador busca a nova na hora. */
export const avatarUrl = (userId, version) => `/api/avatars/${encodeURIComponent(userId)}?v=${encodeURIComponent(version)}`;

/**
 * Bolinha da pessoa: a foto (se houver) ou as iniciais. `person` = { id, name, avatarVersion }. Se a imagem falhar ao carregar,
 * volta sozinha para as iniciais. `size`: 'sm' (menu), 'md' (listas) ou 'lg' (Minha conta). Todo texto entra como texto (sem HTML).
 */
export function avatarEl(person, { size = 'sm' } = {}) {
  const el = h('span', { class: `avatar avatar--${size}`, 'aria-hidden': 'true' }, initials(person.name));
  if (person.avatarVersion) {
    el.replaceChildren(h('img', {
      class: 'avatar__img', src: avatarUrl(person.id, person.avatarVersion), alt: '', decoding: 'async', draggable: 'false',
      onError: () => el.replaceChildren(initials(person.name)),
    }));
  }
  return el;
}

/** Atualiza, sem recarregar a página, o bloco da conta no menu lateral (foto e nome) depois de mudanças no perfil. */
export function syncAccountUi() {
  const { user } = state;
  if (!user) return;
  document.querySelectorAll('[data-account-avatar]').forEach((slot) => slot.replaceChildren(avatarEl(user, { size: 'sm' })));
  document.querySelectorAll('[data-account-name]').forEach((node) => { node.textContent = user.name; });
}
