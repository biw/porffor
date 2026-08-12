import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const token = process.env.GH_TOKEN;
const repository = process.env.GITHUB_REPOSITORY;
const workerRef = process.env.NPM_PACKAGE_WORKER_REF;
const sha = process.env.NPM_PACKAGE_SHA;
const batch = process.env.NPM_PACKAGE_BATCH;
const reportDir = process.env.NPM_PACKAGE_REPORT_DIR;
const concurrency = Number(process.env.NPM_PACKAGE_CONCURRENCY ?? 10);

for (const [ name, value ] of Object.entries({ token, repository, workerRef, sha, batch, reportDir })) {
  if (!value) throw new Error(`missing ${name}`);
}

const packages = execFileSync(process.execPath, [ 'test/npm-packages.mjs', '--list' ], {
  cwd: root,
  encoding: 'utf8'
}).trim().split('\n');

const command = (program, args) => new Promise(resolve => {
  const child = spawn(program, args, { cwd: root, env: { ...process.env, GH_TOKEN: token } });
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  child.on('error', error => resolve({ code: 1, output: error.stack }));
  child.on('close', code => resolve({ code: code ?? 1, output }));
});

const dispatch = async name => {
  const response = await fetch(`https://api.github.com/repos/${repository}/actions/workflows/npm-package-worker.yaml/dispatches`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2026-03-10'
    },
    body: JSON.stringify({
      ref: workerRef,
      return_run_details: true,
      inputs: { sha, package: name, batch }
    })
  });
  if (!response.ok) throw new Error(`workflow dispatch failed: ${response.status} ${await response.text()}`);

  const run = await response.json();
  if (!run.workflow_run_id || !run.html_url) throw new Error('workflow dispatch did not return run details');
  return { name, runId: run.workflow_run_id, url: run.html_url };
};

const worker = async (items, task) => {
  let next = 0;
  const groups = await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    const own = [];
    while (next < items.length) own.push(await task(items[next++]));
    return own;
  }));
  return groups.flat();
};

const artifactName = name => `npm-package-result-${batch}-${name}`;
const findResults = directory => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findResults(path);
      if (found) return found;
    } else if (entry.name === 'results.json') {
      return path;
    }
  }
};

mkdirSync(reportDir, { recursive: true });
const dispatched = await worker(packages, async name => {
  try {
    return await dispatch(name);
  } catch (error) {
    return { name, status: 'failed', stage: 'dispatch', error: error.message };
  }
});

const results = await worker(dispatched, async task => {
  if (!task.runId) return task;

  const waited = await command('gh', [ 'run', 'watch', String(task.runId), '--repo', repository, '--compact', '--exit-status', '--interval', '60' ]);
  const outputDir = join(reportDir, task.name.replaceAll('/', '__'));
  mkdirSync(outputDir, { recursive: true });
  const downloaded = await command('gh', [
    'run', 'download', String(task.runId), '--repo', repository, '--name', artifactName(task.name), '--dir', outputDir
  ]);
  const resultFile = downloaded.code === 0 && findResults(outputDir);
  if (!resultFile) {
    writeFileSync(join(outputDir, 'parent.log'), `${waited.output}\n${downloaded.output}`);
    return { name: task.name, status: 'failed', stage: 'report artifact', url: task.url, error: 'worker did not upload a result artifact' };
  }

  const [ result ] = JSON.parse(readFileSync(resultFile, 'utf8'));
  return { ...result, url: task.url };
});

results.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
const passed = results.filter(result => result.status === 'passed');
const failed = results.filter(result => result.status !== 'passed');
const summary = [
  '## npm package compatibility',
  '',
  `**${passed.length}/${results.length} passed** · ${failed.length} failed`,
  '',
  '| Package | Result | Stage |',
  '| --- | --- | --- |',
  ...results.map(result => `| ${result.url ? `[${result.name}](${result.url})` : result.name} | ${result.status === 'passed' ? '✅ passed' : '❌ failed'} | ${result.stage} |`),
  ''
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (failed.length > 0) process.exitCode = 1;
