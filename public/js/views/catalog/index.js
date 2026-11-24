import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatDate } from '../../format.js';
import { can } from '../../state.js';
import { alertBox, badge, button, emptyState, spinner, toast } from '../../ui.js';
import { pageHeader } from '../layout.js';
import { openCreateCatalogDialog } from './create-dialog.js';
import { catalogDetail } from './detail.js';

const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Catálogo de produtos: lista os catálogos de TODAS as Business Centers do usuário, cria catálogo (em etapas) e abre o detalhe de um
 * catálogo (produtos, envio de produtos por formulário ou CSV, conjuntos de produtos). Um catálogo é obrigatório para campanhas de
 * "Vendas de produtos". Todo texto vindo do TikTok entra como nó de texto (nunca como HTML).
 */
export async function catalogView() {
  const st = { data: null, loading: false, error: null, bc: '', search: '', detail: null };
  const root = h('div', { class: 'catalog' });
  const toolbar = h('div', { class: 'catalog__toolbar' });
  const body = h('div', { class: 'catalog__body' });
  const header = h('div');
  let loadId = 0;
  const canWrite = () => can('campaigns');

  async function load({ fresh = false } = {}) {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    drawBody();
    try {
      const data = await get(`/tiktok/catalogs${fresh ? '?refresh=1' : ''}`);
      if (current !== loadId) return false;
      st.data = data;
      return true;
    } catch (err) {
      if (current === loadId) st.error = err.message;
      return false;
    } finally {
      if (current === loadId) {
        st.loading = false;
        drawHeader();
        drawToolbar();
        drawBody();
      }
    }
  }

  const manageableBcs = () => (st.data?.businessCenters ?? []).filter((b) => b.canManage && b.status === 'ok');

  function create() {
    openCreateCatalogDialog({
      businessCenters: manageableBcs(),
      onCreated: async (catalog, { openAdd }) => {
        await load({ fresh: true });
        if (openAdd) openDetail({ ...catalog }, 'add');
      },
    });
  }

  function openDetail(catalog, tab = 'products') {
    st.detail = catalog;
    draw();
    setChildren(body, catalogDetail({
      catalog, tab, canWrite: canWrite() && catalog.canManage,
      onBack: () => { st.detail = null; draw(); load({ fresh: true }); },
    }));
  }

  function draw() {
    drawHeader();
    drawToolbar();
    toolbar.hidden = Boolean(st.detail);
    if (!st.detail) drawBody();
  }

  function drawHeader() {
    setChildren(header, pageHeader(
      'Catálogo',
      st.detail ? null : 'Catálogos de produtos das suas Business Centers. Um catálogo é obrigatório para campanhas de Vendas de produtos.',
      st.detail ? null : (canWrite() && manageableBcs().length ? button('+ Catálogo', { variant: 'primary', onClick: create }) : null),
    ));
  }

  function visible() {
    const q = normalize(st.search);
    return (st.data?.catalogs ?? []).filter((c) => (!st.bc || `${c.connectionId}:${c.bcId}` === st.bc) && (!q || normalize(`${c.name} ${c.id} ${c.bcName ?? ''}`).includes(q)));
  }

  function drawToolbar() {
    const bcs = (st.data?.businessCenters ?? []).filter((b) => b.bcId);
    const select = h('select', { class: 'input input--filter', 'aria-label': 'Business Center', onChange: (e) => { st.bc = e.target.value; drawBody(); } },
      h('option', { value: '' }, `Todas as Business Centers${bcs.length ? ` (${bcs.length})` : ''}`),
      bcs.map((b) => h('option', { value: `${b.connectionId}:${b.bcId}` }, `BC ${b.bcId} · ${b.connectionName}`)));
    select.value = st.bc;
    setChildren(toolbar,
      bcs.length > 1 ? select : null,
      h('input', { class: 'input toolbar__search', type: 'search', maxlength: 100, placeholder: 'Buscar catálogo por nome ou ID…', 'aria-label': 'Buscar catálogos', value: st.search, onInput: (e) => { st.search = e.target.value; drawBody(); } }),
      button('Atualizar', { small: true, onClick: async () => { if (await load({ fresh: true })) toast('Catálogos atualizados.'); } }));
  }

  function row(c) {
    const ready = c.adCreationEligible;
    return h('tr', null,
      h('td', { 'data-label': 'Catálogo' }, h('span', { class: 'cell-strong', title: c.name }, c.name || c.id), h('span', { class: 'acc-id' }, `ID ${c.id}`)),
      h('td', { 'data-label': 'Business Center' }, c.bcName || `BC ${c.bcId}`, h('span', { class: 'acc-id' }, `${c.bcId} · ${c.connectionName}`)),
      h('td', { 'data-label': 'País · moeda' }, c.regionCode ? `${c.regionCode} · ${c.currency ?? '—'}` : '—'),
      h('td', { 'data-label': 'Anúncios' }, ready ? badge('Pronto para anúncios', 'success') : badge('Sem produtos disponíveis', 'warning')),
      h('td', { class: 'muted', 'data-label': 'Atualizado' }, c.updatedAt ? formatDate(c.updatedAt.replace(' ', 'T') + 'Z') : '—'),
      h('td', { class: 'catalog__actions' }, button('Abrir', { small: true, onClick: () => openDetail(c) })));
  }

  function drawBody() {
    if (st.detail) return;
    if (st.loading && !st.data) return setChildren(body, spinner());
    if (st.error) return setChildren(body, alertBox(st.error), h('p', null, button('Tentar de novo', { onClick: () => load() })));
    if (!st.data) return setChildren(body, spinner());
    if (!st.data.totalConnections) {
      return setChildren(body, h('div', { class: 'card' }, emptyState({ title: 'Conecte sua Business Center', text: 'Os catálogos ficam dentro de uma Business Center. Conecte uma para criar e gerenciar catálogos aqui.', action: h('a', { href: '/business-centers', 'data-link': true, class: 'btn btn--primary' }, 'Conectar Business Center') })));
    }
    const failed = st.data.businessCenters.filter((b) => b.status === 'error');
    const notices = failed.map((b) => alertBox(`${b.bcId ? `BC ${b.bcId}` : b.connectionName}: ${b.error}`, 'warning'));
    const list = visible();
    const total = st.data.catalogs.length;
    setChildren(body,
      ...notices,
      st.loading ? h('p', { class: 'muted' }, 'Atualizando…') : null,
      list.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Catálogo', 'Business Center', 'País · moeda', 'Anúncios', 'Atualizado', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, list.map(row))))
        : h('div', { class: 'card' }, emptyState(
          total
            ? { title: 'Nenhum catálogo com esse filtro', text: 'Mude a Business Center ou a busca.' }
            : { title: 'Você ainda não tem catálogos', text: 'Crie o primeiro catálogo, adicione seus produtos e use-o em campanhas de Vendas de produtos.', action: canWrite() && manageableBcs().length ? button('+ Criar catálogo', { variant: 'primary', onClick: create }) : null },
        )),
      total ? h('p', { class: 'muted catalog__count' }, `${list.length === total ? total : `${list.length} de ${total}`} ${total === 1 ? 'catálogo' : 'catálogos'}`) : null);
    return undefined;
  }

  setChildren(root, header, toolbar, body);
  drawHeader();
  drawToolbar();
  drawBody();
  load();
  return { element: root, cleanup: () => { loadId += 1; } };
}
