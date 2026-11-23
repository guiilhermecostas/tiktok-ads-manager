import { h, setChildren } from '../dom.js';
import { state } from '../state.js';
import { toast } from '../ui.js';
import { avatarEl } from './avatar.js';
import { openCampaignWizard } from './campaign-wizard/index.js';

const MAX_LENGTH = 4000;
const SUGGESTIONS = [
  { title: 'Resumo do desempenho', text: 'Como foi o desempenho das minhas contas nos últimos 7 dias?' },
  { title: 'Onde estou gastando', text: 'Qual conta de anúncio mais gastou esta semana?' },
  { title: 'Ideias de criativo', text: 'Me dê 5 ideias de gancho para um anúncio em vídeo.' },
  { title: 'Nova campanha', text: 'Quero criar uma campanha de tráfego. Por onde começo?', action: 'campaign' },
];
const PLACEHOLDER_REPLY = 'O assistente ainda está sendo preparado e não consegue responder de verdade por enquanto. Em breve você vai poder perguntar sobre suas campanhas, contas e relatórios aqui.';

// A conversa vale só nesta sessão do navegador (nada vai ao servidor) e é descartada se outra pessoa entrar.
let conversation = { ownerId: null, messages: [] };

/** Início: conversa com o assistente, no estilo de um chat (design pronto; as respostas reais entram depois). */
export function homeChatView(ctx) {
  if (conversation.ownerId !== state.user.id) conversation = { ownerId: state.user.id, messages: [] };
  const firstName = state.user.name.split(' ')[0];
  const body = h('div', { class: 'chat__body' });
  const input = h('textarea', { class: 'chat__input', rows: 1, maxlength: MAX_LENGTH, placeholder: 'Pergunte alguma coisa sobre suas campanhas…', 'aria-label': 'Mensagem para o assistente' });
  const send = h('button', { type: 'submit', class: 'chat__send', 'aria-label': 'Enviar mensagem', disabled: true }, '↑');
  let waiting = false;

  // ---------- desenho ----------
  const assistantMark = () => h('span', { class: 'chat__mark', 'aria-hidden': 'true' }, h('img', { src: '/tiktokas.png', alt: '', width: 20, height: 20 }));

  function copyButton(text) {
    return h('button', {
      type: 'button', class: 'chat__copy', 'aria-label': 'Copiar resposta',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(text);
          toast('Resposta copiada.');
        } catch {
          toast('Não foi possível copiar.', 'danger');
        }
      },
    }, 'Copiar');
  }

  function messageEl(message) {
    if (message.role === 'user') return h('div', { class: 'chat__msg chat__msg--user' }, h('div', { class: 'chat__bubble' }, message.text), avatarEl(state.user, { size: 'sm' }));
    if (message.typing) return h('div', { class: 'chat__msg' }, assistantMark(), h('div', { class: 'chat__bubble chat__bubble--typing', 'aria-label': 'O assistente está escrevendo' }, h('span', { class: 'dot' }), h('span', { class: 'dot' }), h('span', { class: 'dot' })));
    return h('div', { class: 'chat__msg' }, assistantMark(), h('div', { class: 'chat__bubble' }, message.text, h('div', { class: 'chat__actions' }, copyButton(message.text))));
  }

  function hero() {
    return h(
      'div',
      { class: 'chat__hero' },
      h('span', { class: 'chat__mark chat__mark--lg', 'aria-hidden': 'true' }, h('img', { src: '/tiktokas.png', alt: '', width: 34, height: 34 })),
      h('h1', { class: 'chat__title' }, `Olá, ${firstName}. Como posso ajudar?`),
      h('p', { class: 'muted chat__subtitle' }, 'Pergunte sobre suas campanhas, contas e relatórios, ou escolha uma sugestão.'),
      h('div', { class: 'chat__suggestions' }, SUGGESTIONS.map((s) => h('button', { type: 'button', class: 'chat__suggestion', onClick: () => (s.action === 'campaign' ? openCampaignWizard(ctx) : submit(s.text)) }, h('strong', null, s.title), h('span', { class: 'muted' }, s.text)))),
    );
  }

  function draw({ stick = true } = {}) {
    setChildren(body, conversation.messages.length ? h('div', { class: 'chat__thread', 'aria-live': 'polite' }, conversation.messages.map(messageEl)) : hero());
    newChat.hidden = conversation.messages.length === 0;
    if (stick) window.scrollTo?.({ top: 0 });
    const scroller = body.closest('.main') ?? document.scrollingElement;
    if (stick && scroller) scroller.scrollTop = scroller.scrollHeight;
  }

  // ---------- envio ----------
  function submit(text) {
    const value = String(text ?? '').trim();
    if (!value || waiting) return;
    waiting = true;
    conversation.messages.push({ role: 'user', text: value.slice(0, MAX_LENGTH) });
    conversation.messages.push({ role: 'assistant', typing: true });
    input.value = '';
    resize();
    draw();
    const owner = conversation;
    setTimeout(() => {
      waiting = false;
      if (conversation !== owner) return; // trocou de conversa ou de usuária no meio
      conversation.messages = conversation.messages.filter((m) => !m.typing);
      conversation.messages.push({ role: 'assistant', text: PLACEHOLDER_REPLY });
      if (body.isConnected) draw();
      refreshSend();
    }, 900);
    refreshSend();
  }

  function refreshSend() {
    send.disabled = waiting || input.value.trim().length === 0;
  }
  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`; // CSSOM: permitido pela CSP
    refreshSend();
  }
  input.addEventListener('input', resize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(input.value);
    }
  });
  const form = h('form', { class: 'chat__composer', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit(input.value); } }, h('div', { class: 'chat__box' }, input, send), h('p', { class: 'chat__hint muted' }, 'Enter envia · Shift+Enter quebra a linha. O assistente ainda está em desenvolvimento.'));

  const newChat = h('button', { type: 'button', class: 'btn btn--secondary btn--sm chat__new', hidden: true, onClick: () => { conversation = { ownerId: state.user.id, messages: [] }; waiting = false; draw(); input.focus(); } }, '+ Nova conversa');

  const element = h('div', { class: 'chat' }, h('div', { class: 'chat__top' }, h('span', { class: 'chat__name' }, 'Assistente'), newChat), body, form);
  draw({ stick: false });
  queueMicrotask(() => input.focus());
  return { element };
}
