import { canClose, chargeFor, monthOf, monthStartDate, monthsBetween, nextMonth } from '../../../shared/billing.js';
import { HttpError, notFound } from '../../lib/http-error.js';

const CLOSE_EVERY_MS = 60 * 60 * 1000; // confere o fechamento dos meses a cada hora
const LOCK_MESSAGE = 'Esta Business Center (ou uma das contas de anúncio dela) pertence a uma conta com pendências financeiras e não pode ser conectada agora. Fale com o suporte para regularizar.';

/**
 * Assinaturas, tudo em DÓLAR (centavos inteiros):
 *  - cada pessoa tem o próprio plano (mensalidade + % do gasto), com início num mês; o plano de um mês é o mais recente que já valia nele;
 *  - o gasto vem do gasto por hora guardado em `spend_ledger` (que NÃO depende da conexão da BC: remover a BC não apaga nem diminui nada);
 *  - o mês fecha uma vez, 2 dias depois de acabar (plano e cotações daquele momento ficam guardados); o mês em andamento é calculado ao vivo;
 *  - saldo = tudo que foi cobrado (meses fechados + o em andamento) menos tudo que foi pago; débito = saldo positivo;
 *  - remover uma BC com débito bloqueia a BC e as contas dela para OUTRAS pessoas até a dívida zerar (ou o admin liberar).
 */
