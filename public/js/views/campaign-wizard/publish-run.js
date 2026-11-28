import { findField } from '/shared/campaign-spec.js';
import { doneLabel, renamedNotice } from '/shared/publish-messages.js';
import { post } from '../../api.js';

export { renamedNotice };

const MAX_RATE_WAITS = 6; // quantas vezes espera o limite de pedidos liberar antes de desistir
const MAX_WAIT_SEC = 70;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Mensagem curta de uma falha de publicação numa conta (inclui os campos inválidos, se houver). */
export function failureMessage(err) {
  if (Array.isArray(err.details) && err.details.length) {
    const parts = err.details.slice(0, 3).map((d) => {
      const [section, key] = String(d.path).split('.');
      return `${findField(section, key)?.label ?? d.path}: ${d.message}`;
    });
    return `Corrija na campanha: ${parts.join(' · ')}`;
  }
  return err.message;
}

/**
 * Faz o pedido e, se o servidor disser "muitos pedidos" (429, o limite por minuto), ESPERA o tempo indicado e tenta de novo (em vez de falhar): publicar muitas campanhas
 * de uma vez passa do limite de propósito. `onWait(segundos)` avisa a tela. Outros erros passam como vieram.
 */
async function postPatient(path, body, onWait) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await post(path, body);
    } catch (err) {
      if (err.status !== 429 || attempt >= MAX_RATE_WAITS) throw err;
      const seconds = Math.min(MAX_WAIT_SEC, Math.max(1, Math.ceil(err.retryAfterSec ?? 10)));
      onWait?.(seconds);
      await sleep(seconds * 1000);
    }
  }
}

/**
 * Publica nas contas escolhidas, UMA conta de cada vez, e em cada conta TODAS as campanhas (`campaignIds`: uma quando é só uma campanha; várias quando a pessoa escolheu
 * "campanhas por conta"). Cada conta tem progresso, erro e retomada próprios e a falha de uma não impede as outras; dentro de uma conta, se uma campanha falha as seguintes
 * não são tentadas (o erro tende a ser o mesmo). Campanha que já foi publicada nesta conta (tentativa anterior) conta como feita. `activate`: publicar já ativa.
 * `targets` é o painel "Publicar em". Devolve { succeeded: [ids das contas 100% publicadas], failed: nº de contas com erro, renamed: [{ id, name }], created: campanhas criadas agora }.
 * Se a sessão cair (401) para: o resto falharia do mesmo jeito.
 */
export async function publishToAccounts({ campaignIds, ids, targets, activate = false }) {
  const total = campaignIds.length;
  const succeeded = [];
  const renamed = []; // contas onde o TikTok já tinha uma campanha com o mesmo nome: o sistema numerou ("Nome (2)")
  let failed = 0;
  let created = 0;
  for (const id of ids) {
    let done = 0;
    let broken = false;
    for (const [index, campaignId] of campaignIds.entries()) {
      const where = total > 1 ? `Campanha ${index + 1} de ${total}` : null;
      targets.setResult(id, { state: 'running', note: where ? `${where}…` : null });
      try {
        const overrides = targets.overridesFor(id);
        const result = await postPatient(
          `/campaigns/${campaignId}/publish`,
          { confirm: true, advertiserId: id, activate, ...(Object.keys(overrides).length ? { overrides } : {}) },
          (seconds) => targets.setResult(id, { state: 'running', note: `${where ? `${where}: ` : ''}aguardando o limite de pedidos do TikTok (${seconds}s)…` }),
        );
        done += 1;
        created += 1;
        if (result.renamedTo) renamed.push({ id, name: result.renamedTo });
      } catch (err) {
        if (err.code === 'already_published') { // publicada numa tentativa anterior: não é erro
          done += 1;
          continue;
        }
        failed += 1;
        broken = true;
        const published = done ? ` (${done} ${done === 1 ? 'já foi publicada' : 'já foram publicadas'} nesta conta)` : '';
        targets.setResult(id, { state: 'failed', message: where ? `${where}: ${failureMessage(err)}${published}. As próximas não foram tentadas nesta conta; ao publicar de novo, as que já existem são puladas.` : failureMessage(err) });
        if (err.status === 401) return { succeeded, failed, renamed, created };
        break;
      }
    }
    if (!broken) {
      targets.setResult(id, { state: 'done', label: doneLabel({ copies: total, activate }) });
      succeeded.push(id);
    }
  }
  return { succeeded, failed, renamed, created };
}
