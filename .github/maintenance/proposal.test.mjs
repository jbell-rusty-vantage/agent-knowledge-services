import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, renameSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectProposal, publishProposal } from './proposal.mjs';
import { requestKey } from './dispatch.mjs';

function requestFor(head = 'a'.repeat(40), task = 'docs') {
  const request = { schemaVersion: 1, repository: 'owner/repo', base: 'b'.repeat(40), head,
    number: 1, pullRequest: false, baseBranch: 'main', provider: 'codex', task,
    eventId: '123', policyVersion: 'knowledge-maintenance/1' };
  return { ...request, key: requestKey(request) };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ks-proposal-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'user.name', 'Fixture');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'docs', 'guide.md'), 'original\n');
  git('add', '.');
  git('commit', '-qm', 'fixture');
  return { root, repo, git, request: requestFor(git('rev-parse', 'HEAD').trim()) };
}

test('collects deletions and new UTF-8 text', t => {
  const { repo, request } = fixture(t);
  unlinkSync(join(repo, 'docs', 'guide.md'));
  writeFileSync(join(repo, 'docs', 'new.md'), 'café \uFFFD\n');
  assert.deepEqual(collectProposal(repo, request).files, [
    { path: 'docs/guide.md', deleted: true },
    { path: 'docs/new.md', content: 'café \uFFFD\n', mode: '100644' },
  ]);
});

test('preserves the indexed executable mode for a staged tracked edit', t => {
  const { repo, git } = fixture(t);
  git('update-index', '--chmod=+x', 'docs/guide.md');
  git('commit', '-qm', 'executable');
  const request = requestFor(git('rev-parse', 'HEAD').trim());
  writeFileSync(join(repo, 'docs', 'guide.md'), 'updated\n');
  git('add', 'docs/guide.md');
  git('update-index', '--chmod=+x', 'docs/guide.md');
  assert.equal(collectProposal(repo, request).files[0].mode, '100755');
});

test('rejects forbidden untracked files', t => {
  const { repo, request } = fixture(t);
  mkdirSync(join(repo, '.github'));
  writeFileSync(join(repo, '.github', 'evil.yml'), 'content');
  assert.throws(() => collectProposal(repo, request), /PROPOSAL_PATH_FORBIDDEN/);
});

test('rejects invalid UTF-8 and NUL bytes', t => {
  const { repo, request } = fixture(t);
  for (const bytes of [Buffer.from([0xff]), Buffer.from([97, 0])]) {
    writeFileSync(join(repo, 'docs', 'guide.md'), bytes);
    assert.throws(() => collectProposal(repo, request), /PROPOSAL_NOT_UTF8_TEXT/);
  }
});

