import { ACCOUNT_FIELDS, applyAccountOverrides, getPath, validateConfig } from '/shared/campaign-spec.js';
import { h, setChildren } from '../../dom.js';
import { badge } from '../../ui.js';
import { renderAccountFields } from './form-fields.js';

const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SEARCH_THRESHOLD = 6; // a partir de quantas contas a busca aparece

/**
 * Painel "Publicar em": escolhe, na etapa final, em quais contas de anúncio (de qualquer Business Center) a campanha será
 * publicada, com ajustes opcionais de IDs próprios de cada conta (pixel, identidade etc.) e o progresso por conta.
 *
 * Opções:
 *  - advertisers: contas disponíveis ({ id, name, currency, businessCenterId, businessCenterName, businessCenterStatus, … })
 *  - getConfig(): configuração base da campanha
 *  - getPublications(): publicações já existentes ({ advertiserId, status, error, tiktokCampaignId, tiktokAdGroupId, overrides })
 *  - onChange(): chamado quando a seleção muda (o assistente atualiza o botão de publicar)
 * Retorna { element, refresh, selectedIds, overridesFor, validate, setResult, setBusy, deselect }.
 */
export function createPublishTargets({ advertisers, getConfig, getPublications, onChange }) {
  const selected = new Set();
  const overrides = new Map(); // id -> { adGroup: {...}, ad: {...} }
  const expanded = new Set(); // contas com o painel de ajustes aberto
  const results = new Map(); // id -> { state: 'running' | 'done' | 'failed', message }
  let query = '';
  let busy = false;
  let showErrors = false;

  const publicationOf = (id) => getPublications().find((p) => p.advertiserId === id) ?? null;
  const isUsable = (a) => a.businessCenterStatus === 'active';
  const isDone = (a) => publicationOf(a.id)?.status === 'published';
  const isSelectable = (a) => isUsable(a) && !isDone(a);
  const ownOverrides = (id) => overrides.get(id) ?? {};

  /** Ajustes da conta: o que o usuário digitou; se já existe grupo criado no TikTok, o do grupo é o que foi usado nele. */
  function effectiveOverrides(id) {
    const publication = publicationOf(id);
    const mine = ownOverrides(id);
    if (!publication?.tiktokAdGroupId) return mine;
    const next = { ...mine };
    if (publication.overrides?.adGroup) next.adGroup = publication.overrides.adGroup;
    else delete next.adGroup;
    return next;
  }
  const mergedConfig = (id) => applyAccountOverrides(getConfig(), effectiveOverrides(id)).config;

  /** Erros de formato nos IDs desta conta (só dos campos por conta: o restante da campanha é validado à parte). */
  function accountErrors(id) {
    const { errors } = validateConfig(mergedConfig(id), { requireComplete: true });
    return errors.filter((e) => ACCOUNT_FIELDS.includes(e.path));
  }

  function setOverride(id, path, value) {
    const [section, key] = path.split('.');
    const base = getPath(getConfig(), path);
    const current = { ...overrides.get(id) };
    const bucket = { ...current[section] };
    if (value === undefined || value === '' || value === base) delete bucket[key];
    else bucket[key] = value;
    if (Object.keys(bucket).length) current[section] = bucket;
    else delete current[section];
    if (Object.keys(current).length) overrides.set(id, current);
    else overrides.delete(id);
  }

  // ---------- desenho ----------
  const list = h('div', { class: 'targets__list' });
  const summary = h('p', { class: 'targets__summary', 'aria-live': 'polite' });
  const warning = h('div');
  const search = h('input', { class: 'input targets__search', type: 'search', placeholder: 'Buscar conta ou Business Center…', 'aria-label': 'Buscar conta de anúncio', maxlength: 100 });
  search.addEventListener('input', () => {
    query = normalize(search.value.trim());
    renderList();
  });
  const searchRow = h('div', { class: 'targets__search-row' }, search);

  function overrideForm(account) {
    const id = account.id;
    const publication = publicationOf(id);
    const groupCreated = Boolean(publication?.tiktokAdGroupId);
    const errors = showErrors ? Object.fromEntries(accountErrors(id).map((e) => [e.path, e.message])) : {};
    const form = h('div', { class: 'targets__adjust' });
    const draw = () => {
      const ctx = {
        get config() { return mergedConfig(id); },
        errors,
        creatives: new Map(),
        moneyText: {},
        // O que pertence ao grupo de anúncios não muda depois que o grupo existe no TikTok (o anúncio ainda pode mudar).
        readOnly: (path) => busy || (groupCreated && path.startsWith('adGroup.')),
        pickCreatives: async () => null,
        set(path, value, { rerender = false } = {}) {
          setOverride(id, path, value);
          if (rerender) draw();
          renderSummary();
        },
      };
      setChildren(
        form,
        h('p', { class: 'field__hint' }, 'Estes IDs pertencem a uma conta específica do TikTok. Se esta conta usa outros, informe aqui; o resto da campanha continua igual. Se apagar um campo, vale o ID da campanha.'),
        groupCreated ? h('p', { class: 'field__hint' }, 'O grupo de anúncios desta conta já foi criado: os IDs dele não mudam mais.') : null,
        renderAccountFields(ctx),
      );
    };
    draw();
    return form;
  }

  function statusChip(account) {
    const result = results.get(account.id);
    if (result?.state === 'running') return h('span', { class: 'targets__state targets__state--running' }, h('span', { class: 'spinner' }), 'Preparando criativos e publicando…');
    if (result?.state === 'done') return h('span', { class: 'targets__state targets__state--done' }, '✓ Publicada (pausada)');
    if (result?.state === 'failed') return h('span', { class: 'targets__state targets__state--failed' }, '✗ Falhou');
    const publication = publicationOf(account.id);
    if (publication?.status === 'published') return badge('Já publicada', 'success');
    if (publication?.status === 'partial') return badge('Parcial: retoma de onde parou', 'danger');
    if (publication?.status === 'failed') return badge('Falhou antes: tentar de novo', 'danger');
    if (!isUsable(account)) return badge('Acesso com erro', 'danger');
    return null;
  }

  function accountRow(account) {
    const id = account.id;
    const selectable = isSelectable(account) && !busy;
    const checkbox = h('input', {
      type: 'checkbox', checked: selected.has(id), disabled: !selectable,
      onChange: (e) => {
        if (e.target.checked) selected.add(id);
        else selected.delete(id);
        renderList();
        onChange?.();
      },
    });
    const publication = publicationOf(id);
    const result = results.get(id);
    const message = result?.state === 'failed' ? result.message : publication?.status !== 'published' ? publication?.error : null;
    const adjusted = Object.keys(ownOverrides(id)).length > 0;
    const showAdjust = selected.has(id) && !isDone(account);
    const errorCount = showErrors && showAdjust ? accountErrors(id).length : 0;
    return h(
      'li',
      { class: `targets__account${selected.has(id) ? ' is-selected' : ''}${selectable ? '' : ' is-disabled'}` },
      h(
        'label',
        { class: 'targets__label' },
        checkbox,
        h('span', { class: 'targets__name' }, account.name),
        h('span', { class: 'code' }, id),
        account.currency ? h('span', { class: 'targets__currency' }, account.currency) : null,
      ),
      h('div', { class: 'targets__status' }, statusChip(account)),
      message ? h('p', { class: 'targets__error', role: 'status' }, message) : null,
      publication?.status === 'published' && publication.tiktokCampaignId ? h('p', { class: 'muted targets__ids' }, `Campanha ${publication.tiktokCampaignId} · Anúncio ${publication.tiktokAdId ?? '—'}`) : null,
      showAdjust
        ? h(
            'div',
            { class: 'targets__adjust-wrap' },
            h(
              'button',
              {
                type: 'button', class: 'link-btn', 'aria-expanded': String(expanded.has(id)), disabled: busy,
                onClick: () => {
                  if (expanded.has(id)) expanded.delete(id);
                  else expanded.add(id);
                  renderList();
                },
              },
              expanded.has(id) ? 'Ocultar ajustes desta conta' : adjusted ? 'Ajustes desta conta (editados)' : 'Ajustar IDs desta conta (pixel, identidade…)',
            ),
            errorCount ? h('span', { class: 'targets__error' }, ` · ${plural(errorCount, 'campo precisa de correção', 'campos precisam de correção')}`) : null,
            expanded.has(id) ? overrideForm(account) : null,
          )
        : null,
    );
  }

  function groupSection(center) {
    const selectable = center.accounts.filter((a) => isSelectable(a));
    const all = selectable.length > 0 && selectable.every((a) => selected.has(a.id));
    const some = selectable.some((a) => selected.has(a.id));
    const toggle = h('input', {
      type: 'checkbox', checked: all, disabled: !selectable.length || busy, 'aria-label': `Selecionar todas as contas de ${center.name}`,
      onChange: (e) => {
        for (const a of selectable) {
          if (e.target.checked) selected.add(a.id);
          else selected.delete(a.id);
        }
        renderList();
        onChange?.();
      },
    });
    toggle.indeterminate = some && !all;
    const first = center.accounts[0];
    return h(
      'section',
      { class: 'targets__group' },
      h(
        'header',
        { class: 'targets__group-head' },
        h('label', { class: 'targets__group-title' }, toggle, h('strong', null, center.name)),
        first.businessCenterBcId ? h('span', { class: 'code' }, first.businessCenterBcId) : null,
        badge(first.businessCenterAuthType === 'oauth' ? 'Por link' : 'Token', 'neutral'),
        first.businessCenterViaProxy ? badge('Via proxy', 'success') : null,
        badge(first.businessCenterShared ? 'Compartilhada' : first.businessCenterOwned ? 'Só você' : 'Privada', first.businessCenterShared ? 'success' : 'neutral'),
        h('span', { class: 'muted targets__count' }, plural(center.accounts.length, 'conta', 'contas')),
      ),
      h('ul', { class: 'targets__accounts' }, center.accounts.map(accountRow)),
    );
  }

  function visibleCenters() {
    const matches = advertisers.filter((a) => !query || normalize(`${a.name} ${a.id} ${a.businessCenterName}`).includes(query));
    const byCenter = new Map();
    for (const a of matches) {
      if (!byCenter.has(a.businessCenterId)) byCenter.set(a.businessCenterId, { id: a.businessCenterId, name: a.businessCenterName, accounts: [] });
      byCenter.get(a.businessCenterId).accounts.push(a);
    }
    return [...byCenter.values()];
  }

  function renderSummary() {
    const picked = advertisers.filter((a) => selected.has(a.id));
    const centers = new Set(picked.map((a) => a.businessCenterId)).size;
    summary.textContent = picked.length ? `${plural(picked.length, 'conta selecionada', 'contas selecionadas')} em ${plural(centers, 'Business Center', 'Business Centers')}` : 'Nenhuma conta selecionada.';
    const currencies = [...new Set(picked.map((a) => a.currency).filter(Boolean))];
    const unusual = currencies.length > 1 || currencies.some((c) => c !== 'BRL');
    setChildren(
      warning,
      unusual
        ? h(
            'div',
            { class: 'alert alert--warning' },
            currencies.length > 1
              ? `Atenção: as contas selecionadas usam moedas diferentes (${currencies.join(', ')}). Orçamentos e lances são enviados como o mesmo número em cada conta, na moeda dela.`
              : `Atenção: a conta usa ${currencies[0]}. Orçamentos e lances da campanha são enviados como o mesmo número, na moeda da conta (não são convertidos).`,
          )
        : null,
    );
  }

  function renderList() {
    const centers = visibleCenters();
    list.replaceChildren(...(centers.length ? centers.map(groupSection) : [h('p', { class: 'muted targets__empty' }, 'Nenhuma conta encontrada para esta busca.')]));
    renderSummary();
  }

  const element = h(
    'section',
    { class: 'card card--pad targets' },
    h('h3', { class: 'card__title' }, 'Publicar em'),
    h('p', { class: 'muted' }, 'Escolha uma ou mais contas de anúncio, de qualquer Business Center. A campanha é criada PAUSADA em cada uma: nada gasta até você ativar no TikTok.'),
    h(
      'p',
      { class: 'targets__note' },
      h('strong', null, 'Criativos blindados: '),
      'em cada conta, vídeos e imagens são refeitos do zero, sem metadados e com hash novo, e os cantos dos primeiros e dos últimos 0,1 s do vídeo recebem pixels de cores próximas. Cada conta e cada campanha enviam uma versão diferente. Por isso a publicação pode levar um pouco mais.',
    ),
    searchRow,
    list,
    summary,
    warning,
  );

  function refresh() {
    searchRow.hidden = advertisers.length < SEARCH_THRESHOLD;
    // Contas que deixaram de ser elegíveis (já publicadas, BC com erro) saem da seleção.
    for (const id of [...selected]) {
      const account = advertisers.find((a) => a.id === id);
      if (!account || !isSelectable(account)) selected.delete(id);
    }
    if (!advertisers.length) {
      list.replaceChildren(h('p', { class: 'muted targets__empty' }, 'Nenhuma conta de anúncio disponível. Conecte uma Business Center em Contas TikTok para publicar.'));
      summary.textContent = '';
      warning.replaceChildren();
      return;
    }
    renderList();
  }
  refresh();

  return {
    element,
    refresh,
    /** IDs selecionados, na ordem em que aparecem na tela (Business Centers e contas). */
    selectedIds: () => advertisers.filter((a) => selected.has(a.id)).map((a) => a.id),
    /** Ajustes não vazios de uma conta, no formato que a API aceita. */
    overridesFor: (id) => effectiveOverrides(id),
    /** Erros de ID por conta selecionada ({ [id]: [{path,message}] }); liga a exibição dos erros. */
    validate() {
      showErrors = true;
      const problems = {};
      for (const id of selected) {
        const errors = accountErrors(id);
        if (errors.length) {
          problems[id] = errors;
          expanded.add(id); // abre os ajustes das contas com problema
        }
      }
      renderList();
      return problems;
    },
    setResult(id, result) {
      if (result) results.set(id, result);
      else results.delete(id);
      renderList();
    },
    setBusy(value) {
      busy = value;
      renderList();
    },
    deselect(ids) {
      ids.forEach((id) => selected.delete(id));
      renderList();
      onChange?.();
    },
    clearResults() {
      results.clear();
    },
  };
}
