import { AVAILABILITY } from '/shared/catalog.js';
import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatCurrency, formatNumber } from '../../format.js';
import { alertBox, badge, button, emptyState, spinner } from '../../ui.js';
import { addProductsTab } from './add-products.js';
import { productSetsTab } from './product-sets.js';

const AVAILABILITY_LABEL = Object.fromEntries(AVAILABILITY);
const AUDIT = { approved: ['Aprovado', 'success'], rejected: ['Reprovado', 'danger'], processing: ['Em análise', 'warning'] };
const PAGE_SIZE = 25;

/** Parâmetros que identificam o catálogo em toda chamada (a conexão e a BC do TikTok; o servidor confere os dois). */
export const refQuery = (catalog) => `connectionId=${catalog.connectionId}&bcId=${encodeURIComponent(catalog.bcId)}`;
export const catalogUrl = (catalog, path = '') => `/tiktok/catalogs/${encodeURIComponent(catalog.id)}${path}`;

/**
 * Detalhe de um catálogo: situação dos produtos (aprovados / reprovados / em análise) e três abas:
 * Produtos (lista com aprovação e elegibilidade para anúncios), Adicionar produtos (formulário ou CSV) e Conjuntos de produtos.
 */
export function catalogDetail({ catalog, tab = 'products', canWrite, onBack }) {
  const root = h('div', { class: 'catalog-detail' });
  const summary = h('div', { class: 'catalog-detail__summary' });
  const content = h('div', { class: 'catalog-detail__content' });
  const tabs = h('div', { class: 'tabs tabs--hub', role: 'tablist' });
  let active = tab;
  let productsRefresh = null;

  async function loadSummary() {
    setChildren(summary, h('span', { class: 'muted' }, 'Carregando situação dos produtos…'));
    try {
      const o = await get(`${catalogUrl(catalog, '/overview')}?${refQuery(catalog)}`);
      setChildren(summary,
        h('div', { class: 'kpi' }, h('span', { class: 'kpi__label' }, 'Aprovados'), h('strong', { class: 'kpi__value' }, formatNumber(o.approved))),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi__label' }, 'Em análise'), h('strong', { class: 'kpi__value' }, formatNumber(o.processing))),
        h('div', { class: 'kpi' }, h('span', { class: 'kpi__label' }, 'Reprovados'), h('strong', { class: 'kpi__value' }, formatNumber(o.rejected))),
        o.approved === 0 ? h('p', { class: 'muted catalog-detail__hint' }, o.processing ? 'Os produtos estão em análise: a aprovação costuma levar alguns minutos. O catálogo só serve para anúncios com produtos aprovados e disponíveis.' : 'Adicione produtos para poder usar este catálogo em campanhas.') : null);
    } catch (err) {
      setChildren(summary, alertBox(err.message, 'warning'));
    }
  }

  function drawTabs() {
    const items = [['products', 'Produtos'], ['add', 'Adicionar produtos'], ['sets', 'Conjuntos de produtos']];
    setChildren(tabs, items.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: `tab${active === id ? ' is-active' : ''}`, 'aria-selected': String(active === id),
      onClick: () => { active = id; drawTabs(); drawContent(); },
    }, label)));
  }

  function drawContent() {
    if (active === 'products') {
      const view = productsTab({ catalog });
      productsRefresh = view.refresh;
      setChildren(content, view.element);
    } else if (active === 'add') {
      setChildren(content, addProductsTab({ catalog, canWrite, onUploaded: () => { loadSummary(); productsRefresh?.(); } }));
    } else {
      setChildren(content, productSetsTab({ catalog, canWrite }));
    }
  }

  setChildren(root,
    h('div', { class: 'catalog-detail__head' },
      button('← Catálogos', { small: true, onClick: onBack }),
      h('div', { class: 'catalog-detail__title' },
        h('h1', { class: 'page-title' }, catalog.name || catalog.id),
        h('p', { class: 'muted' }, `ID ${catalog.id} · BC ${catalog.bcId} · ${catalog.regionCode ?? '—'} · ${catalog.currency ?? '—'}`)),
      catalog.adCreationEligible ? badge('Pronto para anúncios', 'success') : badge('Sem produtos disponíveis', 'warning')),
    !canWrite ? alertBox('Você pode ver este catálogo, mas só o dono da conexão altera produtos e conjuntos.', 'warning') : null,
    summary, tabs, content);
  drawTabs();
  drawContent();
  loadSummary();
  return root;
}

