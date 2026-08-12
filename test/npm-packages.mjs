import { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

// The 50 highest-downloaded packages in the weekly npm ranking when this
// suite was added. `node` packages are bundled with Node built-ins external;
// all other packages use the browser bundle target.
const packages = [
  [ 'chalk' ], [ 'commander', 'node' ], [ 'ajv' ], [ 'uuid' ],
  [ 'typescript', 'node' ], [ 'zod' ], [ 'nanoid' ], [ 'lodash' ],
  [ 'dotenv', 'node' ], [ 'eslint', 'node' ], [ 'react' ], [ 'axios' ],
  [ 'vite', 'node' ], [ 'express', 'node' ], [ 'prettier' ], [ 'ora', 'node' ],
  [ 'sharp', 'node' ], [ 'playwright', 'node' ], [ 'cors', 'node' ], [ 'webpack', 'node' ],
  [ 'dayjs' ], [ 'vitest', 'node' ], [ 'jest', 'node' ], [ 'jsonwebtoken', 'node' ],
  [ 'next', 'node' ], [ 'marked' ], [ 'hono' ], [ 'pino', 'node' ],
  [ 'pg', 'node' ], [ 'winston', 'node' ], [ 'highlight.js' ], [ 'cheerio' ],
  [ 'joi', 'node' ], [ 'ioredis', 'node' ], [ 'mocha', 'node' ], [ 'socket.io', 'node' ],
  [ 'prisma', 'node' ], [ 'morgan', 'node' ], [ 'helmet', 'node' ], [ 'puppeteer', 'node' ],
  [ 'mysql2', 'node' ], [ 'redis', 'node' ], [ 'bcryptjs' ], [ 'drizzle-orm', 'node' ],
  [ 'cypress', 'node' ], [ 'koa', 'node' ], [ 'fastify', 'node' ], [ 'mongoose', 'node' ],
  [ 'bullmq', 'node' ], [ 'knex', 'node' ]
].map(([ name, platform = 'browser' ]) => ({ name, platform }));

const select = () => {
  const index = process.argv.indexOf('--packages');
  if (index === -1) return packages;

  const names = new Set(process.argv[index + 1]?.split(',').filter(Boolean));
  const selected = packages.filter(test => names.has(test.name));
  if (selected.length !== names.size) throw new Error('unknown npm package requested');
  return selected;
};

if (process.argv.includes('--list')) {
  const names = packages.map(test => test.name);
  console.log(process.argv.includes('--json') ? JSON.stringify(names) : names.join('\n'));
  process.exit(0);
}

const command = (program, args, options) => new Promise(resolve => {
  const child = spawn(program, args, { ...options, env: { ...process.env, ...options.env } });
  let output = `$ ${program} ${args.join(' ')}\n`;

  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  child.on('error', error => resolve({ code: 1, output: output + error.stack + '\n' }));
  child.on('close', code => resolve({ code: code ?? 1, output }));
});

const run = async ({ name, platform }, root, reportDir) => {
  const workdir = join(process.env.RUNNER_TEMP ?? '/tmp', 'porffor-npm-package-test', name.replaceAll('/', '__'));
  const log = [];
  let stage = 'install';

  try {
    mkdirSync(workdir, { recursive: true });
    let result = await command('npm', [
      'install', '--prefix', workdir, '--ignore-scripts', '--no-package-lock', '--no-save', name, 'esbuild'
    ], { cwd: root, env: { NPM_CONFIG_AUDIT: 'false', NPM_CONFIG_FUND: 'false' } });
    log.push(result.output);
    if (result.code !== 0) throw new Error(`npm install exited ${result.code}`);

    stage = 'bundle';
    const smokeTest = join(workdir, 'smoke-test.mjs');
    const bundle = join(workdir, 'smoke-test.js');
    writeFileSync(smokeTest, [
      `import * as packageUnderTest from ${JSON.stringify(name)};`,
      "if (Object.keys(packageUnderTest).length === 0) throw new Error('package has no exports');"
    ].join('\n'));
    result = await command(join(workdir, 'node_modules/.bin/esbuild'), [
      smokeTest, '--bundle', '--format=iife', `--platform=${platform}`, '--target=esnext', `--outfile=${bundle}`
    ], { cwd: workdir });
    log.push(result.output);
    if (result.code !== 0) throw new Error(`esbuild exited ${result.code}`);

    stage = 'run with Porffor';
    result = await command(join(root, 'porf'), [ bundle ], { cwd: root });
    log.push(result.output);
    if (result.code !== 0) throw new Error(`Porffor exited ${result.code}`);

    return { name, status: 'passed', stage };
  } catch (error) {
    log.push(`${error.stack}\n`);
    return { name, status: 'failed', stage, error: error.message };
  } finally {
    writeFileSync(join(reportDir, `${name.replaceAll('/', '__')}.log`), log.join('\n'));
    rmSync(workdir, { recursive: true, force: true });
  }
};

const root = resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
const reportDir = process.env.NPM_PACKAGE_REPORT_DIR ?? join(root, 'npm-package-reports');
const concurrency = Number(process.env.NPM_PACKAGE_CONCURRENCY ?? 10);
const selected = select();
mkdirSync(reportDir, { recursive: true });

let next = 0;
const results = await Promise.all(Array.from({ length: Math.min(concurrency, selected.length) }, async () => {
  const own = [];
  while (next < selected.length) own.push(await run(selected[next++], root, reportDir));
  return own;
})).then(groups => groups.flat().sort((a, b) => a.name.localeCompare(b.name)));

writeFileSync(join(reportDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
const passed = results.filter(result => result.status === 'passed');
const failed = results.filter(result => result.status === 'failed');
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
