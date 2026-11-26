import { detectOperation, detectPeriod } from '/shared/assistant-intents.js';
import { PLACEHOLDERS } from '/shared/chat-suggest.js';
import { blocksToText, detectTopic } from '/shared/chat-topics.js';
import { h, icon, setChildren } from '../dom.js';
import { state } from '../state.js';
import { loader, toast } from '../ui.js';
import { avatarEl } from './avatar.js';
import { openCampaignWizard } from './campaign-wizard/index.js';
import { answerFor } from './chat/answers.js';
import { operationAnswer } from './chat/ops-answers.js';
import { renderBlocks } from './chat/rich.js';
import { createSuggestBox } from './chat/suggest-box.js';
import { createVoice, voiceSupported } from './chat/voice.js';

const MAX_LENGTH = 4000;
const TYPING_MS = 600;
const PLACEHOLDER_MS = 4500;

// A conversa vale só nesta sessão do navegador (nada vai ao servidor) e é descartada se outra pessoa entrar.
let conversation = { ownerId: null, messages: [] };

/**
 * Início: conversa com o assistente (dados reais das contas e tutoriais; veja ./chat/answers.js). A tela é limpa: só a saudação e o campo.
 * O que o assistente sabe responder aparece quando precisa: sugestões enquanto a pessoa digita, `/` para ver tudo, exemplos que se alternam no campo,
 * ditado por voz (onde o navegador permite) e a tecla `/` de qualquer lugar da página para ir direto ao campo.
 */
