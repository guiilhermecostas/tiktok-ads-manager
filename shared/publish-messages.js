/**
 * Textos do publicar (confirmação, resumo e avisos), puros e compartilhados entre o assistente de campanha e o one-click. Ficam aqui, fora das telas, para
 * que a decisão de "qual mensagem mostrar" seja testada em Node (uma mensagem enganosa depois de publicar já aconteceu).
 */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "ativa(s)" ou "pausada(s)", concordando com a quantidade. */
export const statusWord = (activate, count = 1) => (activate ? (count === 1 ? 'ativa' : 'ativas') : (count === 1 ? 'pausada' : 'pausadas'));

/**
 * Frase de confirmação antes de publicar. `what` é o que será criado ("a campanha, o grupo de anúncios e o anúncio de “X”"); `where` diz onde ("em 3 contas…").
 * Com várias cópias, diz quantas campanhas serão criadas no total; com `activate`, avisa com todas as letras que elas começam a gastar.
 */
export function confirmMessage({ what, where, accounts, copies = 1, activate = false }) {
  const total = accounts * copies;
  const scope = copies > 1 ? `${plural(copies, 'campanha igual', 'campanhas iguais')} (cada uma com grupo de anúncios e anúncio) ${where}, ${plural(total, 'campanha', 'campanhas')} no total` : `${what} ${where}`;
  const tail = activate
    ? 'Serão publicadas JÁ ATIVAS: começam a gastar o orçamento assim que o TikTok aprovar o anúncio (você ainda pode pausar no Gerenciador).'
    : 'Tudo será criado PAUSADO: nada começa a gastar até você ativar no TikTok.';
  return `Vamos criar ${scope}. ${tail}`;
}

/** Texto do botão de confirmar. */
export function confirmLabel({ accounts, copies = 1, activate = false }) {
  const status = statusWord(activate, accounts * copies);
  if (copies > 1) return `Publicar ${accounts * copies} campanhas (${status})`;
  return accounts === 1 ? `Publicar (${status})` : `Publicar em ${accounts} contas (${status})`;
}

/**
 * Rótulo que aparece na conta quando todas as campanhas dela foram publicadas. `verified`: o servidor conferiu no TikTok que campanha, conjunto de anúncios e anúncio existem;
 * quando a conferência não pôde rodar, o rótulo diz isso em vez de afirmar mais do que se sabe.
 */
export function doneLabel({ copies = 1, activate = false, verified = true }) {
  const base = copies > 1 ? `✓ ${copies} campanhas publicadas (${statusWord(activate, copies)})` : `✓ Publicada (${statusWord(activate)})`;
  return verified ? `${base} · conferida no TikTok` : `${base} · não deu para conferir no TikTok`;
}

/** Aviso (ou nada) para as contas em que o nome da campanha já existia no TikTok e foi numerado. */
export const renamedNotice = (renamed) => (renamed.length ? `${renamed.length === 1 ? 'Já existia uma campanha com esse nome na conta' : `Já existia uma campanha com esse nome em ${renamed.length} contas`}: a nova ficou como “${renamed[0].name}”${renamed.length > 1 ? ' (e parecidas)' : ''}.` : null);

/**
 * Avisos (toasts) depois de publicar, em ordem: [{ message, tone }]. EXATAMENTE um resultado principal (tudo certo, parcial ou nenhum) e, se for o caso, o aviso de nomes numerados.
 * `requested`: contas pedidas; `succeeded`: contas em que TUDO foi publicado; `failed`: contas com erro; `created`: campanhas criadas nesta rodada.
 */
export function resultToasts({ requested, succeeded, failed, created = succeeded, copies = 1, activate = false, renamed = [], unverified = 0 }) {
  const toasts = [];
  if (succeeded && !failed) {
    const word = statusWord(activate, copies > 1 ? created : succeeded);
    toasts.push({
      tone: 'success',
      message: copies > 1
        ? `${plural(created, 'campanha publicada', 'campanhas publicadas')} em ${plural(succeeded, 'conta', 'contas')} (${word}).`
        : succeeded === 1 ? `Campanha publicada no TikTok (${word}).` : `Campanha publicada em ${succeeded} contas (${word}).`,
    });
  } else if (succeeded) {
    toasts.push({ tone: 'danger', message: `Publicada em ${succeeded} de ${requested} contas. Veja os erros abaixo.` });
  } else {
    toasts.push({ tone: 'danger', message: 'Nenhuma conta foi publicada. Veja os erros abaixo.' });
  }
  const notice = renamedNotice(renamed);
  if (notice) toasts.push({ tone: 'warning', message: notice });
  if (unverified) toasts.push({ tone: 'warning', message: `${unverified === 1 ? 'Uma publicação' : `${unverified} publicações`} não pôde ser conferida no TikTok (a consulta falhou). Abra o Gerenciador do TikTok e confirme que o conjunto de anúncios e o anúncio existem.` });
  return toasts;
}

/**
 * Avisos depois de "Conferir no TikTok": `results` = [{ advertiserId, state: 'ok' | 'missing' | 'unverified', missing: [...] }]. Diz o que foi encontrado, o que faltou (e que a conta
 * voltou para "tentar de novo") e o que não deu para conferir. Nunca afirma "tudo certo" sem ter conferido.
 */
const LEVEL_NAMES = { campaign: 'a campanha', adGroup: 'o conjunto de anúncios', ad: 'o anúncio' };
export function verifyToasts(results) {
  const ok = results.filter((r) => r.state === 'ok').length;
  const broken = results.filter((r) => r.state === 'missing');
  const unknown = results.filter((r) => r.state === 'unverified').length;
  const toasts = [];
  if (!results.length) return [{ tone: 'warning', message: 'Nenhuma publicação para conferir.' }];
  if (ok) toasts.push({ tone: 'success', message: ok === 1 ? 'Conferido no TikTok: a campanha, o conjunto de anúncios e o anúncio existem.' : `Conferido no TikTok: ${ok} publicações com campanha, conjunto de anúncios e anúncio.` });
  for (const r of broken) {
    const what = [...new Set(r.missing.map((m) => LEVEL_NAMES[m]))].join(' e ');
    toasts.push({ tone: 'danger', message: `Conta ${r.advertiserId}: não encontramos ${what} no TikTok. A conta voltou para “tentar de novo”: publique de novo e o sistema recria só o que falta.` });
  }
  if (unknown) toasts.push({ tone: 'warning', message: `${unknown === 1 ? 'Uma publicação' : `${unknown} publicações`} não pôde ser conferida agora (a consulta ao TikTok falhou). Tente de novo em instantes.` });
  return toasts;
}
