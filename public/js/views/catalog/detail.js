import { AVAILABILITY } from '/shared/catalog.js';
import { get } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatCurrency, formatNumber } from '../../format.js';
import { can } from '../../state.js';
import { alertBox, badge, button, emptyState, spinner } from '../../ui.js';
import { subTabs, tabIntro } from '../subtabs.js';
import { addProductsTab } from './add-products.js';
import { catalogCampaignTab } from './campaign-tab.js';
import { feedsTab } from './feeds.js';
import { openCatalogCampaign } from './open-campaign.js';
import { productSetsTab } from './product-sets.js';

const AVAILABILITY_LABEL = Object.fromEntries(AVAILABILITY);
const AUDIT = { approved: ['Aprovado', 'success'], rejected: ['Reprovado', 'danger'], processing: ['Em análise', 'warning'] };
const PAGE_SIZE = 25;

/** Parâmetros que identificam o catálogo em toda chamada (a conexão e a BC do TikTok; o servidor confere os dois). */
export const refQuery = (catalog) => `connectionId=${catalog.connectionId}&bcId=${encodeURIComponent(catalog.bcId)}`;
export const catalogUrl = (catalog, path = '') => `/tiktok/catalogs/${encodeURIComponent(catalog.id)}${path}`;

const TABS = [
  ['products', 'Produtos'],
  ['add', 'Adicionar produtos'],
  ['sync', 'Sincronização'],
  ['sets', 'Conjuntos'],
  ['campaign', 'Campanha'],
];

/**
 * Detalhe de um catálogo: situação dos produtos (aprovados / em análise / reprovados) e cinco abas, cada uma começando por uma frase que
 * explica para que serve: Produtos, Adicionar produtos, Sincronização, Conjuntos e Campanha (anúncio padrão).
 */
export function catalogDetail({ ctx, catalog, tab = 'products', canWrite, onBack }) {
  const root = h('div', { class: 'catalog-detail' });
  const summary = h('div', { class: 'cat-stats', 'aria-live': 'polite' });
  const content = h('div', { class: 'catalog-detail__content' });
  let productsRefresh = null;

  const stat = (kind, label, value) => h('div', { class: `cat-stat cat-stat--${kind}` }, h('strong', { class: 'cat-stat__value' }, formatNumber(value)), h('span', { class: 'cat-stat__label' }, label));

  async function loadSummary() {
    setChildren(summary, h('span', { class: 'muted' }, 'Carregando a situação dos produtos…'));
    try {
      const o = await get(`${catalogUrl(catalog, '/overview')}?${refQuery(catalog)}`);
      setChildren(summary,
        stat('ok', 'Aprovados', o.approved), stat('wait', 'Em análise', o.processing), stat('bad', 'Reprovados', o.rejected),
        o.approved === 0 ? h('p', { class: 'cat-stats__hint' }, o.processing ? 'Seus produtos estão em análise (costuma levar alguns minutos). O catálogo só serve para anúncios com produtos aprovados.' : 'Ainda não há produtos. Vá em "Adicionar produtos" para enviar os primeiros.') : null);
    } catch (err) {
      setChildren(summary, alertBox(err.message, 'warning'));
    }
  }

  const tabsView = subTabs({ items: TABS.map(([id, label]) => ({ id, label })), active: tab, label: 'Seções do catálogo', onChange: () => drawContent() });

  function drawContent() {
    const active = tabsView.active();
    if (active === 'products') {
      const view = productsTab({ catalog });
      productsRefresh = view.refresh;
      setChildren(content, view.element);
    } else if (active === 'add') {
      setChildren(content, addProductsTab({ catalog, canWrite, onUploaded: () => { loadSummary(); productsRefresh?.(); } }));
    } else if (active === 'campaign') {
      setChildren(content, catalogCampaignTab({ ctx, catalog }));
    } else if (active === 'sync') {
      setChildren(content, feedsTab({ catalog, canWrite }));
    } else {
      setChildren(content, productSetsTab({ catalog, canWrite }));
    }
  }

  setChildren(root,
    h('div', { class: 'catalog-detail__head' },
      button('← Catálogos', { small: true, onClick: onBack }),
      h('div', { class: 'catalog-detail__title' },
        h('h1', { class: 'page-title' }, catalog.name || catalog.id),
        h('p', { class: 'muted', title: `Business Center ${catalog.bcId}` }, `${catalog.regionCode ?? '—'} · ${catalog.currency ?? '—'} · ID ${catalog.id}`)),
      catalog.adCreationEligible ? badge('Pronto para anúncios', 'success') : badge('Sem produtos disponíveis', 'warning'),
      can('campaigns') ? button('Criar campanha com este catálogo', { variant: 'primary', small: true, onClick: () => openCatalogCampaign(ctx, catalog) }) : null),
    !canWrite ? alertBox('Você pode ver este catálogo, mas só o dono da conexão altera produtos e conjuntos.', 'warning') : null,
    summary, tabsView.element, content);
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
        : h('div', { class: 'card' }, emptyState({ title: st.sku || st.available ? 'Nenhum produto com esse filtro' : 'Nenhum produto ainda', text: st.sku || st.available ? 'Mude a busca ou o filtro.' : 'Abra a aba "Adicionar produtos" e envie os primeiros (em lote, por planilha ou um a um).' })),
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
  setChildren(root, tabIntro('Produtos do catálogo', 'Aqui estão os produtos que o TikTok recebeu e se cada um foi aprovado. Só os aprovados e disponíveis entram nos anúncios.'), filters, body);
  load();
  return { element: root, refresh: () => { st.page = 1; load(); } };
}
