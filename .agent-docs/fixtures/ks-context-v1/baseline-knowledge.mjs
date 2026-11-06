import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { load, JSON_SCHEMA } from '../../vendor/js-yaml.mjs';

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
    `From the workspace root: \`node ${config.id}/.agent-docs/cli.mjs search --repo ${config.id} --query "your terms"\`.`,
    'Concepts describe observed behavior; accepted source decisions remain authoritative. Check cited code/tests before changing behavior.', '',].join('\n');
  return { overview, files: [{ path: indexPath, content: renderIndex(bundle), block: 'knowledge-index', budgetBytes: 32768 }],
    inputs: Object.fromEntries([...cache].sort(([a], [b]) => compare(a, b)).map(([path, text]) => [path, hash(text)])), paths: bundle.concepts.map((concept) => concept.path) };
}

function rankConcept(concept, terms) {
  const { title, description, tags = [] } = concept.metadata;
  const lines = concept.text.split('\n');
  const fields = [[title, 12], [description, 8], [tags.join(' '), 10], [lines.filter((line) => /^#+ /.test(line)).join(' '), 6], [concept.text, 1]];
  const matched = terms.filter((term) => concept.text.toLowerCase().includes(term));
  const score = matched.length * 20 + fields.reduce((sum, [text, weight]) => sum + terms.filter((term) => text.toLowerCase().includes(term)).length * weight, 0);
  const snippets = lines.map((text, index) => ({ line: index + 1, text: text.slice(0, 280) }))
    .filter((item) => item.line > concept.bodyStart && terms.some((term) => item.text.toLowerCase().includes(term)))
    .sort((a, b) => terms.filter((term) => b.text.toLowerCase().includes(term)).length - terms.filter((term) => a.text.toLowerCase().includes(term)).length || a.line - b.line).slice(0, 3);
  return { path: concept.path, id: concept.id, title, type: concept.metadata.type, status: concept.status ?? 'reference', score, matchedTerms: matched, snippets };
}

export function searchKnowledge(bundle, options) {
  check(typeof options.query === 'string' && options.query.trim().length > 0 && options.query.length <= 200, 'Search requires a query of 1–200 characters');
  const terms = [...new Set(options.query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
  check(terms.length > 0, 'Search query needs at least one word');
  const limit = options.limit ?? 5;
  check(Number.isInteger(limit) && limit >= 1 && limit <= 20, 'Search limit must be 1–20');
  const results = bundle.concepts.filter((concept) => (!options.type || concept.metadata.type === options.type) && (!options.tag || concept.metadata.tags?.includes(options.tag)))
    .map((concept) => rankConcept(concept, terms)).filter((result) => result.matchedTerms.length > 0)
    .sort((a, b) => b.score - a.score || compare(a.path, b.path));
  return { query: options.query, total: results.length, results: results.slice(0, limit), exitCode: results.length ? 0 : 1 };
}
