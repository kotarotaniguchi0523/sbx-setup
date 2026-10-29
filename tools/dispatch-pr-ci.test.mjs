import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checksFor, hasCoverage } from './dispatch-pr-ci.mjs';

test('skill updates build only OpenCode and run delta verification', () => {
  for (const branch of ['chore/apm-update', 'chore/pstack-upstream']) {
    assert.deepEqual(checksFor(branch, 'skills'), [
      { workflow: 'build.yml', inputs: { image: 'opencode' } },
      { workflow: 'skills-verify.yml', inputs: {} },
    ]);
  }
});

test('Nix updates validate both images and the flake', () => {
  for (const branch of ['chore/nix-flake-lock', 'chore/nix-tools-update']) {
    assert.deepEqual(checksFor(branch, 'nix'), [
      { workflow: 'build.yml', inputs: { image: 'both' } },
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
