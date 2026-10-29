#!/usr/bin/env node
// GITHUB_TOKEN-created PR runs can require approval. Dispatch the same checks
// on the bot branch, without repeating checks already running or successful.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const branches = {
  'chore/apm-update': 'skills',
  'chore/pstack-upstream': 'skills',
  'chore/nix-flake-lock': 'nix',
  'chore/nix-tools-update': 'nix',
};

export function checksFor(branch, kind) {
  if (!Object.hasOwn(branches, branch) || branches[branch] !== kind) {
    throw new Error('Unexpected automation branch or check group');
  }
  return [
    { workflow: 'build.yml', inputs: { image: kind === 'skills' ? 'opencode' : 'both' } },
    { workflow: kind === 'skills' ? 'skills-verify.yml' : 'nix.yml', inputs: {} },
  ];
}

export function hasCoverage(runs, sha) {
  return runs.some(run => run.head_sha === sha && (
    run.conclusion === 'success' ||
    ['queued', 'in_progress'].includes(run.status)
  ));
}

function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function main() {
  const [number, branch, kind] = process.argv.slice(2);
  if (!/^[1-9]\d*$/.test(number || '')) throw new Error('Expected a PR number');
  const checks = checksFor(branch, kind);
  const pr = JSON.parse(gh('api', `repos/{owner}/{repo}/pulls/${number}`));
  if (pr.state !== 'open' || pr.base.ref !== 'main' || pr.head.ref !== branch ||
      pr.head.repo?.full_name !== pr.base.repo.full_name || pr.user.login !== 'github-actions[bot]') {
    throw new Error('Expected an open, same-repository update PR authored by github-actions[bot]');
  }
  for (const { workflow, inputs } of checks) {
    const pages = JSON.parse(gh('api', '--paginate', '--slurp',
      `repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${pr.head.sha}&per_page=100`));
    if (hasCoverage(pages.flatMap(page => page.workflow_runs), pr.head.sha)) {
      console.log(`${workflow}: already running or successful at ${pr.head.sha}`);
      continue;
    }
    // Check the branch again before dispatch: never intentionally target a
    // different commit than the one whose existing CI was inspected.
    const current = JSON.parse(gh('api', `repos/{owner}/{repo}/pulls/${number}`));
    if (current.head.sha !== pr.head.sha || current.state !== 'open') {
      throw new Error('PR changed during CI dispatch; retry the updater');
    }
    const args = ['workflow', 'run', workflow, '--ref', branch];
    for (const [key, value] of Object.entries(inputs)) args.push('-f', `${key}=${value}`);
    gh(...args);
    console.log(`${workflow}: dispatched on ${branch} (${pr.head.sha})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
