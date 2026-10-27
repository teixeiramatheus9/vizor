// The Automações tab in the real Electron app: the list with its states, the
// history with a report, the form (validation, save), the day cap raised from
// the tab, and "rodar agora" through the stand-in claude. Claude Code and gh
// are stand-ins (fake-bin). Run by scripts/e2e.sh.
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
const first = mk({ id: 'au-1', name: 'PRs da manhã', slug: 'prs-da-manha', when: { kind: 'every', minutes: 600 } });
const second = mk({ id: 'au-2', name: 'Lint noturno', slug: 'lint-noturno', when: { kind: 'daily', at: '09:00' }, level: 'worktree', paused: true });
fs.writeFileSync(path.join(config, 'automacoes.json'), JSON.stringify({ automations: [first, second] }));
const folder = path.join(config, 'automacoes', 'au-1');
fs.mkdirSync(folder, { recursive: true });
const at = new Date(now - 7 * 60000).toISOString();
fs.writeFileSync(path.join(folder, 'historico.jsonl'), `${JSON.stringify({ name: first.name, status: 'ok', costUsd: 0.31, durationMs: 42000, late: false, at, report: '20261027-0930.md' })}\n`);
fs.writeFileSync(path.join(folder, '20261027-0930.md'), '# PRs da manhã\n\n- Status: ok\n\n## Resultado\n\nTrês PRs abertas: **#12** espera review, `#14` passou nos testes.\n\n<img src=x onerror="window.__pwned = 1">\n');

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

const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
let failed = false;
try {
  let workspace;
  for (let attempt = 0; attempt < 100 && !workspace; attempt++) {
    workspace = app.windows().find((page) => page.url().includes('workspace.html'));
    if (!workspace) await sleep(200);
  }
  assert.ok(workspace, 'the workspace window never opened');
  await workspace.waitForLoadState('domcontentloaded');
  await workspace.waitForSelector('#tabs', { timeout: 15000 });

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

  // ---- run now through the stand-in claude ---------------------------------------
  const item = (await workspace.locator('.au-item', { hasText: 'Resumo do dia' }).getAttribute('data-automation'));
  await workspace.click(`[data-automation="${item}"] [data-au-action="run"]`);
  await workspace.waitForFunction((id) => !/nunca rodou/.test(document.querySelector(`[data-automation="${id}"]`)?.textContent ?? ''), item, { timeout: 30000 });
  console.log('e2e: Automações tab OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((it) => it.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-automations-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
