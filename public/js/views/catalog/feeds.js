import { FEED_INTERVALS, FEED_NAME_MAX, FEED_UPDATE_MODES, describeSchedule, normalizeFeedInput } from '/shared/catalog.js';
import { TIKTOK_TIMEZONES, isTikTokTimezone } from '/shared/tiktok-timezones.js';
import { del, get, post } from '../../api.js';
import { h, setChildren } from '../../dom.js';
import { formatNumber } from '../../format.js';
import { alertBox, badge, button, confirmDialog, emptyState, openModal, spinner, toast } from '../../ui.js';
import { catalogUrl, refQuery } from './detail.js';

const MODE_LABEL = { INCREMENTAL: 'Atualizar', OVERWRITE: 'Substituir tudo', SUPPLEMENT: 'Complementar' };
const RUN_LABEL = { SUCCESS: ['Concluída', 'success'], FAILED: ['Falhou', 'danger'], PROCESSING: ['Em andamento', 'warning'], WAITING: ['Aguardando', 'warning'] };

function defaultTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (isTikTokTimezone(zone)) return zone;
  } catch {
    /* usa o padrão abaixo */
  }
  return 'America/Sao_Paulo';
}

const when = (text) => (text ? new Date(`${text.replace(' ', 'T')}Z`).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * Aba "Sincronização": mantém preço e disponibilidade do catálogo atualizados sozinhos. O usuário informa a URL do feed da loja (CSV, TSV ou XML
 * no formato Google/RSS/ATOM) e a frequência; o PRÓPRIO TikTok busca a URL no horário combinado e atualiza os produtos (`/catalog/feed/*`).
 * A senha do feed (se houver) vai direto ao TikTok: o sistema não a guarda nem a devolve.
 */
export function feedsTab({ catalog, canWrite }) {
  const root = h('div', { class: 'catalog-sync' });
  const listSlot = h('div');
  const errorSlot = h('div');

  // ---------- lista ----------
  async function load() {
    setChildren(listSlot, spinner());
    try {
      const { feeds } = await get(`${catalogUrl(catalog, '/feeds')}?${refQuery(catalog)}`);
      const scheduled = feeds.filter((f) => f.url);
      setChildren(listSlot, scheduled.length
        ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Sincronização', 'Agenda', 'Situação', 'Próxima', 'Produtos', ''].map((t) => h('th', { scope: 'col' }, t)))),
          h('tbody', null, scheduled.map(row))))
        : h('div', { class: 'card' }, emptyState({ title: 'Nenhuma sincronização ainda', text: 'Crie uma para o TikTok buscar o feed da sua loja sozinho e manter preço e estoque em dia.' })));
    } catch (err) {
      setChildren(listSlot, alertBox(err.message));
    }
  }

  function row(f) {
    const host = (() => { try { return new URL(f.url).host; } catch { return f.url; } })();
    return h('tr', null,
      h('td', { 'data-label': 'Sincronização' }, h('span', { class: 'cell-strong' }, f.name), h('span', { class: 'acc-id catalog__issue' }, `${host} · ${MODE_LABEL[f.updateMode] ?? '—'}`)),
      h('td', { 'data-label': 'Agenda' }, describeSchedule(f), f.timezone ? h('span', { class: 'acc-id' }, f.timezone) : null),
      h('td', { 'data-label': 'Situação' }, f.status === 'ON' ? badge('Ligada', 'success') : badge('Desligada', 'neutral')),
      h('td', { class: 'muted', 'data-label': 'Próxima' }, f.status === 'ON' ? when(f.nextUpdateTime) : '—'),
      h('td', { class: 'num', 'data-label': 'Produtos' }, f.productCount === null ? '—' : formatNumber(f.productCount)),
      h('td', { class: 'catalog__actions' },
        button('Histórico', { small: true, onClick: () => showLog(f) }),
        canWrite ? button(f.status === 'ON' ? 'Desligar' : 'Ligar', { small: true, onClick: () => toggle(f) }) : null,
        canWrite ? button('Excluir', { small: true, variant: 'danger-ghost', onClick: () => remove(f) }) : null));
  }

  async function toggle(f) {
    const status = f.status === 'ON' ? 'OFF' : 'ON';
    try {
      await post(catalogUrl(catalog, `/feeds/${encodeURIComponent(f.id)}/status`), { connectionId: catalog.connectionId, bcId: catalog.bcId, status });
      toast(status === 'ON' ? 'Sincronização ligada.' : 'Sincronização desligada.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    load();
  }

  async function remove(f) {
    const ok = await confirmDialog({
      title: 'Excluir sincronização?',
      message: `"${f.name}" deixa de buscar o feed. ${f.updateMode === 'OVERWRITE' ? 'Os produtos que vieram dele podem sair do catálogo. ' : ''}Os anúncios que usam o catálogo continuam com os produtos que estiverem nele.`,
      confirmLabel: 'Excluir',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`${catalogUrl(catalog, `/feeds/${encodeURIComponent(f.id)}`)}?${refQuery(catalog)}`);
      toast('Sincronização excluída.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    load();
  }

  async function showLog(f) {
    const body = h('div', { class: 'modal__body' }, spinner());
    const modal = openModal({ title: `Histórico: ${f.name}`, size: 'md', body });
    try {
      const { runs } = await get(`${catalogUrl(catalog, `/feeds/${encodeURIComponent(f.id)}/log`)}?${refQuery(catalog)}`);
      setChildren(body,
        runs.length
          ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
            h('thead', null, h('tr', null, ['Quando', 'Situação', 'Novos', 'Atualizados', 'Removidos', 'Erros'].map((t, i) => h('th', { scope: 'col', class: i > 1 ? 'num' : '' }, t)))),
            h('tbody', null, runs.map((r) => h('tr', null,
              h('td', null, when(r.startTime)), h('td', null, badge(...(RUN_LABEL[r.status] ?? ['—', 'neutral']))),
              h('td', { class: 'num' }, formatNumber(r.addCount)), h('td', { class: 'num' }, formatNumber(r.updateCount)), h('td', { class: 'num' }, formatNumber(r.removeCount)), h('td', { class: 'num' }, formatNumber(r.errorCount)))))))
          : h('p', { class: 'muted' }, 'Ainda não houve nenhuma execução. A primeira acontece no próximo horário da agenda.'),
        h('p', { class: 'field__hint' }, 'Mostra as últimas 10 execuções. Os horários aparecem no fuso do seu navegador.'),
        h('div', { class: 'modal__footer' }, button('Fechar', { variant: 'primary', onClick: () => modal.close() })));
    } catch (err) {
      setChildren(body, alertBox(err.message), h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })));
    }
  }

  // ---------- formulário ----------
  const field = (label, control, hint) => h('div', { class: 'field' }, h('label', { class: 'field__label' }, label), control, hint ? h('p', { class: 'field__hint' }, hint) : null);
  const text = (props) => h('input', { class: 'input', type: 'text', autocomplete: 'off', ...props });
  const name = text({ maxlength: FEED_NAME_MAX, placeholder: 'Ex.: Feed da loja' });
  const url = h('input', { class: 'input', type: 'text', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', maxlength: 2000, placeholder: 'https://minhaloja.com/feed.xml' });
  const username = text({ maxlength: 200, autocomplete: 'off' });
  const password = h('input', { class: 'input', type: 'password', maxlength: 200, autocomplete: 'new-password' });
  const mode = h('select', { class: 'input' }, FEED_UPDATE_MODES.map(([id, label]) => h('option', { value: id }, label)));
  const modeHint = h('p', { class: 'field__hint' });
  const intervalType = h('select', { class: 'input' }, [['HOURLY', 'Horas'], ['DAILY', 'Dias'], ['MONTHLY', 'Meses']].map(([id, label]) => h('option', { value: id }, label)));
  intervalType.value = 'DAILY';
  const intervalCount = h('input', { class: 'input', type: 'number', min: 1, max: 30, step: 1, inputmode: 'numeric', value: 1 });
  const hour = h('input', { class: 'input', type: 'number', min: 0, max: 23, step: 1, inputmode: 'numeric', value: 3 });
  const minute = h('input', { class: 'input', type: 'number', min: 0, max: 59, step: 1, inputmode: 'numeric', value: 0 });
  const dayOfMonth = h('input', { class: 'input', type: 'number', min: 1, max: 28, step: 1, inputmode: 'numeric', value: 1 });
  const timezone = h('select', { class: 'input' }, TIKTOK_TIMEZONES.map(([code, offset]) => h('option', { value: code }, `${code} (${offset})`)));
  timezone.value = defaultTimezone();
  const dayField = field('Dia do mês', dayOfMonth, 'De 1 a 28 (vale em todos os meses).');
  const submit = button('Criar sincronização', { variant: 'primary', type: 'submit', disabled: !canWrite });

  function syncForm() {
    const limits = FEED_INTERVALS[intervalType.value];
    intervalCount.min = String(limits.min);
    intervalCount.max = String(limits.max);
    if (Number(intervalCount.value) > limits.max) intervalCount.value = String(limits.max);
    dayField.hidden = intervalType.value !== 'MONTHLY';
    modeHint.textContent = FEED_UPDATE_MODES.find(([id]) => id === mode.value)[2];
    modeHint.classList.toggle('catalog-sync__warn', mode.value === 'OVERWRITE');
  }
  intervalType.addEventListener('change', syncForm);
  mode.addEventListener('change', syncForm);

  async function onSubmit(event) {
    event.preventDefault();
    errorSlot.replaceChildren();
    const input = {
      name: name.value, url: url.value, username: username.value, password: password.value, updateMode: mode.value, intervalType: intervalType.value,
      intervalCount: Number(intervalCount.value), hour: Number(hour.value), minute: Number(minute.value), dayOfMonth: Number(dayOfMonth.value), timezone: timezone.value,
    };
    const { errors } = normalizeFeedInput(input);
    if (errors.length) {
      errorSlot.replaceChildren(alertBox(errors[0].message));
      return;
    }
    if (input.updateMode === 'OVERWRITE') {
      const ok = await confirmDialog({ title: 'Substituir tudo?', message: 'Neste modo o catálogo passa a ser exatamente o conteúdo do feed: os produtos que NÃO estiverem nele serão removidos do catálogo a cada execução.', confirmLabel: 'Entendi, criar', danger: true });
      if (!ok) return;
    }
    submit.disabled = true;
    try {
      await post(catalogUrl(catalog, '/feeds'), { connectionId: catalog.connectionId, bcId: catalog.bcId, ...input });
      toast('Sincronização criada: o TikTok vai buscar o feed no horário combinado.');
      password.value = '';
      username.value = '';
      name.value = '';
      url.value = '';
      await load();
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message));
    } finally {
      submit.disabled = !canWrite;
    }
  }

  setChildren(root,
    h('div', { class: 'card card--pad catalog-add__intro' },
      h('p', null, h('strong', null, 'Preço e estoque sempre em dia, sem trabalho manual.')),
      h('p', { class: 'muted' }, 'Informe a URL do feed de produtos da sua loja (CSV, TSV ou XML no formato do Google Merchant/RSS/ATOM, até 8 GB). O próprio TikTok busca o feed no horário escolhido e atualiza preço, disponibilidade e dados dos produtos. A maioria das plataformas de loja (Shopify, WooCommerce, Nuvemshop, Tray…) gera esse feed.'),
      h('p', { class: 'muted' }, 'O TikTok não guarda número de estoque, só a disponibilidade (em estoque, sem estoque…): o seu feed precisa ter a coluna de disponibilidade (availability).')),
    listSlot,
    h('section', { class: 'form-section' },
      h('h3', { class: 'form-section__title' }, 'Nova sincronização'),
      canWrite ? null : alertBox('Só o dono da conexão cria ou altera sincronizações.', 'warning'),
      h('form', { class: 'form', novalidate: true, onSubmit },
        errorSlot,
        h('div', { class: 'form-grid' },
          field('Nome', name), field('URL do feed', url, 'Precisa abrir pela internet (não vale rede interna).'),
          field('Usuário (se o feed tiver senha)', username), field('Senha', password, 'Vai direto ao TikTok: o sistema não guarda nem mostra a senha.'),
          h('div', { class: 'field field--wide' }, h('label', { class: 'field__label' }, 'Como atualizar o catálogo'), mode, modeHint),
          field('A cada', h('div', { class: 'catalog-sync__every' }, intervalCount, intervalType)),
          field('Horário', h('div', { class: 'catalog-sync__every' }, hour, h('span', { class: 'muted' }, ':'), minute), 'Nas execuções por hora, é a hora e o minuto da primeira.'),
          dayField,
          field('Fuso horário', timezone)),
        submit)));
  syncForm();
  load();
  return root;
}
