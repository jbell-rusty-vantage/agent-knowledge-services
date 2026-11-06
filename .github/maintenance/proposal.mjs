import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { assertCurrent, permittedPath, requestKey } from './dispatch.mjs';

const maxFiles = 80;
const maxBytes = 2 * 1024 * 1024;
const modes = new Set(['100644', '100755']);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: maxBytes });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertPath(path) {
  if (typeof path !== 'string' || path.includes('\0') || path.includes(':') ||
      path.split('/').some(part => !part || part === '.' || /[. ]$/.test(part)) || !permittedPath(path)) {
    throw new Error('PROPOSAL_PATH_FORBIDDEN');
  }
}

function inspectPath(repo, path) {
  let current = resolve(repo);
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error('PROPOSAL_SYMLINK');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('PROPOSAL_NOT_REGULAR_FILE');
    if (index === parts.length - 1) return stat;
  }
}

function decodeText(bytes) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('PROPOSAL_NOT_UTF8_TEXT'); }
  if (text.includes('\0')) throw new Error('PROPOSAL_NOT_UTF8_TEXT');
  return text;
}

export function collectProposal(repo, request) {
  if (git(repo, 'rev-parse', 'HEAD').trim() !== request.head) throw new Error('AGENT_CHANGED_HEAD');
  const changed = git(repo, 'diff', '--name-only', '--no-renames', '-z', 'HEAD').split('\0');
  const untracked = git(repo, 'ls-files', '--others', '--exclude-standard', '-z').split('\0');
  const paths = [...new Set([...changed, ...untracked].filter(path => path && path !== '.maintenance-report.md'))].sort();
  if (paths.length > maxFiles) throw new Error('PROPOSAL_TOO_MANY_FILES');
  const indexModes = new Map(git(repo, 'ls-files', '--stage', '-z').split('\0').filter(Boolean).map(entry => {
    const separator = entry.indexOf('\t');
    const [mode, , stage] = entry.slice(0, separator).split(' ');
    if (stage !== '0') throw new Error('PROPOSAL_UNMERGED_INDEX');
    return [entry.slice(separator + 1), mode];
  }));
  let bytes = 0;
  const files = paths.map(path => {
    assertPath(path);
    const stat = inspectPath(repo, path);
    if (!stat) return { path, deleted: true };
    if (!stat.isFile()) throw new Error('PROPOSAL_NOT_REGULAR_FILE');
    bytes += stat.size;
    if (bytes > maxBytes) throw new Error('PROPOSAL_TOO_LARGE');
    const content = decodeText(readFileSync(resolve(repo, path)));
    const mode = indexModes.get(path) ?? ((stat.mode & 0o111) ? '100755' : '100644');
    if (!modes.has(mode)) throw new Error('PROPOSAL_NOT_REGULAR_FILE');
    return { path, content, mode };
  });
  const proposal = { schemaVersion: 1, key: request.key, head: request.head, files };
  validateProposal(request, proposal);
  return proposal;
}

function validateProposal(request, proposal) {
  if (!record(proposal) || proposal.schemaVersion !== 1 || !Array.isArray(proposal.files)) throw new Error('INVALID_PROPOSAL');
  if (request.key !== requestKey(request) || proposal.key !== request.key || proposal.head !== request.head) throw new Error('PROPOSAL_IDENTITY_MISMATCH');
  if (proposal.files.length > maxFiles) throw new Error('PROPOSAL_TOO_MANY_FILES');
  const paths = new Set();
  let bytes = 0;
  for (const file of proposal.files) {
    if (!record(file)) throw new Error('INVALID_PROPOSAL_FILE');
    assertPath(file.path);
    if (paths.has(file.path)) throw new Error('DUPLICATE_PATH');
    paths.add(file.path);
    if (file.deleted !== undefined && typeof file.deleted !== 'boolean') throw new Error('INVALID_PROPOSAL_DELETION');
    if (file.deleted === true) {
      if (file.content !== undefined || file.mode !== undefined) throw new Error('INVALID_PROPOSAL_DELETION');
    } else {
      if (typeof file.content !== 'string' || !modes.has(file.mode)) throw new Error('INVALID_PROPOSAL_CONTENT');
      const encoded = Buffer.from(file.content, 'utf8');
      if (decodeText(encoded) !== file.content) throw new Error('PROPOSAL_NOT_UTF8_TEXT');
      bytes += encoded.length;
    }
    if (bytes > maxBytes) throw new Error('PROPOSAL_TOO_LARGE');
  }
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.pop() && parts.length) if (paths.has(parts.join('/'))) throw new Error('PROPOSAL_PATH_CONFLICT');
  }
  if (request.task === 'review' && proposal.files.length) throw new Error('REVIEW_CHANGED_FILES');
}

