/**
 * Assuntos que o assistente do Início sabe responder e como reconhecê-los numa pergunta digitada (regras puras, sem DOM; testadas em Node).
 * Não há modelo de linguagem: o reconhecimento é por palavras-chave, e o que não for reconhecido recebe uma resposta honesta com os assuntos disponíveis.
 */
export const TOPICS = Object.freeze([
  { id: 'performance', title: 'Resumo do desempenho', text: 'Como foi o desempenho das minhas contas nos últimos 7 dias?' },
  { id: 'spend', title: 'Onde estou gastando', text: 'Qual conta de anúncio mais gastou esta semana?' },
  { id: 'creative', title: 'Ideias de criativo', text: 'Me dê 5 ideias de gancho para um anúncio em vídeo.' },
  { id: 'campaign', title: 'Nova campanha', text: 'Quero criar uma campanha de tráfego. Por onde começo?' },
]);
export const EXTRA_TOPICS = Object.freeze([
  { id: 'catalog', title: 'Campanha de catálogo', text: 'Como crio um catálogo e uma campanha de catálogo?' },
  { id: 'connect', title: 'Conectar minha conta', text: 'Como conecto minha Business Center?' },
]);

const plain = (text) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Assunto de uma pergunta (ou null). A ordem importa: o mais específico primeiro. */
export function detectTopic(text) {
  const t = plain(text);
  if (/catalogo/.test(t)) return 'catalog';
  if (/gast|invest|quanto custou/.test(t)) return 'spend';
  if (/desempenho|resumo|resultado|relatorio|metricas?|como (foi|estao|esta)/.test(t)) return 'performance';
  if (/ideia|gancho|hook|criativo|roteiro|copy/.test(t)) return 'creative';
  if (/conectar|business center|\bbc\b|autorizar|token/.test(t)) return 'connect';
  if (/campanha|trafego|comec(ar|o)|como (criar|publicar|anunciar)|anunciar/.test(t)) return 'campaign';
  return null;
}

/** Texto simples de uma resposta em blocos (usado no botão "Copiar" e para leitores de tela). */
export function blocksToText(blocks) {
  const lines = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'h': lines.push('', block.text.toUpperCase()); break;
      case 'p': case 'note': lines.push(block.text); break;
      case 'ol': block.items.forEach((item, i) => lines.push(`${i + 1}. ${typeof item === 'string' ? item : `${item.title}: ${item.text}`}`)); break;
      case 'ul': block.items.forEach((item) => lines.push(`• ${typeof item === 'string' ? item : `${item.title}: ${item.text}`}`)); break;
      case 'kpis': block.items.forEach((k) => lines.push(`${k.label}: ${k.value}${k.delta ? ` (${k.delta})` : ''}`)); break;
      case 'table':
        lines.push(block.head.join(' | '));
        block.rows.forEach((row) => lines.push(row.join(' | ')));
        break;
      default: break; // 'actions' são botões: não entram no texto
    }
  }
  return lines.join('\n').trim();
}
