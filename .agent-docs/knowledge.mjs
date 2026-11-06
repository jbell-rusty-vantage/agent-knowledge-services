import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { load, JSON_SCHEMA } from './vendor/js-yaml.mjs';

const MAX_CONCEPTS = 40;
const MAX_EVIDENCE_FILES = 256;
const MAX_FRONTMATTER_BYTES = 16384;
const MAX_CONCEPT_BYTES = 65536;
const MAX_CORPUS_BYTES = 512 * 1024;
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_KNOWLEDGE_MS = 10000;
const hash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const singleLine = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !/[\r\n]/.test(value);
const label = (value) => value.replace(/[\[\]`|<>]/g, '');

function parseConcept(doc, text, root) {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  check(match && Buffer.byteLength(match[1]) <= MAX_FRONTMATTER_BYTES, `Missing or oversized OKF frontmatter: ${doc.path}`);
  const metadata = load(match[1], { schema: JSON_SCHEMA });
  check(metadata && typeof metadata === 'object' && !Array.isArray(metadata) && singleLine(metadata.type), `OKF type must be a non-empty string: ${doc.path}`);
  // These extra fields belong to our navigation profile, not OKF conformance.
  check(singleLine(metadata.title) && singleLine(metadata.description), `Navigation requires one-line title and description: ${doc.path}`);
  check(metadata.tags === undefined || (Array.isArray(metadata.tags) && metadata.tags.length <= 30 && metadata.tags.every(singleLine)), `Invalid navigation tags: ${doc.path}`);
  check(metadata.status === undefined || metadata.status === (doc.status ?? 'reference'), `Knowledge status disagrees with registry: ${doc.path}`);
  for (const field of ['aliases', 'questions']) check(metadata[field] === undefined || (Array.isArray(metadata[field]) && metadata[field].length <= 30 && metadata[field].every(singleLine)), `Invalid navigation ${field}: ${doc.path}`);
  return { ...doc, id: posix.relative(root, doc.path).slice(0, -3), metadata, text: normalized, bodyStart: match[0].split('\n').length - 1 };
}

export function readKnowledge(config, io) {
  const started = Date.now();
  if (!config.knowledge) return { concepts: [], root: undefined, routes: [] };
  const { root, routes = [] } = config.knowledge;
  check(typeof root === 'string' && /^[a-z][a-z0-9/-]*$/.test(root), 'Invalid knowledge root');
  io.directory(root);
  const docs = config.docs.filter((doc) => doc.path.startsWith(`${root}/`));
  check(docs.length > 0 && docs.length <= MAX_CONCEPTS, 'Knowledge requires 1–40 registered concepts');
  check(docs.every((doc) => /^[a-z0-9-]+\.md$/.test(posix.basename(doc.path)) && posix.dirname(doc.path) === root && !['index.md', 'log.md'].includes(posix.basename(doc.path))), 'Knowledge navigation profile uses flat concept files; index/log are not source concepts');
  let corpusBytes = 0;
  const concepts = docs.map((doc) => {
    const text = io.read(doc.path);
    const bytes = Buffer.byteLength(text);
    corpusBytes += bytes;
    check(bytes <= MAX_CONCEPT_BYTES && corpusBytes <= MAX_CORPUS_BYTES, 'Knowledge corpus exceeds 64 KiB per concept or 512 KiB total');
    check(Date.now() - started < MAX_KNOWLEDGE_MS, 'Knowledge loading exceeded time budget');
    return parseConcept(doc, text, root);
  });
  const ids = new Set(concepts.map((concept) => concept.id));
  check(Array.isArray(routes) && routes.length <= 8, 'Invalid knowledge routes');
  for (const route of routes) {
    check(singleLine(route.task) && Array.isArray(route.concepts) && route.concepts.length > 0 && route.concepts.length <= MAX_CONCEPTS && route.concepts.every((id) => ids.has(id)), 'Unknown concept or invalid knowledge route');
  }
  return { concepts, root, routes, repository: config.id };
}

function evidencePaths(concept, root) {
  const body = concept.text.replace(/```[^\n]*\n[\s\S]*?```/g, '');
  const targets = [...body.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)].map((match) => match[1]);
  const sources = concept.metadata.sources ?? [];
  check(Array.isArray(sources) && sources.length <= MAX_EVIDENCE_FILES, `Invalid knowledge sources: ${concept.path}`);
  for (const source of sources) {
    check(source && singleLine(source.resource), `Knowledge source requires a resource: ${concept.path}`);
    targets.push(source.resource);
  }
  const paths = [];
  for (const target of targets) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    const decoded = decodeURIComponent(target.replace(/^<|>$/g, '').split('#')[0]);
    if (!decoded) continue;
    const path = decoded.startsWith('/') ? posix.join(root, decoded.slice(1)) : posix.normalize(posix.join(posix.dirname(concept.path), decoded));
    check(!path.startsWith('../') && !path.includes('\\') && !path.includes(':'), `Knowledge link escapes repository: ${target}`);
    paths.push(path);
  }
  return paths;
}

function renderIndex(bundle) {
  const lines = [
    `# ${bundle.repository} knowledge index`, '',
    'OKF 0.2 Markdown concepts. Read the matching explanation, then follow its source/test links. These are evidence-backed working-copy descriptions, not new accepted decisions or deployment attestations.', '',
    '## Find the relevant concept', '',
    ...bundle.routes.map((route) => `- **${label(route.task)}:** ${route.concepts.map((id) => `[${id}](${id}.md)`).join(' → ')}`), '',
    '## Concepts', '',
    ...bundle.concepts.map((concept) => `- [${label(concept.metadata.title)}](${concept.id}.md) — ${label(concept.metadata.description)} [${concept.status ?? 'reference'}; ${label(concept.metadata.type)}]`), '',
    '## Search', '',
    'Run from the repository root (PowerShell or bash):', '',
    '```text', 'node .agent-docs/cli.mjs search --repo . --query "retry cancellation"',
    'node .agent-docs/cli.mjs search --repo . --query "admission" --format json',
    `rg -n -i -C 2 "admission|deterministic" ${bundle.root} -g "*.md"`, '```', '',
    'The executable searches registered concepts only, using current files. It ranks title, description, tags, headings, and body matches; returns paths and line snippets; accepts --type, --tag and --limit. It is lexical search, not embeddings. No match exits 1; invalid input exits 2. Try a domain term from the routes or rg when wording differs.', '',
    'For bounded source/test context: `node .agent-docs/cli.mjs context --repo . --query "worker lease" --limit 2 --format json`.', '',
    '## Maintain this bundle', '',
    'Edit concept Markdown and its registration in `.agent-docs/config.json`; keep `type`, `title`, and `description` in YAML frontmatter. Types are open vocabulary. Acceptance status stays in the registry. Retain source/test links and identify uncertainties. Build and check with the repository-local CLI. Do not edit this generated listing.', '',
    'Build validates the local navigation profile and cited local file paths; provenance hashes cited files so changed evidence requires review. It does not prove prose is semantically correct. Reconcile code and accepted architecture rather than refreshing hashes blindly.', '',
    '[OKF specification](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md). The local flat-file navigation profile requires titles/descriptions and resolvable local file links beyond OKF’s minimal requirements. No `verified` claim is inferred from formatting checks.', '',
  ];
  return lines.join('\n');
}

