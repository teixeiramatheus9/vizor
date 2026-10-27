// The Automações tab in the real Electron app: the list with its states, the
// history with a report, the form (validation, save), the day cap raised from
// the tab, then the real thing through the stand-in claude: create (skill and
// rules on disk), run now (kanban card, report, notice, day budget), a
// timeout (blocked until "confirmar"), the real rule-guard.js as the hook, a
// quit with a run in flight (cancelled, nobody left behind), and a due run
// with the window minimized. Claude Code and gh are stand-ins (fake-bin).
// Run by scripts/e2e.sh.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const base = fs.existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : os.tmpdir();
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-au-'));
const repo = path.join(home, 'projeto');
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, HOME: home } });
git('init', '-q', '-b', 'main');
git('-c', 'user.email=e2e@vizor', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');
const config = path.join(home, '.config', 'vizor');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ workspaceProjects: [repo], muted: true, ttsEnabled: false, autoUpdate: false }));
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ workspaceTabs: { tabs: [{ cwd: repo, sessionId: null }], active: 0, windowOpen: true } }));

// Two automações already there, with a past run (and its report) on the first.
const now = Date.now();
const mk = (over) => ({ slug: 'x', prompt: 'Resuma as PRs abertas.', projectRoot: repo, level: 'read', model: 'sonnet', capUsd: 1, timeoutMin: 15, missed: 'skip', skillScope: 'personal', paused: false, blockedUntilConfirm: false, createdAt: now, lastRun: now, ...over });
const first = mk({ id: 'au-1', name: 'Revisão da semana', slug: 'revisao-da-semana', when: { kind: 'every', minutes: 600 } });
const second = mk({ id: 'au-2', name: 'Lint noturno', slug: 'lint-noturno', when: { kind: 'daily', at: '09:00' }, level: 'worktree', paused: true });
fs.writeFileSync(path.join(config, 'automacoes.json'), JSON.stringify({ automations: [first, second] }));
const folder = path.join(config, 'automacoes', 'au-1');
fs.mkdirSync(folder, { recursive: true });
const at = new Date(now - 7 * 60000).toISOString();
fs.writeFileSync(path.join(folder, 'historico.jsonl'), `${JSON.stringify({ name: first.name, status: 'ok', costUsd: 0.31, durationMs: 42000, late: false, at, report: '20261027-0930.md' })}\n`);
fs.writeFileSync(path.join(folder, '20261027-0930.md'), '# Revisão da semana\n\n- Status: ok\n\n## Resultado\n\nTrês PRs abertas: **#12** espera review, `#14` passou nos testes.\n\n<img src=x onerror="window.__pwned = 1">\n');

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

