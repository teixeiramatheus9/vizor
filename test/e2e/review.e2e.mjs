// The review screen, end to end, in the real Electron app: a branch with three
// changed files (a signature change, a caller, a new dependency) and a fake
// `tsc`. After the agent's Stop the verdict shows the files, the contract
// changes and the tsc error; Mudanças lists contract files first and shows the
// tsc error on its line; Comentar and Rejeitar reach the chat; Impacto's node
// filters Mudanças; an approval survives quitting right after the click.
// Claude Code and gh are stand-ins (fake-bin). Run by scripts/e2e.sh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..');
const require = createRequire(path.join(appRoot, 'package.json'));
const electronPath = require('electron');
const shots = process.env.VIZOR_E2E_SHOTS ?? null;

const base = fs.existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : os.tmpdir();
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-review-'));
const repo = path.join(home, 'projeto');
const write = (rel, text, mode) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, { mode });
};
const git = (...args) => execFileSync('git', ['-c', 'user.email=e2e@vizor', '-c', 'user.name=e2e', ...args], { cwd: repo, env: { ...process.env, HOME: home } });

const filler = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `// filler ${from + i}`).join('\n');
const LIB_BEFORE = `export function add(a: number, b: number): number {\n  return a + b;\n}\n${filler(1, 20)}\nexport function label(n: number): string {\n  return 'n=' + n;\n}\n`;
const LIB_AFTER = `export function add(a: number, b: number, c = 0): number {\n  return a + b + c;\n}\n${filler(1, 20)}\nexport function label(n: number): string {\n  return \`n=\${n}\`;\n}\n`;
const APP_BEFORE = `import { add } from './lib';\n\nexport function total(): number {\n  return add(1, 2);\n}\n`;
const APP_AFTER = `import { add } from './lib';\n\nexport function total(): number {\n  return add(1, 2, 3);\n}\n`;
const PKG = (deps) => `${JSON.stringify({ name: 'projeto', version: '1.0.0', dependencies: deps }, null, 2)}\n`;

fs.mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
write('.gitignore', 'node_modules/\n');
write('tsconfig.json', '{ "compilerOptions": { "strict": true }, "include": ["src"] }\n');
write('package.json', PKG({}));
write('src/lib.ts', LIB_BEFORE);
write('src/app.ts', APP_BEFORE);
git('add', '-A');
git('commit', '-q', '-m', 'init');
git('remote', 'add', 'origin', 'https://github.com/teixeiramatheus9/vizor-e2e.git');
git('checkout', '-q', '-b', 'feat/menu');
// The agent's work, still in the working tree (a reject can undo it).
write('src/lib.ts', LIB_AFTER);
write('src/app.ts', APP_AFTER);
write('package.json', PKG({ left: '^1.0.0' }));
// A typescript stand-in: one known error, exit 2, like tsc.
write('node_modules/.bin/tsc', "#!/bin/sh\necho \"src/lib.ts(2,10): error TS2322: Type 'string' is not assignable to type 'number'.\"\nexit 2\n", 0o755);

const config = path.join(home, '.config', 'vizor');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ workspaceProjects: [repo], muted: true, ttsEnabled: false, autoUpdate: false }));
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ workspaceTabs: { tabs: [{ cwd: repo, sessionId: null }], active: 0, windowOpen: true } }));

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
  PATH: `${path.join(here, 'fake-bin')}:${process.env.PATH}`,
  VIZOR_E2E_HOOK: path.join(appRoot, 'src', 'hook', 'hook-emit.js'),
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;

const launch = () => _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
const openWorkspace = async (app) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const found = app.windows().find((page) => page.url().includes('workspace.html'));
    if (found) {
      await found.waitForLoadState('domcontentloaded');
      await found.waitForSelector('#tabs', { timeout: 15000 });
      return found;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the workspace window never opened');
};
const received = () => {
  try {
    return fs.readFileSync(path.join(home, 'claude-received.log'), 'utf8');
  } catch {
    return '';
  }
};
const until = async (what, check, ms = 15000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `e2e-review-${name}.png`) }); };

