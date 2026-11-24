import { del, get, patch, post } from '../../api.js';
import { h, icon, setChildren } from '../../dom.js';
import { formatBytes, formatDate } from '../../format.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, spinner, toast } from '../../ui.js';
import { DRAG_TYPE, FOLDER_ALL, FOLDER_NONE, createFolders, folderIdOf } from './folders.js';
import { createHookActivity } from './hook-activity.js';
import { openHookDialog } from './hook-dialog.js';
import { creativeThumb } from './thumb.js';
import { createUploader, uploadButton } from './uploader.js';

const PAGE_SIZE = 48;
const TABS = [
  ['', 'Todos'],
  ['image', 'Imagens'],
  ['video', 'Vídeos'],
];

/** Biblioteca de criativos: guarde uma vez, use em qualquer campanha. */
export async function creativesView() {
  const st = { kind: '', q: '', creatives: [], total: 0, usedBytes: 0, quotaBytes: 0, limits: { maxImageBytes: 0, maxVideoBytes: 0 }, loading: false, error: null, selected: new Set() };
  const root = h('div');
  let searchTimer;
  let loadId = 0;

  // Pastas (uma por oferta): trocar de pasta recarrega a lista; criativos movidos/pastas alteradas também.
  const folders = createFolders({
    onSelect: () => {
      st.selected.clear();
      reload();
    },
    onChanged: () => {
      st.selected.clear(); // depois de mover/renomear/apagar, começa uma seleção nova
      reload();
    },
  });

  const uploader = createUploader({
    getLimits: () => st.limits,
    getFolderId: () => folderIdOf(folders.current), // com uma pasta aberta, os envios já entram nela
    onUploaded: () => {
      folders.refresh();
      reload();
    },
  });

  // ---------- dados ----------
  async function load({ append = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    if (!append) drawGrid();
    try {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(append ? st.creatives.length : 0) });
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
      }
    }
  }
  const reload = () => load().then(drawSelection);

  // ---------- ações ----------
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

  async function remove(creative) {
    const ok = await confirmDialog({
      title: 'Excluir criativo',
      message: `Excluir "${creative.name}" da biblioteca? O arquivo guardado aqui será apagado. Se ele já foi enviado ao TikTok, a cópia lá continua existindo.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/creatives/${creative.id}`);
      toast('Criativo excluído.');
      st.selected.delete(creative.id);
      await Promise.all([reload(), folders.refresh()]);
    } catch (err) {
      toast(err.message, 'danger');
    }
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

  // ---------- desenho ----------
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

  const grid = h('div');

  // ---------- seleção (para mover vários de uma vez) ----------
  const selectionBar = h('div', { class: 'selection-bar', hidden: true, role: 'region', 'aria-label': 'Criativos selecionados' });
  function drawSelection() {
    const n = st.selected.size;
    selectionBar.hidden = n === 0;
    setChildren(
      selectionBar,
      h('strong', null, `${n} ${n === 1 ? 'selecionado' : 'selecionados'}`),
      button('Mover para pasta…', { small: true, variant: 'primary', onClick: () => folders.openMove([...st.selected]) }),
      button('Limpar seleção', { small: true, onClick: () => { st.selected.clear(); drawGrid(); drawSelection(); } }),
    );
  }
  /** Marca/desmarca só aquele cartão (sem redesenhar a grade, que recarregaria as miniaturas dos vídeos). */
  function toggleSelected(creative, article) {
    if (st.selected.has(creative.id)) st.selected.delete(creative.id);
    else st.selected.add(creative.id);
    article.classList.toggle('is-selected', st.selected.has(creative.id));
    drawSelection();
  }

  function card(creative) {
    const used = creative.tiktokAdvertisers.length;
    const folderName = creative.folderId !== null && folders.current === FOLDER_ALL ? folders.folderName(creative.folderId) : null;
    const selected = st.selected.has(creative.id);
    const article = h(
      'article',
      { class: `creative-card${selected ? ' is-selected' : ''}`, draggable: true },
      h('label', { class: 'creative-card__select', title: 'Selecionar' }, h('input', { type: 'checkbox', checked: selected, 'aria-label': `Selecionar ${creative.name}`, onChange: (event) => toggleSelected(creative, event.currentTarget.closest('article')) })),
      h('button', { type: 'button', class: 'creative-card__preview', 'aria-label': `Ver ${creative.name}`, onClick: () => preview(creative) }, creativeThumb(creative)),
      h(
        'div',
        { class: 'creative-card__body' },
        h('p', { class: 'creative-card__name', title: creative.name }, creative.name),
        h('p', { class: 'muted creative-card__meta' }, `${creative.sizeBytes === null ? 'No TikTok' : formatBytes(creative.sizeBytes)} · ${formatDate(creative.createdAt)}`),
        used || creative.aiGenerated || folderName
          ? h('p', { class: 'creative-card__tags' }, folderName ? h('span', { class: 'folder-tag', title: `Pasta: ${folderName}` }, icon('folder', 12), h('span', null, folderName)) : null, creative.aiGenerated ? badge('Gerado por IA', 'neutral') : null, used ? badge(`Enviado a ${used} conta${used > 1 ? 's' : ''}`, 'success') : null)
          : null,
      ),
      h(
        'div',
        { class: 'creative-card__actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Mover para pasta', 'aria-label': `Mover ${creative.name} para uma pasta`, onClick: () => folders.openMove([creative.id], { current: creative.folderId }) }, icon('folder', 16)),
        h('button', { type: 'button', class: 'icon-btn', title: 'Renomear', 'aria-label': `Renomear ${creative.name}`, onClick: () => rename(creative) }, icon('edit', 16)),
        h('button', { type: 'button', class: 'icon-btn icon-btn--danger', title: 'Excluir', 'aria-label': `Excluir ${creative.name}`, onClick: () => remove(creative) }, icon('trash', 16)),
      ),
    );
    // Arrastar para uma pasta: leva a seleção inteira, se este criativo estiver nela; senão, só ele.
    article.addEventListener('dragstart', (event) => {
      const ids = st.selected.has(creative.id) ? [...st.selected] : [creative.id];
      event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(ids));
      event.dataTransfer.effectAllowed = 'move';
      article.classList.add('is-dragging');
    });
    article.addEventListener('dragend', () => article.classList.remove('is-dragging'));
    return article;
  }

  function drawGrid() {
    if (st.error) return setChildren(grid, alertBox(st.error));
    if (st.loading && !st.creatives.length) return setChildren(grid, spinner());
    if (!st.creatives.length) {
      const filtered = st.kind || st.q;
      const inFolder = typeof folders.current === 'number';
      const unfiled = folders.current === FOLDER_NONE;
      if (inFolder && !filtered) {
        return setChildren(grid, h('div', { class: 'card' }, emptyState({ title: 'Esta pasta está vazia', text: 'Envie arquivos aqui (eles entram nesta pasta) ou arraste criativos da lista para o nome dela.', action: uploadButton(uploader, { label: 'Enviar para esta pasta' }) })));
      }
      return setChildren(
        grid,
        h('div', { class: 'card' }, emptyState({
          title: filtered ? 'Nenhum criativo encontrado' : unfiled ? 'Nenhum criativo sem pasta' : 'Sua biblioteca está vazia',
          text: filtered ? 'Tente outro filtro ou outra busca.' : unfiled ? 'Todos os seus criativos já estão em pastas.' : 'Envie imagens (JPG, PNG) e vídeos (MP4, MOV) uma vez e use em qualquer campanha, sem digitar IDs. Crie pastas para organizar por oferta.',
          action: filtered || unfiled ? null : uploadButton(uploader, { label: 'Enviar primeiros arquivos' }),
        })),
      );
    }
    setChildren(
      grid,
      h('div', { class: 'creative-grid' }, st.creatives.map(card)),
      st.creatives.length < st.total ? h('div', { class: 'load-more' }, button(st.loading ? 'Carregando…' : `Carregar mais (${st.total - st.creatives.length})`, { disabled: st.loading, onClick: () => load({ append: true }) })) : null,
    );
  }

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  function drawTabs() {
    setChildren(
      tabs,
      TABS.map(([value, label]) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.kind === value), class: `tab${st.kind === value ? ' is-active' : ''}`, onClick: () => { st.kind = value; drawTabs(); load(); } }, label),
      ),
    );
  }

  const search = h('input', {
    class: 'input toolbar__search', type: 'search', placeholder: 'Buscar por nome…', 'aria-label': 'Buscar criativos', maxlength: 100,
    onInput: (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { st.q = event.target.value.trim(); load(); }, 300);
    },
  });

  // arrastar e soltar em qualquer lugar da página
  const dropHint = h('div', { class: 'dropzone', hidden: true }, icon('upload', 28), h('strong', null, 'Solte os arquivos para enviar'));
  let dragDepth = 0;
  const onDragEnter = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    dragDepth += 1;
    dropHint.hidden = false;
  };
  const onDragLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropHint.hidden = true;
  };
  const onDragOver = (event) => {
    if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
  };
  const onDrop = (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    dragDepth = 0;
    dropHint.hidden = true;
    uploader.add([...event.dataTransfer.files]);
  };
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('drop', onDrop);

  // Botão "Hook com IA": uma bolinha piscando mostra que há hook gerando ou sendo juntado a um vídeo. O trabalho roda no SERVIDOR, então a bolinha
  // continua mesmo com o pop-up fechado (e volta ao reabrir o site). Ao terminar com o pop-up fechado, a biblioteca se atualiza sozinha.
  const hookDot = h('span', { class: 'pulse-dot', 'aria-hidden': 'true' });
  const hookButton = button('Hook com IA', { onClick: () => {
    activity.pause();
    openHookDialog({ onCreated: () => { folders.refresh(); reload(); }, onClose: () => activity.resume() });
  } });
  const activity = createHookActivity({
    onBusy: (busy) => {
      hookButton.classList.toggle('is-busy', busy);
      if (busy) hookButton.prepend(hookDot);
      else hookDot.remove();
      hookButton.title = busy ? 'Há hooks sendo gerados ou juntados a um vídeo. Continua no servidor mesmo se você fechar o site.' : '';
      hookButton.setAttribute('aria-label', busy ? 'Hook com IA (em andamento)' : 'Hook com IA');
    },
    onApplied: () => { folders.refresh(); reload(); },
  });
  const actions = h('div', { class: 'page-header__actions' }, hookButton, button('Já está no TikTok? Adicionar por ID', { onClick: addFromTikTok }), uploadButton(uploader));
  setChildren(root, h('div', { class: 'page-header' }, h('div', null, h('h1', { class: 'page-title' }, 'Criativos'), h('p', { class: 'muted' }, 'Guarde suas imagens e vídeos, organize por oferta em pastas e selecione nas campanhas.')), actions), meter, folders.element, uploader.element, h('div', { class: 'toolbar toolbar--row' }, tabs, search), selectionBar, grid, dropHint);
  drawTabs();
  drawMeter();
  drawSelection();
  await Promise.all([folders.refresh(), load()]);
  activity.start();

  return {
    element: root,
    cleanup: () => {
      activity.stop();
      loadId += 1;
      clearTimeout(searchTimer);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    },
  };
}

