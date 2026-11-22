import { del, get, patch, post } from '../api.js';
import { h } from '../dom.js';
import { formatDate } from '../format.js';
import { PROXY_KIND_LABELS, parseProxyUrl } from '../proxy-url.js';
import { alertBox, badge, button, confirmDialog, emptyState, field, openModal, toast } from '../ui.js';
import { accountsTabs } from './accounts-tabs.js';
import { pageHeader } from './layout.js';

const kindLabel = (kind) => PROXY_KIND_LABELS[kind] ?? kind;
const address = (p) => `${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`;
const KIND_OPTIONS = [['socks5', 'SOCKS5 (recomendado para proxies residenciais)'], ['http', 'HTTP'], ['https', 'HTTPS'], ['socks4', 'SOCKS4']];

/**
 * Formulário de cadastro/edição. Na edição a senha só é enviada se for digitada (em branco = manter a salva); ela nunca é exibida.
 */
function proxyForm(existing, onSaved) {
  const paste = field('Colar proxy (opcional)', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'socks5://usuario:senha@host:porta  ou  host:porta:usuario:senha' }, {
    hint: 'Cole como o provedor entregou: o tipo, o endereço, a porta, o usuário e a senha são preenchidos abaixo.',
  });
  const name = field('Nome', { type: 'text', required: true, maxlength: 60, value: existing?.name ?? '', placeholder: 'Ex.: EUA – residencial' });
  const kind = field('Tipo', { as: 'select', options: KIND_OPTIONS, value: existing?.kind ?? 'socks5' });
  const host = field('Endereço (host ou IP)', { type: 'text', required: true, maxlength: 253, value: existing?.host ?? '', placeholder: 'proxy.exemplo.com', autocomplete: 'off', spellcheck: 'false' });
  const port = field('Porta', { type: 'text', inputmode: 'numeric', required: true, maxlength: 5, value: existing?.port ?? '', placeholder: '1080', autocomplete: 'off' });
  const username = field('Usuário (se houver)', { type: 'text', maxlength: 128, value: existing?.username ?? '', autocomplete: 'off', spellcheck: 'false' });
  const password = field('Senha (se houver)', { type: 'password', maxlength: 256, autocomplete: 'new-password' }, {
    hint: existing?.hasPassword ? 'Deixe em branco para manter a senha salva. Ela nunca é exibida.' : 'Fica criptografada no servidor e nunca volta para o navegador.',
  });
  const clearAuth = h('input', { type: 'checkbox' });
  const activateBox = h('input', { type: 'checkbox' });
  const errorSlot = h('div');

  // SOCKS4 não tem senha: o campo é desabilitado para não induzir a erro.
  const syncKind = () => {
    const socks4 = kind.control.value === 'socks4';
    password.control.disabled = socks4;
    if (socks4) password.control.value = '';
  };
  kind.control.addEventListener('change', syncKind);
  syncKind();

  let suggestedName = null; // nome sugerido a partir do endereço: só é trocado enquanto o usuário não digitar o dele
  /** Preenche o formulário com o que foi colado. Retorna true se reconheceu a proxy. */
  const applyPasted = (value) => {
    const parsed = parseProxyUrl(value);
    if (!parsed) return false;
    if (parsed.kind) kind.control.value = parsed.kind;
    host.control.value = parsed.host;
    if (parsed.port) port.control.value = String(parsed.port);
    username.control.value = parsed.username ?? '';
    password.control.value = parsed.password ?? '';
    if (!name.control.value.trim() || name.control.value === suggestedName) {
      name.control.value = parsed.host;
      suggestedName = parsed.host;
    }
    syncKind();
    return true;
  };
  // Colar: preenche e NÃO deixa a URL (que traz a senha) visível no campo. Digitar: preenche enquanto digita e limpa ao sair do campo.
  paste.control.addEventListener('paste', (event) => {
    if (applyPasted(event.clipboardData?.getData('text') ?? '')) event.preventDefault();
  });
  paste.control.addEventListener('input', () => applyPasted(paste.control.value));
  paste.control.addEventListener('change', () => {
    if (parseProxyUrl(paste.control.value)) paste.control.value = '';
  });

  const submit = button(existing ? 'Salvar' : 'Cadastrar proxy', { variant: 'primary', type: 'submit' });
  const form = h(
    'form',
    {
      class: 'form modal__body',
      novalidate: true,
      onSubmit: async (event) => {
        event.preventDefault();
        errorSlot.replaceChildren();
        submit.disabled = true;
        const payload = {
          name: name.control.value,
          kind: kind.control.value,
          host: host.control.value,
          port: port.control.value.trim(),
          username: username.control.value,
          ...(password.control.value ? { password: password.control.value } : {}),
          ...(clearAuth.checked ? { clearAuth: true } : {}),
          ...(!existing && activateBox.checked ? { active: true } : {}),
        };
        try {
          if (existing) await patch(`/proxies/${existing.id}`, payload);
          else await post('/proxies', payload);
          password.control.value = '';
          modal.close();
          toast(existing ? 'Proxy atualizada.' : 'Proxy cadastrada. Use “Testar” para conferir o IP e o país de saída.');
          await onSaved();
        } catch (err) {
          errorSlot.replaceChildren(alertBox(err.message));
          submit.disabled = false;
        }
      },
    },
    errorSlot,
    paste.element,
    name.element,
    h('div', { class: 'form-grid' }, kind.element, port.element),
    host.element,
    h('div', { class: 'form-grid' }, username.element, password.element),
    existing?.username || existing?.hasPassword ? h('label', { class: 'check' }, clearAuth, h('span', null, 'Remover usuário e senha (proxy sem autenticação)')) : null,
    existing ? null : h('label', { class: 'check' }, activateBox, h('span', null, 'Ativar depois de cadastrar (as chamadas ao TikTok passam a sair por ela)')),
    h('div', { class: 'modal__footer' }, button('Cancelar', { onClick: () => modal.close() }), submit),
  );
  const modal = openModal({ title: existing ? 'Editar proxy' : 'Adicionar proxy', size: 'md', body: form });
  (existing ? name.control : paste.control).focus();
}

