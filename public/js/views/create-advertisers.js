import { AREAS_NEEDING_DOCUMENTS, MAX_ACCOUNT_BASE_NAME, MAX_CREATE_ADVERTISERS, accountNames, normalizeCurrency, normalizePromotionLink } from '/shared/advertiser-create.js';
import { industriesFor } from '/shared/tiktok-industries.js';
import { TIKTOK_LOCATIONS } from '/shared/tiktok-locations.js';
import { TIKTOK_TIMEZONES } from '/shared/tiktok-timezones.js';
import { get, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, button, confirmDialog, field, openModal, stepper } from '../ui.js';
import { plural } from './hub.js';

const clampCount = (value) => Math.min(MAX_CREATE_ADVERTISERS, Math.max(1, Math.trunc(Number(value)) || 1));
const BC_TYPES = { NORMAL: 'comum', DIRECT: 'direta', AGENCY: 'de agência', SELF_SERVICE: 'de autoatendimento', SELF_SERVICE_AGENCY: 'de agência (autoatendimento)' };
const COUNTRIES = [...TIKTOK_LOCATIONS].sort((a, b) => a[1].localeCompare(b[1]));
const STEPS = [{ title: 'Contas' }, { title: 'Empresa e região' }, { title: 'Revisar e criar' }];
const normalize = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Pop-up "+ CA": cria novas contas de anúncio dentro de uma Business Center do TikTok desta conexão, seguindo o contrato OFICIAL do TikTok.
 * O usuário só precisa da quantidade e de um nome; moeda (a da BC), fuso, país, empresa e ramo vêm PRÉ-PREENCHIDOS (da BC e de uma conta que
 * ela já tem) e fuso, país e ramo são escolhidos nas listas oficiais. Nada é criado sem uma confirmação; enquanto cria, o pop-up não fecha.
 *  - `bc`: a conexão (cartão). `onDone()`: chamado ao fechar depois de criar contas (recarrega a lista).
 */