let app = await launch();
let failed = false;
try {
  let ws = await openWorkspace(app);

  // A chat in the project: it registers, writes its plan and stops (the hook's Stop runs tsc).
  await ws.keyboard.press('Control+K');
  await ws.waitForSelector('#command-list >> text=Puxar #169', { timeout: 15000 });
  await ws.keyboard.type('169');
  await ws.keyboard.press('Enter');
  await ws.waitForSelector('#plan-card >> text=Plano · 0/3', { timeout: 30000 });

  // 1. Resumo opens with the verdict.
  await ws.waitForSelector('#summary-head .verdict-strip');
  const verdict = () => ws.textContent('#summary-head .verdict-strip');
  await until('the verdict', async () => /tsc: 1 erro/.test(await verdict()) && /2 mudanças de contrato/.test(await verdict()), 30000);
  const text = await verdict();
  assert.match(text, /3 arquivos/);
  assert.match(text, /2 mudanças de contrato/);
  assert.match(text, /revisado 0\/4 hunks/);
  await shot(ws, 'verdict');

  // 2. Mudanças: contract files first, the tsc error on its line.
  await ws.click('[data-review-tab="changes"]');
  await ws.waitForSelector('#changes-files .review-file');
  const order = await ws.$$eval('#changes-files .review-file', (rows) => rows.map((row) => row.dataset.path));
  assert.deepEqual(new Set(order.slice(0, 2)), new Set(['package.json', 'src/lib.ts']));
  assert.equal(order[2], 'src/app.ts');
  const badged = await ws.$$eval('#changes-files .review-file', (rows) => rows.filter((row) => row.querySelector('.contract-badge')).map((row) => row.dataset.path));
  assert.deepEqual(new Set(badged), new Set(['package.json', 'src/lib.ts']));
  await ws.click('#changes-files .review-file[data-path="src/lib.ts"]');
  await ws.waitForSelector('#changes-diff .tsc-error');
  assert.match(await ws.textContent('#changes-diff .tsc-error'), /tsc 2:10 · Type 'string' is not assignable/);

  // 4. Reject a hunk of src/app.ts (not committed, the chat is done): the file goes back.
  await ws.click('#changes-files .review-file[data-path="src/app.ts"]');
  await ws.waitForSelector('#changes-diff section.hunk');
  await ws.click('#changes-diff [data-hunk-action="reject"]');
  await ws.waitForSelector('#changes-diff .reject-confirm');
  assert.match(await ws.textContent('#changes-diff .reject-confirm'), /desfazer este trecho\?/);
  await shot(ws, 'reject-confirm');
  await ws.click('[data-review-action="reject-yes"]');
  await until('app.ts back to its base', () => fs.readFileSync(path.join(repo, 'src/app.ts'), 'utf8') === APP_BEFORE);
  await until('the reject notice at the chat', () => /Desfiz o trecho de src\/app\.ts perto da linha \d+, na revisão/.test(received()));

  // 5. Comment on a hunk of lib.ts: the chat gets the header.
  await ws.click('#changes-files .review-file[data-path="src/lib.ts"]');
  await ws.waitForSelector('#changes-diff section.hunk');
  await ws.click('#changes-diff [data-hunk-action="comment"]');
  await ws.fill('[data-composer="draft"]', 'por que o terceiro argumento?');
  await ws.click('[data-composer="send"]');
  await until('the comment at the chat', () => /Sobre src\/lib\.ts, linhas 1–\d+ \(trecho da revisão\):/.test(received()));
  assert.match(received(), /por que o terceiro argumento\?/);

  // 6. Impacto: the changed node, in red; clicking it filters Mudanças.
  await ws.click('[data-review-tab="impact"]');
  await ws.waitForSelector('#impact-body .slice-node', { timeout: 30000 });
  const changed = await ws.$$eval('#impact-body .slice-node.state-changed', (nodes) => nodes.map((node) => node.dataset.node));
  assert.ok(changed.length >= 1, 'a changed node is drawn');
  await shot(ws, 'impact');
  await ws.click('#impact-body .slice-node.state-changed');
  await ws.click('[data-review-action="node-changes"]');
  await ws.waitForSelector('#changes-node-filter .node-filter');
  const filtered = await ws.$$eval('#changes-files .review-file', (rows) => rows.map((row) => row.dataset.path));
  assert.deepEqual(filtered, ['src/lib.ts']);

  // 3. Approve a hunk: the verdict counts it, and it is still there after quitting at once.
  await ws.click('[data-review-tab="summary"]');
  await ws.click('[data-review-tab="changes"]');
  await ws.click('[data-review-action="clear-node-filter"]');
  await ws.click('#changes-files .review-file[data-path="src/lib.ts"]');
  await ws.waitForSelector('#changes-diff section.hunk');
  await ws.click('#changes-diff [data-hunk-action="approve"]');
  await ws.click('[data-review-tab="summary"]');
  await until('revisado 1/3', async () => /revisado 1\/3 hunks/.test(await verdict()));
  await shot(ws, 'approved');
  await app.close();

  app = await launch();
  ws = await openWorkspace(app);
  await ws.waitForSelector('#summary-head .verdict-strip', { timeout: 30000 });
  await until('the approval after relaunch', async () => /revisado 1\/3 hunks/.test(await ws.textContent('#summary-head .verdict-strip')), 30000);
  console.log('e2e: review OK (verdict, contract-first order, tsc line, reject, comment, impact filter, approval across a relaunch)');
} catch (error) {
  failed = true;
  console.error(`e2e review FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-review-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
