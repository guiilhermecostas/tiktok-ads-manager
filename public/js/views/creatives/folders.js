import { del, get, patch, post } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { alertBox, button, confirmDialog, field, openModal, toast } from '../../ui.js';

/** Valores do filtro de pasta: '' = todas, 'none' = sem pasta, número = uma pasta. */
export const FOLDER_ALL = '';
export const FOLDER_NONE = 'none';
export const MAX_FOLDER_NAME = 60;
/** Formato usado ao arrastar criativos para uma pasta. */
export const DRAG_TYPE = 'application/x-creative-ids';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** ID da pasta para enviar ao servidor (só quando uma pasta de verdade está aberta). */
export const folderIdOf = (current) => (typeof current === 'number' ? current : null);

/**
 * Pastas da biblioteca (uma por oferta). Desenha a barra de pastas e cuida de criar, renomear, apagar e mover.
 *  - `onSelect(value)`: a pessoa escolheu "Todos", "Sem pasta" ou uma pasta.
 *  - `onChanged()`: algo mudou (criativos movidos, pasta criada/apagada…): a tela recarrega a lista.
 *  - `getDragIds(id)`: IDs a mover quando se arrasta o criativo `id` (a seleção inteira, se ele estiver nela).
 * Todo texto (inclusive nome de pasta) entra como nó de texto, nunca como HTML.
 */
export function createFolders({ onSelect, onChanged }) {
  const state = { folders: [], total: 0, unfiled: 0, current: FOLDER_ALL, loaded: false, error: null };
  const bar = h('div', { class: 'folders', role: 'group', 'aria-label': 'Pastas' });
  const header = h('div', { class: 'folders__header' });
  const element = h('div', { class: 'folders-wrap' }, bar, header);

  const nameOf = (id) => state.folders.find((f) => f.id === id)?.name ?? null;
  const currentFolder = () => (typeof state.current === 'number' ? state.folders.find((f) => f.id === state.current) ?? null : null);

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

  function chip({ value, label, count, iconName, folder = null }) {
    const active = state.current === value;
    const el = h(
      'button',
      {
        type: 'button',
        class: `folder-chip${active ? ' is-on' : ''}`,
        'aria-pressed': String(active),
        'data-folder': String(value),
        title: folder ? folder.name : label,
        onClick: () => select(value),
      },
      iconName ? icon(iconName, 15) : null,
      h('span', { class: 'folder-chip__name' }, label),
      h('span', { class: 'folder-chip__count' }, String(count)),
    );
    // Soltar criativos arrastados em cima da pasta move todos (só "Todas" não é destino).
    if (value !== FOLDER_ALL) {
      el.addEventListener('dragover', (event) => {
        if (!event.dataTransfer?.types?.includes(DRAG_TYPE)) return;
        event.preventDefault();
        el.classList.add('is-drop');
      });
      el.addEventListener('dragleave', () => el.classList.remove('is-drop'));
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
        if (Array.isArray(ids) && ids.length && ids.every(Number.isInteger)) moveTo(ids, value === FOLDER_NONE ? null : value);
      });
    }
    return el;
  }

  function draw() {
    setChildren(
      bar,
      chip({ value: FOLDER_ALL, label: 'Todos', count: state.total }),
      chip({ value: FOLDER_NONE, label: 'Sem pasta', count: state.unfiled }),
      state.folders.map((f) => chip({ value: f.id, label: f.name, count: f.count, iconName: 'folder', folder: f })),
      h('button', { type: 'button', class: 'folder-chip folder-chip--new', onClick: () => openCreate() }, icon('plus', 14), h('span', null, 'Nova pasta')),
    );
    const folder = currentFolder();
    setChildren(
      header,
      folder
        ? [
            h('strong', { class: 'folders__title' }, icon('folder', 16), h('span', { title: folder.name }, folder.name), h('span', { class: 'muted' }, plural(folder.count, 'criativo', 'criativos'))),
            h('span', { class: 'folders__actions' },
              button('Renomear pasta', { small: true, onClick: () => openRename(folder) }),
              button('Excluir pasta', { small: true, variant: 'danger-ghost', onClick: () => confirmDelete(folder) })),
          ]
        : null,
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
    openCreate,
    openMove,
    moveTo,
    folders: () => state.folders,
    folderName: nameOf,
    get current() {
      return state.current;
    },
  };
}
