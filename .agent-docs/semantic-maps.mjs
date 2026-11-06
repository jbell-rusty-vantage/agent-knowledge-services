import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const MAX_MODULES = 120;
const MAX_SOURCE_FILES = 512;
// Raised from 128 KiB on 2026-10-25 (Sprint V): four new packages (K01, K02/K03, K09, K05) left 382 bytes of headroom.
const MAX_MAP_BYTES = 160 * 1024;
const hash = (text) => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
const unique = (items) => [...new Set(items)].sort();
const list = (items) => items.length ? items.join(', ') : 'none declared';
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 1200 && !/[\r\n|]/.test(value);
const sourceLink = (path) => `[\`${path}\`](../../${path})`;

function validate(manifest) {
  check(manifest.version === 1, 'Unsupported semantic map version');
  check(Array.isArray(manifest.modules) && manifest.modules.length > 0 && manifest.modules.length <= MAX_MODULES, 'Invalid semantic module list');
  check(Array.isArray(manifest.groups) && manifest.groups.length <= 20, 'Invalid semantic groups');
  check(Array.isArray(manifest.routes) && manifest.routes.length <= 12, 'Invalid semantic routes');
  const ids = manifest.modules.map((module) => module.id);
  check(ids.every((id) => /^[a-z0-9-]+$/.test(id)) && new Set(ids).size === ids.length, 'Duplicate or invalid semantic module ID');
  check(new Set(manifest.groups.map((group) => group.path)).size === manifest.groups.length, 'Duplicate semantic group');
  for (const group of manifest.groups) {
    check(text(group.path) && text(group.summary) && ['none', 'directories'].includes(group.inventory), 'Invalid semantic group');
  }
  for (const module of manifest.modules) {
    check(text(module.path) && text(module.summary) && text(module.kind), `Invalid semantic module: ${module.id}`);
    check(['implemented', 'partial', 'reserved', 'legacy'].includes(module.state), `Invalid implementation state: ${module.id}`);
    check(manifest.groups.some((group) => module.path === group.path || module.path.startsWith(`${group.path}/`)), `Module lacks a group: ${module.id}`);
    for (const field of ['entrypoints', 'tests', 'interface', 'constraints', 'uses']) {
      check(Array.isArray(module[field]) && module[field].length <= 12 && module[field].every(text), `Invalid ${field}: ${module.id}`);
    }
    check(module.state === 'reserved' || module.entrypoints.length > 0, `Implemented modules require source entrypoints: ${module.id}`);
    check(module.uses.every((id) => ids.includes(id) && id !== module.id), `Unknown semantic dependency: ${module.id}`);
    check(!module.packageJson || text(module.packageJson), `Invalid package manifest: ${module.id}`);
  }
  for (const route of manifest.routes) check(text(route.task) && Array.isArray(route.modules) && route.modules.length > 0 && route.modules.every((id) => ids.includes(id)), 'Invalid semantic task route');
}

function packageFacts(module, read) {
  if (!module.packageJson) return { dependencies: [], name: undefined, exports: [], scripts: [] };
  const pkg = JSON.parse(read(module.packageJson));
  const exported = pkg.exports;
  const subpaths = exported && typeof exported === 'object' && Object.keys(exported).some((key) => key.startsWith('.')) ? Object.keys(exported) : exported ? ['.'] : [];
  return { name: pkg.name, dependencies: unique(Object.keys(pkg.dependencies ?? {})), exports: unique(subpaths), scripts: unique(Object.keys(pkg.scripts ?? {})) };
}

