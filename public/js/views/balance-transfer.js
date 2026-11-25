import { MAX_TRANSFER_AMOUNT, TRANSFER_TYPES, describeTransfer, parseTransferAmount, transferEligibility } from '/shared/balance-transfer.js';
import { post } from '../api.js';
import { h, setChildren } from '../dom.js';
import { formatCurrency } from '../format.js';
import { alertBox, button, openModal, toast } from '../ui.js';

/** Identificador da operação (32 hexadecimais): a mesma operação nunca move o dinheiro duas vezes, mesmo que o pedido seja reenviado. */
const newOperationId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
const money = (value, currency) => formatCurrency(value, currency);
/** Erros em que o servidor NÃO criou a operação (ou ela falhou de vez): o reenvio é seguro e pode usar o mesmo identificador, exceto "transfer_failed". */
const NEW_OPERATION_ON = new Set(['transfer_failed', 'transfer_duplicate']);

/**
 * Pop-up "Transferir saldo" entre a Business Center e uma conta de anúncio, em duas etapas (preencher → revisar e confirmar com a senha).
 *  - account / bc: linhas do Saldo (a elegibilidade e os limites vêm de shared/balance-transfer.js, as MESMAS regras do servidor);
 *  - onDone(): chamado depois de uma transferência concluída (a tela recarrega o saldo e o histórico).
 * Todo texto (nomes, mensagens do TikTok) entra como nó de texto, nunca como HTML. Enquanto envia, o pop-up não fecha.
 */