function proposalTree(files, parentTree) {
  if (parentTree.truncated) throw new Error('PROPOSAL_BASE_TREE_TRUNCATED');
  const entries = new Map(parentTree.tree.map(entry => [entry.path, entry]));
  return files.map(file => {
    const parts = file.path.split('/');
    while (parts.pop() && parts.length) {
      const parent = entries.get(parts.join('/'));
      if (parent && parent.type !== 'tree') throw new Error('PROPOSAL_BASE_PARENT_NOT_DIRECTORY');
    }
    const original = entries.get(file.path);
    if (original && (!modes.has(original.mode) || original.type !== 'blob')) throw new Error('PROPOSAL_BASE_NOT_REGULAR_FILE');
    if (file.deleted && !original) throw new Error('PROPOSAL_DELETE_MISSING_FILE');
    const mode = original?.mode ?? file.mode;
    if (!file.deleted && original && file.mode !== mode) throw new Error('PROPOSAL_MODE_CHANGE');
    return file.deleted
      ? { path: file.path, mode, type: 'blob', sha: null }
      : { path: file.path, mode, type: 'blob', content: file.content };
  });
}

export async function publishProposal({ github, request, proposal }) {
  validateProposal(request, proposal);
  if (!proposal.files.length) return { status: 'no-changes' };
  const [owner, repo] = request.repository.split('/');
  await assertCurrent({ github, owner, repo, request });
  const branch = `maintenance/${request.key}`;
  const marker = `Maintenance-Request: ${request.key}`;
  const parent = (await github.rest.git.getCommit({ owner, repo, commit_sha: request.head })).data;
  const baseTree = (await github.rest.git.getTree({ owner, repo, tree_sha: parent.tree.sha, recursive: '1' })).data;
  const tree = (await github.rest.git.createTree({ owner, repo, base_tree: parent.tree.sha,
    tree: proposalTree(proposal.files, baseTree),
  })).data;
  const commit = (await github.rest.git.createCommit({ owner, repo, tree: tree.sha, parents: [request.head],
    message: `maintenance: ${request.task} proposal\n\n${marker}`,
  })).data;
  await assertCurrent({ github, owner, repo, request });
  let publishedHead = commit.sha;
  try { await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha }); }
  catch (error) {
    if (error.status !== 422) throw error;
    const found = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    const existingCommit = (await github.rest.git.getCommit({ owner, repo, commit_sha: found.data.object.sha })).data;
    if (existingCommit.tree.sha !== tree.sha || existingCommit.parents.length !== 1 ||
        existingCommit.parents[0].sha !== request.head || !existingCommit.message.split(/\r?\n/).includes(marker)) {
      throw new Error('PROPOSAL_BRANCH_ALREADY_EXISTS');
    }
    publishedHead = found.data.object.sha;
  }
  await assertCurrent({ github, owner, repo, request });
  const existing = await github.rest.pulls.list({ owner, repo, state: 'open', head: `${owner}:${branch}`, base: request.baseBranch });
  if (existing.data.length) return { status: 'existing', url: existing.data[0].html_url, head: publishedHead };
  const pull = (await github.rest.pulls.create({ owner, repo, head: branch, base: request.baseBranch, draft: true,
    title: `Maintenance: ${request.task} proposal`,
    body: `Generated by ${request.provider} for ${request.head}.\n\nThis draft requires fresh CI and review. The generation job does not establish behavioral correctness. Review the workflow report and validate the affected business invariants before merging.\n\nMaintenance request: ${request.key}`,
  })).data;
  return { status: 'draft', url: pull.html_url, head: publishedHead };
}
