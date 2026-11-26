const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Observador central do registro de atividades. Entra na API protegida (depois de sessão, conta aprovada e espaço de trabalho resolvidos) e, para
 * cada pedido que ALTERA algo e casa com uma regra (`activity.rules.js`):
 *  1. roda o `before` da regra (se houver) antes da ação, para guardar o que sumiria (nome do que vai ser excluído);
 *  2. deixa a ação acontecer normalmente (o registro não muda a resposta nem o tempo dela, só em exclusões há uma leitura extra);
 *  3. se a resposta foi de sucesso (2xx), registra a ação com os detalhes que a regra extrai.
 * Nada aqui pode quebrar a ação: toda falha do registro (ou das buscas de nome) é engolida e vai só para o log do servidor.
 */
export function createActivityTrail({ activity, rules, lookups, log = console }) {
  const safe = async (fn, ctx) => {
    try {
      return await fn(ctx);
    } catch (err) {
      log.warn?.(`[atividade] regra falhou: ${err?.code ?? err?.message ?? 'erro'}`);
      return undefined;
    }
  };

  return async function activityTrail(req, res, next) {
    if (!MUTATING.has(req.method) || !req.actor || !req.user) return next();
    const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
    const found = rules.find((r) => r.method === req.method && r.pattern.test(path));
    if (!found) return next();

    const base = { actor: req.actor, user: req.user, match: found.pattern.exec(path), body: req.body, lookups };
    const snapshot = found.before ? await safe(found.before, base) : undefined;

    let result;
    const json = res.json.bind(res);
    res.json = (payload) => { result = payload; return json(payload); }; // guarda a resposta para a regra extrair nomes e quantidades

    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      (async () => {
        const described = await safe(found.describe, { ...base, result, snapshot });
        if (described === null || described === undefined) return;
        await activity.record({ workspaceId: req.actor.id, actor: { id: req.user.id, name: req.user.name }, action: found.action, targetName: described.target ?? null, details: described.details ?? {} });
      })();
    });
    return next();
  };
}
