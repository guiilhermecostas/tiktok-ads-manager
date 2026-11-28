import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatBytes } from '../../format.js';
import { can } from '../../state.js';
import { alertBox, button, emptyState, openModal, spinner } from '../../ui.js';
import { pathLabel, treeOrder } from '/shared/creative-folders.js';
import { FOLDER_ALL, folderIdOf } from './folders.js';
import { creativeThumb } from './thumb.js';
import { createUploader, uploadButton } from './uploader.js';

const PAGE = 60;

/**
 * Seletor de criativos da biblioteca (modal): escolha um ou vários, ou envie novos sem sair da campanha.
 * @param {{ kind: 'image'|'video', multiple?: boolean, max?: number, selected?: number[], title: string, cache: Map<number, object> }} options
 *   `cache` guarda os criativos já vistos (id -> criativo) para o formulário mostrar nome e miniatura.
 * @returns {Promise<number[] | null>} IDs escolhidos (na ordem da escolha) ou null se cancelado
 */
export function pickCreatives({ kind, multiple = false, max = 1, selected = [], title, cache }) {
  return new Promise((resolve) => {
    const st = { chosen: [...selected], q: '', folder: FOLDER_ALL, folders: [], items: [], total: 0, limits: { maxImageBytes: 0, maxVideoBytes: 0 }, loading: true, error: null };
    let settled = false;
    let timer;
    let loadId = 0;

    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      modal.close();
      resolve(value);
    };

    const remember = (creative) => cache.set(creative.id, creative);
    const limit = multiple ? max : 1;

    function toggle(creative) {
      const index = st.chosen.indexOf(creative.id);
      if (index >= 0) st.chosen.splice(index, 1);
      else if (limit === 1) st.chosen = [creative.id];
      else if (st.chosen.length < limit) st.chosen.push(creative.id);
      drawGrid();
      drawFooter();
    }

    async function load() {
      const current = ++loadId;
      st.loading = true;
      drawGrid();
      try {
        const params = new URLSearchParams({ kind, limit: String(PAGE) });
        if (st.q) params.set('q', st.q);
        if (st.folder !== FOLDER_ALL) params.set('folderId', String(st.folder));
        const data = await get(`/creatives?${params}`);
        if (current !== loadId) return;
        st.items = data.creatives;
        st.total = data.total;
        st.limits = data.limits;
        st.error = null;
        data.creatives.forEach(remember);
      } catch (err) {
        if (current === loadId) st.error = err.message;
      } finally {
        if (current === loadId) {
          st.loading = false;
          drawGrid();
        }
      }
    }

    const uploader = createUploader({
      getLimits: () => st.limits,
      getFolderId: () => folderIdOf(st.folder), // enviar com uma pasta escolhida já coloca o arquivo nela
      onUploaded: (creative) => {
        if (creative.kind !== kind) return; // o seletor só mostra o tipo pedido
        remember(creative);
        st.items = [creative, ...st.items.filter((c) => c.id !== creative.id)];
        st.total += 1;
        if (limit === 1) st.chosen = [creative.id];
        else if (st.chosen.length < limit) st.chosen.push(creative.id);
        drawGrid();
        drawFooter();
      },
    });

    const grid = h('div', { class: 'picker__grid-wrap' });
    function drawGrid() {
      if (st.error) return setChildren(grid, alertBox(st.error));
      if (st.loading && !st.items.length) return setChildren(grid, spinner());
      if (!st.items.length) {
        return setChildren(grid, emptyState({ title: st.q ? 'Nada encontrado' : `Nenhum${kind === 'video' ? ' vídeo' : 'a imagem'} na biblioteca`, text: 'Envie um arquivo para usar agora.' }));
      }
      setChildren(
        grid,
        h(
          'div',
          { class: 'creative-grid creative-grid--picker' },
          st.items.map((creative) => {
            const order = st.chosen.indexOf(creative.id);
            return h(
              'button',
              { type: 'button', class: `picker-card${order >= 0 ? ' is-selected' : ''}`, 'aria-pressed': String(order >= 0), onClick: () => toggle(creative) },
              creativeThumb(creative),
              order >= 0 ? h('span', { class: 'picker-card__check' }, limit > 1 ? String(order + 1) : '✓') : null,
              h('span', { class: 'picker-card__name', title: creative.name }, creative.name),
              h('span', { class: 'muted picker-card__meta' }, formatBytes(creative.sizeBytes)),
            );
          }),
        ),
        st.items.length < st.total ? h('p', { class: 'muted', style: { textAlign: 'center' } }, `Mostrando ${st.items.length} de ${st.total}. Refine a busca para ver outros.`) : null,
      );
    }

    const footerInfo = h('span', { class: 'muted' });
    const confirm = button('Usar selecionado', { variant: 'primary', onClick: () => done([...st.chosen]) });
    function drawFooter() {
      footerInfo.textContent = limit > 1 ? `${st.chosen.length} de ${limit} selecionadas` : st.chosen.length ? '1 selecionado' : 'Nenhum selecionado';
      confirm.disabled = st.chosen.length === 0 && limit === 1;
      confirm.textContent = limit > 1 ? 'Usar selecionadas' : 'Usar selecionado';
    }

    const search = h('input', {
      class: 'input', type: 'search', placeholder: 'Buscar por nome…', 'aria-label': 'Buscar criativos', maxlength: 100,
      onInput: (event) => {
        clearTimeout(timer);
        timer = setTimeout(() => { st.q = event.target.value.trim(); load(); }, 300);
      },
    });

    // Filtro por pasta (oferta): só aparece se o usuário tem pastas.
    const folderSelect = h('select', { class: 'input picker__folder', 'aria-label': 'Filtrar por pasta', hidden: true, onChange: (event) => {
      const value = event.target.value;
      st.folder = value === '' || value === 'none' ? value : Number(value);
      load();
    } });
    get('/creatives/folders').then((data) => {
      st.folders = data.folders;
      if (!st.folders.length) return;
      setChildren(folderSelect, h('option', { value: '' }, 'Todas as pastas'), h('option', { value: 'none' }, 'Sem pasta'), treeOrder(st.folders).map(({ folder }) => h('option', { value: String(folder.id) }, `${pathLabel(st.folders, folder.id)} (${folder.count})`)));
      folderSelect.hidden = false;
    }).catch(() => {});

    const modal = openModal({
      title,
      size: 'wide',
      onClose: () => done(null),
      body: h(
        'div',
        { class: 'modal__body picker' },
        h('div', { class: 'picker__toolbar' }, search, folderSelect, can('creatives') ? uploadButton(uploader, { label: kind === 'video' ? 'Enviar vídeo' : 'Enviar imagem', variant: 'secondary' }) : null), // quem só publica campanhas escolhe, mas não envia
        can('creatives') ? uploader.element : null,
        grid,
        h('div', { class: 'modal__footer picker__footer' }, footerInfo, button('Cancelar', { onClick: () => done(null) }), confirm),
      ),
    });
    drawFooter();
    load();
  });
}
