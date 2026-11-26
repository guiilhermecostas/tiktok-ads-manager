import { del, get, patch, post } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { alertBox, button, confirmDialog, field, openModal, toast } from '../../ui.js';
import { openContextMenu } from '../context-menu.js';
import { DROP_ATTR } from './drop-upload.js';

/** Valores do filtro de pasta: '' = todas, 'none' = sem pasta, número = uma pasta. */
export const FOLDER_ALL = '';
export const FOLDER_NONE = 'none';
export const MAX_FOLDER_NAME = 60;
/** Formato usado ao arrastar criativos para uma pasta. */
export const DRAG_TYPE = 'application/x-creative-ids';

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** ID da pasta para enviar ao servidor (só quando uma pasta de verdade está aberta). */
export const folderIdOf = (current) => (typeof current === 'number' ? current : null);

/** Mesmo critério do servidor: espaços extras viram um só e o nome tem no máximo 60 caracteres. */
export const cleanFolderName = (name) => String(name).replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME);

/**
 * Pastas da biblioteca (uma por oferta). Desenha a barra lateral de pastas e cuida de criar, renomear, apagar e mover.
 *  - `onSelect(value)`: a pessoa escolheu "Todos", "Sem pasta" ou uma pasta.
 *  - `onChanged()`: algo mudou (criativos movidos, pasta renomeada/apagada…): a tela recarrega a lista.
 * Cada item da barra aceita soltar CRIATIVOS (move) e ARQUIVOS do computador (envia: atributo `data-drop-folder`).
 * Todo texto (inclusive nome de pasta) entra como nó de texto, nunca como HTML.
 */