export function planKnowledge(config, io) {
  const started = Date.now();
  const bundle = readKnowledge(config, io);
  if (!bundle.root) return { overview: '', files: [], inputs: {}, paths: [] };
  const cache = new Map(bundle.concepts.map((concept) => [concept.path, concept.text]));
  let evidenceBytes = [...cache.values()].reduce((sum, text) => sum + Buffer.byteLength(text), 0);
  const indexPath = `${bundle.root}/index.md`;
  for (const concept of bundle.concepts) {
    const paths = evidencePaths(concept, bundle.root);
    check(paths.some((path) => !path.startsWith(`${bundle.root}/`)), `Navigation profile requires local source evidence outside the bundle: ${concept.path}`);
    for (const path of paths) {
      if (path === indexPath) continue;
      check(!path.endsWith('AGENTS.md') && path !== 'docs/agents/CODE-MAP.md', `Knowledge evidence cannot cite generated guidance: ${path}`);
      if (!cache.has(path)) {
        check(cache.size < MAX_EVIDENCE_FILES, 'Too many knowledge evidence files');
        const text = io.read(path);
        evidenceBytes += Buffer.byteLength(text);
        check(evidenceBytes <= MAX_EVIDENCE_BYTES, 'Knowledge evidence exceeds 8 MiB total');
        check(Date.now() - started < MAX_KNOWLEDGE_MS, 'Knowledge evidence exceeded time budget');
        cache.set(path, text);
      }
    }
  }
  const registered = new Set(bundle.concepts.map((concept) => posix.basename(concept.path)));
  for (const filename of io.files(bundle.root)) {
    check(!filename.endsWith('.md') || filename === 'index.md' || registered.has(filename), `Unregistered knowledge Markdown: ${bundle.root}/${filename}`);
  }
  const overview = ['### Business logic and workflows (OKF)', '',
    `Start with \`${indexPath}\`; read one matching concept, then its implementation/tests. Do not load the whole bundle.`, '',
    ...bundle.routes.map((route) => `- ${route.task}: ${route.concepts.map((id) => `\`${bundle.root}/${id}.md\``).join(' → ')}`),
    '', 'Search: `node .agent-docs/cli.mjs search --repo . --query "your terms"` (add `--format json`).',
    `Exact text: \`rg -n -i "your terms" ${bundle.root} -g "*.md"\`.`,
    'Run this repository-relative command from the canonical repository root; package identity does not determine its workspace directory.',
    'Concepts describe observed behavior; accepted source decisions remain authoritative. Check cited code/tests before changing behavior.', '',].join('\n');
  return { overview, files: [{ path: indexPath, content: renderIndex(bundle), block: 'knowledge-index', budgetBytes: 32768 }],
    inputs: Object.fromEntries([...cache].sort(([a], [b]) => compare(a, b)).map(([path, text]) => [path, hash(text)])), paths: bundle.concepts.map((concept) => concept.path) };
}

