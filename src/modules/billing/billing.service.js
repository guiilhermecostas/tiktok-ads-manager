import { BASE_CURRENCY, INVOICE_MIN_CENTS, allocateInvoices, canClose, canIssueInvoice, chargeFor, convertToBrlCents, dueDateOf, monthOf, monthStartDate, monthsBetween, nextMonth } from '../../../shared/billing.js';
import { HttpError, notFound } from '../../lib/http-error.js';

const CLOSE_EVERY_MS = 60 * 60 * 1000; // confere o fechamento dos meses a cada hora
const LOCK_MESSAGE = 'Esta Business Center (ou uma das contas de anúncio dela) pertence a uma conta com pendências financeiras e não pode ser conectada agora. Fale com o suporte para regularizar.';

/**
 * Assinaturas, tudo em REAL (centavos inteiros):
 *  - cada pessoa tem o próprio plano (mensalidade + % do gasto), com início num mês; o plano de um mês é o mais recente que já valia nele;
 *  - o gasto vem do gasto por hora guardado em `spend_ledger` (que NÃO depende da conexão da BC: remover a BC não apaga nem diminui nada) e pode estar em
 *    qualquer moeda: é CONVERTIDO para real pela cotação (`billing_rates`, atualizada sozinha pelo câmbio e/ou fixada pelo admin). Moeda sem cotação não entra na conta
 *    e é avisada (`unconverted`);
 *  - o mês fecha uma vez, 2 dias depois de acabar (plano, gasto por moeda e cotações daquele momento ficam guardados); o mês em andamento é calculado ao vivo;
 *  - FATURA: quando os meses fechados somam, sem fatura ainda, ao menos o mínimo (R$ 50,00), emite-se uma fatura com esse valor (vence em 5 dias); abaixo disso o valor
 *    passa para a fatura seguinte. Os pagamentos quitam as faturas da mais antiga para a mais nova (a situação de cada fatura é CALCULADA, nunca guardada);
 *  - saldo = tudo que foi cobrado (meses fechados + o em andamento) menos tudo que foi pago; débito = saldo positivo;
 *  - remover uma BC com débito bloqueia a BC e as contas dela para OUTRAS pessoas até a dívida zerar (ou o admin liberar).
 */
