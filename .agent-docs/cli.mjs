#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, opendirSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planSemanticMaps } from './semantic-maps.mjs';
import { planKnowledge, readKnowledge, searchKnowledge, contextKnowledge } from './knowledge.mjs';

export const VERSION = '1.2.0';
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_INPUTS = 100;
const MAX_REPOS = 40;
const MAX_RUN_MS = 30000;
const CONFIG = '.agent-docs/config.json';
const PROVENANCE = '.agent-docs/provenance.json';
const LOCAL_CLI = '.agent-docs/cli.mjs';
const WORKSPACE_CONFIG = 'ai-engineer-meta/docs/agents/workspace/workspace.json';
const BLOCKED = /^(?:\.env(?:\..*)?|\.git|node_modules|\.venv|venv|\.firecrawl|\.eve|\.next|\.temp|dist|build|coverage|artifacts?|outputs?|receipts?|runs?|ai-intelligence-vault|__pycache__|credentials\.json|token\.json)$/i;
const SECRET_EXTENSION = /\.(?:pem|key|pfx|p12)$/i;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const normalize = (text) => text.replace(/\r\n/g, '\n');
const sorted = (items) => [...items].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const semanticGenerator = readFileSync(new URL('./semantic-maps.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const supportFiles = [
  "knowledge.mjs",
  "vendor/js-yaml.mjs",
  "vendor/js-yaml.LICENSE",
  "vendor/README.md",
  "retrieval.test.mjs",
  "retrieval-benchmark.mjs",
  "fixtures/ks-context-v1/manifest.json",
  "fixtures/ks-context-v1/queries.json",
  "fixtures/ks-context-v1/README.md",
  "fixtures/ks-context-v1/baseline-knowledge.mjs",
  "fixtures/ks-context-v1/knowledge/service-boundaries.md",
  "fixtures/ks-context-v1/knowledge/schema-read-and-ingestion.md",
  "fixtures/ks-context-v1/knowledge/preparation-and-publication.md",
  "fixtures/ks-context-v1/knowledge/retrieval-and-evidence.md",
  "fixtures/ks-context-v1/knowledge/verification-and-admission.md",
  "fixtures/ks-context-v1/knowledge/durable-execution-and-recovery.md"
];
const supportSources = Object.fromEntries(supportFiles.map((path) => [path, normalize(readFileSync(new URL(path, import.meta.url), 'utf8'))]));

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function safePath(root, path) {
  requireValue(typeof path === 'string' && path.length > 0 && path.length < 400, 'Invalid path');
  requireValue(!isAbsolute(path) && !path.includes('\\'), `Use a relative slash-separated path: ${path}`);
  const parts = path.split('/');
  requireValue(parts.every((part) => part && part !== '.' && part !== '..' && !/[<>:"|?*\x00-\x1f{}]/.test(part)), `Unsafe path: ${path}`);
  requireValue(parts.every((part) => !BLOCKED.test(part) && !SECRET_EXTENSION.test(part)), `Excluded path: ${path}`);
  const absolute = resolve(root, ...parts);
  requireValue(relative(root, absolute) !== '' && !relative(root, absolute).startsWith(`..${sep}`), `Path escapes root: ${path}`);
  let current = root;
  for (const part of parts) {
    current = resolve(current, part);
    if (existsSync(current)) requireValue(!lstatSync(current).isSymbolicLink(), `Symlinks are not read or written: ${path}`);
  }
  return absolute;
}

function read(root, path) {
  const absolute = safePath(root, path);
  const stat = lstatSync(absolute);
  requireValue(stat.isFile() && stat.size <= MAX_FILE_BYTES, `Input must be a file <= ${MAX_FILE_BYTES} bytes: ${path}`);
  return readFileSync(absolute, 'utf8');
}

function readOptional(root, path) {
  return existsSync(safePath(root, path)) ? read(root, path) : '';
}

function parse(root, path) {
  try { return JSON.parse(read(root, path)); }
  catch (error) { throw new Error(`${path}: ${error.message}`); }
}

function directory(root, path) {
  requireValue(lstatSync(safePath(root, path)).isDirectory(), `Expected a source directory: ${path}`);
}

function childDirectories(root, path) {
  const handle = opendirSync(safePath(root, path));
  const names = [];
  let count = 0;
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      requireValue(++count <= 512, `Source group exceeds 512 immediate entries: ${path}`);
      if (!entry.name.startsWith('.') && !BLOCKED.test(entry.name)) {
        requireValue(!entry.isSymbolicLink(), `Symlink in source inventory: ${path}/${entry.name}`);
        if (entry.isDirectory()) names.push(entry.name);
      }
    }
  } finally { handle.closeSync(); }
  return sorted(names);
}

function childFiles(root, path) {
  const handle = opendirSync(safePath(root, path));
  const names = [];
  let count = 0;
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      requireValue(++count <= 512, `Knowledge directory exceeds 512 immediate entries: ${path}`);
      requireValue(!entry.isSymbolicLink(), `Symlink in knowledge directory: ${path}/${entry.name}`);
      requireValue(!entry.isDirectory(), `Knowledge navigation profile uses a flat directory: ${path}/${entry.name}`);
      if (entry.isFile()) names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  return sorted(names);
}

function validateConfig(config) {
  requireValue(config.version === 1, 'Unsupported manifest version');
  requireValue(typeof config.id === 'string' && /^[a-z0-9_-]+$/.test(config.id), 'Invalid repository identity');
  for (const field of ['purpose', 'lifecycle']) {
    requireValue(typeof config[field] === 'string' && config[field].length > 0 && config[field].length < 800, `Invalid ${field}`);
  }
  for (const field of ['rules', 'commands', 'docs', 'watch', 'decisions']) {
    requireValue(Array.isArray(config[field]) && config[field].length <= MAX_INPUTS, `Invalid ${field} list`);
  }
  requireValue(Number.isInteger(config.budgetBytes) && config.budgetBytes > 0 && config.budgetBytes <= 16384, 'Invalid instruction budget');
  for (const field of ['rules', 'commands', 'watch', 'decisions']) {
    requireValue(config[field].every((item) => typeof item === 'string' && item.length > 0 && item.length < 2000), `Invalid ${field} entry`);
  }
  requireValue(config.docs.length > 0 && config.docs.every((doc) => typeof doc.path === 'string' && typeof doc.task === 'string' && doc.task.length > 0), 'Invalid documentation routes');
  requireValue(config.docs.every((doc) => doc.navigation === undefined || typeof doc.navigation === 'boolean'), 'Document navigation must be boolean');
  requireValue(new Set(config.docs.map((doc) => doc.path)).size === config.docs.length, 'Duplicate documentation path');
}

function compactIndex(docs) {
  const groups = new Map();
  for (const path of sorted(docs.map((doc) => doc.path))) {
    const slash = path.lastIndexOf('/');
    const directory = slash < 0 ? '.' : path.slice(0, slash);
    const filename = path.slice(slash + 1);
    groups.set(directory, [...(groups.get(directory) ?? []), filename]);
  }
  return [...groups].map(([directory, files]) => `|${directory}:{${files.join(',')}}`).join('\n');
}

function renderRepository(config, semantic, knowledge) {
  const routes = config.docs.filter((doc) => doc.navigation !== false && !knowledge.paths.includes(doc.path));
  return [
    '## Repository guide', '', config.purpose, '', `Lifecycle: ${config.lifecycle}`, '',
    'Read the relevant documents below before changing behavior. Inspect more-specific AGENTS.md files in the destination directory. Accepted docs record settled decisions; proposed, reference, and deprecated docs are labelled context. The map is navigation, not proof of implementation or deployment.', '',
    ...config.rules.map((rule) => `- ${rule}`), '',
    knowledge.overview,
    semantic.overview,
    '### Task routes', '', ...routes.map((doc) => `- ${doc.status ? `[${doc.status}] ` : ''}${doc.task}: \`${doc.path}\``), '',
    '### Validation', '', 'Run from this repository root; choose checks relevant to the change. Commands are documented here, never executed by the documentation updater.', '',
    ...config.commands.map((command) => `- \`${command}\``), '',
    'Documentation: `node .agent-docs/cli.mjs check --repo .`; refresh with `node .agent-docs/cli.mjs build --repo .`. Edit `.agent-docs/config.json` to change this guide.', '',
    '[Docs index]|root:.', compactIndex(routes), '',
  ].join('\n');
}

export function replaceBlock(original, content, name) {
  const start = `<!-- BEGIN GENERATED: ${name} -->`;
  const end = `<!-- END GENERATED: ${name} -->`;
  const starts = original.split(start).length - 1;
  const ends = original.split(end).length - 1;
  requireValue((original.split(`BEGIN GENERATED: ${name}`).length - 1) === starts && (original.split(`END GENERATED: ${name}`).length - 1) === ends, `Malformed ${name} markers`);
  requireValue(starts === ends && starts <= 1, `Malformed ${name} markers`);
  const block = `${start}\n${normalize(content).trimEnd()}\n${end}`;
  if (!starts) return `${original}${original ? (original.endsWith('\n') ? '\n' : '\n\n') : ''}${block}\n`;
  const first = original.indexOf(start);
  const last = original.indexOf(end);
  requireValue(last > first, `Reversed ${name} markers`);
  return original.slice(0, first) + block + original.slice(last + end.length);
}

function makeOutput(root, path, content) {
  const previous = readOptional(root, path);
  return { root, path, previous, content, changed: normalize(previous) !== normalize(content) };
}

function ensureBudget(content, budget, label) {
  requireValue(Buffer.byteLength(content) <= budget, `${label} exceeds ${budget}-byte budget (${Buffer.byteLength(content)})`);
}

function provenance(config, generator, readSource) {
  const paths = sorted(new Set([CONFIG, ...config.docs.map((doc) => doc.path), ...config.watch]));
  requireValue(paths.length <= MAX_INPUTS, 'Too many selected inputs');
  const inputs = Object.fromEntries(paths.map((path) => [path, hash(normalize(readSource(path)))]));
  return { version: 1, generator: { version: VERSION, sha256: hash(generator), semanticSha256: hash(semanticGenerator), supportSha256: Object.fromEntries(Object.entries(supportSources).map(([path, text]) => [path, hash(text)])) }, sourceState: 'Filesystem snapshot; may include uncommitted changes. No deployment or commit claim.', inputs };
}

function planRepository(root, generator, snapshots = []) {
  const config = parse(root, CONFIG);
  validateConfig(config);
  const readSource = (path) => snapshots.find((item) => item.path === path)?.content ?? read(root, path);
  const sources = provenance(config, generator, readSource);
  const knowledge = planKnowledge(config, { read: readSource, directory: (path) => directory(root, path), files: (path) => childFiles(root, path) });
  if (config.knowledge) sources.knowledge = { inputs: knowledge.inputs };
  const semantic = planSemanticMaps(config, { read: readSource, directory: (path) => directory(root, path), childDirectories: (path) => childDirectories(root, path) });
  if (config.codeMap) sources.semantic = { inputs: semantic.inputs, inventories: semantic.inventories };
  const instructions = replaceBlock(readOptional(root, 'AGENTS.md'), renderRepository(config, semantic, knowledge), 'agent-docs');
  ensureBudget(instructions, config.budgetBytes, `${config.id}/AGENTS.md`);
  const outputs = [makeOutput(root, 'AGENTS.md', instructions), makeOutput(root, PROVENANCE, json(sources)), makeOutput(root, '.agent-docs/.gitignore', 'update.lock\naudit-state.json\naudit-report.json\n*.tmp\n'), ...snapshots.map((item) => makeOutput(root, item.path, item.content))];
  for (const file of [...semantic.files, ...knowledge.files]) {
    const content = replaceBlock(readOptional(root, file.path), file.content, file.block);
    ensureBudget(content, file.budgetBytes, `${config.id}/${file.path}`);
    outputs.push(makeOutput(root, file.path, content));
  }
  outputs.push(makeOutput(root, '.agent-docs/semantic-maps.mjs', semanticGenerator));
  for (const [path, text] of Object.entries(supportSources)) outputs.push(makeOutput(root, `.agent-docs/${path}`, text));
  if (normalize(readOptional(root, LOCAL_CLI)) !== generator) outputs.push(makeOutput(root, LOCAL_CLI, generator));
  const adapter = readOptional(root, 'CLAUDE.md');
  if (!adapter) outputs.push(makeOutput(root, 'CLAUDE.md', '@AGENTS.md\n'));
  else requireValue(adapter.includes('AGENTS.md'), `${config.id}/CLAUDE.md has no AGENTS.md route; reconcile authored instructions`);
  const workflow = config.ciWorkflow;
  if (workflow) {
    requireValue(workflow === '.github/workflows/agent-docs.yml', 'Unexpected CI workflow target');
    const previous = readOptional(root, workflow);
    requireValue(!previous || previous.startsWith('# Generated by agent-docs'), `Refusing to replace authored workflow: ${workflow}`);
    outputs.push(makeOutput(root, workflow, renderCI(config.id)));
  }
  return { config, outputs, inputsRead: new Set([...Object.keys(sources.inputs), ...Object.keys(semantic.inputs), ...Object.keys(knowledge.inputs)]).size, bytes: Buffer.byteLength(instructions), semantic };
}

function renderCI(id) {
  const tests = id === 'ai-engineer-meta' ? '      - run: node --test tools/agent-docs/cli.test.mjs\n' : '';
  return `# Generated by agent-docs ${VERSION}; source: ai-engineer-meta/tools/agent-docs/cli.mjs\nname: Agent documentation\non:\n  pull_request:\n  push:\n    branches: [main, master]\n  workflow_dispatch:\npermissions:\n  contents: read\njobs:\n  docs:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n    steps:\n      - uses: actions/checkout@v4\n      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n      - run: node .agent-docs/cli.mjs check --repo .\n${tests}`;
}

function planWorkspace(root, generator) {
  const workspace = parse(root, WORKSPACE_CONFIG);
  requireValue(workspace.version === 1 && Array.isArray(workspace.repositories) && workspace.repositories.length <= MAX_REPOS, 'Invalid workspace manifest');
  const paths = workspace.repositories.map((repo) => repo.path);
  requireValue(paths.every((path) => typeof path === 'string' && !path.includes('/')) && new Set(paths).size === paths.length, 'Duplicate or invalid repository directories');
  requireValue(Array.isArray(workspace.otherDirectories) && workspace.otherDirectories.length <= MAX_INPUTS, 'Invalid workspace directory inventory');
  requireValue(Number.isInteger(workspace.budgetBytes) && workspace.budgetBytes > 0 && workspace.budgetBytes <= 16384, 'Invalid workspace instruction budget');
  const plans = workspace.repositories.map((repo) => {
    requireValue(Array.isArray(repo.snapshots ?? []) && (repo.snapshots ?? []).length <= MAX_INPUTS, 'Invalid snapshot list');
    const snapshots = (repo.snapshots ?? []).map((item) => {
      requireValue(typeof item.target === 'string' && item.target.startsWith('docs/agents/shared/') && item.target.endsWith('.md'), 'Shared snapshots must target docs/agents/shared/*.md');
      const source = normalize(read(root, item.source));
      const content = `<!-- Generated documentation snapshot; source: ${item.source}; sha256: ${hash(source)} -->\n\n${source}`;
      return { path: item.target, content };
    });
    requireValue(snapshots.length <= MAX_INPUTS && new Set(snapshots.map((item) => item.path)).size === snapshots.length, 'Invalid snapshot list');
    const repoRoot = safePath(root, repo.path);
    for (const item of snapshots) {
      const previous = readOptional(repoRoot, item.path);
      requireValue(!previous || previous.startsWith('<!-- Generated documentation snapshot;'), `Refusing to replace authored snapshot target: ${item.path}`);
    }
    const plan = planRepository(repoRoot, generator, snapshots);
    requireValue(plan.config.id === repo.path, `Identity mismatch: ${repo.path}`);
    return plan;
  });
  const intro = read(root, workspace.template);
  const rows = plans.map(({ config }) => `| ${config.id}/ | ${config.purpose} | ${config.id}/AGENTS.md |`);
  const map = [intro.trimEnd(), '', '## Codebase map', '', '| Directory | Responsibility | Start |', '|---|---|---|', ...rows, '', '## Other workspace directories', '', ...workspace.otherDirectories.map((item) => `- \`${item.path}/\`: ${item.purpose}`), ''].join('\n');
  const instructions = replaceBlock(readOptional(root, 'AGENTS.md'), map, 'workspace-docs');
  ensureBudget(instructions, workspace.budgetBytes, 'Root AGENTS.md');
  const rootSources = Object.fromEntries([WORKSPACE_CONFIG, workspace.template, ...paths.map((path) => `${path}/${CONFIG}`)].map((path) => [path, hash(normalize(read(root, path)))]));
  const rootProvenance = { version: 1, generator: { version: VERSION, sha256: hash(generator) }, sourceState: 'Local workspace filesystem; may include uncommitted changes.', inputs: rootSources };
  const outputs = [...plans.flatMap((plan) => plan.outputs), makeOutput(root, 'AGENTS.md', instructions), makeOutput(root, 'ai-engineer-meta/docs/agents/workspace/provenance.json', json(rootProvenance))];
  if (!readOptional(root, 'CLAUDE.md')) outputs.push(makeOutput(root, 'CLAUDE.md', '@AGENTS.md\n'));
  const known = new Set([...paths, ...workspace.otherDirectories.map((item) => item.path)]);
  const unknown = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !known.has(entry.name)).map((entry) => entry.name);
  return { plans, outputs, unknown: sorted(unknown), rootBytes: Buffer.byteLength(instructions) };
}

function acquireLocks(roots) {
  const held = [];
  try {
    for (const root of sorted(new Set(roots))) {
      const path = safePath(root, '.agent-docs/update.lock');
      mkdirSync(dirname(path), { recursive: true });
      const handle = openSync(path, 'wx');
      closeSync(handle);
      held.push(path);
    }
    return held;
  } catch (error) {
    for (const path of held) rmSync(path);
    throw new Error(`Could not acquire documentation lock; check for a live updater before removing a stale lock. ${error.code ?? ''}`);
  }
}

function writeOutputs(outputs) {
  const staged = [];
  const written = [];
  try {
    for (const output of outputs.filter((item) => item.changed)) {
      requireValue(readOptional(output.root, output.path) === output.previous, `File changed during update: ${output.path}`);
      const target = safePath(output.root, output.path);
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      writeFileSync(temporary, output.content, { flag: 'wx' });
      staged.push({ ...output, target, temporary, existed: existsSync(target) });
    }
    for (const item of staged) {
      requireValue(readOptional(item.root, item.path) === item.previous, `File changed during update: ${item.path}`);
      renameSync(item.temporary, item.target);
      written.push(item);
    }
  } catch (error) {
    for (const item of written.reverse()) {
      if (readOptional(item.root, item.path) !== item.content) continue;
      if (item.existed) writeFileSync(item.target, item.previous);
      else rmSync(item.target);
    }
    throw error;
  } finally {
    for (const item of staged) if (existsSync(item.temporary)) rmSync(item.temporary);
  }
}

export function run(options) {
  const started = Date.now();
  requireValue(['check', 'build', 'audit'].includes(options.command), 'Command must be check, build, or audit');
  requireValue(['repo', 'workspace'].includes(options.scope), 'Choose --repo or --workspace');
  const root = resolve(options.root);
  requireValue(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Root must be a real directory');
  const generator = normalize(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  const getPlan = () => options.scope === 'workspace' ? planWorkspace(root, generator) : (() => {
    const plan = planRepository(root, generator);
    return { plans: [plan], outputs: plan.outputs, unknown: [], rootBytes: 0 };
  })();
  const plan = getPlan();
  requireValue(Date.now() - started < MAX_RUN_MS, 'Documentation planning exceeded time limit');
  const drift = plan.outputs.filter((output) => output.changed).map((output) => relative(root, resolve(output.root, output.path)).split(sep).join('/'));
  const decisions = plan.plans.flatMap(({ config }) => config.decisions.map((description) => ({ repository: config.id, description })));
  const unmappedModules = plan.plans.flatMap(({ config, semantic }) => semantic.unknown.map((path) => `${config.id}/${path}`));
  if (options.command === 'build') {
    const locks = acquireLocks(plan.outputs.map((output) => output.root));
    try {
      const lockedPlan = getPlan();
      requireValue(Date.now() - started < MAX_RUN_MS, 'Documentation planning exceeded time limit');
      writeOutputs(lockedPlan.outputs);
    } finally { for (const lock of locks) rmSync(lock); }
  }
  const findings = options.command === 'audit' ? decisions : [];
  const exitCode = (options.command !== 'build' && drift.length > 0) || plan.unknown.length > 0 || unmappedModules.length > 0 || findings.length > 0 ? 1 : 0;
  return {
    version: VERSION, command: options.command, exitCode,
    changed: options.command === 'build' ? drift : [], drift: options.command === 'build' ? [] : drift,
    unknownDirectories: plan.unknown, unmappedModules, decisions: findings,
    semanticModules: Object.fromEntries(plan.plans.map(({ config, semantic }) => [config.id, semantic.modules.length])),
    instructionBytes: { workspace: plan.rootBytes, repositories: Object.fromEntries(plan.plans.map((item) => [item.config.id, item.bytes])) },
    inputsRead: plan.plans.reduce((sum, item) => sum + item.inputsRead, 0),
    scanning: 'Explicit files plus bounded immediate-directory inventories of registered source groups. No recursive traversal.',
  };
}

export function search(options) {
  const root = resolve(options.root);
  requireValue(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Root must be a real directory');
  const config = parse(root, CONFIG);
  validateConfig(config);
  requireValue(config.knowledge, 'No knowledge bundle registered for this repository');
  const bundle = readKnowledge(config, { read: (path) => read(root, path), directory: (path) => directory(root, path) });
  if (options.command === 'context') requireValue((options.limit ?? 5) <= 5, 'Context limit must be 1–5');
  const result = searchKnowledge(bundle, options);
  if (options.command !== 'context') return result;
  const modules = config.codeMap ? parse(root, config.codeMap).modules : [];
  const provenance = existsSync(safePath(root, PROVENANCE)) ? parse(root, PROVENANCE) : {};
  return contextKnowledge(bundle, result, { read: (path) => read(root, path) }, { modules, provenance, docs: config.docs });
}

function parseArgs(args) {
  const [command, ...rest] = args;
  const options = { command, scope: undefined, root: undefined, format: 'text' };
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    requireValue(value && !value.startsWith('--'), `Missing value for ${flag}`);
    if (flag === '--format') {
      requireValue(['json', 'text'].includes(value), 'Format must be json or text');
      options.format = value;
    } else if (['--query', '--type', '--tag', '--limit'].includes(flag)) {
      requireValue(['search', 'context'].includes(command), `${flag} is only supported by search`);
      options[flag.slice(2)] = flag === '--limit' ? Number(value) : value;
    } else {
      requireValue(['--repo', '--workspace'].includes(flag) && !options.scope, 'Specify exactly one --repo or --workspace');
      options.scope = flag.slice(2);
      options.root = value;
    }
  }
  requireValue(options.root, 'Usage: node cli.mjs check|build|audit --repo PATH|--workspace PATH [--format json]');
  requireValue(!['search', 'context'].includes(command) || options.scope === 'repo', 'Search requires --repo');
  return options;
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = ['search', 'context'].includes(options.command) ? search(options) : run(options);
    if (options.format === 'json') process.stdout.write(json(result));
    else if (['search', 'context'].includes(options.command)) {
      for (const item of result.results) {
        process.stdout.write(`${item.path} — ${item.title} [${item.type}; ${item.status}]\n`);
        for (const snippet of item.snippets) process.stdout.write(`  ${item.path}:${snippet.line}: ${snippet.text}\n`);
      }
      if (!result.results.length) process.stdout.write('No matching knowledge concepts. Try a shorter domain term or read knowledge/index.md.\n');
    }
    else {
      process.stdout.write(`agent-docs ${result.command}: ${result.exitCode === 0 ? 'clean' : 'findings'}; ${result.inputsRead} selected inputs\n`);
      for (const path of result.changed) process.stdout.write(`updated: ${path}\n`);
      for (const path of result.drift) process.stdout.write(`drift: ${path}\n`);
      for (const path of result.unknownDirectories) process.stdout.write(`unclassified directory: ${path}\n`);
      for (const path of result.unmappedModules) process.stdout.write(`unmapped code module: ${path}\n`);
      for (const item of result.decisions) process.stdout.write(`open decision [${item.repository}]: ${item.description}\n`);
    }
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(json({ exitCode: 2, error: error.message }));
    process.exitCode = 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