function lastTestCell(proxy) {
  const test = proxy.lastTest;
  if (!test) return h('span', { class: 'muted' }, 'Nunca testada');
  if (test.ok) {
    return h('div', null, h('span', { class: 'proxy-test proxy-test--ok' }, `✓ ${test.ip}${test.country ? ` · ${test.country}` : ''}`), h('p', { class: 'muted cell-note' }, formatDate(test.at)));
  }
  return h('div', null, h('span', { class: 'proxy-test proxy-test--fail' }, '✗ Falhou'), h('p', { class: 'muted cell-note' }, test.error ?? 'Sem detalhes.'), h('p', { class: 'muted cell-note' }, formatDate(test.at)));
}

/** Sub-aba "Proxy": cadastra proxies (HTTP, HTTPS, SOCKS4, SOCKS5) e escolhe a ativa para as chamadas ao TikTok. */
export async function proxySettingsView() {
  const container = h('div');

  async function load() {
    const data = await get('/proxies');
    container.replaceChildren(draw(data));
  }
  const reload = async () => {
    try {
      await load();
    } catch (err) {
      container.replaceChildren(alertBox(err.message));
    }
  };

  async function test(proxy, trigger) {
    trigger.disabled = true;
    trigger.textContent = 'Testando…';
    try {
      const { result } = await post(`/proxies/${proxy.id}/test`);
      if (result.ok) toast(`Proxy funcionando: saída ${result.ip}${result.country ? ` · ${result.country}` : ''} (${result.latencyMs} ms).`);
      else toast(result.error ?? 'O teste da proxy falhou.', 'danger');
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  async function activate(proxy) {
    if (!proxy.lastTest?.ok) {
      const ok = await confirmDialog({
        title: 'Ativar proxy',
        message: proxy.lastTest
          ? `O último teste de "${proxy.name}" falhou. Com a proxy ativa, se ela não funcionar as chamadas ao TikTok vão FALHAR (elas nunca usam o IP do servidor como reserva). Ativar mesmo assim?`
          : `"${proxy.name}" ainda não foi testada. Com a proxy ativa, se ela não funcionar as chamadas ao TikTok vão FALHAR (elas nunca usam o IP do servidor como reserva). Ativar mesmo assim?`,
        confirmLabel: 'Ativar mesmo assim',
      });
      if (!ok) return;
    }
    try {
      await post(`/proxies/${proxy.id}/activate`);
      toast(`Proxy "${proxy.name}" ativada: as chamadas ao TikTok agora saem por ela.`);
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  async function deactivate(proxy) {
    try {
      await post(`/proxies/${proxy.id}/deactivate`);
      toast('Proxy desativada: as chamadas ao TikTok voltam a sair do IP do servidor.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  async function remove(proxy) {
    const ok = await confirmDialog({
      title: 'Remover proxy',
      message: `Remover "${proxy.name}"? Os dados de acesso são apagados do servidor.${proxy.active ? ' Ela está ATIVA: depois de remover, as chamadas ao TikTok voltam a sair do IP do servidor.' : ''}`,
      confirmLabel: 'Remover',
      danger: true,
    });
    if (!ok) return;
    try {
      await del(`/proxies/${proxy.id}`);
      toast('Proxy removida.');
    } catch (err) {
      toast(err.message, 'danger');
    }
    await reload();
  }

  function statusCard(proxies) {
    const active = proxies.find((p) => p.active);
    if (active) {
      return h(
        'div',
        { class: 'proxy-status proxy-status--on' },
        h('strong', null, `Proxy ativa: ${active.name}`),
        h('p', null, `${kindLabel(active.kind)} · ${address(active)}${active.lastTest?.ok ? ` · saída ${active.lastTest.ip}${active.lastTest.country ? ` (${active.lastTest.country})` : ''}` : ''}`),
        h('p', { class: 'muted' }, 'TODAS as chamadas à API do TikTok das suas Business Centers saem por ela. Se ela falhar, a chamada falha: o IP do servidor nunca é usado como reserva. Contas de uma Business Center compartilhada pelo administrador usam a proxy de quem conectou essa BC.'),
      );
    }
    return h(
      'div',
      { class: 'proxy-status' },
      h('strong', null, 'Nenhuma proxy ativa'),
      h('p', { class: 'muted' }, 'As chamadas ao TikTok saem do IP do servidor. Vende nos EUA e o TikTok bloqueia por país? Cadastre uma proxy dos EUA, use “Testar” para conferir o IP de saída e ative.'),
    );
  }

  function draw({ configured, max, proxies }) {
    const addButton = button('+ Adicionar proxy', { variant: 'primary', disabled: !configured || proxies.length >= max, onClick: () => proxyForm(null, reload) });
    const header = pageHeader('Contas TikTok', 'Proxies para as chamadas à API do TikTok: HTTP, HTTPS, SOCKS4 e SOCKS5.', addButton);
    const notice = configured ? null : alertBox('O servidor ainda não tem a TOKEN_ENCRYPTION_KEY configurada (arquivo .env). Ela também protege os dados das proxies.');
    if (!proxies.length) {
      return h(
        'div',
        null,
        header,
        accountsTabs('/business-centers/proxy'),
        notice,
        statusCard(proxies),
        h('div', { class: 'card' }, emptyState({
          title: 'Nenhuma proxy cadastrada',
          text: 'Cadastre uma proxy (por exemplo, dos EUA) para que a publicação e as consultas ao TikTok saiam por ela. Usuário e senha ficam criptografados e nunca voltam para o navegador.',
          action: configured ? button('+ Adicionar proxy', { variant: 'primary', onClick: () => proxyForm(null, reload) }) : null,
        })),
      );
    }
    const rows = proxies.map((p) =>
      h(
        'tr',
        null,
        h('td', { class: 'cell-strong' }, p.name),
        h('td', null, badge(kindLabel(p.kind), 'neutral')),
        h('td', null, h('span', { class: 'code' }, address(p))),
        h('td', { class: 'muted' }, p.username || p.hasPassword ? 'Usuário e senha' : 'Sem autenticação'),
        h('td', null, lastTestCell(p)),
        h('td', null, p.active ? badge('Ativa', 'success') : badge('Inativa', 'neutral')),
        h(
          'td',
          null,
          h(
            'div',
            { class: 'cell-actions' },
            button('Testar', { small: true, onClick: (e) => test(p, e.currentTarget) }),
            p.active ? button('Desativar', { small: true, onClick: () => deactivate(p) }) : button('Ativar', { small: true, onClick: () => activate(p) }),
            button('Editar', { small: true, onClick: () => proxyForm(p, reload) }),
            button('Remover', { small: true, variant: 'danger-ghost', onClick: () => remove(p) }),
          ),
        ),
      ),
    );
    return h(
      'div',
      null,
      header,
      accountsTabs('/business-centers/proxy'),
      notice,
      statusCard(proxies),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', null, h('tr', null, ['Nome', 'Tipo', 'Endereço', 'Acesso', 'Último teste', 'Status', ''].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, rows))),
      h('p', { class: 'muted section-note' }, `Até ${max} proxies por usuário; só uma fica ativa por vez. O endereço da proxy precisa ser público: redes internas são bloqueadas por segurança.`),
    );
  }

  await load();
  return { element: container };
}
