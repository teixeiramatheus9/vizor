// The Agentes and GitHub tabs in the real Electron app, with their budgets:
// twenty fake chats (one dying mid-turn) in the kanban, the lists of the fake
// gh (one query failing on purpose), "Puxar", the shortcuts with the terminal
// in front, no gh call while the window is minimized, and a burst of Stops
// leaving as one notice. Claude Code and gh are stand-ins (fake-bin).
// Run by scripts/e2e.sh.
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
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

const BUDGET = { agentsMs: 100, githubCachedMs: 150, idleGhCalls: 0 };

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

// A `gh` first on PATH that logs every call and runs the stand-in.
const bin = path.join(home, 'bin');
const ghLog = path.join(home, 'gh-calls.log');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${ghLog}'\nexec '${path.join(here, 'fake-bin', 'gh')}' "$@"\n`, { mode: 0o755 });
const ghCalls = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean) : []);

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
const hook = path.join(appRoot, 'src', 'hook', 'hook-emit.js');
const emit = (sessionId, cwd, event) =>
  spawnSync(process.execPath, [hook], { input: JSON.stringify({ session_id: sessionId, cwd: cwd ?? undefined, ...event }), env });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Twenty chats: 8 working (one of them dies), 5 waiting, 7 done. Claude Code
// lists each in ~/.claude/sessions; the dying one points at a process we kill.
const live = spawn('sleep', ['1000'], { stdio: 'ignore' });
const dying = spawn('sleep', ['1000'], { stdio: 'ignore' });
const chat = (index) => ({ id: crypto.randomUUID(), index, kind: index < 8 ? 'working' : index < 13 ? 'waiting' : 'done' });
const chats = Array.from({ length: 20 }, (_, index) => chat(index));
const doomed = chats[0];
const sessionsDir = path.join(home, '.claude', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
for (const item of chats) {
  const pid = item === doomed ? dying.pid : live.pid;
  fs.writeFileSync(path.join(sessionsDir, `${item.id}.json`), JSON.stringify({ pid, sessionId: item.id, cwd: repo, startedAt: Date.now(), kind: 'interactive' }));
}

const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
let failed = false;
try {
  const windowOf = async (name) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = app.windows().find((page) => page.url().includes(name));
      if (found) return found;
      await sleep(200);
    }
    throw new Error(`the ${name} window never opened`);
  };
  const workspace = await windowOf('workspace.html');
  await workspace.waitForLoadState('domcontentloaded');
  await workspace.waitForSelector('#tabs', { timeout: 15000 });
  // Each chat keeps its own xterm; the hidden ones stay in the DOM.
  const shownTerminal = '#term-host .xterm >> visible=true';
  const topTab = () => workspace.evaluate(() => document.querySelector('#top-tabs [aria-selected="true"]')?.dataset.topTab ?? null);

  // ---- 1. Agentes: twenty chats, columns, tombstone, budget -----------------
  for (const item of chats) {
    emit(item.id, repo, { hook_event_name: 'UserPromptSubmit', prompt: `Tarefa ${item.index}` });
    if (item.kind === 'waiting') emit(item.id, repo, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
    if (item.kind === 'done') emit(item.id, repo, { hook_event_name: 'Stop' });
    // Claude Code's idle "waiting for your input" a minute after a Stop asks
    // nothing: those chats must stay in Terminou.
    if (item.kind === 'done' && item.index % 2) emit(item.id, repo, { hook_event_name: 'Notification', message: 'Claude is waiting for your input' });
  }
  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector('#view-agents:not([hidden]) .kb-board', { timeout: 10000 });
  await workspace.waitForFunction(() => document.querySelectorAll('[data-card]').length >= 20, null, { timeout: 15000 });
  const count = (column) => workspace.locator(`[data-card][data-column="${column}"]`).count();
  await workspace.waitForFunction(() => document.querySelectorAll('[data-card][data-column="done"]').length === 7, null, { timeout: 10000 });
  assert.deepEqual([await count('working'), await count('waiting'), await count('done'), await count('failed')], [8, 5, 7, 0]);
  assert.match(await workspace.textContent('#top-tabs'), /Agentes · 5 esperando/);
  assert.equal(await workspace.locator('[data-action="interrupt"]').count(), 0, 'chats outside the Vizor have nothing to interrupt');
  if (shots) await workspace.screenshot({ path: path.join(shots, 'agentes.png') });

  await workspace.click('[data-kb-filter="needsMe"]');
  assert.equal(await workspace.locator('[data-card]').count(), 5);
  await workspace.click('[data-kb-filter="needsMe"]');

  // The tab with 20 cards draws inside its budget.
  await workspace.click('[data-top-tab="workspace"]');
  const agentsMs = await workspace.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        document.querySelector('[data-top-tab="agents"]').click();
        requestAnimationFrame(() => resolve(performance.now() - start));
      }),
  );
  console.log(`e2e: Agentes tab with 20 cards drew in ${agentsMs.toFixed(1)} ms`);
  assert.ok(agentsMs < BUDGET.agentsMs, `the Agentes tab took ${agentsMs} ms (limit ${BUDGET.agentsMs} ms)`);

  // One chat dies with its turn open: a tombstone in Falhou, until dismissed.
  dying.kill();
  await workspace.waitForSelector(`[data-card="${doomed.id}"][data-column="failed"]`, { timeout: 30000 });
  assert.equal(await count('working'), 7);
  assert.equal(await workspace.locator(`[data-card="${doomed.id}"] [data-action="focus"]`).count(), 0, 'a tombstone has no chat to focus');
  await workspace.click(`[data-card="${doomed.id}"] [data-action="dismiss"]`);
  await workspace.waitForFunction((id) => !document.querySelector(`[data-card="${id}"]`), doomed.id, { timeout: 10000 });
  assert.equal(await workspace.locator('[data-card]').count(), 19);
  assert.equal(await count('failed'), 0);

  // ---- 2. GitHub: lists, lazy body, cache budget ----------------------------
  await workspace.keyboard.press('Control+3');
  await workspace.waitForSelector('#view-github:not([hidden]) .gh-item', { timeout: 15000 });
  assert.equal(await workspace.locator('[data-gh-section="issues"] .gh-item').count(), 2);
  assert.equal(await workspace.locator('[data-gh-section="prs"] .gh-item').count(), 1);
  assert.equal(await workspace.locator('.gh-checks-ok').count(), 1);
  await workspace.click('[data-gh-section="prs"] .gh-item .gh-title');
  await workspace.waitForSelector('.gh-markdown strong', { timeout: 10000 });
  if (shots) await workspace.screenshot({ path: path.join(shots, 'github.png') });

  await workspace.click('[data-top-tab="workspace"]');
  const githubMs = await workspace.evaluate(
    () =>
      new Promise((resolve) => {
        const start = performance.now();
        document.querySelector('[data-top-tab="github"]').click();
        const wait = () => (document.querySelector('.gh-item') ? resolve(performance.now() - start) : requestAnimationFrame(wait));
        wait();
      }),
  );
  console.log(`e2e: GitHub tab from cache drew in ${githubMs.toFixed(1)} ms`);
  assert.ok(githubMs < BUDGET.githubCachedMs, `the GitHub tab took ${githubMs} ms (limit ${BUDGET.githubCachedMs} ms)`);

  // The PRs query fails: the issues stay, the PRs say why.
  fs.writeFileSync(path.join(home, 'gh-fail'), 'HTTP 502: bad gateway');
  await workspace.click('[data-action="refresh"]');
  await workspace.waitForSelector('[data-gh-section="prs"] .gh-error', { timeout: 15000 });
  assert.match(await workspace.textContent('[data-gh-section="prs"] .gh-error'), /não deu pra (ler|atualizar) as PRs.*502/s);
  assert.equal(await workspace.locator('[data-gh-section="issues"] .gh-item').count(), 2);
  assert.equal(await workspace.locator('[data-gh-section="issues"] .gh-error').count(), 0);
  if (shots) await workspace.screenshot({ path: path.join(shots, 'github-falha.png') });
  fs.rmSync(path.join(home, 'gh-fail'));

  // ---- 3. "Puxar" opens the issue's chat in the Workspace -------------------
  await workspace.click('[data-gh-section="issues"] [data-gh-number="169"] [data-action="pull"]');
  await workspace.waitForSelector('#tabs >> text=#169', { timeout: 30000 });
  assert.equal(await topTab(), 'workspace');
  await workspace.waitForSelector(shownTerminal, { timeout: 15000 });
  const pulled = await workspace.getAttribute('[data-session][aria-selected="true"]', 'data-session');
  assert.ok(pulled, 'the pulled chat is the selected session');

  // ---- 4. A card of "Esperando" takes you to that chat in the Workspace -----
  emit(pulled, null, { hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' });
  // Leave the Workspace in a state the click has to change: another chat
  // selected and the drawer closed (the Puxar step left both the other way).
  await workspace.click(`[data-session]:not([data-session="${pulled}"])`);
  await workspace.keyboard.press('Control+`');
  await workspace.waitForFunction(() => !document.querySelector('#terminal-drawer.open'), null, { timeout: 5000 });
  assert.equal(await workspace.getAttribute(`[data-session="${pulled}"]`, 'aria-selected'), 'false');
  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector(`[data-card="${pulled}"][data-column="waiting"]`, { timeout: 15000 });
  assert.equal(await topTab(), 'agents');
  // The chat was pulled inside the Vizor (no badge) and its permission ask is approved in the chat.
  assert.equal(await workspace.locator(`[data-card="${pulled}"] [data-action="approve"]`).count(), 1);
  assert.equal(await workspace.locator(`[data-card="${pulled}"] [data-action="answer"]`).count(), 0);
  assert.equal(await workspace.locator(`[data-card="${pulled}"] .kb-outside`).count(), 0);
  // Chats outside the Vizor wear the badge ("fora do Vizor").
  assert.match(await workspace.textContent(`[data-card="${chats[1].id}"] .kb-outside`), /fora do Vizor/);
  await workspace.click(`[data-card="${pulled}"] .kb-title`);
  await workspace.waitForSelector('#terminal-drawer.open', { timeout: 10000 });
  assert.equal(await topTab(), 'workspace');
  assert.equal(await workspace.getAttribute(`[data-session="${pulled}"]`, 'aria-selected'), 'true');
  assert.equal(await workspace.locator(shownTerminal).count(), 1);

  // ---- 5. Shortcuts: Ctrl+digit crosses the terminal, a bare digit does not -
  await workspace.focus(`${shownTerminal} .xterm-helper-textarea`);
  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector('#view-agents:not([hidden])', { timeout: 5000 });
  assert.equal(await topTab(), 'agents');
  await workspace.keyboard.press('Control+1');
  await workspace.waitForSelector('#terminal-drawer.open', { timeout: 5000 });
  await workspace.focus(`${shownTerminal} .xterm-helper-textarea`);
  const received = path.join(home, 'claude-received.log');
  const before = fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '';
  const reviewTab = await workspace.evaluate(() => document.body.dataset.reviewTab);
  await workspace.keyboard.press('1');
  for (let attempt = 0; attempt < 50 && (fs.existsSync(received) ? fs.readFileSync(received, 'utf8') : '') === before; attempt++) await sleep(100);
  assert.equal(fs.readFileSync(received, 'utf8'), `${before}1`, 'the bare "1" reached the terminal');
  assert.equal(await workspace.evaluate(() => document.body.dataset.reviewTab), reviewTab, 'and did not move the review tab');
  assert.equal(await topTab(), 'workspace');

  // ---- 5b. A focus request from outside (bubble, balloon, panel) lands in the Workspace
  await workspace.keyboard.press('Control+2');
  await workspace.waitForSelector('#view-agents:not([hidden])', { timeout: 5000 });
  await app.evaluate(({ BrowserWindow }, sessionId) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('workspace.html')).webContents.send('workspace:focus', { sessionId });
  }, pulled);
  await workspace.waitForFunction(() => document.querySelector('#top-tabs [aria-selected="true"]')?.dataset.topTab === 'workspace', null, { timeout: 5000 });
  assert.equal(await workspace.getAttribute(`[data-session="${pulled}"]`, 'aria-selected'), 'true');

  // ---- 6. Three Stops inside a second make ONE notice -----------------------
  // The balloon lives in the main window's page: record every text it takes.
  const bubble = await windowOf('app.html');
  await sleep(4000); // the notices of the setup above have all left by now
  await bubble.evaluate(() => {
    window.__notices = [];
    new MutationObserver(() => window.__notices.push(document.getElementById('tooltip-text').textContent)).observe(document.getElementById('tooltip-text'), { childList: true, characterData: true, subtree: true });
  });
  const burst = chats.filter((item) => item.kind === 'working' && item !== doomed).slice(0, 3);
  for (const item of burst) emit(item.id, repo, { hook_event_name: 'Stop' });
  await bubble.waitForFunction(() => window.__notices.length > 0, null, { timeout: 10000 });
  await sleep(4500); // a second balloon, if one was going to come, would be out by now
  const notices = await bubble.evaluate(() => window.__notices);
  assert.deepEqual(notices, ['3 chats terminaram'], `three Stops in a burst gave ${JSON.stringify(notices)}`);

  // ---- 7. Minimized window: no gh call in five seconds ----------------------
  assert.ok(ghCalls().length >= 1, 'the gh wrapper saw calls earlier, so a count of 0 below means something');
  await workspace.keyboard.press('Control+3');
  await workspace.waitForSelector('#view-github:not([hidden]) .gh-item', { timeout: 15000 });
  await sleep(1500); // whatever the visit started has answered
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('workspace.html')).minimize();
  });
  await sleep(300);
  const callsBefore = ghCalls().length;
  await sleep(5000);
  const idle = ghCalls().slice(callsBefore);
  console.log(`e2e: ${idle.length} gh calls in 5 s with the window minimized`);
  assert.equal(idle.length, BUDGET.idleGhCalls, `gh with the window minimized: ${idle.join(' | ')}`);
  console.log('e2e: Agentes and GitHub tabs OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-tabs-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  live.kill();
  dying.kill();
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
