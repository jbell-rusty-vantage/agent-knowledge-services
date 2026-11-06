import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKnowledge, searchKnowledge } from './knowledge.mjs';
import { searchKnowledge as baselineSearch } from './fixtures/ks-context-v1/baseline-knowledge.mjs';
import { search } from './cli.mjs';
const fixture = new URL('./fixtures/ks-context-v1/', import.meta.url);
export function frozenFixture() {
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', fixture)));
  for (const file of manifest.files) {
    const bytes = readFileSync(new URL(file.path, fixture));
    if (createHash('sha256').update(bytes.toString('utf8').replace(/\r\n/g, '\n')).digest('hex') !== file.normalizedSha256) throw new Error(`Frozen fixture changed: ${file.path}`);
  }
  return { manifest, bundle: readKnowledge({ ...manifest, id: manifest.repository }, { directory() {}, read: (path) => readFileSync(new URL(path, fixture), 'utf8') }),
    labels: JSON.parse(readFileSync(new URL('queries.json', fixture))) };
}
export function measure(run, cases) {
  const rows = cases.map((item) => {
    const results = run(item.query).results;
    const rank = results.findIndex((result) => item.expected.includes(result.id)) + 1;
    return { ...item, rank: rank || null, top3: results.slice(0, 3).map((result) => result.id), passed: item.expected.length ? rank > 0 && rank <= 3 : results.length === 0 };
  });
  const positives = rows.filter((item) => item.expected.length);
  const negatives = rows.filter((item) => !item.expected.length);
  return { positiveCount: positives.length, recallAt3: positives.filter((item) => item.passed).length / positives.length,
    mrr: positives.reduce((sum, item) => sum + (item.rank ? 1 / item.rank : 0), 0) / positives.length,
    negativeCount: negatives.length, correctAbstentions: negatives.filter((item) => item.passed).length,
    criticalFailures: rows.filter((item) => item.critical && !item.passed).map((item) => item.id), rows };
}
export function benchmark(repo) {
  const { bundle, manifest, labels } = frozenFixture();
  const evaluate = (run) => Object.fromEntries(['screening', 'heldout'].map((partition) => [partition, measure(run, labels.cases.filter((item) => item.partition === partition))]));
  return { fixtureHead: manifest.head, labelProvenance: labels.labelProvenance,
    baseline: evaluate((query) => baselineSearch(bundle, { query, limit: 20 })),
    improved: evaluate((query) => searchKnowledge(bundle, { query, limit: 20 })),
    ...(repo ? { current: evaluate((query) => search({ root: repo, query, limit: 20 })) } : {}) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--repo')) throw new Error('Usage: node retrieval-benchmark.mjs [--repo PATH]');
  process.stdout.write(JSON.stringify(benchmark(args[1]), null, 2) + '\n');
}