export function createAdvertisersDialog({ bc, onDone }) {
  const bcIds = bc.bcIds ?? [];
  let busy = false;
  let created = false;
  let defaultsRequest = 0;
  let bcInfo = null; // o que o TikTok informou desta BC (tipo, moeda, papel…), ou null

  const body = h('div', { class: 'modal__body create-ca' });
  const modal = openModal({
    title: 'Criar contas de anúncio',
    size: 'md',
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
  const currency = field('Moeda', { type: 'text', maxlength: 3, required: true, autocomplete: 'off', placeholder: 'USD' }, { hint: 'O TikTok exige a mesma moeda da Business Center.' });
  const timezone = field('Fuso horário', { as: 'select', options: [['', 'Escolha o fuso…'], ...TIKTOK_TIMEZONES.map(([code, offset]) => [code, `${code} (${offset})`])], required: true });
  const company = field('Empresa', { type: 'text', maxlength: 255, required: true, autocomplete: 'off', placeholder: 'Razão social ou nome fantasia' });
  const country = field('País de registro', { as: 'select', options: [['', 'Escolha o país…'], ...COUNTRIES.map(([code, label]) => [code, `${label} (${code})`])], required: true });
  const industrySearch = h('input', { class: 'input create-ca__industry-search', type: 'search', placeholder: 'Buscar ramo (ex.: roupas, cosméticos, educação)…', 'aria-label': 'Buscar ramo de atividade', autocomplete: 'off', maxlength: 60 });
  const industry = field('Ramo de atividade', { as: 'select', options: [['', 'Escolha o ramo…']], required: true }, { hint: 'Lista oficial do TikTok para o tipo desta Business Center. Vem preenchido com o ramo de uma conta que a BC já tem.' });
  industry.element.insertBefore(industrySearch, industry.control);
  industry.element.classList.add('create-ca__wide');
  const promotion = field('Site da empresa', { type: 'url', maxlength: 255, autocomplete: 'off', placeholder: 'https://minhaempresa.com' }, { hint: 'Obrigatório para Business Center de agência: o TikTok exige o endereço do site da empresa.' });
  const email = field('E-mail de contato (opcional)', { type: 'email', maxlength: 254, autocomplete: 'off' });

  const prefill = { currency, timezone, company, country, contactEmail: email, industry };
  for (const f of [name, currency, timezone, company, country, email, industry, promotion]) f.control.addEventListener('input', () => { f.control.dataset.touched = '1'; });
  for (const f of [timezone, country, industry]) f.control.addEventListener('change', () => { f.control.dataset.touched = '1'; refreshNotes(); });

  const preview = h('p', { class: 'create-ca__preview' });
  const status = h('p', { class: 'create-ca__status muted' });
  const errorSlot = h('div');
  const infoSlot = h('div', { class: 'create-ca__bcinfo' });
  const promoSlot = h('div', { class: 'create-ca__wide' });
  const moreFields = h('div', { class: 'invite-fields' }, email.element);
  let step = 0; // etapa atual (0 a 2) e a mais distante já alcançada
  let maxStep = 0;
  let createLabel = 'Criar 1 conta';
  const submit = button('Continuar', { variant: 'primary', type: 'submit' }); // "Continuar" nas duas primeiras etapas; "Criar N contas" na última
  const back = button('Cancelar', { onClick: () => (step === 0 ? modal.requestClose() : goTo(step - 1)) });
  const stepSlot = h('div', { class: 'create-ca__steps' });
  const pane = h('div', { class: 'create-ca__pane' });
  const review = h('dl', { class: 'create-ca__review' });
  const optional = h('div', { class: 'create-ca__optional' });
  const minus = button('−', { small: true, ariaLabel: 'Diminuir a quantidade', onClick: () => setCount(clampCount(count.control.value) - 1) });
  const plus = button('+', { small: true, ariaLabel: 'Aumentar a quantidade', onClick: () => setCount(clampCount(count.control.value) + 1) });
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
    createLabel = `Criar ${plural(n, 'conta', 'contas')}`;
    syncButtons();
  }
  for (const f of [count, name]) f.control.addEventListener('input', refresh);

  // ---------- ramo: lista oficial (por tipo da BC), com busca ----------
  function drawIndustries() {
    const keep = industry.control.value;
    const term = normalize(industrySearch.value);
    const list = industriesFor(bcInfo?.type ?? null).filter(([id, label, group]) => !term || normalize(`${label} ${group} ${id}`).includes(term) || String(id) === keep);
    const groups = new Map();
    for (const [id, label, group] of list) groups.set(group, [...(groups.get(group) ?? []), [id, label]]);
    setChildren(
      industry.control,
      h('option', { value: '' }, list.length ? 'Escolha o ramo…' : 'Nenhum ramo encontrado'),
      [...groups.entries()].map(([group, items]) => h('optgroup', { label: group }, items.map(([id, label]) => h('option', { value: String(id) }, `${label} (${id})`)))),
    );
    industry.control.value = keep;
  }
  industrySearch.addEventListener('input', drawIndustries);

  // ---------- avisos conforme o que o TikTok disse desta BC ----------
  const selectedBc = () => (bcSelect ? bcSelect.control.value : bcIds[0]);
  const docsArea = () => AREAS_NEEDING_DOCUMENTS[country.control.value] ?? AREAS_NEEDING_DOCUMENTS[bcInfo?.registeredArea] ?? null;
  const blocked = () => (bcInfo?.isAdmin === false ? 'Seu usuário não é administrador desta Business Center no TikTok: só administradores criam contas de anúncio.' : docsArea() ? `Contas registradas em ${docsArea()} exigem documentos (licença/CNPJ, imagens, e-mail e cobrança) que este sistema ainda não envia. Crie-as pelo próprio TikTok.` : null);

  function refreshNotes() {
    const notes = [];
    if (bcInfo) {
      const parts = [`Business Center ${BC_TYPES[bcInfo.type] ?? bcInfo.type ?? ''}`.trim(), bcInfo.currency ? `moeda ${bcInfo.currency}` : null, bcInfo.isAdmin === true ? 'você é administrador' : null].filter(Boolean);
      notes.push(h('p', { class: 'create-ca__bcline' }, parts.join(' · ')));
    }
    const problem = blocked();
    if (problem) notes.push(alertBox(problem, 'warning'));
    setChildren(infoSlot, notes);
    syncButtons();
  }

  /** Aplica o que o TikTok informou da BC: moeda travada, ramos do tipo, site da empresa (só BC de agência) e avisos. */
  function applyBc() {
    currency.control.readOnly = Boolean(bcInfo?.currency);
    currency.control.classList.toggle('input--locked', Boolean(bcInfo?.currency));
    promotion.control.required = Boolean(bcInfo?.requiresPromotionLink);
    promotion.element.querySelector('label').textContent = bcInfo?.requiresPromotionLink ? 'Site da empresa (obrigatório)' : 'Site da empresa (só BC de agência)';
    (bcInfo?.requiresPromotionLink ? promoSlot : moreFields).append(promotion.element);
    drawIndustries();
    refreshNotes();
  }

  /** Sugere os dados a partir do TikTok. Nunca sobrescreve o que o usuário já digitou ou escolheu. */
  async function loadDefaults() {
    const ticket = ++defaultsRequest;
    status.textContent = 'Buscando os dados da Business Center no TikTok…';
    try {
      const data = await get(`/tiktok/business-centers/${bc.id}/advertiser-defaults?bcId=${encodeURIComponent(selectedBc())}`);
      if (ticket !== defaultsRequest) return;
      bcInfo = data.bc ?? null;
      applyBc(); // primeiro as opções do ramo (dependem do tipo da BC); depois os valores
      let filled = 0;
      for (const [key, f] of Object.entries(prefill)) {
        const value = data.defaults?.[key];
        if (value && (!f.control.dataset.touched || (key === 'currency' && bcInfo?.currency))) {
          f.control.value = value;
          if (f.control.value === value) filled += 1;
        }
      }
      refreshNotes();
      status.textContent = bcInfo
        ? 'Preenchido com os dados da sua Business Center e de uma conta que ela já tem. Confira antes de criar.'
        : filled ? 'O TikTok não informou os dados da BC; preenchi com uma conta que ela já tem. Confira antes de criar.' : 'Não foi possível sugerir os dados. Preencha os campos.';
    } catch {
      if (ticket === defaultsRequest) status.textContent = 'Não foi possível sugerir os dados. Preencha os campos.';
    }
  }
  bcSelect?.control.addEventListener('change', () => {
    for (const f of Object.values(prefill)) delete f.control.dataset.touched; // outra BC: as sugestões voltam a valer
    bcInfo = null;
    applyBc();
    loadDefaults();
  });

  // ---------- conferência por etapa (cada "Continuar" confere só o que a etapa pede; "Criar" confere tudo) ----------
  function checkAccounts() {
    const problem = blocked();
    if (problem) throw new Error(problem);
    const n = Number(count.control.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CREATE_ADVERTISERS) throw new Error(`A quantidade deve ser de 1 a ${MAX_CREATE_ADVERTISERS}.`);
    if (name.control.value.trim().length < 2) throw new Error('Informe o nome das contas.');
  }
  function checkCompany() {
    const problem = blocked();
    if (problem) throw new Error(problem);
    const cur = normalizeCurrency(currency.control.value);
    if (!cur) throw new Error('Informe a moeda com 3 letras (ex.: USD ou BRL).');
    if (bcInfo?.currency && cur !== bcInfo.currency) throw new Error(`A moeda precisa ser a da Business Center (${bcInfo.currency}).`);
    if (!timezone.control.value) throw new Error('Escolha o fuso horário na lista.');
    if (company.control.value.trim().length < 2) throw new Error('Informe a empresa.');
    if (!country.control.value) throw new Error('Escolha o país de registro na lista.');
    if (!industry.control.value) throw new Error('Escolha o ramo de atividade na lista.');
    const link = promotion.control.value.trim();
    if (bcInfo?.requiresPromotionLink && !link) throw new Error('Esta Business Center é de agência: informe o site da empresa.');
    if (link && !normalizePromotionLink(link)) throw new Error('Site da empresa inválido: use um endereço completo, como https://minhaempresa.com.');
  }
  function checkOptional() {
    const value = email.control.value.trim();
    if (value && !/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(value)) throw new Error('E-mail de contato inválido: informe o endereço completo (ou deixe em branco).');
    const link = promotion.control.value.trim();
    if (link && !normalizePromotionLink(link)) throw new Error('Site da empresa inválido: use um endereço completo, como https://minhaempresa.com.');
  }
  const CHECKS = [checkAccounts, checkCompany, checkOptional];

  /** Lê e confere TODOS os campos; devolve o corpo do pedido ou lança o aviso para o usuário. */
  function readForm() {
    for (const check of CHECKS) check();
    const link = promotion.control.value.trim();
    return {
      bcId: selectedBc(),
      count: Number(count.control.value),
      name: name.control.value.trim(),
      currency: normalizeCurrency(currency.control.value),
      timezone: timezone.control.value,
      company: company.control.value.trim(),
      registeredArea: country.control.value,
      industry: industry.control.value,
      ...(link ? { promotionLink: link } : {}),
      ...(email.control.value.trim() ? { contactEmail: email.control.value.trim() } : {}),
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
    body.classList.add('is-result'); // o resultado não precisa do tamanho fixo das etapas
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

  // ---------- etapas ----------
  const selectedOption = (f) => f.control.selectedOptions[0]?.textContent ?? '';
  function drawReview() {
    const n = clampCount(count.control.value);
    const rows = [
      ['Business Center', selectedBc()],
      [n === 1 ? 'Conta' : 'Contas', preview.textContent.replace(/^Ser(á|ão) criadas? \d+ contas?: /, '')],
      ['Moeda', normalizeCurrency(currency.control.value) ?? '—'],
      ['Fuso horário', selectedOption(timezone) || '—'],
      ['Empresa', company.control.value.trim() || '—'],
      ['País de registro', selectedOption(country) || '—'],
      ['Ramo de atividade', selectedOption(industry) || '—'],
      ...(promotion.control.value.trim() ? [['Site da empresa', promotion.control.value.trim()]] : []),
    ];
    setChildren(review, rows.map(([label, value]) => h('div', { class: 'create-ca__review-row' }, h('dt', null, label), h('dd', null, value))));
  }

  function drawStep({ keepError = false } = {}) {
    if (!keepError) errorSlot.replaceChildren();
    if (step === 0) setChildren(pane, errorSlot, bcSelect ? bcSelect.element : h('p', { class: 'create-ca__bc' }, 'Business Center do TikTok: ', h('strong', null, bcIds[0])), infoSlot, h('div', { class: 'create-ca__qty' }, qtyField, name.element), preview);
    else if (step === 1) setChildren(pane, errorSlot, h('div', { class: 'invite-fields' }, currency.element, timezone.element, company.element, country.element, industry.element), promoSlot);
    else {
      drawReview();
      setChildren(optional, h('p', { class: 'create-ca__section' }, 'Opcional'), moreFields);
      setChildren(pane, errorSlot, h('p', { class: 'create-ca__section' }, 'Confira antes de criar'), review, optional, h('p', { class: 'field__hint' }, 'As contas ficam no seu TikTok e não podem ser desfeitas por aqui.'));
    }
    setChildren(stepSlot, stepper({ steps: STEPS, current: step, maxStep, disabled: busy, onGo: goTo, label: 'Etapas da criação de contas' }));
    pane.scrollTop = 0;
    syncButtons();
  }

  function syncButtons() {
    const last = step === STEPS.length - 1;
    back.textContent = step === 0 ? 'Cancelar' : 'Voltar';
    back.disabled = busy;
    submit.textContent = busy ? 'Criando no TikTok…' : last ? createLabel : 'Continuar';
    submit.disabled = busy || (last && Boolean(blocked()));
    status.hidden = last && !busy; // o texto de "preenchido com os dados…" só vale antes da revisão
  }

  /** Ir para uma etapa já alcançada; para a frente só passando pela conferência de cada etapa no caminho. */
  function goTo(target) {
    if (busy || target === step) return;
    if (target > step) {
      try {
        for (let i = step; i < target; i += 1) CHECKS[i]();
      } catch (err) {
        errorSlot.replaceChildren(alertBox(err.message));
        return;
      }
    }
    step = target;
    maxStep = Math.max(maxStep, step);
    drawStep();
  }

  async function create() {
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
    syncButtons();
    stepSlot.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    status.textContent = 'Isso pode levar alguns segundos. Não feche esta janela.';
    try {
      showResult(await post(`/tiktok/business-centers/${bc.id}/advertisers`, payload));
    } catch (err) {
      errorSlot.replaceChildren(alertBox(err.message), h('p', { class: 'field__hint' }, 'Se a mensagem falar em permissão, o acesso desta conexão pode não incluir a criação de contas: renove o acesso (ou gere um token) com um usuário administrador da Business Center. Se a BC for de agência, preencha o site da empresa em “Empresa e região”.'));
      status.textContent = '';
      pane.scrollTop = 0;
      refresh();
    } finally {
      busy = false;
      if (pane.isConnected) drawStep({ keepError: true });
    }
  }

  const form = h(
    'form',
    {
      class: 'form create-ca__form',
      novalidate: true,
      onSubmit: (event) => {
        event.preventDefault();
        if (busy) return;
        if (step < STEPS.length - 1) goTo(step + 1);
        else create();
      },
    },
    stepSlot,
    pane,
    status,
    h('div', { class: 'modal__footer create-ca__footer' }, back, submit),
  );
  body.append(form);
  applyBc();
  refresh();
  drawStep();
  loadDefaults();
}