export function openTransferDialog({ account, bc, onDone }) {
  const eligibility = transferEligibility(account, bc);
  const st = { type: 'RECHARGE', amount: '', step: 'form', busy: false, operationId: newOperationId(), error: null, result: null };
  const body = h('div', { class: 'modal__body transfer' });
  let amountInput;
  let passwordInput;

  const limit = () => (st.type === 'RECHARGE' ? eligibility.maxRecharge : eligibility.maxRefund);
  const parsed = () => parseTransferAmount(st.amount);
  const currency = account.currency;
  const sentence = () => describeTransfer({ type: st.type, amount: parsed() ?? 0, currency, bcId: bc.bcId, advertiserName: account.name, advertiserId: account.advertiserId }, money);

  function balances() {
    return h('dl', { class: 'transfer__balances' },
      h('div', null, h('dt', null, `Saldo da BC ${bc.bcId}`), h('dd', null, money(bc.main, currency))),
      h('div', null, h('dt', null, `Saldo de ${account.name}`), h('dd', null, money(account.main, currency))));
  }

  function drawForm() {
    const choices = Object.values(TRANSFER_TYPES).map((t) => h('label', { class: `choice${st.type === t.id ? ' is-on' : ''}` },
      h('input', { type: 'radio', name: 'transfer-type', value: t.id, checked: st.type === t.id, onChange: () => { st.type = t.id; st.error = null; draw(); } }),
      h('span', null, h('strong', null, t.label), h('small', { class: 'muted' }, ` (${t.from} → ${t.to})`))));
    amountInput = h('input', { id: 'transfer-amount', class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off', maxlength: 14, placeholder: '0,00', value: st.amount, 'aria-describedby': 'transfer-amount-hint', onInput: (e) => { st.amount = e.target.value; st.error = null; } });
    const max = limit();
    setChildren(body,
      h('div', { class: 'alert alert--warning', role: 'note' }, 'Isto movimenta dinheiro de verdade entre a Business Center e a conta de anúncio. Para colocar dinheiro NOVO na Business Center (cartão, PIX, boleto), use o portal do TikTok: por aqui só se move o que já está no TikTok.'),
      balances(),
      h('fieldset', { class: 'choice-group' }, h('legend', { class: 'field__label' }, 'O que fazer'), choices),
      h('div', { class: 'field' },
        h('label', { for: 'transfer-amount', class: 'field__label' }, `Valor (${currency})`),
        h('div', { class: 'transfer__amount-row' }, amountInput, button('Usar o máximo', { small: true, disabled: max <= 0, onClick: () => { st.amount = String(max).replace('.', ','); amountInput.value = st.amount; } })),
        h('p', { id: 'transfer-amount-hint', class: 'field__hint' }, `${st.type === 'RECHARGE' ? 'Máximo: o saldo disponível da Business Center' : 'Máximo: o valor transferível da conta (não inclui o que está bloqueado)'}: ${money(max, currency)}. Até 2 casas decimais, no máximo ${money(MAX_TRANSFER_AMOUNT, currency)} por vez.`)),
      st.error ? alertBox(st.error) : null,
      h('p', { class: 'field__hint' }, 'Só quem tem a função Finance Manager na Business Center consegue concluir (o TikTok confere). Colaboradores não movimentam saldo.'),
      h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.requestClose() }), button('Revisar', { variant: 'primary', onClick: review })));
    amountInput.focus();
  }

  function review() {
    const amount = parsed();
    if (amount === null) { st.error = `Informe um valor maior que zero, com até 2 casas decimais (máximo ${money(MAX_TRANSFER_AMOUNT, currency)}).`; return draw(); }
    if (amount > limit()) { st.error = `O valor passa do que está disponível agora (${money(limit(), currency)}).`; return draw(); }
    st.step = 'review';
    st.error = null;
    return draw();
  }

  function drawReview() {
    const amount = parsed();
    const sign = st.type === 'RECHARGE' ? 1 : -1;
    passwordInput = h('input', { id: 'transfer-password', class: 'input', type: 'password', autocomplete: 'current-password', maxlength: 200, 'aria-describedby': 'transfer-password-hint' });
    const submit = button(`Confirmar ${TRANSFER_TYPES[st.type].short.toLowerCase()} ${money(amount, currency)}`, { variant: 'primary', type: 'submit', disabled: st.busy });
    setChildren(body, h('form', {
      class: 'form', novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        if (st.busy) return;
        if (!passwordInput.value) { st.error = 'Digite a sua senha para confirmar.'; return drawReview(); }
        await send(passwordInput.value);
        return undefined;
      },
    },
    h('div', { class: 'transfer__review' }, h('p', { class: 'muted' }, 'Você vai transferir'), h('p', { class: 'transfer__sentence' }, sentence())),
    h('dl', { class: 'transfer__balances' },
      h('div', null, h('dt', null, `BC ${bc.bcId} depois`), h('dd', null, money(Math.max(0, bc.main - sign * amount), currency))),
      h('div', null, h('dt', null, `${account.name} depois`), h('dd', null, money(Math.max(0, account.main + sign * amount), currency)))),
    h('div', { class: 'field' },
      h('label', { for: 'transfer-password', class: 'field__label' }, 'Sua senha'),
      passwordInput,
      h('p', { id: 'transfer-password-hint', class: 'field__hint' }, 'Pedimos a senha para confirmar que foi você. A transferência não pode ser desfeita por aqui (só com uma nova transferência no sentido contrário).')),
    st.error ? alertBox(st.error) : null,
    h('div', { class: 'modal__footer' }, button('Voltar', { disabled: st.busy, onClick: () => { st.step = 'form'; st.error = null; draw(); } }), submit)));
    passwordInput.focus();
  }

  async function send(password) {
    st.busy = true;
    st.error = null;
    drawReview();
    try {
      const res = await post('/tiktok/balance/transfer', { connectionId: account.connectionId, bcId: bc.bcId, advertiserId: account.advertiserId, type: st.type, amount: st.amount, operationId: st.operationId, password });
      st.result = res.transfer;
      st.step = 'done';
      toast('Transferência concluída.');
      onDone?.();
    } catch (err) {
      if (err.code === 'transfer_unconfirmed') { // o TikTok não respondeu: o dinheiro pode ter se movido, então NUNCA se reenvia sozinho
        st.step = 'unconfirmed';
        st.error = err.message;
        onDone?.();
      } else {
        st.error = err.message;
        if (NEW_OPERATION_ON.has(err.code)) st.operationId = newOperationId(); // a operação anterior terminou (falhou): a próxima tentativa é outra
      }
    } finally {
      st.busy = false;
    }
    draw();
  }

  function drawDone() {
    const ids = st.result?.transactionIds ?? [];
    setChildren(body,
      alertBox(`Transferência concluída: ${sentence()}.`, 'success'),
      ids.length ? h('p', { class: 'muted transfer__ids' }, `Código${ids.length > 1 ? 's' : ''} da transação no TikTok: ${ids.join(' · ')}`) : null,
      h('p', { class: 'field__hint' }, 'O saldo na tela já foi atualizado. O histórico fica logo abaixo da tabela.'),
      h('div', { class: 'modal__footer' }, button('Fechar', { variant: 'primary', onClick: () => modal.close() })));
  }

  function drawUnconfirmed() {
    setChildren(body,
      alertBox(st.error, 'warning'),
      h('p', { class: 'field__hint' }, 'Para não mover o dinheiro duas vezes, o sistema NÃO tenta de novo sozinho. Veja o saldo atualizado e o histórico: se a transferência não aparecer, faça uma nova.'),
      h('div', { class: 'modal__footer' }, button('Fechar', { variant: 'primary', onClick: () => modal.close() })));
  }

  function draw() {
    if (st.step === 'form') drawForm();
    else if (st.step === 'review') drawReview();
    else if (st.step === 'done') drawDone();
    else drawUnconfirmed();
  }

  const modal = openModal({
    title: `Transferir saldo · ${account.name}`,
    body,
    dismissOnOverlay: false,
    canClose: () => !st.busy, // enviando: não fecha (a resposta ainda vai chegar)
  });
  draw();
  return modal;
}
