import { findField } from '/shared/campaign-spec.js';
import { post } from '../../api.js';

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
 * Publica a campanha nas contas escolhidas, UMA de cada vez: cada conta tem progresso, erro e retomada próprios, e a falha de uma não impede as outras.
 * `targets` é o painel "Publicar em" (mostra o andamento de cada conta). Devolve { succeeded: [ids], failed: número }.
 * Se a sessão cair (401) para: o resto falharia do mesmo jeito.
 */
export async function publishToAccounts({ campaignId, ids, targets }) {
  const succeeded = [];
  let failed = 0;
  for (const id of ids) {
    targets.setResult(id, { state: 'running' });
    try {
      const overrides = targets.overridesFor(id);
      await post(`/campaigns/${campaignId}/publish`, { confirm: true, advertiserId: id, ...(Object.keys(overrides).length ? { overrides } : {}) });
      targets.setResult(id, { state: 'done' });
      succeeded.push(id);
    } catch (err) {
      failed += 1;
      targets.setResult(id, { state: 'failed', message: failureMessage(err) });
      if (err.status === 401) break;
    }
  }
  return { succeeded, failed };
}
