import { del, get, uploadFile } from '../api.js';
import { h, setChildren } from '../dom.js';
import { formatBytes, formatDate } from '../format.js';
import { alertBox, badge, button, confirmDialog, emptyState, toast } from '../ui.js';
import { hubLayout, plural } from './hub.js';

/**
 * Sub-aba "Arquivos" de Contas TikTok: anexos compartilhados com quem tem acesso a esta área (ex.: arquivos de logins).
 * Arraste e solte ou escolha; ficam criptografados no servidor e são sempre baixados (nunca abertos no navegador).
 */
export async function filesView() {
  const data = await get('/files');
  const { limits } = data;
  const accepted = limits.extensions.map((e) => `.${e}`);
  const state = { files: data.files, usage: data.usage };
  const body = h('div');
  const summary = h('p', { 'aria-live': 'polite' }); // atualizado a cada mudança (enviar, excluir)
  const queue = h('ul', { class: 'files__queue', 'aria-live': 'polite' });
  let busy = false;

  const extOf = (name) => (/\.([A-Za-z0-9]{1,5})$/.exec(name)?.[1] ?? '').toLowerCase();

  async function reload() {
    const fresh = await get('/files');
    state.files = fresh.files;
    state.usage = fresh.usage;
    draw();
  }

  /** Envia um por vez; cada arquivo mostra o andamento e o motivo se for recusado. */
  async function sendAll(list) {
    if (busy || !list.length) return;
    busy = true;
    draw();
    let sent = 0;
    for (const file of list) {
      const status = h('span', { class: 'muted' }, 'Na fila…');
      const row = h('li', { class: 'files__item' }, h('span', { class: 'files__item-name' }, file.name), status);
      queue.append(row);
      const ext = extOf(file.name);
      if (!limits.extensions.includes(ext === 'jpeg' ? 'jpg' : ext)) {
        status.textContent = `Tipo não aceito (use ${accepted.join(' ')})`;
        status.className = 'files__error';
        continue;
      }
      if (file.size > limits.maxFileBytes) {
        status.textContent = `Maior que ${formatBytes(limits.maxFileBytes)}`;
        status.className = 'files__error';
        continue;
      }
      try {
        const upload = uploadFile(`/files?filename=${encodeURIComponent(file.name)}`, file, { onProgress: (p) => { status.textContent = `Enviando… ${Math.round(p * 100)}%`; } });
        await upload.promise;
        status.textContent = '✓ Enviado';
        status.className = 'files__ok';
        sent += 1;
      } catch (err) {
        status.textContent = err.message;
        status.className = 'files__error';
      }
    }
    busy = false;
    if (sent) toast(`${plural(sent, 'arquivo enviado', 'arquivos enviados')}.`);
    await reload();
  }

  /** Baixa pelo navegador, mas com `fetch`: se o servidor recusar, o motivo vira aviso (e não uma página de erro). */
  async function download(file, trigger) {
    trigger.disabled = true;
    try {
      const response = await fetch(`/api/files/${encodeURIComponent(file.id)}/download`, { credentials: 'same-origin' });
      if (!response.ok) {
        const info = await response.json().catch(() => null);
        throw new Error(info?.error?.message ?? 'Não foi possível baixar o arquivo.');
      }
      const url = URL.createObjectURL(await response.blob());
      const link = h('a', { href: url, download: file.name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast(err.message, 'danger');
    } finally {
      trigger.disabled = false;
    }
  }

  async function remove(file) {
    const ok = await confirmDialog({ title: 'Excluir arquivo', message: `Excluir "${file.name}"? Ele deixa de estar disponível para toda a equipe.`, confirmLabel: 'Excluir', danger: true });
    if (!ok) return;
    try {
      await del(`/files/${file.id}`);
      toast('Arquivo excluído.');
      await reload();
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  // ---------- área de envio ----------
  const input = h('input', { type: 'file', multiple: true, accept: accepted.join(','), class: 'visually-hidden', tabindex: -1, 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    const list = [...input.files];
    input.value = '';
    sendAll(list);
  });
  const zone = h(
    'div',
    { class: 'files__drop', role: 'button', tabindex: 0, 'aria-label': 'Enviar arquivos: arraste aqui ou pressione Enter para escolher' },
    h('strong', null, 'Arraste os arquivos aqui'),
    h('span', { class: 'muted' }, `ou clique para escolher · ${accepted.join(' ')} · até ${formatBytes(limits.maxFileBytes)} cada`),
  );
  const pick = () => { if (!busy) input.click(); };
  zone.addEventListener('click', pick);
  zone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  ['dragenter', 'dragover'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((type) => zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('is-over'); }));
  zone.addEventListener('drop', (e) => sendAll([...(e.dataTransfer?.files ?? [])]));

  // ---------- lista ----------
  function draw() {
    summary.textContent = `${plural(state.files.length, 'arquivo', 'arquivos')} · ${formatBytes(state.usage.bytes)} de ${formatBytes(limits.maxTotalBytes)}`;
    zone.classList.toggle('is-disabled', busy || !data.enabled);
    if (!state.files.length) {
      setChildren(body, h('div', { class: 'card' }, emptyState({ title: 'Nenhum arquivo ainda', text: 'Envie aqui os arquivos que a equipe precisa (por exemplo, os logins). Todos com acesso a Contas TikTok conseguem baixar.' })));
      return;
    }
    setChildren(
      body,
      h(
        'div',
        { class: 'card table-wrap' },
        h(
          'table',
          { class: 'table table--stack' },
          h('thead', null, h('tr', null, ['Arquivo', 'Tamanho', 'Enviado por', 'Em', 'Ações'].map((t) => h('th', { scope: 'col' }, t)))),
          h(
            'tbody',
            null,
            state.files.map((f) =>
              h(
                'tr',
                null,
                h('td', { 'data-label': 'Arquivo' }, h('span', { class: 'cell-strong files__name' }, f.name), ' ', badge(f.ext.toUpperCase(), 'neutral')),
                h('td', { class: 'muted', 'data-label': 'Tamanho' }, formatBytes(f.size)),
                h('td', { 'data-label': 'Enviado por' }, f.uploadedBy ?? h('span', { class: 'muted' }, 'Ex-colaborador')),
                h('td', { class: 'muted', 'data-label': 'Em' }, formatDate(f.createdAt)),
                h('td', { 'data-label': 'Ações' }, h('div', { class: 'team__actions' }, button('Baixar', { small: true, ariaLabel: `Baixar ${f.name}`, onClick: (e) => download(f, e.currentTarget) }), button('Excluir', { small: true, variant: 'danger-ghost', ariaLabel: `Excluir ${f.name}`, onClick: () => remove(f) }))),
              ),
            ),
          ),
        ),
      ),
    );
  }
  draw();

  return {
    element: hubLayout({
      active: '/business-centers/files',
      subtitle: 'Anexe arquivos para a equipe, como os arquivos de logins. Ficam criptografados e só quem tem acesso a Contas TikTok os vê.',
      summary,
      notice: data.enabled ? null : alertBox('Os anexos estão desligados: o servidor ainda não tem a TOKEN_ENCRYPTION_KEY configurada. Peça ao administrador.', 'warning'),
      children: [
        input,
        zone,
        queue,
        h('p', { class: 'hub__note' }, 'Dica: para senhas, um gerenciador de senhas é mais seguro. Aqui o arquivo fica criptografado, mas qualquer pessoa com acesso a Contas TikTok pode baixá-lo.'),
        body,
      ],
    }),
  };
}