// Domain words remain searchable; conversational filler never supplies relevance.
const STOP_WORDS = new Set('a an the i we you it is are was were be been do does did how what where when why which who can should could would to of for and or in on at by with from its this that as after into'.split(' '));
export function queryTokens(text) {
  const expanded = text.normalize('NFKC').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return [...new Set((expanded.match(/[\p{L}\p{N}]+/gu) ?? []).filter((term) => !STOP_WORDS.has(term)))];
}

function fieldsFor(concept) {
  const { title, description, tags = [], aliases = [], questions = [] } = concept.metadata;
  const body = concept.text.split('\n').slice(concept.bodyStart).join('\n');
  return [[title, 5], [description, 3], [tags.join(' '), 4], [aliases.join(' '), 5],
    [questions.join(' '), 4], [body.match(/^#+ .+$/gm)?.join(' ') ?? '', 2], [body, 1]];
}

function rankConcept(concept, terms, frequencies, count) {
  const fields = fieldsFor(concept).map(([text, weight]) => ({ tokens: queryTokens(text), weight }));
  const allTokens = new Set(fields.flatMap(({ tokens }) => tokens));
  const matchedTerms = terms.filter((term) => allTokens.has(term));
  const score = terms.reduce((sum, term) => {
    const rarity = Math.log(1 + (count - (frequencies.get(term) ?? 0) + 0.5) / ((frequencies.get(term) ?? 0) + 0.5));
    return sum + fields.reduce((value, field) => value + (field.tokens.includes(term) ? field.weight * rarity : 0), 0);
  }, 0) * (matchedTerms.length / Math.max(1, terms.length));
  const snippets = concept.text.split('\n').map((text, index) => ({ line: index + 1, text: text.slice(0, 280) }))
    .filter((item) => item.line > concept.bodyStart && queryTokens(item.text).some((term) => terms.includes(term)))
    .sort((a, b) => queryTokens(b.text).filter((term) => terms.includes(term)).length - queryTokens(a.text).filter((term) => terms.includes(term)).length || a.line - b.line).slice(0, 3);
  return { path: concept.path, id: concept.id, title: concept.metadata.title, type: concept.metadata.type,
    status: concept.status ?? 'reference', score, matchedTerms, snippets };
}

export function searchKnowledge(bundle, options) {
  check(typeof options.query === 'string' && options.query.trim().length > 0 && options.query.length <= 200, 'Search requires a query of 1–200 characters');
  check(/[\p{L}\p{N}]/u.test(options.query), 'Search query needs at least one word');
  const terms = queryTokens(options.query);
  const limit = options.limit ?? 5;
  check(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'Search limit must be 1–20');
  const frequencies = new Map(terms.map((term) => [term, bundle.concepts.filter((concept) => fieldsFor(concept).some(([text]) => queryTokens(text).includes(term))).length]));
  const results = bundle.concepts.filter((concept) => (!options.type || concept.metadata.type === options.type) && (!options.tag || concept.metadata.tags?.includes(options.tag)))
    .map((concept) => rankConcept(concept, terms, frequencies, bundle.concepts.length)).filter((result) => result.matchedTerms.length > 0)
    .sort((a, b) => b.score - a.score || compare(a.path, b.path));
  return { query: options.query, total: results.length, results: results.slice(0, limit), exitCode: results.length ? 0 : 1 };
}

export function contextKnowledge(bundle, result, io, registry = {}) {
  let evidenceBytes = 0;
  const evidenceCache = new Map();
  const provenance = registry.provenance?.knowledge?.inputs ?? {};
  const results = result.results.map((item) => {
    const concept = bundle.concepts.find((candidate) => candidate.path === item.path);
    const lines = concept.text.split('\n');
    const sectionStarts = lines.flatMap((line, index) => /^#+ /.test(line) ? [index] : []);
    const sections = [...new Set(item.snippets.map((snippet) => sectionStarts.filter((index) => index < snippet.line).at(-1)).filter((index) => index !== undefined))].slice(0, 2).map((start) => {
      const end = sectionStarts.find((index) => index > start) ?? lines.length;
      return { heading: lines[start].replace(/^#+ /, ''), line: start + 1, text: lines.slice(start, Math.min(end, start + 24)).join('\n').slice(0, 2400), truncated: end - start > 24 || lines.slice(start, Math.min(end, start + 24)).join('\n').length > 2400 };
    });
    const evidence = [...new Set(evidencePaths(concept, bundle.root))].filter((path) => !path.startsWith(bundle.root + '/')).slice(0, 24).map((path) => {
      check(!path.endsWith('AGENTS.md') && path !== 'docs/agents/CODE-MAP.md', `Knowledge evidence cannot cite generated guidance: ${path}`);
      if (!evidenceCache.has(path)) {
        try {
          const text = io.read(path); evidenceBytes += Buffer.byteLength(text);
          check(evidenceBytes <= MAX_EVIDENCE_BYTES, 'Context evidence exceeds 8 MiB total');
          evidenceCache.set(path, { path, hash: hash(text), freshness: provenance[path] === undefined ? 'untracked' : provenance[path] === hash(text) ? 'unchanged' : 'changed' });
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          evidenceCache.set(path, { path, freshness: 'missing' });
        }
      }
      return evidenceCache.get(path);
    });
    const modules = (registry.modules ?? []).filter((module) => concept.modules?.includes(module.id)).slice(0, 8).map((module) => ({ id: module.id, path: module.path, state: module.state, entrypoints: module.entrypoints?.slice(0, 8), tests: module.tests?.slice(0, 8) }));
    const architecture = (registry.docs ?? []).filter((doc) => !doc.path.startsWith(bundle.root + '/') && doc.modules?.some((id) => concept.modules?.includes(id))).map(({ path, status = 'reference', task }) => ({ path, status, task })).sort((a, b) => Number(b.status === 'accepted') - Number(a.status === 'accepted') || compare(a.path, b.path)).slice(0, 12);
    const conceptFreshness = provenance[concept.path] === undefined ? 'untracked' : provenance[concept.path] === hash(concept.text) ? 'unchanged' : 'changed';
    return { ...item, conceptFreshness, sections, evidence, evidenceTruncated: evidencePaths(concept, bundle.root).filter((path) => !path.startsWith(bundle.root + '/')).length > 24, modules, architecture };
  });
  return { ...result, results, freshnessMeaning: 'Hashes compare current files with the last generated provenance; unchanged does not attest semantic correctness or deployment.', bounded: { maximumSectionsPerResult: 2, maximumSectionCharacters: 2400, maximumEvidenceFilesPerResult: 24, maximumEvidenceBytes: MAX_EVIDENCE_BYTES } };
}
