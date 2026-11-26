import { computeLevel } from '../../../shared/spend-levels.js';

/**
 * Nível de gasto em anúncios do dono do espaço. O número é o MAIOR entre duas fontes, ambas em dólar:
 *  - o relatório oficial do TikTok (gasto vitalício de cada conta de anúncio conectada, em cache curto);
 *  - o livro permanente de gasto por hora (continua valendo mesmo se a BC for removida).
 * Moeda sem cotação cadastrada pelo admin não entra na conta e é avisada em `unconverted`. Se o TikTok estiver fora do ar, vale o livro.
 */
export function createLevelService({ spend, billing, log = console }) {
  /** Gasto vitalício por conta (uma conta de anúncio conectada por duas BCs conta uma vez só), somado por moeda. */
  function totalsByCurrency(accounts) {
    const byAdvertiser = new Map();
    for (const [key, value] of Object.entries(accounts ?? {})) {
      if (!value || value.error || !Number.isFinite(value.spend) || !value.currency) continue;
      const advertiserId = key.slice(key.indexOf(':') + 1);
      const known = byAdvertiser.get(advertiserId);
      if (!known || value.spend > known.spend) byAdvertiser.set(advertiserId, { currency: value.currency, spend: value.spend });
    }
    const totals = new Map();
    for (const { currency, spend: amount } of byAdvertiser.values()) totals.set(currency, (totals.get(currency) ?? 0) + amount);
    return [...totals].map(([currency, amount]) => ({ currency, spend: amount }));
  }

  return {
    async forOwner(actor) {
      const ledger = await billing.lifetimeSpend(actor.id);
      let report = { spendCents: 0, unconverted: [] };
      let partial = false;
      try {
        report = await billing.toUsd(totalsByCurrency((await spend(actor)).accounts));
      } catch (err) {
        partial = true; // TikTok indisponível: o nível sai só do livro e a tela avisa que pode estar desatualizado
        log.warn?.(`[level] relatório de gasto indisponível: ${err.message}`);
      }
      const spendUsd = Math.max(ledger.spendCents, report.spendCents) / 100;
      const unconverted = report.unconverted.length ? report.unconverted : ledger.unconverted;
      const { level, progress, remaining, isMax } = computeLevel(spendUsd);
      return { spendUsd, level: level.n, progress, remaining, isMax, unconverted, partial };
    },
  };
}
