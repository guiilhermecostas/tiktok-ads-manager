import { HttpError, notFound } from '../../lib/http-error.js';
import { localParts, previousDate, zonedToUtc } from '../../lib/timezone.js';

const HOUR_MS = 60 * 60 * 1000;
const COLLECT_EVERY_MS = 30 * 60 * 1000; // a cada 30 minutos
const FIRST_RUN_DELAY_MS = 45 * 1000; // depois da subida do servidor
const RETENTION_DAYS = 90;
const ADVERTISER_CONCURRENCY = 3;
const BACKFILL_DAYS = 3; // conta sem histórico: hoje + 2 dias anteriores
const YESTERDAY_UNTIL_HOUR = 4; // até as 4h (hora da conta) a coleta também reconfere o dia anterior (dados que fecham tarde)
export const REPORT_HOURS = [24, 48, 168];
const MAX_FUTURE_MS = 2 * HOUR_MS; // linhas "do futuro" (relógio da conta adiantado/lixo) são descartadas

/**
 * Gasto POR HORA das contas de anúncio.
 *  - Coleta: a cada 30 minutos pede ao TikTok o relatório por hora do dia atual de cada conta (e o do dia anterior logo depois da
 *    meia-noite; contas novas recebem uma carga inicial) e guarda no banco. A hora em andamento é regravada a cada coleta.
 *  - Leitura: série contínua por moeda, com os totais e o pico, para o gráfico da aba Relatórios → Por hora.
 * Falha de uma conta nunca interrompe as outras; token revogado marca a conexão com erro (o serviço do TikTok faz isso).
 */
