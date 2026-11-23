import { MAX_ACCOUNT_BASE_NAME, MAX_CREATE_ADVERTISERS, accountNames, normalizeCountry, normalizeCurrency, normalizeTimezone } from '/shared/advertiser-create.js';
import { get, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, button, confirmDialog, field, openModal } from '../ui.js';
import { plural } from './hub.js';

const clampCount = (value) => Math.min(MAX_CREATE_ADVERTISERS, Math.max(1, Math.trunc(Number(value)) || 1));

/**
 * Pop-up "+ CA": cria novas contas de anúncio dentro de uma Business Center do TikTok desta conexão.
 * O usuário só precisa da quantidade e de um nome; moeda, fuso, empresa e país vêm PRÉ-PREENCHIDOS de uma conta que a BC já tem
 * (e podem ser corrigidos). Nada é criado sem uma confirmação. Enquanto cria, o pop-up não fecha (evita pedido duplicado).
 *  - `bc`: a conexão (cartão). `onDone()`: chamado ao fechar depois de criar contas (recarrega a lista).
 */
export function createAdvertisersDialog({ bc, onDone }) {
  const bcIds = bc.bcIds ?? [];
  let busy = false;
  let created = false;
  let defaultsRequest = 0;

  const body = h('div', { class: 'modal__body create-ca' });
  const modal = openModal({
    title: 'Criar contas de anúncio',
    body,
    dismissOnOverlay: false,
    canClose: () => !busy,
    onClose: () => {
      if (created) onDone?.();
    },
  });

  if (!bcIds.length) {
    body.append(
      alertBox('O sistema ainda não sabe o ID da Business Center desta conexão. Clique em “Atualizar contas” e tente de novo.', 'warning'),
      h('div', { class: 'modal__footer' }, button('Fechar', { onClick: () => modal.close() })),
    );
    return;
  }

  // ----- campos -----
  const bcSelect = bcIds.length > 1 ? field('Business Center do TikTok', { as: 'select', options: bcIds.map((id) => [id, id]) }, { hint: 'As contas novas ficam dentro desta Business Center.' }) : null;
  const count = field('Quantidade', { type: 'number', min: 1, max: MAX_CREATE_ADVERTISERS, step: 1, value: 1, inputmode: 'numeric', required: true });
  const name = field('Nome das contas', { type: 'text', maxlength: MAX_ACCOUNT_BASE_NAME, required: true, autocomplete: 'off', placeholder: 'Ex.: Loja Principal' });
  const currency = field('Moeda', { type: 'text', maxlength: 3, required: true, autocomplete: 'off', placeholder: 'USD' });
  const timezone = field('Fuso horário', { type: 'text', maxlength: 64, required: true, autocomplete: 'off', spellcheck: 'false', placeholder: 'America/Sao_Paulo' });
  const company = field('Empresa', { type: 'text', maxlength: 255, required: true, autocomplete: 'off', placeholder: 'Razão social ou nome fantasia' });
  const country = field('País de registro', { type: 'text', maxlength: 2, required: true, autocomplete: 'off', placeholder: 'BR' });
  const email = field('E-mail de contato (opcional)', { type: 'email', maxlength: 254, autocomplete: 'off' });
  const industry = field('Ramo de atividade (opcional)', { type: 'text', inputmode: 'numeric', maxlength: 9, autocomplete: 'off' }, { hint: 'ID numérico do ramo no TikTok. Deixe vazio se não souber.' });

  const prefill = { currency, timezone, company, country, contactEmail: email };
  for (const f of [name, currency, timezone, company, country, email, industry]) f.control.addEventListener('input', () => { f.control.dataset.touched = '1'; });

  const preview = h('p', { class: 'create-ca__preview' });
  const status = h('p', { class: 'create-ca__status muted' });
  const errorSlot = h('div');
  const submit = button('Criar 1 conta', { variant: 'primary', type: 'submit' });
  const minus = button('−', { small: true, ariaLabel: 'Diminuir a quantidade', onClick: () => setCount(clampCount(count.control.value) - 1) });
  const plus = button('+', { small: true, ariaLabel: 'Aumentar a quantidade', onClick: () => setCount(clampCount(count.control.value) + 1) });

  // Quantidade: [−] [número] [+] na mesma linha, com o rótulo do campo em cima.
  const qtyField = h('div', { class: 'field' }, count.element.querySelector('label'), h('div', { class: 'create-ca__stepper' }, minus, count.control, plus));

  function setCount(value) {
    count.control.value = String(clampCount(value));
    refresh();
  }

  function refresh() {
    const n = clampCount(count.control.value);
    const typed = name.control.value.trim();
    const names = accountNames(typed || 'Nome', n);
    preview.textContent = !typed ? `Digite o nome para ver como ${n === 1 ? 'a conta vai se chamar' : 'as contas vão se chamar'}.` : n === 1 ? `Será criada 1 conta: ${names[0]}` : `Serão criadas ${n} contas: ${names.slice(0, 3).join(', ')}${n > 3 ? `… até ${names[n - 1]}` : ''}`;
    submit.textContent = `Criar ${plural(n, 'conta', 'contas')}`;
  }
  for (const f of [count, name]) f.control.addEventListener('input', refresh);

  /** Sugere moeda, fuso, empresa e país de uma conta que a BC já tem. Nunca sobrescreve o que o usuário já digitou. */
  async function loadDefaults() {
    const ticket = ++defaultsRequest;
    status.textContent = 'Buscando dados de uma conta existente para preencher…';
    try {
      const { defaults } = await get(`/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=${encodeURIComponent(selectedBc())}`);
      if (ticket !== defaultsRequest) return;
      let filled = 0;
      for (const [key, f] of Object.entries(prefill)) {
        const value = defaults?.[key];
        if (value && !f.control.dataset.touched) {
          f.control.value = value;
          filled += 1;
        }
      }
      status.textContent = filled ? 'Preenchido com os dados de uma conta que esta Business Center já tem. Confira antes de criar.' : 'Não foi possível sugerir os dados. Preencha moeda, fuso, empresa e país.';
    } catch {
      if (ticket === defaultsRequest) status.textContent = 'Não foi possível sugerir os dados. Preencha moeda, fuso, empresa e país.';
    }
  }
  const selectedBc = () => (bcSelect ? bcSelect.control.value : bcIds[0]);
  bcSelect?.control.addEventListener('change', () => {
    for (const f of Object.values(prefill)) delete f.control.dataset.touched; // outra BC: as sugestões voltam a valer
    loadDefaults();
  });

  /** Lê e confere os campos; devolve o corpo do pedido ou lança o aviso para o usuário. */
  function readForm() {
    const n = Number(count.control.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CREATE_ADVERTISERS) throw new Error(`A quantidade deve ser de 1 a ${MAX_CREATE_ADVERTISERS}.`);
    const baseName = name.control.value.trim();
    if (baseName.length < 2) throw new Error('Informe o nome das contas.');
    const cur = normalizeCurrency(currency.control.value);
    if (!cur) throw new Error('Informe a moeda com 3 letras (ex.: USD ou BRL).');
    const zone = normalizeTimezone(timezone.control.value);
    if (!zone) throw new Error('Fuso horário inválido. Use o formato America/Sao_Paulo.');
    if (company.control.value.trim().length < 2) throw new Error('Informe a empresa.');
    const area = normalizeCountry(country.control.value);
    if (!area) throw new Error('Informe o país de registro com 2 letras (ex.: BR).');
    if (industry.control.value.trim() && !/^\d{1,9}$/.test(industry.control.value.trim())) throw new Error('O ramo de atividade é um número (ID do TikTok). Deixe vazio se não souber.');
    return {
      bcId: selectedBc(),
      count: n,
      name: baseName,
      currency: cur,
      timezone: zone,
      company: company.control.value.trim(),
      registeredArea: area,
      ...(email.control.value.trim() ? { contactEmail: email.control.value.trim() } : {}),
      ...(industry.control.value.trim() ? { industry: industry.control.value.trim() } : {}),
    };
  }

  function showResult(result) {
    created = created || result.created.length > 0;
    const ok = result.created.length;
    const list = h(
      'ul',
      { class: 'create-ca__list' },
      result.created.map((c) => h('li', null, h('strong', null, c.name), c.id ? h('span', { class: 'muted' }, ` · ID ${c.id}`) : h('span', { class: 'muted' }, ' · ID não informado pelo TikTok'))),
    );
    const notVisible = ok - result.visible;
    setChildren(
      body,
      h('p', { class: 'create-ca__headline' }, ok === result.requested ? `${plural(ok, 'conta criada', 'contas criadas')} no TikTok.` : `${ok} de ${result.requested} contas criadas.`),
      list,
      result.failure ? alertBox(`A criação parou: ${result.failure.message} As demais não foram tentadas.`, 'warning') : null,
      notVisible > 0
        ? alertBox(
            bc.authType === 'oauth'
              ? `${plural(notVisible, 'conta ainda não aparece', 'contas ainda não aparecem')} nesta conexão. Se não surgirem em “Atualizar contas”, use “Renovar acesso” e marque as contas novas na autorização.`
              : `${plural(notVisible, 'conta ainda não aparece', 'contas ainda não aparecem')} nesta conexão (o TikTok pode demorar um pouco). Clique em “Atualizar contas” em instantes.`,
            'warning',
          )
        : h('p', { class: 'muted' }, 'As contas já estão na lista desta conexão.'),
      h('div', { class: 'modal__footer' }, button('Fechar', { variant: 'primary', onClick: () => modal.close() })),
    );
  }

  const form = h(
    'form',
    {
      class: 'form create-ca__form',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        if (busy) return;
        errorSlot.replaceChildren();
        let payload;
        try {
          payload = readForm();
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
          return;
        }
        const ok = await confirmDialog({
          title: `Criar ${plural(payload.count, 'conta de anúncio', 'contas de anúncio')}?`,
          message: `${accountNames(payload.name, payload.count).slice(0, 3).join(', ')}${payload.count > 3 ? '…' : ''} ${payload.count === 1 ? 'será criada' : 'serão criadas'} na Business Center ${payload.bcId}, em ${payload.currency}. ${payload.count === 1 ? 'Ela fica' : 'Elas ficam'} no seu TikTok e não ${payload.count === 1 ? 'pode ser desfeita' : 'podem ser desfeitas'} por aqui.`,
          confirmLabel: 'Criar agora',
        });
        if (!ok) return;
        busy = true;
        submit.disabled = true;
        submit.textContent = 'Criando no TikTok…';
        status.textContent = 'Isso pode levar alguns segundos. Não feche esta janela.';
        try {
          showResult(await post(`/tiktok/business-centers/${bc.id}/advertisers`, payload));
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message), h('p', { class: 'field__hint' }, 'Se a mensagem falar em permissão, o acesso desta conexão pode não incluir a criação de contas: renove o acesso (ou gere um token) com um usuário administrador da Business Center.'));
          status.textContent = '';
          refresh();
        } finally {
          busy = false;
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    bcSelect ? bcSelect.element : h('p', { class: 'create-ca__bc' }, 'Business Center do TikTok: ', h('strong', null, bcIds[0])),
    h('div', { class: 'create-ca__qty' }, qtyField, name.element),
    preview,
    h('div', { class: 'invite-fields' }, currency.element, timezone.element, company.element, country.element),
    h('details', { class: 'create-ca__more' }, h('summary', null, 'Mais opções'), h('div', { class: 'invite-fields' }, email.element, industry.element)),
    status,
    h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.requestClose() }), submit),
  );
  body.append(form);
  refresh();
  loadDefaults();
}