export function createBillingService({ repo, users, log = console, now = () => new Date() }) {
  let timer = null;

  const planAt = (plans, period) => plans.filter((p) => p.effectiveMonth <= period).at(-1) ?? null;

  /** Gasto de um mês em centavos de dólar: dólar entra direto; outra moeda só com cotação cadastrada (senão fica em `unconverted`, sem entrar na conta). */
  function toUsdCents(rows, rateByCurrency) {
    let spendCents = 0;
    const unconverted = [];
    for (const row of rows) {
      if (row.currency === 'USD') spendCents += Math.round(row.spend * 100);
      else if (rateByCurrency.has(row.currency)) spendCents += Math.round(row.spend * rateByCurrency.get(row.currency) * 100);
      else unconverted.push({ currency: row.currency, spend: Math.round(row.spend * 100) / 100 });
    }
    return { spendCents, unconverted };
  }

  /** Extrato completo de uma pessoa (nunca lança por falta de plano: devolve vazio). */
  async function summaryOf(userId) {
    const at = now();
    const current = monthOf(at);
    const [plans, statements, payments, rates] = await Promise.all([repo.listPlans(userId), repo.listStatements(userId), repo.listPayments(userId), repo.listRates()]);
    const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    const base = { currentMonth: current, plan: planAt(plans, current), nextPlan: plans.find((p) => p.effectiveMonth > current) ?? null, payments, paidCents };
    if (!plans.length) return { ...base, months: [], chargedCents: 0, balanceCents: -paidCents, debtCents: 0 };

    const first = plans[0].effectiveMonth;
    const months = monthsBetween(first, current);
    const spendRows = await repo.spendByMonth(userId, monthStartDate(first), monthStartDate(nextMonth(current)));
    const rateByCurrency = new Map(rates.map((r) => [r.currency, r.usdPerUnit]));
    const stored = new Map(statements.map((s) => [s.period, s]));
    const entries = months.map((period) => {
      const saved = stored.get(period);
      if (saved) return { period, closed: true, closable: false, ...saved };
      const plan = planAt(plans, period);
      const { spendCents, unconverted } = toUsdCents(spendRows.filter((r) => r.month === period), rateByCurrency);
      const { percentFeeCents, totalCents } = chargeFor({ spendCents, monthlyFeeCents: plan.monthlyFeeCents, percentBp: plan.percentBp });
      return { period, closed: false, closable: canClose(period, at), monthlyFeeCents: plan.monthlyFeeCents, percentBp: plan.percentBp, spendCents, percentFeeCents, totalCents, unconverted };
    }).reverse(); // do mais novo para o mais antigo
    const chargedCents = entries.reduce((sum, e) => sum + e.totalCents, 0);
    const balanceCents = chargedCents - paidCents;
    return { ...base, months: entries, chargedCents, balanceCents, debtCents: Math.max(0, balanceCents) };
  }

  /** Fecha os meses vencidos de todas as pessoas com plano (idempotente: um mês nunca é fechado duas vezes). */
  async function closeDueMonths() {
    let closed = 0;
    for (const userId of await repo.usersWithPlans()) {
      const { months } = await summaryOf(userId);
      for (const e of months) {
        if (e.closed || !e.closable) continue;
        const created = await repo.insertStatement({ userId, period: e.period, monthlyFeeCents: e.monthlyFeeCents, percentBp: e.percentBp, spendCents: e.spendCents, percentFeeCents: e.percentFeeCents, totalCents: e.totalCents, unconverted: e.unconverted });
        if (created) closed += 1;
      }
    }
    return closed;
  }

  /** Dívida zerada: os bloqueios daquela pessoa caem sozinhos. */
  async function settleLocks(userId) {
    const { debtCents } = await summaryOf(userId);
    if (debtCents > 0) return 0;
    const ids = (await repo.listActiveLocks()).filter((l) => l.ownerId === userId).map((l) => l.id);
    return repo.release(ids, { reason: 'paid' });
  }

  const requirePerson = async (userId) => {
    const user = await users.findById(userId);
    if (!user || user.role === 'admin') throw notFound('Usuário não encontrado.');
    return user;
  };

  const service = {
    summaryOf,
    closeDueMonths,

    /** Extrato da própria pessoa (tela "Plano e cobrança"). */
    async mine(userId) {
      return summaryOf(userId);
    },

    /** Visão do admin: cada pessoa com o plano, o mês em andamento e o que está em aberto. */
    async overview() {
      const people = (await users.list()).filter((u) => u.role !== 'admin' && ['approved', 'blocked'].includes(u.status));
      const locks = await repo.countActiveLocksByOwner();
      const rows = [];
      for (const person of people) {
        const s = await summaryOf(person.id);
        let month = s.months.find((m) => m.period === s.currentMonth) ?? null;
        // Sem plano nada é cobrado, mas o admin vê o gasto do mês (ajuda a decidir o plano).
        if (!month) {
          const start = monthStartDate(s.currentMonth);
          const usd = toUsdCents(await repo.spendByMonth(person.id, start, monthStartDate(nextMonth(s.currentMonth))), new Map((await repo.listRates()).map((r) => [r.currency, r.usdPerUnit])));
          month = { spendCents: usd.spendCents, totalCents: 0, unconverted: usd.unconverted };
        }
        rows.push({
          id: person.id, name: person.name, email: person.email, status: person.status,
          plan: s.plan, nextPlan: s.nextPlan,
          monthSpendCents: month.spendCents, monthChargeCents: month.totalCents, unconverted: month.unconverted,
          balanceCents: s.balanceCents, debtCents: s.debtCents, locks: locks.get(person.id) ?? 0,
        });
      }
      const totals = {
        billed: rows.filter((r) => r.plan).length,
        monthChargeCents: rows.reduce((sum, r) => sum + r.monthChargeCents, 0),
        debtCents: rows.reduce((sum, r) => sum + r.debtCents, 0),
        locks: rows.reduce((sum, r) => sum + r.locks, 0),
      };
      return { users: rows, totals, rates: await repo.listRates(), currentMonth: monthOf(now()) };
    },

    async userDetail(userId) {
      const user = await requirePerson(userId);
      return { user: { id: user.id, name: user.name, email: user.email, status: user.status }, ...(await summaryOf(userId)) };
    },

    /** Define o plano: "este mês" (vale o mês inteiro) ou "próximo mês". */
    async setPlan(adminId, userId, { monthlyFeeCents, percentBp, effective, note }) {
      const user = await requirePerson(userId);
      const current = monthOf(now());
      const effectiveMonth = effective === 'next' ? nextMonth(current) : current;
      await repo.setPlan({ userId, monthlyFeeCents, percentBp, effectiveMonth, note, createdBy: adminId });
      return { user, effectiveMonth };
    },

    async addPayment(adminId, userId, { amountCents, paidAt, note }) {
      const user = await requirePerson(userId);
      const id = await repo.addPayment({ userId, amountCents, paidAt, note, registeredBy: adminId });
      const released = await settleLocks(userId);
      return { id, user, released };
    },

    listLocks: () => repo.listActiveLocks(),

    async releaseLock(adminId, lockId) {
      const lock = await repo.getLock(lockId);
      if (!lock) throw notFound('Bloqueio não encontrado.');
      if (lock.released) throw new HttpError(409, 'Este bloqueio já foi liberado.', 'conflict');
      await repo.release([lock.id], { by: adminId, reason: 'admin' });
      return lock;
    },

    setRate: (currency, usdPerUnit, adminId) => repo.setRate(currency, usdPerUnit, adminId),
    listRates: () => repo.listRates(),

    /** Converte gastos por moeda ({ currency, spend }) em dólar com as cotações atuais; moeda sem cotação volta em `unconverted`. */
    async toUsd(rows) {
      const rates = new Map((await repo.listRates()).map((r) => [r.currency, r.usdPerUnit]));
      return toUsdCents(rows, rates);
    },

    /** Gasto vitalício guardado no livro permanente, já em dólar. */
    async lifetimeSpend(ownerId) {
      const [rows, rates] = await Promise.all([repo.spendTotals(ownerId), repo.listRates()]);
      return toUsdCents(rows, new Map(rates.map((r) => [r.currency, r.usdPerUnit])));
    },

    // ---------- ganchos usados pela integração com o TikTok ----------
    /**
     * Chamado ANTES de remover uma conexão: se a dona tem débito, bloqueia a BC e as contas dela para outras pessoas.
     * `ids`: { bcIds, advertiserIds } da conexão. Falha fechada: se não der para gravar o bloqueio, o erro sobe e a remoção NÃO acontece.
     */
    async onRemoving(ownerId, { bcIds, advertiserIds }) {
      const { debtCents } = await summaryOf(ownerId);
      if (debtCents <= 0) return { locked: 0, debtCents };
      const items = [...new Set(bcIds)].map((value) => ({ kind: 'bc', value })).concat([...new Set(advertiserIds)].map((value) => ({ kind: 'advertiser', value })));
      const locked = await repo.createLocks(ownerId, items, debtCents);
      log.info?.(`[assinaturas] conexão removida com débito: ${locked} bloqueio(s) criado(s)`); // sem nomes, IDs nem valores no log
      return { locked, debtCents };
    },

    /**
     * Chamado ANTES de conectar uma BC/contas: recusa (409 `billing_locked`) se alguma delas está bloqueada por débito de OUTRA pessoa.
     * Bloqueios da própria pessoa caem ao reconectar; os de quem já quitou a dívida caem sozinhos.
     */
    async assertConnectable(userId, { bcIds = [], advertiserIds = [] }) {
      const hits = await repo.findActiveMatching({ bcIds: [...new Set(bcIds.filter(Boolean))], advertiserIds: [...new Set(advertiserIds.filter(Boolean))] });
      if (!hits.length) return;
      const own = hits.filter((h) => h.ownerId === userId).map((h) => h.id);
      if (own.length) await repo.release(own, { reason: 'owner_reconnected' });
      const others = hits.filter((h) => h.ownerId !== userId);
      let blocked = false;
      for (const ownerId of new Set(others.map((h) => h.ownerId))) {
        const { debtCents } = await summaryOf(ownerId);
        if (debtCents > 0) blocked = true;
        else await repo.release(others.filter((h) => h.ownerId === ownerId).map((h) => h.id), { reason: 'paid' });
      }
      if (blocked) throw new HttpError(409, LOCK_MESSAGE, 'billing_locked');
    },

    /** Fecha os meses vencidos a cada hora (ligado só pelo servidor, nunca pelos testes). */
    start() {
      if (timer) return;
      const run = () => closeDueMonths().then((n) => { if (n) log.info?.(`[assinaturas] ${n} mês(es) fechado(s)`); }).catch((err) => log.error?.('[assinaturas] falha ao fechar meses:', err?.code ?? err?.message));
      run();
      timer = setInterval(run, CLOSE_EVERY_MS);
      timer.unref();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
  return service;
}