export function createHourlyService({ tiktok, connections, repo, ledger = null, statusLog = null, reconcileDays = 3, log = console, now = () => new Date(), intervalMs = COLLECT_EVERY_MS, pauseMs = 200 }) {
  let running = false;
  const loaded = new Set(); // contas que já tiveram a carga inicial neste processo (conta parada, sem nenhuma linha, não repete a carga a cada ciclo)
  const reconciled = new Set(); // `conexão:conta:dia` já reconferidos hoje (cobrança: recupera horas perdidas se o servidor ficou fora do ar)
  let timer = null;
  let firstTimer = null;
  const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

  /** Dias (YYYY-MM-DD no fuso da conta) a consultar para esta conta agora. */
  function datesFor(advertiser, hasHistory, reconcile = false) {
    const local = localParts(now(), advertiser.timezone);
    const dates = [local.date];
    if (!hasHistory) for (let back = 1; back < BACKFILL_DAYS; back += 1) dates.unshift(previousDate(local.date, back));
    else if (local.hour < YESTERDAY_UNTIL_HOUR) dates.unshift(previousDate(local.date));
    // Uma vez por dia por conta, reconfere os últimos dias: o gasto guardado para a cobrança não pode ficar com buracos.
    if (reconcile) for (let back = 1; back <= reconcileDays; back += 1) if (!dates.includes(previousDate(local.date, back))) dates.unshift(previousDate(local.date, back));
    return dates.sort();
  }

  /** Linhas do TikTok -> linhas do banco (hora em UTC). Descarta o que não converte ou está no futuro. */
  function toRows(rawHours, timezone) {
    const limit = now().getTime() + MAX_FUTURE_MS;
    return rawHours
      .map((r) => ({ hourStart: zonedToUtc(r.hourLocal, timezone), spend: r.spend, impressions: r.impressions, clicks: r.clicks, conversions: r.conversions }))
      .filter((r) => r.hourStart && r.hourStart.getTime() <= limit);
  }

  /** Coleta uma conexão. Devolve { advertisers, rows, failed }. Erro de token propaga (a conexão já foi marcada com erro). */
  async function collectConnection(connection) {
    const withData = await repo.advertisersWithData(connection.id);
    const stats = { advertisers: connection.advertisers.length, rows: 0, failed: 0 };
    let stop = false;
    await tiktok.withToken(connection.id, async (token, api) => {
      for (let i = 0; i < connection.advertisers.length && !stop; i += ADVERTISER_CONCURRENCY) {
        const batch = connection.advertisers.slice(i, i + ADVERTISER_CONCURRENCY);
        const results = await Promise.allSettled(
          batch.map(async (advertiser) => {
            let written = 0;
            const key = `${connection.id}:${advertiser.id}`;
            const reconcileKey = `${key}:${localParts(now(), advertiser.timezone).date}`;
            for (const date of datesFor(advertiser, withData.has(advertiser.id) || loaded.has(key), reconcileDays > 0 && !reconciled.has(reconcileKey))) {
              const fetched = await api.getHourlyReport(token, advertiser.id, date);
              const rows = toRows(fetched, advertiser.timezone);
              written += await repo.upsertHours(connection.id, advertiser.id, advertiser.currency, rows);
              // Livro permanente do gasto (assinaturas): não some quando a BC é removida.
              if (ledger) await ledger.recordSpend(connection.ownerId, advertiser.id, advertiser.currency, rows);
            }
            if (reconcileDays > 0) reconciled.add(reconcileKey);
            loaded.add(key);
            return written;
          }),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') {
            stats.rows += result.value;
            continue;
          }
          stats.failed += 1;
          const err = result.reason;
          if (err instanceof HttpError && err.code === 'tiktok_reauth') throw err; // token caiu: para esta conexão
          if (err instanceof HttpError && err.code === 'tiktok_rate_limited') stop = true; // limite do TikTok: tenta no próximo ciclo
          log.warn?.(`[por hora] conta falhou: ${err?.code ?? 'erro'}`); // nunca registra token nem dados da conta
        }
        await sleep(pauseMs);
      }
      // Situação das contas (conta caiu? foi punida?): UMA chamada por até 100 contas; falhar aqui nunca atrapalha a coleta do gasto.
      if (statusLog && !stop) {
        try {
          await statusLog.record(connection.ownerId, await api.getAdvertiserStatuses(token, connection.advertisers.map((a) => a.id)), now());
        } catch (err) {
          if (err instanceof HttpError && err.code === 'tiktok_reauth') throw err;
          log.warn?.(`[por hora] situação das contas não lida: ${err?.code ?? 'erro'}`);
        }
      }
    });
    return stats;
  }

  async function collect(list) {
    if (running) return { skipped: true, connections: 0, advertisers: 0, rows: 0, failed: 0 };
    running = true;
    const summary = { skipped: false, connections: 0, advertisers: 0, rows: 0, failed: 0 };
    try {
      for (const connection of list) {
        try {
          const stats = await collectConnection(connection);
          summary.connections += 1;
          summary.advertisers += stats.advertisers;
          summary.rows += stats.rows;
          summary.failed += stats.failed;
        } catch (err) {
          summary.failed += connection.advertisers.length;
          log.warn?.(`[por hora] conexão ${connection.id} não coletada: ${err?.code ?? err?.message ?? 'erro'}`);
        }
      }
    } finally {
      running = false;
    }
    return summary;
  }

  /** Um ciclo completo de todas as conexões ativas + limpeza do histórico antigo. Nunca lança (roda sozinho em segundo plano). */
  async function collectAll() {
    try {
      const summary = await collect(await connections.listCollectable());
      if (!summary.skipped) await repo.purgeOlderThan(RETENTION_DAYS);
      if (summary.rows || summary.failed) log.info?.(`[por hora] coleta: ${summary.rows} linhas de ${summary.advertisers} contas (${summary.failed} falhas)`);
      return summary;
    } catch (err) {
      log.error?.('[por hora] falha na coleta:', err?.code ?? err?.message);
      return { skipped: false, connections: 0, advertisers: 0, rows: 0, failed: 0, error: true };
    }
  }

  /** Coleta AGORA uma conexão (usado antes de removê-la, para o último gasto entrar no livro). Se já há coleta rodando, não faz nada. */
  async function collectNow(connectionId, ownerId) {
    const list = (await connections.listCollectable({ ownerId })).filter((c) => c.id === connectionId);
    if (list.length) await collect(list);
  }

  /** Série contínua por hora, por moeda, das contas visíveis a `actor`. */
  async function report(actor, { hours = 24, advertiserId = null } = {}) {
    const all = await connections.advertisers(actor.id);
    if (advertiserId && !all.some((a) => a.id === advertiserId)) throw notFound('Conta de anúncio não encontrada.');
    const currentHour = Math.floor(now().getTime() / HOUR_MS) * HOUR_MS;
    const since = new Date(currentHour - (hours - 1) * HOUR_MS);
    const { rows, firstHour, lastFetchedAt } = await repo.series(actor.id, { since, advertiserId });

    // Começa na primeira hora COM dado (antes disso o sistema ainda não coletava: mostrar zero seria mentira).
    const start = firstHour ? Math.max(since.getTime(), Math.floor(firstHour.getTime() / HOUR_MS) * HOUR_MS) : currentHour;
    const byCurrency = new Map();
    for (const r of rows) {
      const map = byCurrency.get(r.currency) ?? new Map();
      map.set(r.hour.getTime(), r);
      byCurrency.set(r.currency, map);
    }
    const groups = [...byCurrency.entries()].map(([currency, map]) => {
      const points = [];
      const totals = { spend: 0, impressions: 0, clicks: 0, conversions: 0 };
      let peak = null;
      let activeHours = 0;
      for (let t = start; t <= currentHour; t += HOUR_MS) {
        const row = map.get(t);
        const point = { hour: new Date(t).toISOString(), spend: row?.spend ?? 0, impressions: row?.impressions ?? 0, clicks: row?.clicks ?? 0, conversions: row?.conversions ?? 0 };
        points.push(point);
        for (const key of Object.keys(totals)) totals[key] += point[key];
        if (point.spend > 0) activeHours += 1;
        if (point.spend > 0 && (!peak || point.spend > peak.spend)) peak = { hour: point.hour, spend: point.spend };
      }
      return { currency, points, totals, peak, activeHours, hoursCovered: points.length };
    }).sort((a, b) => b.totals.spend - a.totals.spend);

    return {
      hours,
      from: new Date(start).toISOString(),
      to: new Date(currentHour).toISOString(),
      collectedSince: firstHour ? firstHour.toISOString() : null,
      lastCollectedAt: lastFetchedAt ? lastFetchedAt.toISOString() : null,
      everyMinutes: Math.round(intervalMs / 60_000),
      totalAdvertisers: all.length,
      accountOptions: all.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
      groups,
    };
  }

  /** "Atualizar agora": coleta só as conexões do próprio usuário (dono do espaço). 409 se já houver uma coleta em andamento. */
  async function refresh(actor) {
    if (running) throw new HttpError(409, 'Uma coleta já está em andamento. Aguarde alguns instantes e atualize a tela.', 'collect_in_progress');
    const summary = await collect(await connections.listCollectable({ ownerId: actor.id }));
    if (summary.skipped) throw new HttpError(409, 'Uma coleta já está em andamento. Aguarde alguns instantes e atualize a tela.', 'collect_in_progress');
    return { connections: summary.connections, advertisers: summary.advertisers, rows: summary.rows, failed: summary.failed };
  }

  return {
    collectAll,
    collectNow,
    refresh,
    report,
    /** Liga a coleta automática (a cada 30 min; a primeira logo após a subida). Chamado só pelo servidor, nunca pelos testes. */
    start() {
      if (timer) return;
      firstTimer = setTimeout(collectAll, FIRST_RUN_DELAY_MS);
      firstTimer.unref();
      timer = setInterval(collectAll, intervalMs);
      timer.unref();
    },
    stop() {
      clearTimeout(firstTimer);
      clearInterval(timer);
      timer = null;
      firstTimer = null;
    },
  };
}
