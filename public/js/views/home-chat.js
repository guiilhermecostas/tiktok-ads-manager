import { h, icon, setChildren } from '../dom.js';
import { state } from '../state.js';
import { toast } from '../ui.js';
import { avatarEl } from './avatar.js';
import { TOPICS, blocksToText, detectTopic } from '/shared/chat-topics.js';
import { openCampaignWizard } from './campaign-wizard/index.js';
import { answerFor } from './chat/answers.js';
import { renderBlocks } from './chat/rich.js';

const MAX_LENGTH = 4000;
const TYPING_MS = 600;
const SUGGESTIONS = TOPICS;

// A conversa vale só nesta sessão do navegador (nada vai ao servidor) e é descartada se outra pessoa entrar.
let conversation = { ownerId: null, messages: [] };

/** Início: conversa com o assistente. Responde os assuntos do menu de sugestões (dados reais das contas e tutoriais); veja ./chat/answers.js. */
export function homeChatView(ctx) {
  if (conversation.ownerId !== state.user.id) conversation = { ownerId: state.user.id, messages: [] };
  const firstName = state.user.name.split(' ')[0];
  const body = h('div', { class: 'chat__body' });
  const input = h('textarea', { class: 'chat__input', rows: 1, maxlength: MAX_LENGTH, placeholder: 'Pergunte ao assistente…', 'aria-label': 'Mensagem para o assistente' });
  const send = h('button', { type: 'submit', class: 'chat__send', 'aria-label': 'Enviar mensagem', title: 'Enviar', disabled: true }, icon('send', 18));
  let waiting = false;

  // ---------- desenho ----------
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
    if (message.typing) return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble chat__bubble--typing', 'aria-label': 'O assistente está escrevendo' }, h('span', { class: 'dot' }), h('span', { class: 'dot' }), h('span', { class: 'dot' })));
    if (message.blocks) return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble chat__bubble--rich' }, renderBlocks(message.blocks, { openWizard: () => openCampaignWizard(ctx), ask: (text) => submit(text) }), h('div', { class: 'chat__actions' }, copyButton(message.text))));
    return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble' }, message.text, h('div', { class: 'chat__actions' }, copyButton(message.text))));
  }

  function hero() {
    return h(
      'div',
      { class: 'chat__hero' },
      h('h1', { class: 'chat__title' }, `Olá, ${firstName}. Como posso ajudar?`),
      h('p', { class: 'muted chat__subtitle' }, 'Pergunte sobre suas campanhas, contas e relatórios, ou escolha uma sugestão.'),
      h('div', { class: 'chat__suggestions' }, SUGGESTIONS.map((s) => h('button', { type: 'button', class: 'chat__suggestion', onClick: () => submit(s.text, s.id) }, h('strong', null, s.title), h('span', { class: 'muted' }, s.text)))),
    );
  }

  function draw({ stick = true } = {}) {
    setChildren(body, conversation.messages.length ? h('div', { class: 'chat__thread', 'aria-live': 'polite' }, conversation.messages.map(messageEl)) : hero());
    newChat.hidden = conversation.messages.length === 0;
    if (stick) body.scrollTop = body.scrollHeight; // a conversa rola dentro da própria área; a mais recente fica à vista
  }

  // ---------- envio ----------
  function submit(text, topicId = null) {
    const value = String(text ?? '').trim();
    if (!value || waiting) return;
    waiting = true;
    conversation.messages.push({ role: 'user', text: value.slice(0, MAX_LENGTH) });
    conversation.messages.push({ role: 'assistant', typing: true });
    input.value = '';
    resize();
    draw();
    const owner = conversation;
    const topic = topicId ?? detectTopic(value);
    const pause = new Promise((resolve) => { setTimeout(resolve, TYPING_MS); }); // o "digitando…" aparece por um instante: a resposta não "bate" de uma vez
    answerFor(topic).then(
      (blocks) => ({ blocks, text: blocksToText(blocks) }),
      (err) => ({ blocks: null, text: `Não consegui buscar isso agora: ${err.message || 'erro desconhecido'}. Tente de novo em instantes.` }),
    ).then((reply) => pause.then(() => reply)).then((reply) => {
      waiting = false;
      if (conversation !== owner) return; // trocou de conversa ou de usuária no meio
      conversation.messages = conversation.messages.filter((m) => !m.typing);
      conversation.messages.push({ role: 'assistant', ...reply });
      if (body.isConnected) draw();
      refreshSend();
    });
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