test('rejects an ancestor junction before reading outside the checkout', t => {
  const { root, repo, request } = fixture(t);
  const outside = join(root, 'outside');
  renameSync(join(repo, 'docs'), outside);
  writeFileSync(join(outside, 'guide.md'), 'outside bytes');
  mkdirSync(join(repo, 'docs'));
  symlinkSync(outside, join(repo, 'docs', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => collectProposal(repo, request), /PROPOSAL_SYMLINK/);
});

function apiFixture(request, options = {}) {
  const calls = [];
  let ref = options.ref;
  let pull = options.pull;
  let createCount = 0;
  let currentChecks = 0;
  const commits = new Map();
  const base = { tree: { sha: 'base-tree' }, parents: [], message: 'base' };
  if (ref) commits.set(ref, options.existingCommit);
  const github = { rest: {
    repos: { getCommit: async () => ({ data: { sha: options.staleAfter !== undefined && currentChecks++ >= options.staleAfter ? 'c'.repeat(40) : request.head } }) },
    git: {
      getCommit: async ({ commit_sha }) => ({ data: commit_sha === request.head ? base : commits.get(commit_sha) }),
      getTree: async () => ({ data: { tree: options.baseEntries ?? [], truncated: false } }),
      createTree: async input => { calls.push(['tree', input]); return { data: { sha: 'proposed-tree' } }; },
      createCommit: async input => {
        const sha = `commit-${++createCount}`;
        commits.set(sha, { tree: { sha: input.tree }, parents: input.parents.map(sha => ({ sha })), message: input.message });
        return { data: { sha } };
      },
      createRef: async input => { if (ref) throw Object.assign(new Error('exists'), { status: 422 }); ref = input.sha; calls.push(['ref', input]); },
      getRef: async () => ({ data: { object: { sha: ref } } }),
    },
    pulls: {
      list: async () => ({ data: pull ? [pull] : [] }),
      create: async input => {
        calls.push(['pull', input]);
        if (options.failFirstPull) { options.failFirstPull = false; throw new Error('NETWORK_FAILURE'); }
        pull = { html_url: 'https://github.com/owner/repo/pull/2' };
        return { data: pull };
      },
    },
  } };
  return { github, calls };
}

const proposalFor = (request, files = [{ path: 'docs/new.md', content: 'new\n', mode: '100644' }]) =>
  ({ schemaVersion: 1, key: request.key, head: request.head, files });

test('publisher preserves executable mode and deletion mode in the Git tree', async () => {
  const request = requestFor();
  const { github, calls } = apiFixture(request, { baseEntries: [
    { path: 'docs/run.sh', mode: '100755', type: 'blob' },
    { path: 'docs/old.sh', mode: '100755', type: 'blob' },
  ] });
  const proposal = proposalFor(request, [
    { path: 'docs/run.sh', content: 'echo updated', mode: '100755' },
    { path: 'docs/old.sh', deleted: true },
  ]);
  await publishProposal({ github, request, proposal });
  assert.deepEqual(calls.find(([kind]) => kind === 'tree')[1].tree, [
    { path: 'docs/run.sh', mode: '100755', type: 'blob', content: 'echo updated' },
    { path: 'docs/old.sh', mode: '100755', type: 'blob', sha: null },
  ]);
  assert.equal(calls.find(([kind]) => kind === 'pull')[1].draft, true);
});

for (const [label, files, message] of [
  ['protected path', [{ path: '.github/workflows/x.yml', content: 'x', mode: '100644' }], /PROPOSAL_PATH_FORBIDDEN/],
  ['path traversal', [{ path: 'docs/../README.md', content: 'x', mode: '100644' }], /PROPOSAL_PATH_FORBIDDEN/],
  ['nonboolean deletion', [{ path: 'docs/a.md', deleted: 'true' }], /INVALID_PROPOSAL_DELETION/],
  ['deletion with content', [{ path: 'docs/a.md', deleted: true, content: 'x' }], /INVALID_PROPOSAL_DELETION/],
  ['symlink mode', [{ path: 'docs/a.md', content: '../x', mode: '120000' }], /INVALID_PROPOSAL_CONTENT/],
  ['NUL content', [{ path: 'docs/a.md', content: '\0', mode: '100644' }], /PROPOSAL_NOT_UTF8_TEXT/],
  ['lone surrogate', [{ path: 'docs/a.md', content: '\uD800', mode: '100644' }], /PROPOSAL_NOT_UTF8_TEXT/],
  ['oversized content', [{ path: 'docs/a.md', content: 'x'.repeat(2 * 1024 * 1024 + 1), mode: '100644' }], /PROPOSAL_TOO_LARGE/],
  ['duplicate paths', [{ path: 'docs/a.md', deleted: true }, { path: 'docs/a.md', deleted: true }], /DUPLICATE_PATH/],
]) test(`publisher independently rejects ${label} before using credentials`, async () => {
  const request = requestFor();
  await assert.rejects(publishProposal({ github: null, request, proposal: proposalFor(request, files) }), message);
});

test('publisher rejects stale source before writing objects', async () => {
  const request = requestFor();
  const { github, calls } = apiFixture(request, { staleAfter: 0 });
  await assert.rejects(publishProposal({ github, request, proposal: proposalFor(request) }), /SUPERSEDED_REVISION/);
  assert.deepEqual(calls, []);
});

test('publisher rechecks source before creating the draft', async () => {
  const request = requestFor();
  const { github, calls } = apiFixture(request, { staleAfter: 2 });
  await assert.rejects(publishProposal({ github, request, proposal: proposalFor(request) }), /SUPERSEDED_REVISION/);
  assert.equal(calls.some(([kind]) => kind === 'pull'), false);
});

test('retry reuses same parent/tree/request despite different generated commit SHA', async () => {
  const request = requestFor();
  const { github } = apiFixture(request, { failFirstPull: true });
  const input = { github, request, proposal: proposalFor(request) };
  await assert.rejects(publishProposal(input), /NETWORK_FAILURE/);
  assert.equal((await publishProposal(input)).head, 'commit-1');
  assert.equal((await publishProposal(input)).status, 'existing');
});

for (const mismatch of ['tree', 'parent', 'marker']) test(`retry rejects existing branch with different ${mismatch}`, async () => {
  const request = requestFor();
  const existingCommit = { tree: { sha: mismatch === 'tree' ? 'other' : 'proposed-tree' },
    parents: [{ sha: mismatch === 'parent' ? 'other' : request.head }],
    message: mismatch === 'marker' ? 'unrelated' : `Maintenance-Request: ${request.key}` };
  const { github, calls } = apiFixture(request, { ref: 'occupied', existingCommit });
  await assert.rejects(publishProposal({ github, request, proposal: proposalFor(request) }), /PROPOSAL_BRANCH_ALREADY_EXISTS/);
  assert.equal(calls.some(([kind]) => kind === 'pull'), false);
});

test('publisher rejects a base-tree symlink ancestor', async () => {
  const request = requestFor();
  const { github } = apiFixture(request, { baseEntries: [{ path: 'docs', mode: '120000', type: 'blob' }] });
  await assert.rejects(publishProposal({ github, request, proposal: proposalFor(request) }), /PROPOSAL_BASE_PARENT_NOT_DIRECTORY/);
});

test('publisher refuses to flatten an existing executable file mode', async () => {
  const request = requestFor();
  const { github } = apiFixture(request, { baseEntries: [{ path: 'docs/new.md', mode: '100755', type: 'blob' }] });
  await assert.rejects(publishProposal({ github, request, proposal: proposalFor(request) }), /PROPOSAL_MODE_CHANGE/);
});

test('publisher rejects malformed envelopes and mismatched identities before API use', async () => {
  const request = requestFor();
  for (const proposal of [null, [], { schemaVersion: 2, files: [] }, { schemaVersion: 1, files: {} }]) {
    await assert.rejects(publishProposal({ github: null, request, proposal }), /INVALID_PROPOSAL/);
  }
  await assert.rejects(publishProposal({ github: null, request,
    proposal: { ...proposalFor(request), key: 'forged' } }), /PROPOSAL_IDENTITY_MISMATCH/);
});

test('publisher bounds file count and rejects ancestor path collisions', async () => {
  const request = requestFor();
  await assert.rejects(publishProposal({ github: null, request,
    proposal: proposalFor(request, Array.from({ length: 81 }, (_, index) => ({ path: `docs/${index}.md`, deleted: true }))) }), /PROPOSAL_TOO_MANY_FILES/);
  await assert.rejects(publishProposal({ github: null, request, proposal: proposalFor(request, [
    { path: 'docs/folder', content: 'file', mode: '100644' },
    { path: 'docs/folder/child.md', content: 'child', mode: '100644' },
  ]) }), /PROPOSAL_PATH_CONFLICT/);
});

test('review proposals cannot smuggle changes through the no-change path', async () => {
  const request = requestFor(undefined, 'review');
  await assert.rejects(publishProposal({ github: null, request, proposal: proposalFor(request) }), /REVIEW_CHANGED_FILES/);
  assert.deepEqual(await publishProposal({ github: null, request, proposal: proposalFor(request, []) }), { status: 'no-changes' });
});

test('publisher refuses deletion of a path absent from the base tree', async () => {
  const request = requestFor();
  const { github } = apiFixture(request);
  await assert.rejects(publishProposal({ github, request,
    proposal: proposalFor(request, [{ path: 'docs/missing.md', deleted: true }]) }), /PROPOSAL_DELETE_MISSING_FILE/);
});
