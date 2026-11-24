import { get } from '../../api.js';
import { toast } from '../../ui.js';

const BUSY_POLL_MS = 4000; // enquanto algo está gerando/juntando
const IDLE_POLL_MS = 30_000; // sem nada em andamento: só confere de vez em quando (outra aba ou outro aparelho pode ter começado algo)

const isBusy = (hook) => ['queued', 'generating', 'processing'].includes(hook.status) || hook.applying;

/**
 * Acompanha o Hook com IA FORA do pop-up: o trabalho roda no servidor (fechar a janela, o site ou o navegador não o interrompe), então a tela
 * só precisa perguntar a situação. Serve para a bolinha piscando no botão "Hook com IA" e para avisar quando algo termina com o pop-up fechado.
 *  - onBusy(boolean): há algo gerando ou juntando agora?
 *  - onApplied(): uma junção terminou e o vídeo novo está na biblioteca (a tela recarrega a lista)
 *  - pause()/resume(): o pop-up aberto faz o próprio acompanhamento e os próprios avisos; ao fechar, `resume()` só recomeça a partir do estado atual
 */
export function createHookActivity({ onBusy, onApplied }) {
  let timer = null;
  let stopped = false;
  let paused = false;
  let known = null; // id -> { applying, status } do último estado visto (null = ainda sem base para comparar)
  let request = 0;

  const schedule = (ms) => {
    clearTimeout(timer);
    if (!stopped && !paused) timer = setTimeout(check, ms);
  };

  async function check({ silent = false } = {}) {
    const ticket = ++request;
    let data;
    try {
      data = await get('/hooks');
    } catch {
      schedule(IDLE_POLL_MS); // falha momentânea de rede: tenta de novo mais tarde, sem barulho
      return;
    }
    if (stopped || paused || ticket !== request) return;
    if (!data.enabled) {
      onBusy(false);
      return; // recurso desligado no servidor: não há o que acompanhar
    }
    const now = new Map(data.hooks.map((hook) => [hook.id, hook]));
    if (known && !silent) {
      for (const [id, hook] of now) {
        const before = known.get(id);
        if (!before) continue;
        if (before.applying && !hook.applying) {
          if (hook.applyError) toast(hook.applyError, 'danger');
          else if (hook.creativeId) {
            toast('Pronto! O vídeo com o hook já está na sua biblioteca.');
            onApplied?.();
          }
        } else if (before.status !== hook.status && ['queued', 'generating', 'processing'].includes(before.status)) {
          if (hook.status === 'ready') toast('Um hook ficou pronto. Abra "Hook com IA" para usar.');
          else if (hook.status === 'failed') toast(hook.errorMessage ?? 'Não foi possível gerar um hook.', 'danger');
        }
      }
    }
    known = new Map([...now].map(([id, hook]) => [id, { applying: hook.applying, status: hook.status }]));
    const busy = data.hooks.some(isBusy);
    onBusy(busy);
    schedule(busy ? BUSY_POLL_MS : IDLE_POLL_MS);
  }

  return {
    start: () => check({ silent: true }),
    /** Chame ao criar ou aplicar um hook: passa a olhar de perto na hora, sem esperar o próximo ciclo. */
    nudge: () => check({ silent: true }),
    pause() {
      paused = true;
      request += 1;
      clearTimeout(timer);
    },
    resume() {
      paused = false;
      known = null; // o pop-up já avisou do que terminou enquanto esteve aberto
      return check({ silent: true });
    },
    stop() {
      stopped = true;
      request += 1;
      clearTimeout(timer);
    },
  };
}