// What the stand-in claude does in an automação's run (read on every run).
const fakeKnob = (knob) => fs.writeFileSync(path.join(home, 'fake-auto.json'), JSON.stringify(knob));
const fakeRuns = () => {
  try {
    return fs.readFileSync(path.join(home, 'fake-auto-runs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const automacoesFile = path.join(config, 'automacoes.json');
const idOf = (name) => JSON.parse(fs.readFileSync(automacoesFile, 'utf8')).automations.find((a) => a.name === name)?.id;
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const t0 = Date.now();
const lap = (what) => console.log(`e2e: [${stamp()}] ${what}`);

async function openApp() {
  const launched = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
  let page;
  for (let attempt = 0; attempt < 100 && !page; attempt++) {
    page = launched.windows().find((it) => it.url().includes('workspace.html'));
    if (!page) await sleep(200);
  }
  assert.ok(page, 'the workspace window never opened');
  await page.waitForLoadState('domcontentloaded');
  // Reopened on the tab it was closed on, so #tabs may be hidden: attached is enough.
  await page.waitForSelector('#tabs', { state: 'attached', timeout: 15000 });
  return { launched, page };
}
const windowOf = (launched, name) => launched.windows().find((it) => it.url().includes(name));
const setMinimized = (launched, on) =>
  launched.evaluate(({ BrowserWindow }, minimize) => {
    const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('workspace.html'));
    if (minimize) win.minimize();
    else win.restore();
  }, on);

fakeKnob({ mode: 'ok', costUsd: 0.42, delayMs: 0, result: '## Resumo\n\nTrês PRs **abertas**, uma espera review.' });
let { launched: app, page: workspace } = await openApp();
let failed = false;
try {

  // ---- the list ---------------------------------------------------------------
  await workspace.keyboard.press('Control+4');
  await workspace.waitForSelector('#view-automations:not([hidden]) .au-item', { timeout: 15000 });
  assert.equal(await workspace.locator('.au-item').count(), 2);
  assert.match(await workspace.textContent('#au-top'), /hoje: US\$ 0,00 de 5,00/);
  assert.match(await workspace.textContent('[data-automation="au-1"]'), /a cada 10 h/);
  assert.match(await workspace.textContent('[data-automation="au-1"]'), /✓ ok há 7 min/);
  assert.match(await workspace.textContent('[data-automation="au-2"]'), /pausada/);
  assert.match(await workspace.textContent('#status-bar'), /próxima automação: /);

  // ---- history and the report, escaped ------------------------------------------
  await workspace.click('[data-automation="au-1"] [data-au-action="history"]');
  await workspace.waitForSelector('.au-report strong', { timeout: 10000 });
  assert.match(await workspace.textContent('.au-report'), /Três PRs abertas/);
  assert.equal(await workspace.evaluate(() => window.__pwned ?? null), null, 'a report never runs anything');
  assert.equal(await workspace.locator('.au-report img').count(), 0);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'automacoes.png') });

  // ---- the day cap, raised from the tab -----------------------------------------
  await workspace.click('[data-au-action="cap-edit"]');
  await workspace.fill('[data-au-cap-input]', '500');
  await workspace.click('[data-au-cap] button[type="submit"]');
  await workspace.waitForSelector('.au-cap .au-error', { timeout: 5000 });
  await workspace.fill('[data-au-cap-input]', '8,5');
  await workspace.click('[data-au-cap] button[type="submit"]');
  await workspace.waitForFunction(() => /de 8,50/.test(document.querySelector('#au-top')?.textContent ?? ''), null, { timeout: 5000 });

  // ---- the form: live validation, then a new automação ---------------------------
  await workspace.click('[data-au-action="new"]');
  await workspace.waitForSelector('[data-au-form]');
  assert.equal(await workspace.isDisabled('[data-au-action="save"]'), true);
  await workspace.click('[data-au-preset="0"]');
  await workspace.fill('[data-au-field="everyN"]', '5');
  await workspace.waitForFunction(() => /mínimo/.test(document.querySelector('[data-au-error="when"]')?.textContent ?? ''));
  await workspace.click('[data-au-preset="1"]');
  await workspace.fill('[data-au-field="name"]', 'Resumo do dia');
  await workspace.fill('[data-au-field="prompt"]', 'Liste o que mudou hoje.');
  assert.equal(await workspace.isDisabled('[data-au-action="save"]'), false);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'automacoes-form.png') });
  await workspace.click('[data-au-action="save"]');
  await workspace.waitForFunction(() => document.querySelectorAll('.au-item').length === 3, null, { timeout: 10000 });
  assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'vizor-resumo-do-dia', 'SKILL.md')), 'the skill was written');

  // ---- 1. create "PRs da manhã": the skill and the rules land on disk ------------
  const bubble = windowOf(app, 'app.html');
  await bubble.evaluate(() => {
    window.__notices = [];
    new MutationObserver(() => window.__notices.push(document.getElementById('tooltip-text').textContent)).observe(document.getElementById('tooltip-text'), { childList: true, characterData: true, subtree: true });
  });
  await workspace.click('[data-au-action="new"]');
  await workspace.waitForSelector('[data-au-form]');
  await workspace.fill('[data-au-field="name"]', 'PRs da manhã');
  await workspace.fill('[data-au-field="prompt"]', 'Resuma as PRs abertas e diga qual espera review.');
  await workspace.click('[data-au-preset="0"]');
  await workspace.fill('[data-au-field="everyN"]', '15');
  await workspace.fill('[data-au-field="timeoutMin"]', '1'); // the shortest the form takes: scenario 3 waits it out
  assert.equal(await workspace.isChecked('[data-au-field="level"][value="read"]'), true, 'the default level is "Ler e relatar"');
  await workspace.click('[data-au-action="save"]');
  await workspace.waitForFunction(() => document.querySelectorAll('.au-item').length === 4, null, { timeout: 10000 });
  const id = idOf('PRs da manhã');
  assert.ok(id, 'the new automação is in automacoes.json');
  const skill = fs.readFileSync(path.join(home, '.claude', 'skills', 'vizor-prs-da-manha', 'SKILL.md'), 'utf8');
  assert.match(skill, /name: vizor-prs-da-manha/);
  assert.match(skill, /Resuma as PRs abertas/);
  const rulesFile = path.join(config, 'automacoes', 'regras.json');
  const rulesOf = () => {
    try {
      return JSON.parse(fs.readFileSync(rulesFile, 'utf8')).automations?.[id];
    } catch {
      return undefined;
    }
  };
  for (let attempt = 0; attempt < 50 && !rulesOf(); attempt++) await sleep(100);
  assert.equal(rulesOf()?.level, 'read', 'regras.json carries the new automação at the read level');
  assert.equal(rulesOf()?.denyEdits, true);
  lap('1. created: skill and rules on disk');

  // ---- 2. run now: card with the badge, report, notice, budget --------------------
  fakeKnob({ mode: 'ok', costUsd: 0.42, delayMs: 4000, result: '## Resumo\n\nTrês PRs **abertas**, uma espera review.' });
  await workspace.click(`[data-automation="${id}"] [data-au-action="run"]`);
  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector(`[data-card="automation:${id}"] .kb-automation`, { timeout: 10000 });
  assert.equal((await workspace.textContent(`[data-card="automation:${id}"] .kb-automation`)).trim(), 'automação');
  assert.match(await workspace.textContent(`[data-card="automation:${id}"]`), /PRs da manhã/);
  await workspace.waitForSelector(`[data-card="automation:${id}"]`, { state: 'detached', timeout: 20000 });
  await workspace.keyboard.press('Control+4');
  await workspace.waitForSelector('#view-automations:not([hidden]) .au-item');
  await workspace.click(`[data-automation="${id}"] [data-au-action="history"]`);
  await workspace.waitForSelector('.au-report strong', { timeout: 10000 });
  assert.match(await workspace.textContent('.au-report'), /Três PRs abertas, uma espera review/);
  assert.match(await workspace.textContent('.au-report h2, .au-report h3, .au-report h4'), /Resumo/);
  assert.match(await workspace.textContent(`[data-automation="${id}"] .au-last`), /ok/);
  await bubble.waitForFunction(() => window.__notices.some((text) => /a automação PRs da manhã terminou/.test(text)), null, { timeout: 15000 });
  await workspace.waitForFunction(() => /US\$ 0,42 de 8,50/.test(document.querySelector('#au-top')?.textContent ?? ''), null, { timeout: 5000 });
  assert.equal(fakeRuns().length, 1);
  assert.match(fakeRuns()[0].args.join(' '), /\/vizor-prs-da-manha/);
  lap('2. run now: card, report, notice, budget');

  // ---- 3. timeout: "passou do tempo", blocked, "confirmar" unblocks ---------------
  fakeKnob({ mode: 'sleep' });
  await workspace.click(`[data-automation="${id}"] [data-au-action="run"]`);
  await workspace.waitForSelector(`[data-automation="${id}"] .au-state.running`, { timeout: 10000 });
  await workspace.waitForSelector(`[data-automation="${id}"] .au-state.blocked`, { timeout: 110000 });
  assert.match(await workspace.textContent(`[data-automation="${id}"] .au-last`), /passou do tempo/);
  assert.equal(await workspace.isDisabled(`[data-automation="${id}"] [data-au-action="run"]`), true, 'a blocked automação does not run again');
  await bubble.waitForFunction(() => window.__notices.some((text) => /PRs da manhã passou do tempo/.test(text)), null, { timeout: 15000 });
  await workspace.waitForFunction(() => /US\$ 1,42 de 8,50/.test(document.querySelector('#au-top')?.textContent ?? ''), null, { timeout: 5000 });
  const slept = fakeRuns()[1];
  assert.ok(!alive(slept.pid) && !alive(slept.childPid), 'the timeout took the whole process group down');
  await workspace.click(`[data-automation="${id}"] [data-au-action="confirm"]`);
  await workspace.waitForSelector(`[data-automation="${id}"] .au-state.blocked`, { state: 'detached', timeout: 10000 });
  assert.equal(await workspace.isDisabled(`[data-automation="${id}"] [data-au-action="run"]`), false, '"confirmar" frees the run');
  lap('3. timeout, blocked, confirmed');

  // ---- 4. the real rule-guard.js as the hook, with the rules the app wrote --------
  const guard = (command) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(appRoot, 'src', 'hook', 'rule-guard.js')], {
        env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), VIZOR_AUTOMATION: id, CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: repo, tool_name: 'Bash', tool_input: { command } }));
    });
  const pushed = await guard('git push origin main');
  assert.equal(pushed.code, 0);
  const verdict = JSON.parse(pushed.stdout).hookSpecificOutput;
  assert.equal(verdict.permissionDecision, 'deny');
  assert.match(verdict.permissionDecisionReason, /^Automação do Vizor \(nível ler\): comando fora do permitido para esta automação\.$/);
  assert.deepEqual(await guard('git status'), { code: 0, stdout: '' }, 'a read-only command still passes');
  lap('4. the guard denied git push');

  // ---- 5. quit with a run in flight: cancelled, nobody left behind ----------------
  fakeKnob({ mode: 'sleep' });
  await workspace.click(`[data-automation="${id}"] [data-au-action="run"]`);
  await workspace.waitForSelector(`[data-automation="${id}"] .au-state.running`, { timeout: 10000 });
  for (let attempt = 0; attempt < 50 && fakeRuns().length < 3; attempt++) await sleep(100);
  const inflight = fakeRuns()[2];
  assert.ok(inflight?.childPid && alive(inflight.pid) && alive(inflight.childPid), 'the run is in flight');
  // Control for scenario 6: with the tab on screen its clock repaints.
  const repaints = await workspace.evaluate(async () => {
    let count = 0;
    new MutationObserver(() => count++).observe(document.getElementById('au-list'), { childList: true, characterData: true, subtree: true });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return count;
  });
  assert.ok(repaints > 0, 'the visible tab repaints its running clock');
  await app.close();
  for (let attempt = 0; attempt < 50 && (alive(inflight.pid) || alive(inflight.childPid)); attempt++) await sleep(100);
  assert.ok(!alive(inflight.pid), 'the fake claude is gone');
  assert.ok(!alive(inflight.childPid), "the fake claude's child is gone");
  assert.throws(() => process.kill(-inflight.pid, 0), { code: 'ESRCH' }, 'the process group is gone');
  lap('5. quit: the group is gone');

  // The next open: the cancelled run in the history; a run that comes due at
  // about 30 s after the open (lastRun 14,5 min ago) for scenario 6.
  const saved = JSON.parse(fs.readFileSync(automacoesFile, 'utf8'));
  saved.automations.find((a) => a.id === id).lastRun = Date.now() - 14.5 * 60000;
  fs.writeFileSync(automacoesFile, JSON.stringify(saved));
  fakeKnob({ mode: 'ok', costUsd: 0.1, delayMs: 9000, result: 'Nada de novo.' });
  ({ launched: app, page: workspace } = await openApp());
  await workspace.keyboard.press('Control+4');
  await workspace.waitForSelector(`#view-automations:not([hidden]) [data-automation="${id}"]`, { timeout: 15000 });
  assert.match(await workspace.textContent(`[data-automation="${id}"] .au-last`), /cancelada/);
  await workspace.click(`[data-automation="${id}"] [data-au-action="history"]`);
  await workspace.waitForFunction(() => /cancelada/.test(document.querySelector('#au-side')?.textContent ?? ''), null, { timeout: 5000 });
  // 0,42 + 1,00 (the timeout's whole cap) + 1,00 (the cancelled run's): charged once.
  assert.match(await workspace.textContent('#au-top'), /US\$ 2,42 de 8,50/);
  lap('5. reopened: "cancelada" in the history');

  // ---- 6. minimized: the scheduler runs, the tab's clock does not ------------------
  const runsBefore = fakeRuns().length;
  await setMinimized(app, true);
  await sleep(500);
  // Xephyr runs no window manager, so minimize() is a no-op there and the page
  // never turns hidden by itself: say so to the page the way the browser would
  // (the same flag and event the tab and the status bar listen to).
  const hiddenByItself = await workspace.evaluate(() => document.hidden);
  if (!hiddenByItself) {
    await workspace.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
  assert.equal(await workspace.evaluate(() => document.hidden), true);
  await workspace.evaluate(() => {
    window.__repaints = 0;
    new MutationObserver(() => window.__repaints++).observe(document.getElementById('au-list'), { childList: true, characterData: true, subtree: true });
  });
  for (let attempt = 0; attempt < 400 && fakeRuns().length === runsBefore; attempt++) await sleep(250);
  assert.equal(fakeRuns().length, runsBefore + 1, 'the due run started with the window minimized');
  const due = fakeRuns()[runsBefore];
  await sleep(1500);
  const first = await workspace.evaluate(() => window.__repaints);
  await sleep(3000);
  assert.ok(alive(due.pid), 'the due run is still going');
  assert.equal(await workspace.evaluate(() => window.__repaints), first, "the tab's running clock does not repaint while minimized");
  const historyFile = path.join(config, 'automacoes', id, 'historico.jsonl');
  const entries = () => fs.readFileSync(historyFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  for (let attempt = 0; attempt < 100 && entries().at(-1)?.status !== 'ok'; attempt++) await sleep(200);
  assert.equal(entries().at(-1).status, 'ok', 'the run finished and was recorded while minimized');
  assert.equal(fakeRuns().length, runsBefore + 1, `and it ran once: ${JSON.stringify(fakeRuns().slice(runsBefore))}`);
  await setMinimized(app, false);
  await workspace.evaluate(() => {
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await workspace.waitForFunction((target) => /✓ ok/.test(document.querySelector(`[data-automation="${target}"] .au-last`)?.textContent ?? ''), id, { timeout: 10000 });
  lap('6. minimized: scheduler ran, no repaint');
  console.log('e2e: Automações end to end OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  for (const name of ['em-andamento.json', 'gasto-do-dia.json']) {
    const file = path.join(config, 'automacoes', name);
    if (fs.existsSync(file)) console.error(`--- ${name} ---\n${fs.readFileSync(file, 'utf8')}`);
  }
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((it) => it.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-automations-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  for (const run of fakeRuns()) for (const pid of [run.pid, run.childPid]) if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
