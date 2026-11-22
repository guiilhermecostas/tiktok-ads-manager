import { get } from '../api.js';
import { h } from '../dom.js';
import { alertBox, badge, emptyState } from '../ui.js';
import { accountsTabs } from './accounts-tabs.js';
import { pageHeader } from './layout.js';

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Sub-aba "Contas de anúncio": todas as contas que o usuário pode usar e de qual Business Center (conexão) cada uma vem.
 * Mostra só as contas das BCs do próprio usuário e das compartilhadas com a equipe (mesma regra do resto do sistema).
 */
export async function adAccountsView() {
  const { advertisers } = await get('/tiktok/advertisers');
  const state = { q: '', bc: '' };

  const centers = [...new Map(advertisers.map((a) => [a.businessCenterId, a.businessCenterName])).entries()].sort((x, y) => x[1].localeCompare(y[1], 'pt-BR'));

  const summary = h('p', { class: 'muted section-note', 'aria-live': 'polite' });
  const body = h('div');

  const search = h('input', { class: 'input toolbar__search', type: 'search', placeholder: 'Buscar por nome ou ID da conta…', 'aria-label': 'Buscar contas de anúncio', maxlength: 100 });
  const filter = h('select', { class: 'input', 'aria-label': 'Filtrar por Business Center' }, h('option', { value: '' }, 'Todas as Business Centers'), centers.map(([id, name]) => h('option', { value: String(id) }, name)));
  search.addEventListener('input', () => { state.q = normalize(search.value.trim()); draw(); });
  filter.addEventListener('change', () => { state.bc = filter.value; draw(); });

  function origin(a) {
    return h(
      'div',
      null,
      h('span', { class: 'cell-strong' }, a.businessCenterName),
      h('div', { class: 'cell-meta' }, a.businessCenterBcId ? h('span', { class: 'code' }, a.businessCenterBcId) : null, badge(a.businessCenterAuthType === 'oauth' ? 'Por link' : 'Token', 'neutral'), a.businessCenterViaProxy ? badge('Via proxy', 'success') : null, badge(a.businessCenterShared ? 'Compartilhada' : a.businessCenterOwned ? 'Só você' : 'Privada', a.businessCenterShared ? 'success' : 'neutral')),
    );
  }

  function draw() {
    const rows = advertisers.filter((a) => (!state.bc || String(a.businessCenterId) === state.bc) && (!state.q || normalize(`${a.name} ${a.id}`).includes(state.q)));
    const bcCount = new Set(rows.map((a) => a.businessCenterId)).size;
    summary.textContent = `${plural(rows.length, 'conta de anúncio', 'contas de anúncio')} em ${plural(bcCount, 'Business Center', 'Business Centers')}` + (rows.length !== advertisers.length ? ` (de ${advertisers.length} no total)` : '');

    if (!rows.length) {
      body.replaceChildren(h('div', { class: 'card' }, emptyState({ title: 'Nenhuma conta encontrada', text: 'Ajuste a busca ou o filtro de Business Center.' })));
      return;
    }
    body.replaceChildren(
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'table' },
          h('thead', null, h('tr', null, ['Conta de anúncio', 'ID da conta', 'Business Center', 'Moeda', 'Fuso horário', 'Status'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            rows.map((a) =>
              h(
                'tr',
                null,
                h('td', { class: 'cell-strong' }, a.name),
                h('td', null, h('span', { class: 'code' }, a.id)),
                h('td', null, origin(a)),
                h('td', null, a.currency ?? '—'),
                h('td', { class: 'muted' }, a.timezone ?? '—'),
                h('td', null, a.businessCenterStatus === 'active' ? badge('Ativa', 'success') : badge('Acesso com erro', 'danger')),
              ),
            ),
          ),
        ),
      ),
    );
  }

  const header = pageHeader('Contas TikTok', 'Todas as contas de anúncio disponíveis para você e a Business Center de cada uma.');
  if (!advertisers.length) {
    return {
      element: h('div', null, header, accountsTabs('/business-centers/accounts'), h('div', { class: 'card' }, emptyState({
        title: 'Nenhuma conta de anúncio ainda',
        text: 'Conecte uma Business Center na aba “Business Centers”: as contas de anúncio dela aparecem aqui.',
        action: h('a', { class: 'btn btn--primary', href: '/business-centers', 'data-link': '' }, 'Ir para Business Centers'),
      }))),
    };
  }
  draw();
  return {
    element: h('div', null, header, accountsTabs('/business-centers/accounts'), h('div', { class: 'toolbar' }, search, filter), summary, body, advertisers.some((a) => a.businessCenterStatus !== 'active') ? alertBox('Algumas Business Centers estão com erro de acesso. Reautorize ou atualize o token na aba “Business Centers”.', 'warning') : null),
  };
}
