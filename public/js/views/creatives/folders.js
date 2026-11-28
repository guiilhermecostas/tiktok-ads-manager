import { MAX_FOLDER_DEPTH, depthOf, descendantIds, pathLabel, pathOf, treeOrder, withTotals } from '/shared/creative-folders.js';
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
 * Pastas da biblioteca (uma por oferta, cada uma com subpastas até MAX_FOLDER_DEPTH níveis). Desenha a barra lateral em árvore (as subpastas
 * aparecem sob a pasta aberta e as que levam até ela) e cuida de criar, renomear, apagar e mover.
 *  - `onSelect(value)`: a pessoa escolheu "Todos", "Sem pasta" ou uma pasta.
 *  - `onChanged()`: algo mudou (criativos movidos, pasta renomeada/apagada…): a tela recarrega a lista.
 * Cada item da barra aceita soltar CRIATIVOS (move) e ARQUIVOS do computador (envia: atributo `data-drop-folder`).
 * Todo texto (inclusive nome de pasta) entra como nó de texto, nunca como HTML.
 */
export function createFolders({ onSelect, onChanged }) {
  // `folders`: lista simples do servidor; `tree`: a mesma lista com os totais de cada pasta somando as subpastas (deepCount, subfolderCount).
  const state = { folders: [], tree: [], total: 0, unfiled: 0, current: FOLDER_ALL, loaded: false, error: null };
  const element = h('nav', { class: 'folder-nav', 'aria-label': 'Pastas' });

  /** "Oferta A / Verão" (ou só o nome, se for de nível mais alto); nulo se a pasta não existe. */
  const nameOf = (id) => pathLabel(state.folders, id);
  const byId = (id) => state.tree.find((f) => f.id === id) ?? null;
  const currentFolder = () => (typeof state.current === 'number' ? byId(state.current) : null);
  /** Subpastas diretas de uma pasta (`null` = as de nível mais alto), na ordem da lista. */
  const childrenOf = (parentId) => state.tree.filter((f) => (f.parentId ?? null) === parentId);
  const canHaveChildren = (id) => depthOf(state.folders, id) < MAX_FOLDER_DEPTH;

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
    ...(canHaveChildren(folder.id) ? [{ label: 'Nova subpasta', icon: 'plus', onClick: () => openCreate({ parentId: folder.id }) }] : []),
    'separator',
    { label: 'Renomear pasta', icon: 'edit', onClick: () => openRename(folder) },
    { label: 'Excluir pasta', icon: 'trash', danger: true, onClick: () => confirmDelete(folder) },
  ];

  function navItem({ value, label, count, iconName, folder = null, depth = 0, hasMore = false }) {
    const active = state.current === value;
    const el = h(
      'button',
      {
        type: 'button',
        class: `folder-item${active ? ' is-on' : ''}`,
        'aria-current': active ? 'page' : null,
        'data-folder': String(value),
        'data-depth': depth ? String(depth) : null,
        [DROP_ATTR]: folder ? String(folder.id) : 'none', // "Todos" e "Sem pasta": arquivos do computador entram sem pasta
        title: folder ? nameOf(folder.id) : label,
        onClick: () => select(value),
      },
      icon(iconName, 16),
      h('span', { class: 'folder-item__name' }, label),
      hasMore ? h('span', { class: 'folder-item__more', title: 'Tem subpastas', 'aria-label': 'Tem subpastas' }, icon('chevron', 12)) : null,
      h('span', { class: 'folder-item__count' }, String(count)),
    );
    // Soltar criativos arrastados em cima de uma pasta move todos; "Todos" não é destino.
    if (value !== FOLDER_ALL) bindMoveTarget(el, value === FOLDER_NONE ? null : value);
    if (folder) el.addEventListener('contextmenu', (event) => { event.preventDefault(); openContextMenu({ x: event.clientX, y: event.clientY, items: menuItems(folder), label: `Ações da pasta ${folder.name}` }); });
    return el;
  }

  /** Árvore da barra lateral: as de nível mais alto sempre; as subpastas só sob a pasta aberta e as que levam até ela (sem carets nem cliques extras). */
  function visibleFolders() {
    const open = new Set(typeof state.current === 'number' ? pathOf(state.folders, state.current).map((f) => f.id) : []);
    return treeOrder(state.tree).filter(({ folder, depth }) => depth === 0 || open.has(folder.parentId)).map((entry) => ({ ...entry, open: open.has(entry.folder.id) }));
  }

  function draw() {
    setChildren(
      element,
      navItem({ value: FOLDER_ALL, label: 'Todos os arquivos', count: state.total, iconName: 'box' }),
      navItem({ value: FOLDER_NONE, label: 'Sem pasta', count: state.unfiled, iconName: 'inbox' }),
      state.folders.length ? h('div', { class: 'folder-nav__title' }, 'Pastas') : null,
      visibleFolders().map(({ folder, depth, open }) => navItem({ value: folder.id, label: folder.name, count: folder.deepCount, iconName: 'folder', folder, depth, hasMore: folder.subfolderCount > 0 && !open })),
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
      Object.assign(state, { folders: data.folders, tree: withTotals(data.folders), total: data.total, unfiled: data.unfiledCount, loaded: true, error: null });
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
   * Devolve o ID da pasta de NÍVEL MAIS ALTO com este nome (a comparação ignora maiúsculas e espaços extras), criando-a se ainda não existir.
   * Usado ao soltar uma PASTA do computador: ela vira uma pasta da biblioteca com o mesmo nome. Lança Error com mensagem em português.
   */
  async function ensure(rawName) {
    const name = cleanFolderName(rawName);
    if (!name) throw new Error('A pasta solta não tem nome.');
    const find = () => state.folders.find((f) => f.parentId === null && f.name.toLowerCase() === name.toLowerCase());
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
  function nameDialog({ title, submitLabel, initial = '', context = null, onSubmit }) {
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
        context ? h('p', { class: 'muted' }, context) : null,
        name.element,
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
    name.control.select();
    return modal;
  }

  /** Nova pasta; com `parentId`, nova SUBPASTA dentro dela. `then(folder)` (opcional) roda depois de criar, no lugar de abrir a pasta nova. */
  function openCreate({ parentId = null, then } = {}) {
    nameDialog({
      title: parentId === null ? 'Nova pasta' : 'Nova subpasta',
      submitLabel: parentId === null ? 'Criar pasta' : 'Criar subpasta',
      context: parentId === null ? null : `Será criada dentro de “${nameOf(parentId) ?? 'pasta'}”.`,
      onSubmit: async (value) => {
        const { folder } = await post('/creatives/folders', parentId === null ? { name: value } : { name: value, parentId });
        toast(`${parentId === null ? 'Pasta' : 'Subpasta'} "${folder.name}" criada.`);
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
    const subfolders = descendantIds(state.folders, folder.id).length;
    const files = byId(folder.id)?.deepCount ?? folder.count;
    const ok = await confirmDialog({
      title: 'Excluir pasta',
      message: `Excluir a pasta "${folder.name}"${subfolders ? ` e ${plural(subfolders, 'subpasta', 'subpastas')} dentro dela` : ''}? ${files ? `${plural(files, 'criativo', 'criativos')} dentro ${files === 1 ? 'dela NÃO é apagado: volta' : 'dela NÃO são apagados: voltam'} para "Sem pasta".` : subfolders ? 'Todas estão vazias.' : 'Ela está vazia.'}`,
      confirmLabel: 'Excluir pasta',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/creatives/folders/${folder.id}`);
      toast(subfolders ? 'Pasta e subpastas excluídas. Os criativos continuam na biblioteca.' : 'Pasta excluída. Os criativos continuam na biblioteca.');
      // Estava dentro da pasta apagada (ou de uma subpasta dela)? Vai para a pasta de cima (ou "Todos").
      const gone = new Set([folder.id, ...descendantIds(state.folders, folder.id)]);
      const wasInside = typeof state.current === 'number' && gone.has(state.current);
      if (wasInside) state.current = folder.parentId ?? FOLDER_ALL;
      await refresh();
      if (wasInside) onSelect(state.current);
      else onChanged();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- "Mover para…" ----------
  /** Pop-up para escolher a pasta de destino (ou criar uma nova na hora). `ids`: criativos a mover. */
  function openMove(ids, { current = null } = {}) {
    const NEW = '__new__';
    const options = [['', 'Sem pasta'], ...treeOrder(state.folders).map(({ folder }) => [String(folder.id), nameOf(folder.id)]), [NEW, '＋ Nova pasta…']];
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
    folders: () => state.tree,
    childrenOf,
    canHaveChildren,
    pathOf: (id) => pathOf(state.folders, id),
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
