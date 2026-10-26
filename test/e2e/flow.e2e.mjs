// The core flow, end to end, in the real Electron app: Ctrl+K → pick issue
// 169 → its chat opens in a tab → the plan card shows 0/3 → "Aprovar plano"
// → the chat ticks step one → the card shows 1/3. Claude Code and gh are
// stand-ins (fake-bin); the hook, the socket, the pty and the UI are real.
// Run by scripts/e2e.sh, which gives it a hidden X server.
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
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-'));
const repo = path.join(home, 'projeto');
fs.mkdirSync(repo, { recursive: true });
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
  VIZOR_E2E_HOOK: path.join(appRoot, 'src', 'hook', 'hook-emit.js'),
  DBUS_SESSION_BUS_ADDRESS: 'disabled:', // no tray icon on the real desktop
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;

const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: appRoot });
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

  await workspace.keyboard.press('Control+K');
  await workspace.waitForSelector('#command-bar:not([hidden])', { timeout: 5000 });
  await workspace.waitForSelector('#command-list >> text=Puxar #169', { timeout: 15000 });
  await workspace.keyboard.type('169');
  const first = await workspace.textContent('#command-list [aria-selected="true"]');
  assert.match(first, /Puxar #169/);
  await workspace.keyboard.press('Enter');
  assert.equal(await workspace.isVisible('#command-bar'), false);

  await workspace.waitForSelector('#plan-card >> text=Plano · 0/3', { timeout: 30000 });
  assert.match(await workspace.textContent('#plan-card'), /Ler a issue.*Criar o menu.*Testar o menu/s);
  assert.equal(await workspace.isVisible('[data-plan="approve"]'), true);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'e2e-plan.png') });
  // The plan file stays out of git.
  assert.match(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), /^\.vizor\/$/m);

  await workspace.click('[data-plan="approve"]');
  await workspace.waitForSelector('#plan-card >> text=Plano · 1/3', { timeout: 30000 });
  assert.equal(await workspace.isVisible('[data-plan="approve"]'), false);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'e2e-approved.png') });
  console.log('e2e: core flow OK (Ctrl+K → issue → plan 0/3 → approve → 1/3)');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
