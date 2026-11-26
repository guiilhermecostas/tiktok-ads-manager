import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATIONS, OPERATION_IDS, OPERATION_PERIODS, detectOperation, detectPeriod } from '../shared/assistant-intents.js';

const id = (text) => detectOperation(text)?.id ?? null;

describe('assistente: perguntas sobre a operação', () => {
  it('reconhece as perguntas do dia a dia (com acento, sem acento, maiúsculas e gírias)', () => {
    const cases = {
      bcs: ['quantas BC tem?', 'Quantas Business Centers eu tenho?', 'qtd de BMs', 'quantas bcs eu tenho conectadas', 'Número de business center'],
      accounts: ['quantas contas de anúncio eu tenho?', 'quantas contas tenho', 'quantidade de contas de ads'],
      accountsDown: ['quantas contas caiu hoje?', 'Quantas contas caíram hoje', 'quais contas foram banidas hoje', 'alguma conta suspensa hoje?', 'conta punida hoje', 'perdi alguma conta hoje?'],
      adsRejected: ['quantos anúncios foram rejeitados hoje?', 'anuncios reprovados hoje', 'quantos ads foram negados hoje', 'anúncio recusado ontem'],
      creativesUploaded: ['quantos criativos eu subi hoje?', 'quantos criativos enviei hoje', 'criativos que fiz upload hoje', 'quantos vídeos subi ontem'],
      spendTotal: ['quanto gastei no total hoje em ads?', 'quanto gastei hoje', 'total gasto hoje', 'gasto total ontem', 'quanto investi nos últimos 7 dias', 'valor gasto este mês'],
      bestCreatives: ['quais criativos performou melhor?', 'quais criativos performaram melhor hoje', 'melhor criativo da semana', 'qual vídeo é o vencedor'],
      bestCost: ['quais anúncios tinham as melhores métricas de custo?', 'anúncios com menor CPC hoje', 'quais ads têm o custo mais barato', 'melhores métricas de custo dos anúncios'],
    };
    for (const [expected, texts] of Object.entries(cases)) for (const text of texts) assert.equal(id(text), expected, text);
  });

  it('cada pergunta de exemplo do menu é reconhecida como ela mesma', () => {
    for (const op of Object.values(OPERATIONS)) assert.equal(id(op.text), op.id, op.text);
    assert.deepEqual(OPERATION_IDS, Object.keys(OPERATIONS));
  });

  it('o período vem da frase (padrão: hoje)', () => {
    const cases = { 'quanto gastei hoje': 'today', 'quanto gastei': 'today', 'gasto de ontem': 'yesterday', 'gasto nos últimos 7 dias': 'last7', 'gasto da semana': 'last7', 'gasto este mês': 'thisMonth', 'gasto do mês passado': 'lastMonth', 'gasto nos últimos 30 dias': 'last30', 'gasto em 14 dias': 'last14' };
    for (const [text, period] of Object.entries(cases)) assert.equal(detectPeriod(text), period, text);
    assert.equal(detectOperation('quanto gastei ontem').period, 'yesterday');
    for (const key of Object.keys(OPERATION_PERIODS)) assert.ok(OPERATION_PERIODS[key]);
  });

  it('o que não é pergunta de operação NÃO é reconhecido (cai nos assuntos antigos)', () => {
    for (const text of ['', '   ', 'oi', 'me dê 5 ideias de gancho', 'como crio uma campanha de catálogo?', 'qual conta mais gastou esta semana?', 'como conecto minha business center', 'resumo do desempenho']) {
      assert.equal(detectOperation(text), null, text);
    }
    assert.equal(detectOperation(undefined), null);
    assert.equal(detectOperation(null), null);
  });

  it('"qual conta gastou mais" continua sendo o assunto antigo, não o gasto total', () => {
    assert.equal(id('qual conta mais gastou?'), null);
    assert.equal(id('quanto gastei no total hoje'), 'spendTotal');
  });
});