export function createFolders({ onSelect, onChanged }) {
  const state = { folders: [], total: 0, unfiled: 0, current: FOLDER_ALL, loaded: false, error: null };
  const element = h('nav', { class: 'folder-nav', 'aria-label': 'Pastas' });

  const nameOf = (id) => state.folders.find((f) => f.id === id)?.name ?? null;
  const byId = (id) => state.folders.find((f) => f.id === id) ?? null;
  const currentFolder = () => (typeof state.current === 'number' ? byId(state.current) : null);

  // ---------- mover (por arrastar ou pelo botão) ----------
  async function moveTo(ids, folderId) {
    try {
      const { moved } = await post('/creatives/move', { ids, folderId });
      const target = folderId === null ? 'Sem pasta' : `"${nameOf(folderId) ?? 'pasta'}"`;
      toast(`${plural(moved, 'criativo movido', 'criativos movidos')} para ${target}.`);
      await refresh();
      onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  /** Faz de `el` um destino para soltar criativos da própria tela (`folderId`: número ou null = sem pasta). */
  function bindMoveTarget(el, folderId) {
    el.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes(DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      el.classList.add('is-drop');
    });
    el.addEventListener('dragleave', (event) => {
      if (!el.contains(event.relatedTarget)) el.classList.remove('is-drop');
    });
    el.addEventListener('drop', (event) => {
      el.classList.remove('is-drop');
      const raw = event.dataTransfer?.getData(DRAG_TYPE);
      if (!raw) return;
      event.preventDefault();
      let ids;
      try {
        ids = JSON.parse(raw);
      } catch {
        return;
      }
      if (Array.isArray(ids) && ids.length && ids.every(Number.isInteger)) moveTo(ids, folderId);
    });
  }

  /** Itens do menu de contexto de uma pasta (usados na barra lateral e nos cartões de pasta). */
  const menuItems = (folder) => [
    { label: 'Abrir', icon: 'folder', onClick: () => select(folder.id) },
    'separator',
    { label: 'Renomear pasta', icon: 'edit', onClick: () => openRename(folder) },
    { label: 'Excluir pasta', icon: 'trash', danger: true, onClick: () => confirmDelete(folder) },
  ];

  function navItem({ value, label, count, iconName, folder = null }) {
    const active = state.current === value;
    const el = h(
      'button',
      {
        type: 'button',
        class: `folder-item${active ? ' is-on' : ''}`,
        'aria-current': active ? 'page' : null,
        'data-folder': String(value),
        [DROP_ATTR]: folder ? String(folder.id) : 'none', // "Todos" e "Sem pasta": arquivos do computador entram sem pasta
        title: folder ? folder.name : label,
        onClick: () => select(value),
      },
      icon(iconName, 16),
      h('span', { class: 'folder-item__name' }, label),
      h('span', { class: 'folder-item__count' }, String(count)),
    );
    // Soltar criativos arrastados em cima de uma pasta move todos; "Todos" não é destino.
    if (value !== FOLDER_ALL) bindMoveTarget(el, value === FOLDER_NONE ? null : value);
    if (folder) el.addEventListener('contextmenu', (event) => { event.preventDefault(); openContextMenu({ x: event.clientX, y: event.clientY, items: menuItems(folder), label: `Ações da pasta ${folder.name}` }); });
    return el;
  }

  function draw() {
    setChildren(
      element,
      navItem({ value: FOLDER_ALL, label: 'Todos os arquivos', count: state.total, iconName: 'box' }),
      navItem({ value: FOLDER_NONE, label: 'Sem pasta', count: state.unfiled, iconName: 'inbox' }),
      state.folders.length ? h('div', { class: 'folder-nav__title' }, 'Pastas') : null,
      state.folders.map((f) => navItem({ value: f.id, label: f.name, count: f.count, iconName: 'folder', folder: f })),
      h('button', { type: 'button', class: 'folder-item folder-item--new', onClick: () => openCreate() }, icon('plus', 16), h('span', { class: 'folder-item__name' }, 'Nova pasta')),
    );
  }

  function select(value) {
    if (state.current === value) return;
    state.current = value;
    draw();
    onSelect(value);
  }

  async function refresh() {
    try {
      const data = await get('/creatives/folders');
      Object.assign(state, { folders: data.folders, total: data.total, unfiled: data.unfiledCount, loaded: true, error: null });
      // A pasta aberta foi apagada (por outra aba ou por outra pessoa da equipe): volta para "Todos".
      if (typeof state.current === 'number' && !state.folders.some((f) => f.id === state.current)) {
        state.current = FOLDER_ALL;
        onSelect(FOLDER_ALL);
      }
    } catch (err) {
      state.error = err.message;
    }
    draw();
  }

  /**
   * Devolve o ID da pasta com este nome (a comparação ignora maiúsculas e espaços extras), criando-a se ainda não existir.
   * Usado ao soltar uma PASTA do computador: ela vira uma pasta da biblioteca com o mesmo nome. Lança Error com mensagem em português.
   */
  async function ensure(rawName) {
    const name = cleanFolderName(rawName);
    if (!name) throw new Error('A pasta solta não tem nome.');
    const find = () => state.folders.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (find()) return find().id;
    try {
      const { folder } = await post('/creatives/folders', { name });
      await refresh();
      return folder.id;
    } catch (err) {
      if (err.code === 'folder_exists') {
        await refresh();
        if (find()) return find().id;
      }
      throw err;
    }
  }

  // ---------- criar / renomear ----------
  function nameDialog({ title, submitLabel, initial = '', onSubmit }) {
    const name = field('Nome da pasta', { type: 'text', required: true, maxlength: MAX_FOLDER_NAME, value: initial, placeholder: 'Ex.: Oferta Emagrecimento', autocomplete: 'off' }, { hint: 'Use um nome por oferta, para achar os criativos rápido.' });
    const errorSlot = h('div');
    const submit = button(submitLabel, { variant: 'primary', type: 'submit' });
    const modal = openModal({
      title,
      body: h(
        'form',
        {
          class: 'form modal__body',
          novalidate: true,
          onSubmit: async (event) => {
            event.preventDefault();
            const value = name.control.value.trim();
            if (!value) return errorSlot.replaceChildren(alertBox('Informe o nome da pasta.'));
            errorSlot.replaceChildren();
            submit.disabled = true;
            try {
              await onSubmit(value);
              modal.close();
            } catch (err) {
              errorSlot.replaceChildren(alertBox(err.message));
              submit.disabled = false;
            }
            return undefined;
          },
        },
        errorSlot,
        name.element,
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
    name.control.select();
    return modal;
  }

  function openCreate({ then } = {}) {
    nameDialog({
      title: 'Nova pasta',
      submitLabel: 'Criar pasta',
      onSubmit: async (value) => {
        const { folder } = await post('/creatives/folders', { name: value });
        toast(`Pasta "${folder.name}" criada.`);
        await refresh();
        if (then) await then(folder);
        else select(folder.id); // abre a pasta nova (assim o próximo envio já cai nela)
      },
    });
  }

  function openRename(folder) {
    nameDialog({
      title: 'Renomear pasta',
      submitLabel: 'Salvar',
      initial: folder.name,
      onSubmit: async (value) => {
        await patch(`/creatives/folders/${folder.id}`, { name: value });
        toast('Pasta renomeada.');
        await refresh();
        onChanged();
      },
    });
  }

  async function confirmDelete(folder) {
    const ok = await confirmDialog({
      title: 'Excluir pasta',
      message: `Excluir a pasta "${folder.name}"? ${folder.count ? `Os ${plural(folder.count, 'criativo', 'criativos')} dela NÃO são apagados: voltam para "Sem pasta".` : 'Ela está vazia.'}`,
      confirmLabel: 'Excluir pasta',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/creatives/folders/${folder.id}`);
      toast('Pasta excluída. Os criativos continuam na biblioteca.');
      await refresh();
      if (state.current === folder.id) select(FOLDER_ALL);
      else onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- "Mover para…" ----------
  /** Pop-up para escolher a pasta de destino (ou criar uma nova na hora). `ids`: criativos a mover. */
  function openMove(ids, { current = null } = {}) {
    const NEW = '__new__';
    const options = [['', 'Sem pasta'], ...state.folders.map((f) => [String(f.id), f.name]), [NEW, '＋ Nova pasta…']];
    const target = field('Mover para', { as: 'select', options, value: current === null ? '' : String(current) });
    const newName = field('Nome da nova pasta', { type: 'text', maxlength: MAX_FOLDER_NAME, autocomplete: 'off', placeholder: 'Ex.: Oferta Emagrecimento' });
    newName.element.hidden = true;
    target.control.addEventListener('change', () => {
      newName.element.hidden = target.control.value !== NEW;
      if (!newName.element.hidden) newName.control.focus();
    });
    const errorSlot = h('div');
    const submit = button('Mover', { variant: 'primary', type: 'submit' });
    const modal = openModal({
      title: ids.length === 1 ? 'Mover criativo' : `Mover ${ids.length} criativos`,
      body: h(
        'form',
        {
          class: 'form modal__body',
          novalidate: true,
          onSubmit: async (event) => {
            event.preventDefault();
            errorSlot.replaceChildren();
            submit.disabled = true;
            try {
              let folderId = target.control.value === '' ? null : Number(target.control.value);
              if (target.control.value === NEW) {
                const name = newName.control.value.trim();
                if (!name) throw new Error('Informe o nome da nova pasta.');
                folderId = (await post('/creatives/folders', { name })).folder.id;
                await refresh();
              }
              modal.close();
              await moveTo(ids, folderId);
            } catch (err) {
              errorSlot.replaceChildren(alertBox(err.message));
              submit.disabled = false;
            }
          },
        },
        errorSlot,
        target.element,
        newName.element,
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
  }

  draw();
  return {
    element,
    refresh,
    select,
    ensure,
    openCreate,
    openRename,
    confirmDelete,
    openMove,
    moveTo,
    bindMoveTarget,
    menuItems,
    folders: () => state.folders,
    folderName: nameOf,
    folderById: byId,
    currentFolder,
    get total() {
      return state.total;
    },
    get current() {
      return state.current;
    },
  };
}