/** Aba "Produtos": busca por SKU, só os disponíveis para anúncios, paginação. */
function productsTab({ catalog }) {
  const st = { page: 1, sku: '', available: false, data: null, loading: false, error: null };
  const root = h('div', { class: 'catalog-products' });
  const filters = h('div', { class: 'catalog__toolbar' });
  const body = h('div');
  let loadId = 0;

  async function load() {
    const current = ++loadId;
    st.loading = true;
    st.error = null;
    drawBody();
    const params = new URLSearchParams({ page: String(st.page), pageSize: String(PAGE_SIZE) });
    if (st.sku) params.set('sku', st.sku);
    if (st.available) params.set('available', '1');
    try {
      const data = await get(`${catalogUrl(catalog, '/products')}?${refQuery(catalog)}&${params}`);
      if (current !== loadId) return;
      st.data = data;
    } catch (err) {
      if (current === loadId) st.error = err.message;
    } finally {
      if (current === loadId) { st.loading = false; drawBody(); }
    }
  }

  function row(p) {
    const [auditLabel, tone] = AUDIT[p.auditStatus] ?? ['—', 'neutral'];
    const issue = p.rejectedReasons?.[0] ?? (p.imageStatus === 'FILTERED' ? 'Imagem menor que 500 × 500 px.' : p.imageStatus === 'FAIL' ? 'Não foi possível baixar a imagem.' : p.suggestion);
    return h('tr', null,
      h('td', { 'data-label': 'SKU' }, h('span', { class: 'cell-strong' }, p.skuId)),
      h('td', { 'data-label': 'Produto' }, h('span', { title: p.title }, p.title), p.brand ? h('span', { class: 'acc-id' }, p.brand) : null),
      h('td', { class: 'num', 'data-label': 'Preço' }, p.price === null ? '—' : formatCurrency(p.price, catalog.currency ?? p.currency ?? 'USD'), p.salePrice ? h('span', { class: 'acc-id' }, `Promo ${formatCurrency(p.salePrice, catalog.currency ?? 'USD')}`) : null),
      h('td', { 'data-label': 'Estoque' }, AVAILABILITY_LABEL[p.availability] ?? p.availability ?? '—'),
      h('td', { 'data-label': 'Aprovação' }, badge(auditLabel, tone), issue ? h('span', { class: 'acc-id catalog__issue' }, issue) : null),
      h('td', { 'data-label': 'Anúncios' }, p.adCreationEligible ? badge('Pode usar', 'success') : badge('Não', 'neutral')));
  }

  function drawBody() {
    if (st.loading && !st.data) return setChildren(body, spinner());
    if (st.error) return setChildren(body, alertBox(st.error));
    const products = st.data?.products ?? [];
    const pages = Math.max(1, Math.ceil((st.data?.total ?? 0) / PAGE_SIZE));
    setChildren(body,
      products.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['SKU', 'Produto', 'Preço', 'Estoque', 'Aprovação', 'Anúncios'].map((t) => h('th', { scope: 'col', class: t === 'Preço' ? 'num' : '' }, t)))),
          h('tbody', null, products.map(row))))
        : h('div', { class: 'card' }, emptyState({ title: st.sku || st.available ? 'Nenhum produto com esse filtro' : 'Nenhum produto ainda', text: st.sku || st.available ? 'Mude a busca ou o filtro.' : 'Use a aba "Adicionar produtos" para enviar o seu primeiro lote (formulário ou CSV).' })),
      products.length ? h('div', { class: 'manager__footer' },
        h('span', { class: 'muted' }, `${formatNumber(st.data.total)} ${st.data.total === 1 ? 'produto' : 'produtos'}`),
        pages > 1 ? h('div', { class: 'manager__pager' },
          button('‹ Anterior', { small: true, disabled: st.page <= 1, onClick: () => { st.page -= 1; load(); } }),
          h('span', { class: 'muted' }, `Página ${st.page} de ${pages}`),
          button('Próxima ›', { small: true, disabled: st.page >= pages, onClick: () => { st.page += 1; load(); } })) : null) : null);
    return undefined;
  }

  setChildren(filters,
    h('input', { class: 'input toolbar__search', type: 'search', maxlength: 100, placeholder: 'Buscar por SKU exato…', 'aria-label': 'Buscar produto por SKU', onChange: (e) => { st.sku = e.target.value.trim(); st.page = 1; load(); } }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', onChange: (e) => { st.available = e.target.checked; st.page = 1; load(); } }), h('span', null, 'Só os que servem para anúncios')),
    button('Atualizar', { small: true, onClick: () => load() }));
  setChildren(root, filters, body);
  load();
  return { element: root, refresh: () => { st.page = 1; load(); } };
}