function moduleSection(module, context) {
  const facts = context.facts.get(module.id);
  const localDependencies = facts.dependencies.filter((name) => context.packageOwners.has(name)).map((name) => context.packageOwners.get(name));
  const external = facts.dependencies.filter((name) => !context.packageOwners.has(name));
  const docs = context.docs.filter((doc) => doc.modules?.includes(module.id));
  return [
    `## ${module.id}`, '', `**${module.path}** · ${module.kind} · ${module.state}`, '', module.summary, '',
    `**Enter:** ${module.entrypoints.length ? module.entrypoints.map(sourceLink).join(', ') : 'Reserved directory; no implementation entrypoint registered.'}`,
    `**Interface:** ${list(module.interface)}`,
    `**Package:** ${facts.name ?? 'not a standalone package'}${module.packageJson ? ` (${sourceLink(module.packageJson)})` : ''}`,
    `**Export subpaths:** ${list(facts.exports)}. Declared metadata; build outputs are not read.`,
    `**Declared internal package dependencies:** ${list(localDependencies.map((id) => `[${id}](#${id})`))}`,
    `**Other runtime dependencies:** ${list(external)}`,
    `**Reviewed runtime/data relationships:** ${list(module.uses.map((id) => `[${id}](#${id})`))}`,
    `**Checks:** ${module.tests.length ? module.tests.map(sourceLink).join(', ') : 'No specific test anchor registered.'}${facts.scripts.length ? ` Package script names: ${facts.scripts.join(', ')}.` : ''}`,
    ...module.constraints.map((rule) => `- ${rule}`), '',
    '**Architecture and detailed docs:**', '',
    ...(docs.length ? docs.map((doc) => `- [${doc.status ?? 'reference'}] ${sourceLink(doc.path)} — ${doc.task}`) : ['No module-specific architecture document registered. Do not infer a design decision from the folder name.']), '',
  ].join('\n');
}

function renderMap(manifest, context) {
  return [
    '# Semantic code map', '',
    'Generated from reviewed module descriptions and current selected source files. Package dependencies/exports/script names are extracted from manifests; relationships and ownership are authored. This is not a complete import graph or proof that a designed capability is implemented.', '',
    'Paths below are repository-relative. Use the task routes, then search the module heading. Follow accepted architecture docs for decisions; proposed/reference/deprecated documents retain those labels.', '',
    '## Task routes', '', ...manifest.routes.map((route) => `- ${route.task}: ${route.modules.map((id) => `[${id}](#${id})`).join(' → ')}`), '',
    '## Modules', '', '| Module | Source | Responsibility | State |', '|---|---|---|---|',
    ...manifest.modules.map((module) => `| [${module.id}](#${module.id}) | ${module.path} | ${module.summary} | ${module.state} |`), '',
    ...manifest.modules.map((module) => moduleSection(module, context)),
  ].join('\n');
}

export function planSemanticMaps(config, io) {
  if (!config.codeMap) return { overview: '', files: [], inputs: {}, inventories: {}, unknown: [], modules: [] };
  check(config.codeMap === '.agent-docs/modules.json', 'Semantic manifest must be .agent-docs/modules.json');
  const cache = new Map();
  const read = (path) => {
    if (!cache.has(path)) {
      check(cache.size < MAX_SOURCE_FILES, 'Too many semantic source files');
      cache.set(path, io.read(path));
    }
    return cache.get(path);
  };
  const manifest = JSON.parse(read(config.codeMap));
  validate(manifest);
  const facts = new Map();
  for (const module of manifest.modules) {
    io.directory(module.path);
    for (const path of [...module.entrypoints, ...module.tests]) read(path);
    facts.set(module.id, packageFacts(module, read));
  }
  const ids = new Set(manifest.modules.map((module) => module.id));
  for (const doc of config.docs) {
    check(doc.path !== 'docs/agents/CODE-MAP.md' && !doc.path.endsWith('AGENTS.md'), `Generated instruction/map files cannot be source documents: ${doc.path}`);
    check(['accepted', 'proposed', 'deprecated', 'reference'].includes(doc.status ?? 'reference'), `Invalid architecture status: ${doc.path}`);
    check(!doc.modules || (Array.isArray(doc.modules) && doc.modules.every((id) => ids.has(id))), `Unknown architecture module: ${doc.path}`);
  }
  const packageOwners = new Map();
  for (const module of manifest.modules) {
    const factsForModule = facts.get(module.id);
    // Several logical modules may share a root package; do not invent ownership for it.
    if (module.packageJson === `${module.path}/package.json` && factsForModule.name) {
      check(!packageOwners.has(factsForModule.name), `Duplicate package name: ${factsForModule.name}`);
      packageOwners.set(factsForModule.name, module.id);
    }
  }
  const inventories = {};
  const unknown = [];
  const files = [];
  for (const group of manifest.groups) {
    io.directory(group.path);
    if (group.inventory === 'directories') {
      const children = io.childDirectories(group.path);
      inventories[group.path] = children;
      for (const name of children) {
        const path = `${group.path}/${name}`;
        if (!manifest.modules.some((module) => module.path === path)) unknown.push(path);
      }
    }
    const modules = manifest.modules.filter((module) => {
      const owners = manifest.groups.filter((candidate) => module.path === candidate.path || module.path.startsWith(`${candidate.path}/`)).sort((left, right) => right.path.length - left.path.length);
      return owners[0]?.path === group.path;
    });
    const mapPath = posix.relative(group.path, 'docs/agents/CODE-MAP.md');
    const content = [`## Code navigation: ${group.path}`, '', group.summary, '', `Full interfaces, dependencies, tests, and architecture: [semantic map](${mapPath}). Paths in the rows below are repository-relative.`, '', '| Module | Responsibility | Enter |', '|---|---|---|', ...modules.map((module) => `| [${module.id}](${mapPath}#${module.id}) | ${module.summary} | ${module.entrypoints[0] ?? 'reserved'} |`), '', 'Descriptions are maintained in `.agent-docs/modules.json` at the repository root. Do not edit this generated block.', ''].join('\n');
    files.push({ path: `${group.path}/AGENTS.md`, content, block: 'semantic-map', budgetBytes: 8192 });
  }
  const content = renderMap(manifest, { facts, packageOwners, docs: config.docs });
  check(Buffer.byteLength(content) <= MAX_MAP_BYTES, 'Semantic map exceeds 160 KiB');
  files.push({ path: 'docs/agents/CODE-MAP.md', content, block: 'semantic-map', budgetBytes: MAX_MAP_BYTES });
  const overview = ['### Code navigation', '', 'Read `docs/agents/CODE-MAP.md` for source entrypoints, interfaces, dependencies, tests, and architecture by module.', '', ...manifest.groups.map((group) => `- \`${group.path}/AGENTS.md\`: ${group.summary}`), ...manifest.routes.map((route) => `- ${route.task}: ${route.modules.join(' → ')}`), ''].join('\n');
  return { overview, files, inputs: Object.fromEntries([...cache].sort(([a], [b]) => a.localeCompare(b)).map(([path, value]) => [path, hash(value)])), inventories, unknown, modules: manifest.modules.map(({ id, path }) => ({ id, path })) };
}
