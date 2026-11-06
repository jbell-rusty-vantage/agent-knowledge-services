import assert from 'node:assert/strict';
import { test } from 'node:test';
import { queryTokens, searchKnowledge, contextKnowledge } from './knowledge.mjs';
import { frozenFixture, benchmark } from './retrieval-benchmark.mjs';
const concept = (id, body, metadata = {}) => ({ id, path: `knowledge/${id}.md`, status: 'reference', metadata: { type: 'concept', title: id, description: id, ...metadata }, bodyStart: 0, text: body });
const find = (concepts, query) => searchKnowledge({ concepts }, { query });
test('conversational filler cannot match inside arbitrary words', () => {
  assert.equal(find([concept('banana', 'Bananas contain potassium')], 'How do I do this?').total, 0);
  assert.equal(find([concept('capture', 'capture')], 'cat').total, 0);
});
test('camelCase and snake_case identifiers share component tokens', () => {
  assert.deepEqual(queryTokens('readKnowledge read_knowledge'), ['read', 'knowledge']);
});
test('aliases and questions route vocabulary absent from body', () => {
  assert.equal(find([concept('leases', 'fenced ownership', { aliases: ['heartbeat'], questions: ['How does a worker restart?'] })], 'heartbeat restart').results[0].id, 'leases');
});
test('irrelevant repeated prose does not raise ranking', () => {
  const first = concept('first', 'lease retry');
  const second = concept('second', 'lease retry');
  const before = find([first, second], 'lease').results.map(({ score }) => score);
  second.text += ' irrelevant'.repeat(500);
  assert.deepEqual(find([first, second], 'lease').results.map(({ score }) => score), before);
});
test('ranking ties are independent of registry order', () => {
  assert.deepEqual(find([concept('z', 'lease'), concept('a', 'lease')], 'lease').results.map(({ id }) => id), ['a', 'z']);
});
test('context sections remain bounded and do not imply semantic review', () => {
  const item = concept('lease', '# Lease\nlease\n' + 'detail\n'.repeat(100));
  const bundle = { root: 'knowledge', concepts: [item] };
  const output = contextKnowledge(bundle, find(bundle.concepts, 'lease'), { read() { throw new Error('unexpected read'); } });
  assert.equal(output.results[0].sections[0].truncated, true);
  assert.match(output.freshnessMeaning, /does not attest semantic correctness/);
});
test('real KS fixture bytes retain their independently recorded hashes', () => {
  assert.equal(frozenFixture().manifest.files.length, 6);
});
test('frozen KS routing improves screening without losing critical routes', () => {
  const result = benchmark();
  assert.ok(result.improved.screening.recallAt3 >= result.baseline.screening.recallAt3);
  assert.ok(result.improved.screening.mrr > result.baseline.screening.mrr);
  assert.deepEqual(result.improved.screening.criticalFailures, []);
});


test('context preserves registry authority and returns registered source and test destinations', () => {
  const item = { ...concept('lease', '# Lease\nlease'), modules: ['worker'] };
  const bundle = { root: 'knowledge', concepts: [item] };
  const output = contextKnowledge(bundle, find(bundle.concepts, 'lease'), { read() { throw new Error('unexpected'); } }, {
    modules: [{ id: 'worker', path: 'apps/worker', state: 'partial', entrypoints: ['apps/worker/src/index.ts'], tests: ['apps/worker/src/worker.test.ts'] }],
    docs: [{ path: 'docs/proposed.md', modules: ['worker'], status: 'proposed' }, { path: 'docs/accepted.md', modules: ['worker'], status: 'accepted' }],
  });
  assert.equal(output.results[0].modules[0].state, 'partial');
  assert.deepEqual(output.results[0].modules[0].tests, ['apps/worker/src/worker.test.ts']);
  assert.deepEqual(output.results[0].architecture.map(({ status }) => status), ['accepted', 'proposed']);
  assert.equal(output.results[0].conceptFreshness, 'untracked');
});

test('context never fetches remote source metadata', () => {
  const item = concept('lease', '# Lease\nlease', { sources: [{ resource: 'https://example.com/doc' }] });
  const output = contextKnowledge({ root: 'knowledge', concepts: [item] }, find([item], 'lease'), { read() { throw new Error('unexpected'); } });
  assert.deepEqual(output.results[0].evidence, []);
});
