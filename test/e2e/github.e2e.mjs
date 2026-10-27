// The GitHub tab in the real Electron app, with the fake gh: lists, lazy body
// and the cached re-open inside its budget. Run by scripts/e2e.sh.
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
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;

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

  await workspace.keyboard.press('Control+3');
  await workspace.waitForSelector('#view-github:not([hidden]) .gh-item', { timeout: 15000 });
  assert.equal(await workspace.locator('[data-gh-section="issues"] .gh-item').count(), 2);
  assert.equal(await workspace.locator('[data-gh-section="prs"] .gh-item').count(), 1);
  assert.equal(await workspace.locator('.gh-checks-ok').count(), 1);
  // The body is read when a row is picked.
  await workspace.click('[data-gh-section="prs"] .gh-item .gh-title');
  await workspace.waitForSelector('.gh-markdown strong', { timeout: 10000 });
  if (shots) await workspace.screenshot({ path: path.join(shots, 'github.png') });

  // Back in the tab, inside the period: drawn from the cache inside the budget.
  await workspace.click('[data-top-tab="workspace"]');
  const millis = await workspace.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        document.querySelector('[data-top-tab="github"]').click();
        const wait = () => (document.querySelector('.gh-item') ? resolve(performance.now() - start) : requestAnimationFrame(wait));
        wait();
      }),
  );
  console.log(`e2e: GitHub tab from cache drew in ${millis.toFixed(1)} ms`);
  assert.ok(millis < 150, `the GitHub tab took ${millis} ms`);
  console.log('e2e: GitHub tab OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-github-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