export function homeChatView(ctx) {
  if (conversation.ownerId !== state.user.id) conversation = { ownerId: state.user.id, messages: [] };
  const firstName = state.user.name.split(' ')[0];
  const body = h('div', { class: 'chat__body' });
  const input = h('textarea', { class: 'chat__input', rows: 1, maxlength: MAX_LENGTH, placeholder: PLACEHOLDERS[0], 'aria-label': 'Sua pergunta' });
  const send = h('button', { type: 'submit', class: 'chat__send', 'aria-label': 'Enviar mensagem', title: 'Enviar', disabled: true }, icon('send', 18));
  let waiting = false;
  let placeholderIndex = 0;
  let stopVoice = () => {};

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
    if (message.typing) return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble chat__bubble--typing', 'aria-label': 'Escrevendo a resposta' }, h('span', { class: 'dot' }), h('span', { class: 'dot' }), h('span', { class: 'dot' })));
    if (message.blocks) return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble chat__bubble--rich' }, renderBlocks(message.blocks, { openWizard: () => openCampaignWizard(ctx), ask: (text) => submit(text) }), h('div', { class: 'chat__actions' }, copyButton(message.text))));
    return h('div', { class: 'chat__msg' }, h('div', { class: 'chat__bubble' }, message.text, h('div', { class: 'chat__actions' }, copyButton(message.text))));
  }

  function hero() {
    return h(
      'div',
      { class: 'chat__hero' },
      h('span', { class: 'chat__mark' }, loader({ large: true })),
      h('h1', { class: 'chat__title' }, `Olá, ${firstName}. Como posso ajudar?`),
      h('p', { class: 'muted chat__subtitle' }, 'Pergunte sobre suas campanhas, contas e relatórios. Digite ', h('kbd', { class: 'chat__kbd' }, '/'), ' para ver tudo o que sei responder.'),
    );
  }

  function draw({ stick = true } = {}) {
    setChildren(body, conversation.messages.length ? h('div', { class: 'chat__thread', 'aria-live': 'polite' }, conversation.messages.map(messageEl)) : hero());
    newChat.hidden = conversation.messages.length === 0;
    if (stick) body.scrollTop = body.scrollHeight; // a conversa rola dentro da própria área; a mais recente fica à vista
  }

  // ---------- envio ----------
  function submit(text, topicId = null, operation = null) {
    const value = String(text ?? '').trim();
    if (!value || waiting) return;
    waiting = true;
    conversation.messages.push({ role: 'user', text: value.slice(0, MAX_LENGTH) });
    conversation.messages.push({ role: 'assistant', typing: true });
    input.value = '';
    resize();
    draw();
    const owner = conversation;
    // Pergunta sobre a operação (BCs, contas que caíram, rejeitados, criativos, gasto…) tem prioridade; o resto cai nos assuntos antigos.
    const op = topicId ? null : (operation ?? detectOperation(value));
    const topic = topicId ?? detectTopic(value);
    const pause = new Promise((resolve) => { setTimeout(resolve, TYPING_MS); }); // o "digitando…" aparece por um instante: a resposta não "bate" de uma vez
    (op ? operationAnswer(op) : answerFor(topic)).then(
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
  // ---------- sugestões enquanto digita ----------
  const suggestBox = createSuggestBox({
    input,
    onPick: (item) => submit(item.text, item.kind === 'topic' ? item.id : null, item.kind === 'operation' ? { id: item.id, period: detectPeriod(item.text) } : null),
  });
  input.addEventListener('input', () => { resize(); suggestBox.update(); });
  input.addEventListener('blur', () => setTimeout(() => suggestBox.close(), 120)); // dá tempo do clique numa sugestão chegar
  input.addEventListener('keydown', (e) => {
    if (suggestBox.handleKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit(input.value);
    }
  });

  // ---------- ditado por voz (opcional) ----------
  let voiceStatus = null;
  let mic = null;
  if (voiceSupported) {
    voiceStatus = h('p', { class: 'chat__voice muted', 'aria-live': 'polite', hidden: true });
    const voice = createVoice({
      onText: (text) => { input.value = text.slice(0, MAX_LENGTH); resize(); },
      onState: (listening) => {
        mic.classList.toggle('is-listening', listening);
        mic.setAttribute('aria-pressed', String(listening));
        mic.title = listening ? 'Parar de ouvir' : 'Falar em vez de digitar (usa o serviço de voz do seu navegador)';
        voiceStatus.hidden = !listening;
        voiceStatus.textContent = listening ? 'Ouvindo… fale a sua pergunta.' : '';
        if (!listening) input.focus();
      },
      onError: (message) => toast(message, 'danger'),
    });
    mic = h('button', { type: 'button', class: 'chat__mic', 'aria-label': 'Falar a pergunta', 'aria-pressed': 'false', title: 'Falar em vez de digitar (usa o serviço de voz do seu navegador)', onClick: () => voice.toggle() }, icon('mic', 18));
    stopVoice = () => voice.stop();
  }

  const form = h('form', { class: 'chat__composer', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit(input.value); } },
    suggestBox.element,
    h('div', { class: 'chat__box' }, input, mic, send),
    voiceStatus,
    h('p', { class: 'chat__hint muted' }, 'Enter envia · Shift+Enter quebra a linha · / mostra as opções'));

  const newChat = h('button', { type: 'button', class: 'btn btn--secondary btn--sm chat__new', hidden: true, onClick: () => { conversation = { ownerId: state.user.id, messages: [] }; waiting = false; draw(); input.focus(); } }, '+ Nova conversa');

  const element = h('div', { class: 'chat' }, h('div', { class: 'chat__top' }, newChat), body, form);
  draw({ stick: false });
  queueMicrotask(() => input.focus());

  // Exemplos que se alternam no campo vazio (uma pista do que dá para perguntar, sem encher a tela).
  const rotation = setInterval(() => {
    if (!element.isConnected) return clearInterval(rotation);
    if (input.value) return undefined;
    placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
    input.placeholder = PLACEHOLDERS[placeholderIndex];
    return undefined;
  }, PLACEHOLDER_MS);

  // A tecla "/" de qualquer lugar da página leva ao campo (e já mostra tudo o que o assistente responde).
  const onShortcut = (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || document.body.classList.contains('modal-open')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
    e.preventDefault();
    input.focus();
    input.value = '/';
    resize();
    suggestBox.update();
  };
  document.addEventListener('keydown', onShortcut);

  return {
    element,
    cleanup: () => {
      clearInterval(rotation);
      document.removeEventListener('keydown', onShortcut);
      stopVoice();
    },
  };
}
