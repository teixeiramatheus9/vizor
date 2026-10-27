// The review screen's performance budgets, measured in the real Electron app:
// a branch with 150 changed JS files (~40 diff lines each) plus one file with a
// 1,000-line diff, no task running and no Maestro order pending. Times are taken
// in the page (performance.now() from the click to the DOM settled, layout
// forced), memory from main (workingSetSize of the workspace's renderer), and
// "parado" counts the `git` calls a wrapper first on PATH logs while the window
// is minimized. No warm-up: every number is the first time the user would see it
// (the list: the median of three cold openings).
// Claude Code and gh are stand-ins (fake-bin). Run by scripts/e2e.sh.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

const BUDGET = { listMs: 300, fileMs: 100, impactMs: 150, memoryMb: 40, idleCalls: 0 };
const FILES = 150;
const BIG_HUNKS = 50; // 50 blocks of 10 changed lines = 1,000 diff lines

const base = fs.existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : os.tmpdir();
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-perf-'));
const repo = path.join(home, 'projeto');
const realGit = execFileSync('sh', ['-c', 'command -v git']).toString().trim(); // before PATH changes
const write = (rel, text, mode) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text, { mode });
};
const git = (...args) => execFileSync(realGit, ['-c', 'user.email=e2e@vizor', '-c', 'user.name=e2e', ...args], { cwd: repo, env: { ...process.env, HOME: home } });

// m<i>.js: an import, then 39 one-line functions; the edit rewrites the even
// ones (20 lines, so 40 diff lines in one hunk). Function 1 calls the next module.
const moduleText = (i, edited) => {
  const lines = [i < FILES - 1 ? `import { m${i + 1}_1 } from './m${i + 1}.js';` : '// last module'];
  for (let k = 0; k < 39; k++) {
    if (k === 1 && i < FILES - 1) lines.push(`export function m${i}_1(x) { return m${i + 1}_1(x) + 1; }`);
    else lines.push(`export function m${i}_${k}(x) { return x ${edited && k % 2 === 0 ? '*' : '+'} ${k}; }`);
  }
  return `${lines.join('\n')}\n`;
};
// big.js: 1,000 lines; in each run of 20, the first 10 are rewritten.
const bigText = (edited) => `${Array.from({ length: 1000 }, (_, n) => `export function big_${n}(x) { return x ${edited && n % 20 < 10 ? '*' : '+'} ${n}; }`).join('\n')}\n`;

fs.mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
write('.gitignore', 'node_modules/\n');
for (let i = 0; i < FILES; i++) write(`src/m${i}.js`, moduleText(i, false));
write('src/big.js', bigText(false));
git('add', '-A');
git('commit', '-q', '-m', 'init');
git('remote', 'add', 'origin', 'https://github.com/teixeiramatheus9/vizor-e2e.git');
git('checkout', '-q', '-b', 'feat/perf');
for (let i = 0; i < FILES; i++) write(`src/m${i}.js`, moduleText(i, true));
write('src/big.js', bigText(true));

const config = path.join(home, '.config', 'vizor');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ workspaceProjects: [repo], muted: true, ttsEnabled: false, autoUpdate: false }));
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ workspaceTabs: { tabs: [{ cwd: repo, sessionId: null }], active: 0, windowOpen: true } }));
// The worktree opens on Ao vivo, so the baseline holds no review data.
fs.mkdirSync(path.join(config, 'revisao'), { recursive: true });
fs.writeFileSync(path.join(config, 'revisao', `${createHash('sha1').update(repo).digest('hex')}.json`), JSON.stringify({ approved: [], prefs: { tab: 'live', drawerOpen: true } }));

