import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const reportDir = process.env.NPM_PACKAGE_REPORT_DIR;
if (!reportDir) throw new Error('missing NPM_PACKAGE_REPORT_DIR');

const packages = JSON.parse(execFileSync(process.execPath, [ 'test/npm-packages.mjs', '--list', '--json' ], {
  cwd: root,
  encoding: 'utf8'
}));
const resultFiles = [];
const findResults = directory => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findResults(path);
      else if (entry.name === 'results.json') resultFiles.push(path);
  }
};

findResults(reportDir);
const received = new Map();
for (const file of resultFiles) {
  for (const result of JSON.parse(readFileSync(file, 'utf8'))) received.set(result.name, result);
}

const results = packages.map(name => received.get(name) ?? {
  name,
  status: 'failed',
  stage: 'report artifact',
  error: 'worker did not upload a result artifact'
});
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
  ...results.map(result => `| ${result.name} | ${result.status === 'passed' ? '✅ passed' : '❌ failed'} | ${result.stage} |`),
  ''
].join('\n');

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
if (failed.length > 0) process.exitCode = 1;
