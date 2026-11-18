import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checksFor, hasCoverage, approvalRequired, updateBranches } from './dispatch-pr-ci.mjs';

test('skill updates build only OpenCode and run delta verification', () => {
  for (const branch of ['chore/apm-update', 'chore/pstack-upstream']) {
    assert.deepEqual(checksFor(branch, 'skills'), [
      { workflow: 'build.yml', inputs: { image: 'opencode' } },
      { workflow: 'skills-verify.yml', inputs: {} },
    ]);
  }
});

test('Nix updates validate all images and the flake', () => {
  for (const branch of ['chore/nix-flake-lock', 'chore/nix-tools-update']) {
    assert.deepEqual(checksFor(branch, 'nix'), [
      { workflow: 'build.yml', inputs: { image: 'all' } },
      { workflow: 'nix.yml', inputs: {} },
    ]);
  }
});

test('rejects unrelated branches and mismatched check groups', () => {
  for (const branch of ['main', 'renovate/actions', '__proto__']) {
    assert.throws(() => checksFor(branch, 'skills'));
  }
  assert.throws(() => checksFor('chore/apm-update', 'nix'));
});

test('approval-required, failed, cancelled, and stale runs do not prevent dispatch', () => {
  assert.equal(hasCoverage([
    { head_sha: 'head', status: 'completed', conclusion: 'action_required' },
    { head_sha: 'head', status: 'completed', conclusion: 'failure' },
    { head_sha: 'head', status: 'completed', conclusion: 'cancelled' },
    { head_sha: 'head', status: 'waiting', conclusion: null },
    { head_sha: 'old', status: 'completed', conclusion: 'success' },
  ], 'head'), false);
});

test('current successful or running CI prevents duplicate dispatch', () => {
  for (const run of [
    { status: 'completed', conclusion: 'success' },
    { status: 'queued', conclusion: null },
    { status: 'in_progress', conclusion: null },
  ]) assert.equal(hasCoverage([{ head_sha: 'head', ...run }], 'head'), true);
});

test('a run waiting for approval is approved for the same commit only', () => {
  const pending = { id: 42, head_sha: 'head', status: 'completed', conclusion: 'action_required' };
  assert.equal(approvalRequired([pending], 'head'), pending);
  assert.equal(approvalRequired([{ ...pending, head_sha: 'old' }], 'head'), null);
  assert.equal(approvalRequired([
    { id: 1, head_sha: 'head', status: 'completed', conclusion: 'cancelled' },
    { id: 2, head_sha: 'head', status: 'queued', conclusion: null },
  ], 'head'), null);
});

// Update PRs: one source = one fixed branch = one PR. A newer run force-updates
// that branch, so yesterday's PR for the same source is replaced, never kept
// beside today's. Scheduled updaters run daily; audits are not updaters.
const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const updaters = readdirSync(workflowsDir)
  .filter(name => name.endsWith('.yml'))
  .map(name => ({ name, text: readFileSync(new URL(name, workflowsDir), 'utf8') }))
  .filter(({ text }) => text.includes('peter-evans/create-pull-request@'));

test('each updater owns exactly one fixed, known update branch', () => {
  const owned = updaters.map(({ name, text }) => {
    const branches = [...text.matchAll(/^\s+branch:\s*(\S+)\s*$/gm)].map(m => m[1]);
    assert.equal(branches.length, 1, `${name}: one create-pull-request branch`);
    assert.ok(Object.hasOwn(updateBranches, branches[0]), `${name}: ${branches[0]} is registered`);
    assert.match(text, /^\s+delete-branch:\s*true\s*$/m, `${name}: closes the PR when the diff disappears`);
    return branches[0];
  });
  assert.deepEqual([...owned].sort(), Object.keys(updateBranches).sort());
});

test('scheduled updaters run daily', () => {
  for (const { name, text } of updaters) {
    for (const [, cron] of text.matchAll(/^\s+- cron:\s*"([^"]+)"/gm)) {
      assert.match(cron, /^\S+ \S+ \* \* \*$/, `${name}: ${cron} is daily`);
    }
  }
});