// A `git` first on PATH that logs every call and runs the real one.
const bin = path.join(home, 'bin');
const gitLog = path.join(home, 'git-calls.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${gitLog}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
const gitCalls = () => (fs.existsSync(gitLog) ? fs.readFileSync(gitLog, 'utf8').split('\n').filter(Boolean) : []);

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
  PATH: `${bin}:${path.join(here, 'fake-bin')}:${process.env.PATH}`,
  VIZOR_E2E_HOOK: path.join(appRoot, 'src', 'hook', 'hook-emit.js'),
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
let failed = false;
try {
  const ws = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = app.windows().find((page) => page.url().includes('workspace.html'));
      if (found) return found;
      await sleep(200);
    }
    throw new Error('the workspace window never opened');
  })();
  await ws.waitForLoadState('domcontentloaded');
  await ws.waitForSelector('#tabs', { timeout: 15000 });

  // From the click to the moment the page satisfies `done`, layout forced, all
  // inside the page: the test runner's own round trips are not in the number.
  const timed = (click, done) => ws.evaluate(async ({ click, done }) => {
    const finished = new Function(`return (${done});`)();
    const t0 = performance.now();
    document.querySelector(click).click();
    await new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => check());
      const stop = setTimeout(() => { observer.disconnect(); reject(new Error(`timed out: ${done}`)); }, 20000);
      function check() {
        if (!finished()) return false;
        clearTimeout(stop);
        observer.disconnect();
        resolve();
        return true;
      }
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      check();
    });
    document.body.getBoundingClientRect(); // layout belongs to the cost
    return performance.now() - t0;
  }, { click, done });
  const memoryKb = () => app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('workspace.html'));
    const pid = win.webContents.getOSProcessId();
    return electronApp.getAppMetrics().find((m) => m.pid === pid).memory.workingSetSize;
  });
  const medianMemory = async () => {
    const readings = [];
    for (let i = 0; i < 3; i++) { readings.push(await memoryKb()); await sleep(500); }
    return median(readings);
  };

  // Baseline: Ao vivo active, one terminal open, the worktree selected and quiet.
  await ws.waitForSelector('#review-tabs [data-review-tab="live"].active', { timeout: 15000 });
  await ws.waitForSelector('#term-host .xterm', { timeout: 15000 });
  await sleep(3000);
  const baseline = await medianMemory();
  const over = async () => ((await medianMemory()) - baseline) / 1024;

  // Mudanças: click until the list holds every file. One opening is one sample
  // and the first can be unlucky, so the budget is on the median of three COLD
  // openings: between them the files get a new mtime (the service keys its
  // per-file work by path+mtime+size, so every opening redoes it) and the tab
  // is left for Ao vivo, which asks main for nothing. Rows from the previous
  // drawing are marked stale so only a fresh list ends the clock.
  const fileRows = `() => document.querySelectorAll('#changes-files .review-file:not([data-stale])').length === ${FILES + 1}`;
  const coldOpenings = [];
  for (let opening = 0; opening < 3; opening++) {
    if (opening > 0) {
      await ws.click('[data-review-tab="live"]');
      const stamp = new Date(Date.now() + opening * 60_000);
      for (let i = 0; i < FILES; i++) fs.utimesSync(path.join(repo, `src/m${i}.js`), stamp, stamp);
      fs.utimesSync(path.join(repo, 'src/big.js'), stamp, stamp);
      await sleep(1500);
      await ws.evaluate(() => { for (const row of document.querySelectorAll('#changes-files .review-file')) row.dataset.stale = '1'; });
    }
    coldOpenings.push(await timed('[data-review-tab="changes"]', fileRows));
  }
  const list = median(coldOpenings);

  // The big file: click until its last hunk is in the DOM.
  await ws.evaluate(() => { document.querySelector('#changes-files .review-file[data-path="src/big.js"]').scrollIntoView(); });
  const bigFile = await timed('#changes-files .review-file[data-path="src/big.js"]', `() => document.querySelectorAll('#changes-diff section.hunk').length === ${BIG_HUNKS}`);

  // Memory: Mudanças open with the big file expanded (the renderer keeps settling for a few seconds).
  await sleep(3000);
  const memoryMb = await over();

  // Impacto: the first open builds the graph; the measured one finds it warm.
  await ws.click('[data-review-tab="impact"]');
  await ws.waitForSelector('#impact-body .slice-svg', { timeout: 60000 });
  await ws.click('[data-review-tab="changes"]');
  await sleep(500);
  // The old drawing stays in the panel: only a fresh one counts.
  await ws.evaluate(() => { for (const svg of document.querySelectorAll('#impact-body .slice-svg')) svg.dataset.stale = '1'; });
  const impact = await timed('[data-review-tab="impact"]', "() => !!document.querySelector('#impact-body .slice-svg:not([data-stale])')");

  // Not a budget, only a number to watch: the same memory after a round trip through Impacto.
  await ws.click('[data-review-tab="changes"]');
  await ws.waitForSelector(`#changes-diff section.hunk >> nth=${BIG_HUNKS - 1}`);
  await sleep(3000);
  const afterImpactMb = await over();

  const signed = (mb) => `${mb >= 0 ? '+' : ''}${Math.round(mb)}MB`;
  console.log(`perf: lista ${Math.round(list)}ms (mediana de ${coldOpenings.map((ms) => Math.round(ms)).join(', ')}), arquivo ${Math.round(bigFile)}ms, impacto ${Math.round(impact)}ms, mem ${signed(memoryMb)} (${signed(afterImpactMb)} depois de passar pelo Impacto)`);

  // Parado: minimized, five quiet seconds, no `git` call.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('workspace.html')).minimize();
  });
  await sleep(300);
  const before = gitCalls().length;
  await sleep(5000);
  const idle = gitCalls().slice(before);
  console.log(`perf: parado ${idle.length} chamadas de git em 5s`);

  assert.ok(list < BUDGET.listMs, `lista de Mudanças, mediana de 3 aberturas a frio ${Math.round(list)}ms (limite ${BUDGET.listMs}ms)`);
  assert.ok(bigFile < BUDGET.fileMs, `arquivo grande ${Math.round(bigFile)}ms (limite ${BUDGET.fileMs}ms)`);
  assert.ok(impact < BUDGET.impactMs, `Impacto ${Math.round(impact)}ms (limite ${BUDGET.impactMs}ms)`);
  assert.ok(memoryMb <= BUDGET.memoryMb, `memória do renderer +${Math.round(memoryMb)}MB (limite +${BUDGET.memoryMb}MB)`);
  assert.equal(idle.length, BUDGET.idleCalls, `git com a janela minimizada: ${idle.join(' | ')}`);
  console.log('e2e: perf OK (list, big file, impact, renderer memory, idle)');
} catch (error) {
  failed = true;
  console.error(`e2e perf FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
