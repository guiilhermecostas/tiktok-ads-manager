import { get, patch, post } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { formatBytes } from '../../format.js';
import { alertBox, button, confirmDialog, emptyState, field, openModal, spinner, toast } from '../../ui.js';
import { closeContextMenu, openContextMenu } from '../context-menu.js';
import { createFileDrop } from './drop-upload.js';
import { fileCard, fileTable, folderTile } from './explorer-items.js';
import { SORT_OPTIONS, defaultDirFor, loadPrefs, savePrefs } from './explorer-prefs.js';
import { DRAG_TYPE, FOLDER_ALL, FOLDER_NONE, createFolders, folderIdOf, plural } from './folders.js';
import { createHookActivity } from './hook-activity.js';
import { openHookDialog } from './hook-dialog.js';
import { creativeThumb } from './thumb.js';
import { createUploader, uploadButton } from './uploader.js';

const PAGE_SIZE = 48;
const KIND_OPTIONS = [['', 'Todos os tipos'], ['image', 'Imagens'], ['video', 'Vídeos']];
const REFRESH_DELAY_MS = 500; // vários envios terminando juntos recarregam a lista uma vez só

/** Biblioteca de criativos como um gerenciador de arquivos: pastas ao lado, grade ou lista, arrastar e soltar para enviar e para organizar. */
export async function creativesView() {
  const prefs = loadPrefs();
  const st = { kind: '', q: '', ...prefs, creatives: [], total: 0, usedBytes: 0, quotaBytes: 0, limits: { maxImageBytes: 0, maxVideoBytes: 0 }, loading: false, error: null, selected: new Set(), anchor: null };
  const root = h('div', { class: 'explorer-page' });
  let searchTimer;
  let refreshTimer;
  let loadId = 0;
  let disposed = false;

  const isFolderOpen = () => typeof folders.current === 'number';
  const showFolderTiles = () => folders.current === FOLDER_ALL && !st.q && !st.kind && folders.folders().length > 0;
  const byId = (id) => st.creatives.find((c) => c.id === id);

  // Pastas (uma por oferta): trocar de pasta recarrega a lista; criativos movidos/pastas alteradas também.
  const folders = createFolders({
    onSelect: () => {
      st.selected.clear();
      st.anchor = null;
      drawCrumbs();
      reload();
    },
    onChanged: () => {
      st.selected.clear(); // depois de mover/renomear/apagar, começa uma seleção nova
      st.anchor = null;
      drawCrumbs();
      reload();
    },
  });

  const uploader = createUploader({
    getLimits: () => st.limits,
    getFolderId: () => folderIdOf(folders.current), // com uma pasta aberta, os envios já entram nela
    onUploaded: () => scheduleRefresh(),
  });

  /** Vários envios acabando perto um do outro: atualiza pastas e lista uma vez só, depois de uma pausa curta. */
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (disposed) return;
      await folders.refresh();
      if (!disposed) reload();
    }, REFRESH_DELAY_MS);
  }

  // ---------- dados ----------
  async function load({ append = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    if (!append) drawGrid();
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(append ? st.creatives.length : 0), sort: st.sort, dir: st.dir });
      if (st.kind) params.set('kind', st.kind);
      if (st.q) params.set('q', st.q);
      if (folders.current !== FOLDER_ALL) params.set('folderId', String(folders.current));
      const data = await get(`/creatives?${params}`);
      if (current !== loadId) return;
      st.creatives = append ? [...st.creatives, ...data.creatives] : data.creatives;
      for (const id of [...st.selected]) if (!st.creatives.some((c) => c.id === id)) st.selected.delete(id); // seleção só vale para o que está na tela
      Object.assign(st, { total: data.total, usedBytes: data.usedBytes, quotaBytes: data.quotaBytes, limits: data.limits });
    } catch (err) {
      if (current === loadId) st.error = err.message;
    } finally {
      if (current === loadId) {
        st.loading = false;
        drawGrid();
        drawMeter();
        drawStatus();
        drawSelection();
      }
    }
  }
  const reload = () => load();

  // ---------- ações sobre arquivos ----------
  function rename(creative) {
    const name = field('Nome', { type: 'text', required: true, maxlength: 100, value: creative.name });
    const errorSlot = h('div');
    const submit = button('Salvar', { variant: 'primary', type: 'submit' });
    const modal = openModal({
      title: 'Renomear criativo',
      body: h(
        'form',
        {
          class: 'form modal__body',
          novalidate: true,
          onSubmit: async (event) => {
            event.preventDefault();
            submit.disabled = true;
            try {
              await patch(`/creatives/${creative.id}`, { name: name.control.value });
              modal.close();
              toast('Criativo renomeado.');
              await reload();
            } catch (err) {
              errorSlot.replaceChildren(alertBox(err.message));
              submit.disabled = false;
            }
          },
        },
        errorSlot,
        name.element,
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
    name.control.select();
  }

  /** Exclui um ou vários (pede confirmação). Os que estiverem em uso em rascunho de campanha ficam, e a mensagem explica o motivo. */
  async function removeCreatives(ids) {
    if (!ids.length) return;
    const single = ids.length === 1 ? byId(ids[0]) : null;
    const ok = await confirmDialog({
      title: single ? 'Excluir criativo' : `Excluir ${ids.length} criativos`,
      message: single
        ? `Excluir "${single.name}" da biblioteca? O arquivo guardado aqui será apagado. Se ele já foi enviado ao TikTok, a cópia lá continua existindo.`
        : `Excluir ${plural(ids.length, 'criativo selecionado', 'criativos selecionados')} da biblioteca? Os arquivos guardados aqui serão apagados. Se algum já foi enviado ao TikTok, a cópia lá continua existindo.`,
      confirmLabel: single ? 'Excluir' : `Excluir ${ids.length}`,
      danger: true,
    });
    if (!ok) return;
    try {
      const { removed, failed } = await post('/creatives/delete', { ids });
      if (removed) toast(removed === 1 ? 'Criativo excluído.' : `${removed} criativos excluídos.`);
      if (failed.length) toast(failed.length === 1 ? failed[0].message : `${failed.length} criativos não foram excluídos: ${failed[0].message}`, 'danger');
    } catch (err) {
      toast(err.message, 'danger');
    }
    st.selected.clear();
    await Promise.all([reload(), folders.refresh()]);
    drawGrid();
  }

  function preview(creative) {
    const modal = openModal({
      title: creative.name,
      size: 'wide',
      body: h(
        'div',
        { class: 'modal__body' },
        h('div', { class: 'preview' }, creativeThumb(creative, { video: true })),
        h('p', { class: 'muted preview__meta' }, `${creative.kind === 'video' ? 'Vídeo' : 'Imagem'} · ${formatBytes(creative.sizeBytes)} · ${creative.mimeType ?? 'referência do TikTok'}`),
        creative.aiGenerated ? alertBox('Este vídeo contém um trecho gerado por IA. Ao publicar, ative a divulgação de conteúdo gerado por IA do TikTok.', 'warning') : null,
        h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })),
      ),
    });
  }

  function addFromTikTok() {
    const name = field('Nome', { type: 'text', required: true, maxlength: 100, placeholder: 'Ex.: Vídeo promoção' });
    const kind = field('Tipo', { as: 'select', options: [['video', 'Vídeo'], ['image', 'Imagem']], value: 'video' });
    const advertiser = field('ID da conta de anúncio', { type: 'text', inputmode: 'numeric', required: true, maxlength: 24, autocomplete: 'off' }, { hint: 'A conta precisa estar em uma das suas Business Centers.' });
    const tiktokId = field('ID do criativo no TikTok', { type: 'text', required: true, maxlength: 200, autocomplete: 'off', spellcheck: 'false' }, { hint: 'video_id ou image_id, como aparece na biblioteca de criativos do TikTok Ads.' });
    const errorSlot = h('div');
    const submit = button('Adicionar', { variant: 'primary', type: 'submit' });
    const modal = openModal({
      title: 'Adicionar criativo que já está no TikTok',
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
              await post('/creatives/tiktok', { name: name.control.value, kind: kind.control.value, advertiserId: advertiser.control.value, tiktokId: tiktokId.control.value });
              modal.close();
              toast('Criativo adicionado à biblioteca.');
              await reload();
            } catch (err) {
              errorSlot.replaceChildren(alertBox(err.message));
              submit.disabled = false;
            }
          },
        },
        errorSlot,
        name.element,
        kind.element,
        advertiser.element,
        tiktokId.element,
        h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
      ),
    });
  }

  // ---------- desenho: medidor, caminho, status ----------
  const meter = h('div', { class: 'meter' });
  function drawMeter() {
    const percent = st.quotaBytes ? Math.min(100, Math.round((st.usedBytes / st.quotaBytes) * 100)) : 0;
    const bar = h('div', { class: 'progress__bar' });
    bar.style.width = `${percent}%`;
    setChildren(
      meter,
      h('span', { class: 'muted' }, `${formatBytes(st.usedBytes)} de ${formatBytes(st.quotaBytes)} usados`),
      h('div', { class: `progress${percent >= 90 ? ' progress--warn' : ''}`, role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': 'Armazenamento usado' }, bar),
    );
  }

  const crumbs = h('div', { class: 'explorer__crumbs' });
  function drawCrumbs() {
    const folder = folders.currentFolder();
    const home = button('Criativos', { small: true, onClick: () => folders.select(FOLDER_ALL) });
    home.classList.add('crumb');
    home.setAttribute('aria-label', 'Voltar para todos os arquivos');
    const where = folders.current === FOLDER_NONE ? h('strong', { class: 'crumb crumb--now' }, icon('inbox', 15), 'Sem pasta') : folder ? h('strong', { class: 'crumb crumb--now', title: folder.name }, icon('folder', 15), h('span', null, folder.name)) : null;
    setChildren(
      crumbs,
      h('nav', { class: 'crumbs', 'aria-label': 'Caminho' }, where ? [home, icon('chevron', 14), where] : h('strong', { class: 'crumb crumb--now' }, icon('box', 15), 'Todos os arquivos')),
      folder ? h('span', { class: 'explorer__crumb-actions' }, button('Renomear pasta', { small: true, onClick: () => folders.openRename(folder) }), button('Excluir pasta', { small: true, variant: 'danger-ghost', onClick: () => folders.confirmDelete(folder) })) : null,
    );
  }

  const status = h('p', { class: 'muted explorer__status', 'aria-live': 'polite' });
  function drawStatus() {
    status.textContent = st.error || st.loading ? '' : `${plural(st.total, 'arquivo', 'arquivos')}${st.q || st.kind ? ' encontrados' : ''}`;
  }

  // ---------- seleção ----------
  const selectionBar = h('div', { class: 'selection-bar', hidden: true, role: 'region', 'aria-label': 'Criativos selecionados' });
  function drawSelection() {
    const n = st.selected.size;
    selectionBar.hidden = n === 0;
    setChildren(
      selectionBar,
      h('strong', null, `${n} ${n === 1 ? 'selecionado' : 'selecionados'}`),
      button('Mover para pasta…', { small: true, variant: 'primary', onClick: () => folders.openMove([...st.selected]) }),
      button('Excluir', { small: true, variant: 'danger-ghost', onClick: () => removeCreatives([...st.selected]) }),
      st.selected.size < st.creatives.length ? button('Selecionar tudo', { small: true, onClick: selectAll }) : null,
      button('Limpar seleção', { small: true, onClick: clearSelection }),
    );
  }
  /** Marca/desmarca só o que mudou nos itens já na tela (sem redesenhar, o que recarregaria as miniaturas dos vídeos). */
  function paintSelection() {
    for (const el of grid.querySelectorAll('[data-creative-id]')) {
      const on = st.selected.has(Number(el.dataset.creativeId));
      el.classList.toggle('is-selected', on);
      const box = el.querySelector('input[data-check]');
      if (box) box.checked = on;
    }
    drawSelection();
  }
  function clearSelection() {
    st.selected.clear();
    st.anchor = null;
    paintSelection();
  }
  function selectAll() {
    st.selected = new Set(st.creatives.map((c) => c.id));
    paintSelection();
  }
  /** Clique no item: sozinho seleciona só ele; Ctrl/⌘ soma ou tira; Shift marca o intervalo desde o último clicado. */
  function pick(creative, { additive = false, range = false } = {}) {
    if (range && st.anchor !== null && byId(st.anchor)) {
      const ids = st.creatives.map((c) => c.id);
      const [a, b] = [ids.indexOf(st.anchor), ids.indexOf(creative.id)].sort((x, y) => x - y);
      st.selected = new Set(additive ? [...st.selected, ...ids.slice(a, b + 1)] : ids.slice(a, b + 1));
    } else if (additive) {
      if (st.selected.has(creative.id)) st.selected.delete(creative.id);
      else st.selected.add(creative.id);
      st.anchor = creative.id;
    } else {
      st.selected = new Set([creative.id]);
      st.anchor = creative.id;
    }
    paintSelection();
  }

  // ---------- desenho: lista de arquivos ----------
  const grid = h('div', { class: 'explorer__content', tabindex: '-1' });
  const touchDevice = () => window.matchMedia?.('(pointer: coarse)').matches === true;

  function drawGrid() {
    closeContextMenu();
    if (st.error) return setChildren(grid, alertBox(st.error));
    if (st.loading && !st.creatives.length) return setChildren(grid, spinner());
    const tiles = showFolderTiles()
      ? h('section', { class: 'explorer__section', 'aria-label': 'Pastas' }, h('h2', { class: 'explorer__heading' }, `Pastas (${folders.folders().length})`), h('div', { class: 'folder-grid' }, folders.folders().map((f) => {
          const tile = folderTile(f);
          folders.bindMoveTarget(tile, f.id);
          return tile;
        })))
      : null;
    if (!st.creatives.length) {
      const filtered = st.kind || st.q;
      const inFolder = isFolderOpen();
      const unfiled = folders.current === FOLDER_NONE;
      const text = filtered ? 'Tente outro filtro ou outra busca.' : unfiled ? 'Todos os seus criativos já estão em pastas.' : inFolder ? 'Arraste arquivos do computador para esta página (eles entram nesta pasta) ou arraste criativos da lista para o nome da pasta.' : 'Arraste imagens (JPG, PNG) e vídeos (MP4, MOV) para esta página, ou use o botão. Crie pastas para organizar por oferta.';
      return setChildren(grid, tiles, h('div', { class: 'card explorer__empty' }, emptyState({
        title: filtered ? 'Nenhum criativo encontrado' : unfiled ? 'Nenhum criativo sem pasta' : inFolder ? 'Esta pasta está vazia' : 'Sua biblioteca está vazia',
        text,
        action: filtered || unfiled ? null : uploadButton(uploader, { label: inFolder ? 'Enviar para esta pasta' : 'Enviar primeiros arquivos' }),
      })));
    }
    const showFolder = folders.current === FOLDER_ALL;
    const files = st.view === 'list'
      ? fileTable(st.creatives, { selected: st.selected, showFolder, folderNameOf: (id) => folders.folderName(id), sort: st.sort, dir: st.dir })
      : h('div', { class: 'creative-grid' }, st.creatives.map((c) => fileCard(c, { selected: st.selected.has(c.id), folderName: showFolder && c.folderId !== null ? folders.folderName(c.folderId) : null })));
    setChildren(
      grid,
      tiles,
      tiles ? h('h2', { class: 'explorer__heading' }, 'Arquivos') : null,
      files,
      st.creatives.length < st.total ? h('div', { class: 'load-more' }, button(st.loading ? 'Carregando…' : `Carregar mais (${st.total - st.creatives.length})`, { disabled: st.loading, onClick: () => load({ append: true }) })) : null,
    );
  }

  // Um conjunto de ouvintes na área inteira (em vez de um por item): clique, duplo clique, botão direito, teclado e arrastar.
  const itemOf = (event) => event.target.closest('[data-creative-id]');
  const folderOf = (event) => event.target.closest('[data-folder-id]');

  grid.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]');
    const sortBtn = event.target.closest('[data-sort]');
    const item = itemOf(event);
    const tile = folderOf(event);
    if (sortBtn) return setSort(sortBtn.dataset.sort);
    if (tile && action) {
      const folder = folders.folderById(Number(tile.dataset.folderId));
      if (!folder) return undefined;
      if (action.dataset.action === 'open-folder') folders.select(folder.id);
      else if (action.dataset.action === 'rename-folder') folders.openRename(folder);
      else if (action.dataset.action === 'delete-folder') folders.confirmDelete(folder);
      return undefined;
    }
    if (!item) {
      if (event.target === grid || event.target.classList.contains('explorer__section') || event.target.classList.contains('creative-grid')) clearSelection(); // clicar no vazio limpa a seleção
      return undefined;
    }
    const creative = byId(Number(item.dataset.creativeId));
    if (!creative) return undefined;
    if (action) {
      const name = action.dataset.action;
      if (name === 'view') preview(creative);
      else if (name === 'move') folders.openMove([creative.id], { current: creative.folderId });
      else if (name === 'rename') rename(creative);
      else if (name === 'remove') removeCreatives([creative.id]);
      return undefined;
    }
    if (event.target.closest('input[data-check]')) return pick(creative, { additive: true, range: event.shiftKey });
    if (event.target.closest('label, a')) return undefined;
    // celular/tablet: tocar abre a pré-visualização, a menos que já haja uma seleção em andamento
    if (touchDevice() && !st.selected.size && !event.shiftKey && !event.metaKey && !event.ctrlKey) return preview(creative);
    return pick(creative, { additive: event.metaKey || event.ctrlKey, range: event.shiftKey });
  });

  grid.addEventListener('dblclick', (event) => {
    const item = itemOf(event);
    if (!item || event.target.closest('button, input, label')) return;
    const creative = byId(Number(item.dataset.creativeId));
    if (creative) preview(creative);
  });

  grid.addEventListener('contextmenu', (event) => {
    const item = itemOf(event);
    const tile = folderOf(event);
    if (tile) {
      const folder = folders.folderById(Number(tile.dataset.folderId));
      if (!folder) return;
      event.preventDefault();
      openContextMenu({ x: event.clientX, y: event.clientY, items: folders.menuItems(folder), label: `Ações da pasta ${folder.name}` });
      return;
    }
    if (!item) return;
    const creative = byId(Number(item.dataset.creativeId));
    if (!creative) return;
    event.preventDefault();
    if (!st.selected.has(creative.id)) pick(creative); // botão direito num item fora da seleção seleciona só ele (como no Explorador/Finder)
    const ids = [...st.selected];
    const many = ids.length > 1;
    openContextMenu({
      x: event.clientX,
      y: event.clientY,
      label: many ? `Ações para ${ids.length} criativos` : `Ações para ${creative.name}`,
      items: [
        ...(many ? [] : [{ label: 'Ver', icon: 'eye', onClick: () => preview(creative) }, { label: 'Renomear', icon: 'edit', onClick: () => rename(creative) }]),
        { label: many ? `Mover ${ids.length} para pasta…` : 'Mover para pasta…', icon: 'folder', onClick: () => folders.openMove(ids, { current: many ? null : creative.folderId }) },
        'separator',
        { label: many ? `Excluir ${ids.length}` : 'Excluir', icon: 'trash', danger: true, onClick: () => removeCreatives(ids) },
      ],
    });
  });

  // Arrastar para uma pasta: leva a seleção inteira, se este criativo estiver nela; senão, só ele.
  grid.addEventListener('dragstart', (event) => {
    const item = itemOf(event);
    if (!item) return;
    const id = Number(item.dataset.creativeId);
    const ids = st.selected.has(id) ? [...st.selected] : [id];
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
    event.dataTransfer.effectAllowed = 'move';
    item.classList.add('is-dragging');
  });
  grid.addEventListener('dragend', (event) => itemOf(event)?.classList.remove('is-dragging'));

  // Teclado (só com o foco fora de campos de texto e sem pop-up aberto): Ctrl/⌘+A, Esc, Delete, Enter, F2.
  function onKeyDown(event) {
    if (document.body.classList.contains('modal-open') || event.defaultPrevented) return;
    const tag = event.target.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || event.target.isContentEditable) return;
    const focused = event.target.closest?.('[data-creative-id]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
    } else if (event.key === 'Escape' && st.selected.size) {
      clearSelection();
    } else if (event.key === 'Delete' && st.selected.size) {
      event.preventDefault();
      removeCreatives([...st.selected]);
    } else if (focused && event.key === 'Enter' && !event.target.closest('button')) {
      event.preventDefault();
      const creative = byId(Number(focused.dataset.creativeId));
      if (creative) preview(creative);
    } else if (focused && event.key === ' ' && !event.target.closest('button, input')) {
      event.preventDefault();
      const creative = byId(Number(focused.dataset.creativeId));
      if (creative) pick(creative, { additive: true });
    } else if (event.key === 'F2' && st.selected.size === 1) {
      event.preventDefault();
      const creative = byId([...st.selected][0]);
      if (creative) rename(creative);
    } else if (focused && ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      moveFocus(focused, event);
    }
  }
  /** Setas: mudam o foco entre os itens. Na grade, para cima/baixo vai à mesma coluna da linha vizinha; na lista, só para cima/baixo. */
  function moveFocus(focused, event) {
    const items = [...grid.querySelectorAll('[data-creative-id]')];
    const firstTop = items[0]?.offsetTop;
    const columns = Math.max(1, items.filter((el) => el.offsetTop === firstTop).length);
    const steps = st.view === 'list' ? { ArrowDown: 1, ArrowUp: -1 } : { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns };
    const next = items[items.indexOf(focused) + (steps[event.key] ?? 0)];
    if (!steps[event.key] || !next || next === focused) return;
    event.preventDefault();
    next.focus();
    if (event.shiftKey) {
      st.selected.add(Number(next.dataset.creativeId)); // Shift + seta amplia a seleção
      paintSelection();
    }
  }
  document.addEventListener('keydown', onKeyDown);

  // ---------- barra de ferramentas: busca, tipo, ordenar, visualização ----------
  function setSort(sort) {
    if (st.sort === sort) st.dir = st.dir === 'asc' ? 'desc' : 'asc';
    else {
      st.sort = sort;
      st.dir = defaultDirFor(sort);
    }
    persist();
    drawToolbar();
    load();
  }
  const persist = () => savePrefs({ view: st.view, sort: st.sort, dir: st.dir });

  const search = h('input', {
    class: 'input toolbar__search', type: 'search', placeholder: 'Buscar por nome…', 'aria-label': 'Buscar criativos', maxlength: 100,
    onInput: (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.q = event.target.value.trim(); load(); }, 300);
    },
  });
  const kindSelect = h('select', { class: 'input explorer__select', 'aria-label': 'Filtrar por tipo', onChange: (event) => { st.kind = event.target.value; st.selected.clear(); load(); } }, KIND_OPTIONS.map(([value, label]) => h('option', { value }, label)));
  const sortSelect = h('select', { class: 'input explorer__select', 'aria-label': 'Ordenar por', onChange: (event) => { st.sort = event.target.value; st.dir = defaultDirFor(st.sort); persist(); drawToolbar(); load(); } }, SORT_OPTIONS.map(([value, label]) => h('option', { value }, `Ordenar: ${label}`)));
  const dirButton = h('button', { type: 'button', class: 'icon-btn explorer__dir', onClick: () => { st.dir = st.dir === 'asc' ? 'desc' : 'asc'; persist(); drawToolbar(); load(); } });
  const viewButtons = h('div', { class: 'view-toggle', role: 'group', 'aria-label': 'Modo de visualização' });
  function drawToolbar() {
    sortSelect.value = st.sort;
    setChildren(dirButton, icon(st.dir === 'asc' ? 'arrow-up' : 'arrow-down', 16));
    dirButton.title = st.dir === 'asc' ? 'Crescente (clique para inverter)' : 'Decrescente (clique para inverter)';
    dirButton.setAttribute('aria-label', st.dir === 'asc' ? 'Ordem crescente. Inverter' : 'Ordem decrescente. Inverter');
    setChildren(
      viewButtons,
      [['grid', 'Grade', 'grid'], ['list', 'Lista', 'list']].map(([view, label, iconName]) =>
        h('button', { type: 'button', class: `icon-btn${st.view === view ? ' is-on' : ''}`, 'aria-pressed': String(st.view === view), title: label, 'aria-label': `Visualizar em ${label.toLowerCase()}`, onClick: () => { if (st.view === view) return; st.view = view; persist(); drawToolbar(); drawGrid(); } }, icon(iconName, 16)),
      ),
    );
  }

  // ---------- envio por arrastar e soltar ----------
  async function handleDrop({ files, directories, folderId, failed = false }) {
    if (failed) return toast('Não foi possível ler o que foi solto. Use o botão "Enviar arquivos".', 'danger');
    const label = (id) => (id === null ? null : folders.folderName(id));
    if (files.length) {
      uploader.add(files, { folderId, folderLabel: label(folderId) });
      toast(`Enviando ${plural(files.length, 'arquivo', 'arquivos')}${folderId === null ? '' : ` para "${label(folderId) ?? 'pasta'}"`}…`);
    }
    for (const dir of directories) {
      try {
        const id = await folders.ensure(dir.name);
        if (!dir.files.length) toast(`A pasta "${dir.name}" não tem arquivos para enviar.`, 'danger');
        else uploader.add(dir.files, { folderId: id, folderLabel: folders.folderName(id) });
        if (dir.subfolders) toast(`"${dir.name}": ${plural(dir.subfolders, 'subpasta foi ignorada', 'subpastas foram ignoradas')} (a biblioteca tem um nível de pastas só).`, 'danger');
        if (dir.ignored) toast(`"${dir.name}": só os primeiros ${dir.files.length} arquivos foram enviados.`, 'danger');
      } catch (err) {
        toast(`Não foi possível criar a pasta "${dir.name}": ${err.message}`, 'danger');
      }
    }
    drawGrid();
  }
  const fileDrop = createFileDrop({
    currentFolder: () => folderIdOf(folders.current),
    labelOf: (id) => folders.folderName(id),
    onDrop: handleDrop,
  });

  // Botão "Hook com IA": uma bolinha piscando mostra que há hook gerando ou sendo juntado a um vídeo. O trabalho roda no SERVIDOR, então a bolinha
  // continua mesmo com o pop-up fechado (e volta ao reabrir o site). Ao terminar com o pop-up fechado, a biblioteca se atualiza sozinha.
  const hookDot = h('span', { class: 'pulse-dot', 'aria-hidden': 'true' });
  const hookButton = button('Hook com IA', { onClick: () => {
    activity.pause();
    openHookDialog({ onCreated: () => scheduleRefresh(), onClose: () => activity.resume() });
  } });
  const activity = createHookActivity({
    onBusy: (busy) => {
      hookButton.classList.toggle('is-busy', busy);
      if (busy) hookButton.prepend(hookDot);
      else hookDot.remove();
      hookButton.title = busy ? 'Há hooks sendo gerados ou juntados a um vídeo. Continua no servidor mesmo se você fechar o site.' : '';
      hookButton.setAttribute('aria-label', busy ? 'Hook com IA (em andamento)' : 'Hook com IA');
    },
    onApplied: () => scheduleRefresh(),
  });

  const actions = h('div', { class: 'page-header__actions' }, hookButton, button('Já está no TikTok? Adicionar por ID', { onClick: addFromTikTok }), uploadButton(uploader));
  const toolbar = h('div', { class: 'explorer__toolbar' }, crumbs, h('div', { class: 'explorer__tools' }, search, kindSelect, sortSelect, dirButton, viewButtons));
  const main = h('section', { class: 'explorer__main', 'aria-label': 'Arquivos' }, toolbar, status, selectionBar, uploader.element, grid);
  setChildren(
    root,
    h('div', { class: 'page-header' }, h('div', null, h('h1', { class: 'page-title' }, 'Criativos'), h('p', { class: 'muted' }, 'Arraste imagens e vídeos para esta página para enviar. Organize por oferta em pastas e selecione nas campanhas.')), actions),
    meter,
    h('div', { class: 'explorer' }, h('aside', { class: 'explorer__nav' }, folders.element), main),
    fileDrop.hint,
  );
  drawToolbar();
  drawCrumbs();
  drawMeter();
  drawSelection();
  await Promise.all([folders.refresh(), load()]);
  drawGrid(); // as pastas já chegaram: desenha os cartões de pasta
  activity.start();

  return {
    element: root,
    cleanup: () => {
      disposed = true;
      activity.stop();
      loadId += 1;
      clearTimeout(searchTimer);
      clearTimeout(refreshTimer);
      closeContextMenu();
      document.removeEventListener('keydown', onKeyDown);
      fileDrop.destroy();
    },
  };
}
