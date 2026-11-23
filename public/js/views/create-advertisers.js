import { AREAS_NEEDING_DOCUMENTS, MAX_ACCOUNT_BASE_NAME, MAX_CREATE_ADVERTISERS, accountNames, normalizeCurrency, normalizePromotionLink } from '/shared/advertiser-create.js';
import { industriesFor } from '/shared/tiktok-industries.js';
import { TIKTOK_LOCATIONS } from '/shared/tiktok-locations.js';
import { TIKTOK_TIMEZONES } from '/shared/tiktok-timezones.js';
import { get, post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { alertBox, button, confirmDialog, field, openModal } from '../ui.js';
import { plural } from './hub.js';

const clampCount = (value) => Math.min(MAX_CREATE_ADVERTISERS, Math.max(1, Math.trunc(Number(value)) || 1));
const BC_TYPES = { NORMAL: 'comum', DIRECT: 'direta', AGENCY: 'de agência', SELF_SERVICE: 'de autoatendimento', SELF_SERVICE_AGENCY: 'de agência (autoatendimento)' };
const COUNTRIES = [...TIKTOK_LOCATIONS].sort((a, b) => a[1].localeCompare(b[1]));
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
  const submit = button('Criar 1 conta', { variant: 'primary', type: 'submit' });
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
    submit.textContent = `Criar ${plural(n, 'conta', 'contas')}`;
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
    submit.disabled = busy || Boolean(problem);
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

  /** Lê e confere os campos; devolve o corpo do pedido ou lança o aviso para o usuário. */
  function readForm() {
    const problem = blocked();
    if (problem) throw new Error(problem);
    const n = Number(count.control.value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_CREATE_ADVERTISERS) throw new Error(`A quantidade deve ser de 1 a ${MAX_CREATE_ADVERTISERS}.`);
    const baseName = name.control.value.trim();
    if (baseName.length < 2) throw new Error('Informe o nome das contas.');
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
    return {
      bcId: selectedBc(),
      count: n,
      name: baseName,
      currency: cur,
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
          errorSlot.replaceChildren(alertBox(err.message), h('p', { class: 'field__hint' }, 'Se a mensagem falar em permissão, o acesso desta conexão pode não incluir a criação de contas: renove o acesso (ou gere um token) com um usuário administrador da Business Center. Se a BC for de agência, preencha o site da empresa em “Mais opções”.'));
          status.textContent = '';
          refresh();
        } finally {
          busy = false;
          submit.disabled = Boolean(blocked());
        }
      },
    },
    errorSlot,
    bcSelect ? bcSelect.element : h('p', { class: 'create-ca__bc' }, 'Business Center do TikTok: ', h('strong', null, bcIds[0])),
    infoSlot,
    h('div', { class: 'create-ca__qty' }, qtyField, name.element),
    preview,
    h('div', { class: 'invite-fields' }, currency.element, timezone.element, company.element, country.element, industry.element),
    promoSlot,
    h('details', { class: 'create-ca__more' }, h('summary', null, 'Mais opções'), moreFields),
    status,
    h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.requestClose() }), submit),
  );
  body.append(form);
  applyBc();
  refresh();
  loadDefaults();
}
