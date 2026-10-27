// The Agentes tab in the real Electron app: sessions reported through the real
// hook land in the kanban columns, a card's actions answer for themselves, and
// the tab with 20 cards draws inside its budget. Run by scripts/e2e.sh.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
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
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-'));
const repo = path.join(home, 'projeto');
const elsewhere = path.join(home, 'solta');
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(elsewhere, { recursive: true });
const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, HOME: home } });
git('init', '-q', '-b', 'main');
git('-c', 'user.email=e2e@vizor', '-c', 'user.name=e2e', 'commit', '-q', '--allow-empty', '-m', 'init');
git('remote', 'add', 'origin', 'https://github.com/teixeiramatheus9/vizor-e2e.git');
const config = path.join(home, '.config', 'vizor');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ workspaceProjects: [repo], muted: true, ttsEnabled: false, autoUpdate: false }));
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ workspaceTabs: { tabs: [{ cwd: repo, sessionId: null }], active: 0, windowOpen: true } }));

const env = {
  ...process.env,
  HOME: home,
  SHELL: '/bin/bash',
  PATH: `${path.join(here, 'fake-bin')}:${process.env.PATH}`,
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;
const hook = path.join(appRoot, 'src', 'hook', 'hook-emit.js');
const emit = (sessionId, cwd, event) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: sessionId, cwd, ...event }), env });

const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
let failed = false;
try {
  const workspace = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = app.windows().find((page) => page.url().includes('workspace.html'));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('the workspace window never opened');
  })();
  await workspace.waitForLoadState('domcontentloaded');
  await workspace.waitForSelector('#tabs', { timeout: 15000 });

  const working = crypto.randomUUID();
  const asking = crypto.randomUUID();
  const finished = crypto.randomUUID();
  emit(working, repo, { hook_event_name: 'UserPromptSubmit', prompt: 'Refatorar o menu de ação' });
  emit(asking, repo, { hook_event_name: 'UserPromptSubmit', prompt: 'Escolher o banco' });
  emit(asking, repo, { hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  emit(finished, elsewhere, { hook_event_name: 'UserPromptSubmit', prompt: 'Rodar a migração' });
  emit(finished, elsewhere, { hook_event_name: 'Stop' });

  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector('#view-agents:not([hidden]) .kb-board', { timeout: 10000 });
  await workspace.waitForSelector('[data-card]', { timeout: 10000 });
  const column = (id) => workspace.getAttribute(`[data-card="${id}"]`, 'data-column');
  await workspace.waitForSelector(`[data-card="${asking}"][data-column="waiting"]`, { timeout: 10000 });
  await workspace.waitForSelector(`[data-card="${finished}"][data-column="done"]`, { timeout: 10000 });
  assert.equal(await column(working), 'working');
  assert.match(await workspace.textContent('#top-tabs'), /Agentes · 1 esperando/);
  // Chats outside the Vizor: badge, and no interrupt to press.
  assert.equal(await workspace.isVisible(`[data-card="${working}"] .kb-outside`), true);
  assert.equal(await workspace.locator('[data-action="interrupt"]').count(), 0);
  assert.equal(await workspace.locator(`[data-card="${asking}"] [data-action="answer"]`).count(), 1);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'agentes.png') });

  // The "só o que precisa de mim" chip.
  await workspace.click('[data-kb-filter="needsMe"]');
  assert.equal(await workspace.locator('[data-card]').count(), 1);
  await workspace.click('[data-kb-filter="needsMe"]');

  // Twenty cards: the tab draws inside the 100 ms budget.
  for (let index = 0; index < 17; index++) {
    const id = crypto.randomUUID();
    emit(id, repo, { hook_event_name: 'UserPromptSubmit', prompt: `Tarefa ${index}` });
  }
  await workspace.waitForFunction(() => document.querySelectorAll('[data-card]').length >= 20, null, { timeout: 15000 });
  await workspace.click('[data-top-tab="workspace"]');
  const millis = await workspace.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        document.querySelector('[data-top-tab="agents"]').click();
        requestAnimationFrame(() => resolve(performance.now() - start));
      }),
  );
  console.log(`e2e: Agentes tab with 20 cards drew in ${millis.toFixed(1)} ms`);
  assert.ok(millis < 100, `the Agentes tab took ${millis} ms`);
  console.log('e2e: Agentes tab OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-agents-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
