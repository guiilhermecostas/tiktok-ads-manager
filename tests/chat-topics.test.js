import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXTRA_TOPICS, TOPICS, blocksToText, detectTopic } from '../shared/chat-topics.js';

describe('assistente do Início: assuntos', () => {
  it('cada sugestão do menu leva ao seu assunto (a pergunta pronta é reconhecida)', () => {
    for (const topic of [...TOPICS, ...EXTRA_TOPICS]) assert.equal(detectTopic(topic.text), topic.id, topic.text);
  });

  it('reconhece perguntas digitadas com outras palavras, com ou sem acento e caixa', () => {
    const cases = [
      ['Quanto eu gastei ontem?', 'spend'], ['ONDE ESTOU INVESTINDO MAIS', 'spend'], ['qual conta gastou mais', 'spend'],
      ['me mostra o resumo', 'performance'], ['como estão meus resultados', 'performance'], ['relatório da semana', 'performance'],
      ['preciso de ideias de hook', 'creative'], ['roteiro para vídeo', 'creative'], ['Dê dicas de CRIATIVO', 'creative'],
      ['como crio um catálogo', 'catalog'], ['quero vender produtos do catálogo', 'catalog'],
      ['como conectar a business center', 'connect'], ['onde coloco o token', 'connect'],
      ['como criar campanha de conversão', 'campaign'], ['quero anunciar meu produto', 'campaign'], ['por onde começo?', 'campaign'],
    ];
    for (const [text, topic] of cases) assert.equal(detectTopic(text), topic, text);
  });

  it('o que não é reconhecido devolve null (o assistente responde com os assuntos que sabe) e entradas estranhas não quebram', () => {
    for (const text of ['oi', 'qual a capital da França?', '', '   ', null, undefined, 42, {}, '<script>alert(1)</script>']) assert.equal(detectTopic(text), null, String(text));
  });

  it('o texto simples da resposta (botão Copiar) inclui títulos, passos, números e tabelas, mas não os botões', () => {
    const text = blocksToText([
      { type: 'p', text: 'Introdução.' },
      { type: 'h', text: 'Passos' },
      { type: 'ol', items: [{ title: 'Um', text: 'faça isto' }, 'dois'] },
      { type: 'ul', items: ['a', { title: 'b', text: 'c' }] },
      { type: 'kpis', items: [{ label: 'Gasto', value: 'R$ 10,00', delta: '+5% vs. período anterior' }, { label: 'CTR', value: '1%', delta: null }] },
      { type: 'table', head: ['Conta', 'Gasto'], rows: [['A', 'R$ 1,00']] },
      { type: 'note', tone: 'warn', text: 'Cuidado.' },
      { type: 'actions', items: [{ label: 'Abrir', href: '/x' }] },
    ]);
    assert.equal(text, ['Introdução.', '', 'PASSOS', '1. Um: faça isto', '2. dois', '• a', '• b: c', 'Gasto: R$ 10,00 (+5% vs. período anterior)', 'CTR: 1%', 'Conta | Gasto', 'A | R$ 1,00', 'Cuidado.'].join('\n'));
    assert.ok(!text.includes('Abrir'));
  });
});
