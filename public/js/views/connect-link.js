import { del, get, post } from '../api.js';
import { h } from '../dom.js';
import { alertBox, button, field, loader, openModal } from '../ui.js';

/** O link de autorização só pode apontar para o TikTok: qualquer outra origem é descartada. */
const TIKTOK_ORIGIN = 'https://business-api.tiktok.com';
const POLL_MS = 2500;
const POLL_RETRY_MS = 6000;

function safeTikTokUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === TIKTOK_ORIGIN && url.pathname === '/portal/auth' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Copia para a área de transferência; sem a API moderna (ex.: página sem HTTPS), usa o método clássico. */
async function copyText(text, input) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    input.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    }
  }
}

const mmss = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Pop-up "Conectar por link": o usuário gera um link do TikTok, abre na aba/perfil em que está logado na
 * Business Center e libera o acesso; esta janela acompanha o resultado sozinha (consulta o servidor).
 *  - `initialName`: nome sugerido (reautorização usa o nome da conexão).
 *  - `onDone()`: chamado ao fechar depois de uma conexão concluída (recarrega a lista).
 *  - `onUseToken()`: alternativa avançada (colar um token manualmente).
 */
export function connectByLink({ initialName = '', onDone, onUseToken }) {
  let attempt = null; // { attemptId, url, expiresAt }
  let timer = null;
  let tick = null;
  let closed = false;
  let waiting = false; // há um link ativo aguardando autorização
  let connected = false;
  let lastName = initialName;

  const body = h('div', { class: 'modal__body' });

  function stopTimers() {
    clearTimeout(timer);
    clearInterval(tick);
    timer = null;
    tick = null;
  }

  function teardown() {
    closed = true;
    stopTimers();
    // Fechou sem concluir: invalida o link (ele não deve continuar valendo por 15 minutos).
    if (waiting && attempt) del(`/tiktok/connect/${attempt.attemptId}`).catch(() => {});
    if (connected) onDone?.();
  }

  const modal = openModal({ title: 'Conectar Business Center', size: 'md', body, onClose: teardown });
  const footer = (...buttons) => h('div', { class: 'modal__footer' }, ...buttons);

  // ---------- 1) nome ----------
  function showForm(message) {
    waiting = false;
    attempt = null;
    stopTimers();
    const name = field('Nome interno', { type: 'text', required: true, maxlength: 80, value: lastName, placeholder: 'Ex.: Loja Principal', autocomplete: 'off' }, {
      hint: 'Só para você identificar esta conexão aqui no sistema.',
    });
    const errorSlot = h('div', null, message ? alertBox(message) : null);
    const submit = button('Gerar link de conexão', { variant: 'primary', type: 'submit' });
    const form = h(
      'form',
      {
        class: 'form',
        novalidate: true,
        onSubmit: async (event) => {
          event.preventDefault();
          const value = name.control.value.trim();
          if (!value) return errorSlot.replaceChildren(alertBox('Informe um nome para a conexão.'));
          lastName = value;
          errorSlot.replaceChildren();
          submit.disabled = true;
          submit.textContent = 'Gerando link…';
          try {
            attempt = await post('/tiktok/connect', { name: value });
            if (closed) {
              del(`/tiktok/connect/${attempt.attemptId}`).catch(() => {}); // fechou enquanto gerava: invalida o link
              return;
            }
            showLink();
          } catch (err) {
            submit.disabled = false;
            submit.textContent = 'Gerar link de conexão';
            errorSlot.replaceChildren(alertBox(err.message));
          }
        },
      },
      errorSlot,
      h('p', { class: 'muted' }, 'Você vai receber um link para abrir no navegador onde está logado na sua Business Center do TikTok e liberar o acesso. É mais simples e seguro: você não precisa copiar tokens nem IDs.'),
      name.element,
      footer(button('Cancelar', { onClick: () => modal.close() }), submit),
      onUseToken
        ? h('p', { class: 'connect__alt' }, h('button', { type: 'button', class: 'link-btn', onClick: () => { modal.close(); onUseToken(); } }, 'Prefiro colar um token de acesso manualmente (avançado)'))
        : null,
    );
    body.replaceChildren(form);
    name.control.focus();
  }

  // ---------- 2) link + espera ----------
  function showLink() {
    waiting = true;
    const safeUrl = safeTikTokUrl(attempt.url);
    const linkInput = h('input', { type: 'text', class: 'input connect__link', readonly: true, value: attempt.url, 'aria-label': 'Link de autorização do TikTok', spellcheck: 'false' });
    const copyButton = button('Copiar link', {
      variant: 'primary',
      onClick: async () => {
        const ok = await copyText(attempt.url, linkInput);
        copyButton.textContent = ok ? 'Link copiado ✓' : 'Selecione e copie (Ctrl+C)';
        setTimeout(() => { copyButton.textContent = 'Copiar link'; }, 2500);
      },
    });
    const openLink = safeUrl ? h('a', { class: 'btn btn--secondary', href: safeUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir em nova aba') : null;

    const statusText = h('span', null, 'Aguardando você liberar o acesso no TikTok…');
    const remaining = h('span', { class: 'muted' });
    const status = h('div', { class: 'connect__status', 'aria-live': 'polite' }, loader({ small: true }), statusText, remaining);

    body.replaceChildren(
      h(
        'ol',
        { class: 'connect__steps' },
        h('li', null, h('strong', null, 'Copie o link'), ' abaixo (ou use “Abrir em nova aba” se este navegador já estiver logado na Business Center).'),
        h('li', null, h('strong', null, 'Cole na aba ou perfil'), ' do navegador em que você está logado na Business Center do TikTok.'),
        h('li', null, h('strong', null, 'Escolha as contas de anúncio'), ' que quer liberar e confirme. Esta janela atualiza sozinha.'),
      ),
      h('div', { class: 'connect__row' }, linkInput, copyButton),
      openLink ? h('div', { class: 'connect__open' }, openLink) : alertBox('O link recebido é inválido. Gere um novo link.'),
      status,
      h('div', { class: 'alert alert--warning connect__warn' }, 'Use somente links que você mesmo gerou aqui e não envie este link a ninguém: quem autorizar por ele liga as próprias contas a esta conexão. O link vale por 15 minutos e só funciona uma vez.'),
      footer(button('Cancelar', { onClick: () => modal.close() })),
    );
    linkInput.select();

    const expiresAt = new Date(attempt.expiresAt).getTime();
    const paint = () => {
      const left = expiresAt - Date.now();
      remaining.textContent = left > 0 ? `· expira em ${mmss(left)}` : '· verificando…';
      if (left <= 0) clearInterval(tick); // quem decide se expirou é o servidor (próxima consulta)
    };
    paint();
    tick = setInterval(paint, 1000);

    const poll = async () => {
      if (closed || !attempt) return;
      try {
        const result = await get(`/tiktok/connect/${attempt.attemptId}`);
        if (closed) return;
        if (result.status === 'pending' || result.status === 'processing') {
          statusText.textContent = result.status === 'processing' ? 'Autorização recebida, concluindo a conexão…' : 'Aguardando você liberar o acesso no TikTok…';
          timer = setTimeout(poll, POLL_MS);
          return;
        }
        showResult(result);
      } catch (err) {
        if (closed) return;
        if (err.status === 404) return showResult({ status: 'expired' });
        timer = setTimeout(poll, POLL_RETRY_MS); // falha momentânea de rede: continua tentando
      }
    };
    timer = setTimeout(poll, POLL_MS);
  }

  // ---------- 3) resultado ----------
  function showResult(result) {
    waiting = false;
    stopTimers();
    if (result.status === 'connected') {
      connected = true;
      const count = result.connection?.advertiserCount ?? 0;
      body.replaceChildren(
        h('div', { class: 'alert alert--success connect__done' }, h('strong', null, `“${result.connection?.name ?? 'Business Center'}” conectada.`), h('p', null, `${count} ${count === 1 ? 'conta de anúncio disponível' : 'contas de anúncio disponíveis'} no sistema.`)),
        footer(button('Concluir', { variant: 'primary', onClick: () => modal.close() })),
      );
      return;
    }
    const text =
      result.status === 'expired'
        ? 'O link expirou ou já foi usado. Gere um novo link para tentar de novo.'
        : (result.message ?? 'Não foi possível concluir a conexão.');
    body.replaceChildren(
      alertBox(text, result.status === 'expired' ? 'warning' : 'danger'),
      footer(button('Fechar', { onClick: () => modal.close() }), button('Gerar novo link', { variant: 'primary', onClick: () => showForm() })),
    );
  }

  showForm();
  return modal;
}
