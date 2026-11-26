import { uploadFile } from '../../api.js';
import { h } from '../../dom.js';
import { formatBytes } from '../../format.js';
import { button, toast } from '../../ui.js';

/** Tipos aceitos (o servidor confere o CONTEÚDO de verdade; aqui é só para avisar cedo). */
export const ACCEPT = 'image/jpeg,image/png,video/mp4,video/quicktime,.jpg,.jpeg,.png,.mp4,.mov';
const KIND_BY_TYPE = { 'image/jpeg': 'image', 'image/png': 'image', 'video/mp4': 'video', 'video/quicktime': 'video' };
const MAX_PARALLEL = 2;
/** O servidor limita quantos envios por minuto: ao receber "espere" (429), o arquivo volta para a fila e tenta de novo (até 3 vezes). */
const MAX_RETRIES = 3;
const DEFAULT_RETRY_SECONDS = 10;
const MAX_RETRY_SECONDS = 60;

/** Mensagem curta para o tamanho máximo, ex.: "10 MB". */
const limitText = (bytes) => formatBytes(bytes);

/** Confere tipo e tamanho antes de gastar banda. Retorna a mensagem de erro ou null. */
function validate(file, limits) {
  const kind = KIND_BY_TYPE[file.type];
  if (!kind) return 'Tipo não suportado. Use JPG, PNG, MP4 ou MOV.';
  if (file.size === 0) return 'O arquivo está vazio.';
  const max = kind === 'video' ? limits.maxVideoBytes : limits.maxImageBytes;
  if (max && file.size > max) return `Arquivo maior que o limite de ${limitText(max)} para ${kind === 'video' ? 'vídeos' : 'imagens'}.`;
  return null;
}

/**
 * Fila de envios com barra de progresso (até 2 em paralelo).
 * `getLimits()` devolve os limites atuais; `onUploaded(creative)` é chamado a cada envio concluído;
 * `getFolderId()` (opcional) devolve a pasta padrão dos arquivos (ou null = sem pasta).
 * `add(files, { folderId, folderLabel })` envia para uma pasta ESCOLHIDA NA HORA de soltar/escolher (não muda se a pessoa trocar de pasta
 * enquanto o arquivo espera na fila); sem opções, usa a pasta padrão. `folderLabel` aparece na fila ("→ Oferta X").
 * Retorna { element, add(files, options), pending() }.
 */
export function createUploader({ getLimits, onUploaded, getFolderId = () => null }) {
  const list = h('ul', { class: 'uploads__list' });
  const panel = h('div', { class: 'uploads', hidden: true, 'aria-live': 'polite' }, list);
  const queue = [];
  let running = 0;

  const refreshVisibility = () => {
    panel.hidden = list.children.length === 0;
  };

  function makeItem(file, folderLabel) {
    const bar = h('div', { class: 'progress__bar' });
    const status = h('span', { class: 'uploads__status' }, 'Na fila');
    const cancel = h('button', { type: 'button', class: 'link-btn' }, 'Cancelar');
    const li = h(
      'li',
      { class: 'uploads__item' },
      h('div', { class: 'uploads__row' }, h('span', { class: 'uploads__name', title: file.name }, file.name), h('span', { class: 'muted' }, formatBytes(file.size)), folderLabel ? h('span', { class: 'uploads__dest muted', title: `Destino: ${folderLabel}` }, `→ ${folderLabel}`) : null, status, cancel),
      h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': `Envio de ${file.name}` }, bar),
    );
    return { li, bar, status, cancel };
  }

  function finish(item, ok, message) {
    item.cancel.remove();
    if (!ok) item.li.querySelector('.progress')?.remove(); // erro: a barra não faz mais sentido
    item.li.classList.add(ok ? 'is-done' : 'is-error');
    item.status.textContent = message;
    if (ok) setTimeout(() => { item.li.remove(); refreshVisibility(); }, 4000);
    else item.li.append(h('button', { type: 'button', class: 'link-btn', onClick: () => { item.li.remove(); refreshVisibility(); } }, 'Dispensar'));
  }

  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const entry = queue.shift();
      const { file, item, folderId } = entry;
      running += 1;
      item.status.textContent = 'Enviando…';
      item.bar.style.width = '0%';
      const upload = uploadFile(`/creatives?filename=${encodeURIComponent(file.name)}${folderId === null ? '' : `&folderId=${folderId}`}`, file, {
        onProgress: (fraction) => {
          const percent = Math.round(fraction * 100);
          item.bar.style.width = `${percent}%`;
          item.status.textContent = `Enviando… ${percent}%`;
        },
      });
      item.cancel.onclick = () => {
        entry.cancelled = true;
        clearTimeout(entry.retryTimer);
        upload.abort();
        if (entry.waiting) {
          entry.waiting = false;
          finish(item, false, 'Cancelado');
        }
      };
      upload.promise
        .then(({ creative }) => {
          item.bar.style.width = '100%';
          finish(item, true, 'Concluído');
          onUploaded(creative);
        })
        .catch((err) => {
          if (err.status === 429 && !entry.cancelled && (entry.attempts ?? 0) < MAX_RETRIES) return retryLater(entry, err.retryAfterSec);
          return finish(item, false, err.code === 'aborted' ? 'Cancelado' : err.message);
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  /** O servidor pediu para esperar: mostra o aviso e põe o arquivo de volta na fila depois do tempo indicado. */
  function retryLater(entry, retryAfterSec) {
    entry.attempts = (entry.attempts ?? 0) + 1;
    entry.waiting = true;
    const seconds = Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(retryAfterSec ?? DEFAULT_RETRY_SECONDS)));
    entry.item.status.textContent = `Muitos envios seguidos: tentando de novo em ${seconds}s…`;
    entry.item.bar.style.width = '0%';
    entry.retryTimer = setTimeout(() => {
      if (entry.cancelled) return;
      entry.waiting = false;
      queue.push(entry);
      pump();
    }, seconds * 1000);
  }

  return {
    element: panel,
    pending: () => running + queue.length,
    add(files, { folderId = getFolderId(), folderLabel = null } = {}) {
      const limits = getLimits();
      let accepted = 0;
      for (const file of files) {
        const item = makeItem(file, folderLabel);
        list.append(item.li);
        const problem = validate(file, limits);
        if (problem) {
          item.bar.parentElement.remove();
          finish(item, false, problem);
          continue;
        }
        queue.push({ file, item, folderId });
        accepted += 1;
      }
      refreshVisibility();
      if (!accepted && files.length) toast('Nenhum arquivo válido para enviar.', 'danger');
      pump();
    },
  };
}

/** Botão "Enviar arquivos" com seletor de arquivos escondido. */
export function uploadButton(uploader, { label = 'Enviar arquivos', variant = 'primary' } = {}) {
  const input = h('input', { type: 'file', accept: ACCEPT, multiple: true, class: 'visually-hidden', tabindex: '-1', 'aria-hidden': 'true' });
  input.addEventListener('change', () => {
    uploader.add([...input.files]);
    input.value = '';
  });
  const trigger = button(label, { variant, onClick: () => input.click() });
  return h('span', null, trigger, input);
}