export function createBillingService({ repo, users, fx = null, log = console, now = () => new Date() }) {
  let timer = null;
  const paying = new Set(); // pessoas com "marcar fatura como paga" em andamento (instância única): evita pagar a mesma fatura duas vezes

  const planAt = (plans, period) => plans.filter((p) => p.effectiveMonth <= period).at(-1) ?? null;
  const today = () => now().toISOString().slice(0, 10);
  const sum = (list, pick) => list.reduce((total, item) => total + pick(item), 0);
  const ratesMap = async () => new Map((await repo.listRates()).map((r) => [r.currency, r.brlPerUnit]));

  /** Extrato completo de uma pessoa (nunca lança por falta de plano: devolve vazio). Tudo em centavos de real. */
  async function summaryOf(userId) {
    const at = now();
    const current = monthOf(at);
    const [plans, statements, payments, rates, invoiceRows] = await Promise.all([repo.listPlans(userId), repo.listStatements(userId), repo.listPayments(userId), ratesMap(), repo.listInvoices(userId)]);
    const paidCents = sum(payments, (p) => p.amountCents);
    const invoices = allocateInvoices(invoiceRows, paidCents, today());
    const invoicedCents = sum(invoices, (i) => i.amountCents);
    const base = {
      currentMonth: current, plan: planAt(plans, current), nextPlan: plans.find((p) => p.effectiveMonth > current) ?? null, payments, paidCents,
      invoices, invoicedCents, openInvoicesCents: sum(invoices, (i) => i.remainingCents), invoiceMinCents: INVOICE_MIN_CENTS,
    };
    if (!plans.length) return { ...base, months: [], chargedCents: 0, accruedCents: 0, balanceCents: -paidCents, debtCents: 0 };

    const first = plans[0].effectiveMonth;
    const months = monthsBetween(first, current);
    const spendRows = await repo.spendByMonth(userId, monthStartDate(first), monthStartDate(nextMonth(current)));
    const stored = new Map(statements.map((s) => [s.period, s]));
    const entries = months.map((period) => {
      const saved = stored.get(period);
      if (saved) return { period, closed: true, closable: false, ...saved };
      const plan = planAt(plans, period);
      const { cents: spendCents, breakdown, unconverted } = convertToBrlCents(spendRows.filter((r) => r.month === period), rates);
      const { percentFeeCents, totalCents } = chargeFor({ spendCents, monthlyFeeCents: plan.monthlyFeeCents, percentBp: plan.percentBp });
      return { period, closed: false, closable: canClose(period, at), monthlyFeeCents: plan.monthlyFeeCents, percentBp: plan.percentBp, spendCents, percentFeeCents, totalCents, unconverted, breakdown };
    }).reverse(); // do mais novo para o mais antigo
    const chargedCents = sum(entries, (e) => e.totalCents);
    const balanceCents = chargedCents - paidCents;
    // "Acumulando": cobrado (inclusive o mês em andamento) que ainda não virou fatura.
    return { ...base, months: entries, chargedCents, accruedCents: Math.max(0, chargedCents - invoicedCents), balanceCents, debtCents: Math.max(0, balanceCents) };
  }

  /**
   * Emite a fatura da pessoa se os meses FECHADOS ainda sem fatura somam o mínimo; abaixo dele o valor espera o próximo fechamento. A fatura cobre os meses
   * seguidos desde a anterior. Idempotente (a mesma fatura nunca é emitida duas vezes). Devolve true se emitiu.
   */
  async function issueInvoice(userId) {
    const [statements, invoices] = await Promise.all([repo.listStatements(userId), repo.listInvoices(userId)]);
    if (!statements.length) return false;
    const uninvoiced = sum(statements, (s) => s.totalCents) - sum(invoices, (i) => i.amountCents);
    if (!canIssueInvoice(uninvoiced)) return false;
    const periodTo = statements.at(-1).period;
    const previousTo = invoices.at(-1)?.periodTo;
    const periodFrom = previousTo ? nextMonth(previousTo) : statements[0].period;
    if (periodFrom > periodTo) return false;
    return repo.insertInvoice({ userId, amountCents: uninvoiced, periodFrom, periodTo, dueDate: dueDateOf(now()) });
  }

  /** Fecha os meses vencidos de todas as pessoas com plano (idempotente: um mês nunca é fechado duas vezes). */
  async function closeDueMonths() {
    let closed = 0;
    for (const userId of await repo.usersWithPlans()) {
      const { months } = await summaryOf(userId);
      for (const e of months) {
        if (e.closed || !e.closable) continue;
        const created = await repo.insertStatement({ userId, period: e.period, monthlyFeeCents: e.monthlyFeeCents, percentBp: e.percentBp, spendCents: e.spendCents, percentFeeCents: e.percentFeeCents, totalCents: e.totalCents, unconverted: e.unconverted, breakdown: e.breakdown });
        if (created) closed += 1;
      }
      await issueInvoice(userId);
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
    issueInvoice,

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
          const converted = convertToBrlCents(await repo.spendByMonth(person.id, start, monthStartDate(nextMonth(s.currentMonth))), await ratesMap());
          month = { spendCents: converted.cents, totalCents: 0, unconverted: converted.unconverted };
        }
        rows.push({
          id: person.id, name: person.name, email: person.email, status: person.status,
          plan: s.plan, nextPlan: s.nextPlan,
          monthSpendCents: month.spendCents, monthChargeCents: month.totalCents, unconverted: month.unconverted,
          balanceCents: s.balanceCents, debtCents: s.debtCents, openInvoicesCents: s.openInvoicesCents, openInvoices: s.invoices.filter((i) => i.status !== 'paid').length, locks: locks.get(person.id) ?? 0,
        });
      }
      const totals = {
        billed: rows.filter((r) => r.plan).length,
        monthChargeCents: rows.reduce((total, r) => total + r.monthChargeCents, 0),
        debtCents: rows.reduce((total, r) => total + r.debtCents, 0),
        openInvoicesCents: rows.reduce((total, r) => total + r.openInvoicesCents, 0),
        locks: rows.reduce((total, r) => total + r.locks, 0),
      };
      return { users: rows, totals, rates: await repo.listRates(), fx: fx?.status() ?? { enabled: false, lastOkAt: null, lastError: null }, currentMonth: monthOf(now()) };
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

    /**
     * Marca uma fatura como paga (o cliente pagou por fora): registra um pagamento com o que FALTA da fatura (até o último centavo), ligado a ela.
     * Só a fatura mais antiga em aberto pode ser marcada: os pagamentos quitam da mais antiga para a mais nova, então pular uma quitaria a errada.
     */
    async payInvoice(adminId, userId, invoiceId, { paidAt, note }) {
      const user = await requirePerson(userId);
      if (paying.has(userId)) throw new HttpError(409, 'Já há um pagamento sendo registrado para esta pessoa. Aguarde um instante.', 'payment_in_progress');
      paying.add(userId);
      try {
        const { invoices } = await summaryOf(userId);
        const target = invoices.find((i) => i.id === invoiceId);
        if (!target) throw notFound('Fatura não encontrada.');
        if (target.status === 'paid') throw new HttpError(409, 'Esta fatura já está paga.', 'already_paid');
        if (invoices.some((i) => i.id < target.id && i.remainingCents > 0)) throw new HttpError(409, 'Marque primeiro a fatura mais antiga como paga: os pagamentos quitam da mais antiga para a mais nova.', 'pay_older_first');
        const id = await repo.addPayment({ userId, amountCents: target.remainingCents, paidAt, note: note ?? `Fatura nº ${target.id}`, registeredBy: adminId, invoiceId: target.id });
        const released = await settleLocks(userId);
        return { id, user, invoice: target, amountCents: target.remainingCents, released };
      } finally {
        paying.delete(userId);
      }
    },

    listLocks: () => repo.listActiveLocks(),

    async releaseLock(adminId, lockId) {
      const lock = await repo.getLock(lockId);
      if (!lock) throw notFound('Bloqueio não encontrado.');
      if (lock.released) throw new HttpError(409, 'Este bloqueio já foi liberado.', 'conflict');
      await repo.release([lock.id], { by: adminId, reason: 'admin' });
      return lock;
    },

    // ---------- câmbio ----------
    /** Fixa a cotação de uma moeda (quantos reais vale 1 unidade). Vale até ser removida; a atualização automática não a sobrescreve. */
    setRate: (currency, brlPerUnit, adminId) => repo.setManualRate(currency, brlPerUnit, adminId),
    /** Remove a cotação; a automática volta no próximo ciclo. */
    async clearRate(currency) {
      if (!(await repo.deleteRate(currency))) throw notFound('Não há cotação para esta moeda.');
    },
    listRates: () => repo.listRates(),
    fxStatus: () => fx?.status() ?? { enabled: false, lastOkAt: null, lastError: null },
    /** Busca as cotações agora (botão do admin). Sem internet ou com a fonte fora do ar, as cotações guardadas continuam valendo. */
    async refreshRates() {
      if (!fx || !fx.status().enabled) throw new HttpError(409, 'A atualização automática de cotações está desligada neste servidor. Fixe as cotações à mão.', 'fx_disabled');
      try {
        return await fx.refresh();
      } catch {
        throw new HttpError(502, `Não foi possível atualizar as cotações agora (${fx.status().lastError ?? 'fonte indisponível'}). As cotações guardadas continuam valendo.`, 'fx_unavailable');
      }
    },

    /** Converte gastos por moeda ({ currency, spend }) em centavos de DÓLAR pelas cotações para real (usado pelo nível de gasto). Moeda sem cotação volta em `unconverted`. */
    async toUsd(rows) {
      const rates = await ratesMap();
      const usdBrl = rates.get('USD'); // quantos reais vale 1 dólar
      let spendCents = 0;
      const unconverted = [];
      for (const row of rows) {
        const spend = Number(row.spend);
        if (!Number.isFinite(spend) || spend <= 0) continue;
        const rate = row.currency === 'USD' ? 1 : row.currency === BASE_CURRENCY ? 1 : rates.get(row.currency);
        if (row.currency === 'USD') spendCents += Math.round(spend * 100);
        else if (usdBrl > 0 && rate > 0) spendCents += Math.round(((spend * rate) / usdBrl) * 100);
        else unconverted.push({ currency: row.currency, spend: Math.round(spend * 100) / 100 });
      }
      return { spendCents, unconverted };
    },

    /** Gasto vitalício guardado no livro permanente, já em dólar. */
    async lifetimeSpend(ownerId) {
      return this.toUsd(await repo.spendTotals(ownerId));
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
      fx?.start();
      if (timer) return;
      const run = () => closeDueMonths().then((n) => { if (n) log.info?.(`[assinaturas] ${n} mês(es) fechado(s)`); }).catch((err) => log.error?.('[assinaturas] falha ao fechar meses:', err?.code ?? err?.message));
      run();
      timer = setInterval(run, CLOSE_EVERY_MS);
      timer.unref();
    },
    stop() {
      fx?.stop();
      clearInterval(timer);
      timer = null;
    },
  };
  return service;
}
