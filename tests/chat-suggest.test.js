import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OPERATION_IDS } from '../shared/assistant-intents.js';
import { PLACEHOLDERS, SUGGESTION_POOL, plain, suggest } from '../shared/chat-suggest.js';
import { EXTRA_TOPICS, TOPICS } from '../shared/chat-topics.js';

const ids = (list) => list.map((s) => s.id);

describe('Sugestões do campo do Início', () => {
  it('o conjunto cobre TODAS as perguntas sobre a operação e os assuntos gerais (nada fica sem sugestão)', () => {
    assert.deepEqual(ids(SUGGESTION_POOL.filter((s) => s.kind === 'operation')), OPERATION_IDS);
    assert.deepEqual(ids(SUGGESTION_POOL.filter((s) => s.kind === 'topic')), [...TOPICS, ...EXTRA_TOPICS].map((t) => t.id));
    assert.ok(SUGGESTION_POOL.every((s) => s.title && s.text), 'todas têm título e texto');
    assert.ok(Object.isFrozen(SUGGESTION_POOL));
  });

  it('"/" sozinho lista tudo; "/palavra" filtra; sem texto não sugere nada', () => {
    assert.equal(suggest('/').length, SUGGESTION_POOL.length);
    assert.equal(suggest('  /  ').length, SUGGESTION_POOL.length, 'espaços antes e depois não atrapalham');
    assert.deepEqual(ids(suggest('/gasto')).slice(0, 1), ['spendTotal']);
    assert.ok(suggest('/gasto').length >= 1 && suggest('/gasto').length < SUGGESTION_POOL.length);
    assert.deepEqual(suggest(''), []);
    assert.deepEqual(suggest('   '), []);
    assert.deepEqual(suggest(null), []);
    assert.deepEqual(suggest('a'), [], 'uma letra só não basta');
  });

  it('reconhece o que a pessoa digita (sem acento, maiúsculas ou palavras soltas) e põe o mais certo primeiro', () => {
    assert.equal(suggest('contas que cairam')[0].id, 'accountsDown');
    assert.equal(suggest('CAIU')[0].id, 'accountsDown', 'palavra-chave');
    assert.equal(suggest('quanto gastei')[0].id, 'spendTotal');
    assert.equal(suggest('rejeitados')[0].id, 'adsRejected');
    assert.equal(suggest('bm')[0].id, 'bcs');
    assert.equal(suggest('melhor custo')[0].id, 'bestCost');
    assert.equal(suggest('criativos enviados')[0].id, 'creativesUploaded');
    assert.ok(ids(suggest('catalogo')).includes('catalog'));
    assert.ok(ids(suggest('conectar')).includes('connect'));
  });

  it('todas as palavras precisam combinar (nada de resposta aleatória) e há no máximo 5 sugestões', () => {
    assert.deepEqual(suggest('zzzxxx yyywww'), []);
    assert.deepEqual(suggest('gasto zzzxxx'), []);
    assert.ok(suggest('conta').length <= 5);
    assert.ok(suggest('de').length <= 5);
    assert.equal(suggest('conta', { limit: 2 }).length, 2);
  });

  it('texto estranho não quebra nada (regex, HTML, muito longo)', () => {
    for (const q of ['(((', '[a-', '.*', '<script>alert(1)</script>', '\\', 'a'.repeat(10_000), '/' + 'x'.repeat(5_000), '💥💥', '\u0000']) assert.doesNotThrow(() => suggest(q), q.slice(0, 20));
    assert.deepEqual(suggest('<script>alert(1)</script>'), []);
  });

  it('a lista de exemplos do campo é curta, em português e a primeira é o texto padrão', () => {
    assert.ok(PLACEHOLDERS.length >= 4 && PLACEHOLDERS.length <= 8);
    assert.ok(PLACEHOLDERS.every((p) => p.length > 5 && p.length < 80));
    assert.match(PLACEHOLDERS[0], /campanhas/);
    assert.equal(plain('  Ação  RÁPIDA '), 'acao rapida');
  });
});
