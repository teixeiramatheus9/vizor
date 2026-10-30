// The Claude usage limits, end to end, in the real Electron app: the app puts
// the status-line tap into the isolated ~/.claude/settings.json around a fake
// original, the tap command (the very one Claude Code would run, through sh)
// feeds readings to the real socket, and the status bar, the panel, the
// notices, the reset alarm and a restart are checked on what the user sees.
// Run by scripts/e2e.sh, which gives it a hidden X server.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-limits-'));
const repo = path.join(home, 'projeto');
const alfa = path.join(home, 'alfa');
const beta = path.join(home, 'beta');
for (const dir of [repo, alfa, beta]) fs.mkdirSync(dir, { recursive: true });
const config = path.join(home, '.config', 'vizor');
fs.mkdirSync(config, { recursive: true });
fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ workspaceProjects: [repo], muted: true, ttsEnabled: false, autoUpdate: false }));
fs.writeFileSync(path.join(config, 'state.json'), JSON.stringify({ workspaceTabs: { tabs: [{ cwd: repo, sessionId: null }], active: 0, windowOpen: true } }));
const settingsFile = path.join(home, '.claude', 'settings.json');
const ORIGINAL = { type: 'command', command: 'echo ORIGINAL', padding: 2 };
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
fs.writeFileSync(settingsFile, JSON.stringify({ statusLine: ORIGINAL }));

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
delete env.VIZOR_SOCKET;
delete env.APPIMAGE;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (what, check, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const statusLine = () => readJson(settingsFile)?.statusLine;
const windowOf = (launched, name) => launched.windows().find((it) => it.url().includes(name));

// Runs the statusLine command from settings.json the way Claude Code does.
const runTap = (input) => {
  const command = statusLine()?.command;
  assert.ok(command, 'there is a statusLine command to run');
  return spawnSync('sh', ['-c', command], { input: JSON.stringify(input), env, encoding: 'utf8' });
};
const reading = ({ session = 's1', cwd = alfa, cost = 1, pct, resetsAt }) => ({
  session_id: session,
  cwd,
  cost: { total_cost_usd: cost },
  rate_limits: { five_hour: { used_percentage: pct, resets_at: resetsAt } },
});
const inSeconds = (ms) => (Date.now() + ms) / 1000;

const launch = () => _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
const openWindows = async (launched) => {
  const ws = await until('the workspace window', () => windowOf(launched, 'workspace.html'), 20000);
  await ws.waitForLoadState('domcontentloaded');
  await ws.waitForSelector('#status-bar', { timeout: 15000 });
  const bubble = await until('the bubble window', () => windowOf(launched, 'app.html'), 20000);
  await bubble.waitForLoadState('domcontentloaded');
  // Every balloon text that shows up, the one already there included.
  await bubble.evaluate(() => {
    const target = document.getElementById('tooltip-text');
    window.__notices = target.textContent ? [target.textContent] : [];
    new MutationObserver(() => window.__notices.push(target.textContent)).observe(target, { childList: true, characterData: true, subtree: true });
  });
  return { ws, bubble };
};
const noticesMatching = (bubble, source) =>
  bubble.evaluate((pattern) => window.__notices.filter((text) => new RegExp(pattern).test(text)).length, source);
const waitNotice = (bubble, source, ms = 15000) =>
  until(`a notice like ${source}`, async () => (await noticesMatching(bubble, source)) > 0, ms);
const statusText = (ws) => ws.evaluate(() => document.querySelector('.status-limits')?.textContent ?? '');

let app = await launch();
let failed = false;
try {
  let { ws, bubble } = await openWindows(app);

  // ---- 1. the tap is installed around the original, and removed cleanly ------------
  const tap = await until('the tap in settings.json', () => /statusline-tap\.sh/.test(statusLine()?.command ?? '') && statusLine().command);
  assert.equal(statusLine().padding, 2, 'the original keys stay on the line');
  assert.deepEqual(readJson(path.join(config, 'statusline-original.json')), ORIGINAL);
  assert.equal(fs.readFileSync(path.join(config, 'statusline-original.sh'), 'utf8'), 'echo ORIGINAL', 'the shim keeps its own copy of the original');
  assert.ok(fs.existsSync(path.join(config, 'statusline', 'statusline-tap.js')), 'the tap is copied out of the app');
  const ran = runTap({ session_id: 'none' });
  assert.equal(ran.stdout.trim(), 'ORIGINAL', 'the tap runs the original and prints what it printed');
  assert.equal(ran.status, 0);
  await bubble.evaluate((partial) => window.manager.setConfig(partial), { limits: { fiveHour: false, sevenDay: false } });
  await until('the original back in settings.json', () => statusLine()?.command === 'echo ORIGINAL');
  assert.deepEqual(statusLine(), ORIGINAL, 'remove restores the whole original line');
  assert.equal(fs.existsSync(path.join(config, 'statusline-original.json')), false, 'the sidecar goes with it');
  assert.equal(fs.existsSync(path.join(config, 'statusline-original.sh')), false, "and the shim's copy too");
  await bubble.evaluate((partial) => window.manager.setConfig(partial), { limits: { fiveHour: true, sevenDay: true } });
  await until('the tap back', () => statusLine()?.command === tap);
  assert.deepEqual(readJson(path.join(config, 'statusline-original.json')), ORIGINAL);
  assert.equal(runTap({}).stdout.trim(), 'ORIGINAL');

  // ---- 2. 82% for 5h: the label, the near level, one notice -----------------------------
  const windowEnd = inSeconds(5 * 3600_000);
  runTap(reading({ session: 's1', cwd: alfa, cost: 1.0, pct: 82, resetsAt: windowEnd }));
  await until('the label', async () => /5h 82%/.test(await statusText(ws)));
  assert.equal(await ws.evaluate(() => document.querySelector('.status-limits').classList.contains('near')), true);
  await waitNotice(bubble, 'tá em 82%');
  runTap(reading({ session: 's1', cwd: alfa, cost: 1.0, pct: 82, resetsAt: windowEnd }));
  await sleep(1500);
  assert.equal(await noticesMatching(bubble, 'tá em 82%'), 1, 'exactly one near notice');

  // ---- 3. two chats: costs 1.0→1.5 and 2.0→3.0 ------------------------------------------
  runTap(reading({ session: 's2', cwd: beta, cost: 2.0, pct: 82, resetsAt: windowEnd }));
  runTap(reading({ session: 's1', cwd: alfa, cost: 1.5, pct: 84, resetsAt: windowEnd }));
  runTap(reading({ session: 's2', cwd: beta, cost: 3.0, pct: 85, resetsAt: windowEnd }));
  await until('85%', async () => /5h 85%/.test(await statusText(ws)));
  await ws.click('[data-limits-toggle]');
  await ws.waitForSelector('#limits-popover:not([hidden]) .lim-shares');
  const shares = await ws.textContent('.lim-shares');
  assert.match(shares, /alfa.*≈\d+%/);
  assert.match(shares, /beta.*≈\d+%/);
  assert.match(shares, /fora do Vizor/);
  assert.equal(await ws.locator('.lim-shares li').count(), 3);
  if (shots) await ws.screenshot({ path: path.join(shots, 'e2e-limits-panel.png') });
  await ws.keyboard.press('Escape');

  // ---- 4. out, then back at the reset; the window leaves the bar --------------------------
  runTap(reading({ session: 's1', cwd: alfa, cost: 1.6, pct: 100, resetsAt: inSeconds(4000) }));
  await waitNotice(bubble, 'Acabou o limite de 5h — volta às');
  await until('"voltou"', async () => (await noticesMatching(bubble, 'Voltou! O limite de 5h zerou')) > 0, 15000);
  await until('the window leaving the bar', async () => !/5h/.test(await statusText(ws)));
  await sleep(1500);
  assert.equal(await noticesMatching(bubble, 'Voltou! O limite de 5h zerou'), 1, 'exactly one "voltou"');

  // ---- 5. out again, the app closed across the reset: one "voltou" at boot ----------------
  runTap(reading({ session: 's1', cwd: alfa, cost: 1.7, pct: 100, resetsAt: inSeconds(3000) }));
  await waitNotice(bubble, 'Acabou o limite de 5h');
  const saved = () => Object.values(readJson(path.join(config, 'limites.json'))?.fired ?? {}).filter((f) => f.out).length;
  await until('the exhausted window saved', () => saved() >= 2);
  await app.close();
  await sleep(4000);
  app = await launch();
  ({ ws, bubble } = await openWindows(app));
  await waitNotice(bubble, 'Voltou! O limite de 5h zerou');
  await sleep(1500);
  assert.equal(await noticesMatching(bubble, 'Voltou! O limite de 5h zerou'), 1, 'exactly one "voltou" at boot');
  assert.equal(await noticesMatching(bubble, 'Acabou o limite'), 0, 'nothing else rings at boot');
  assert.equal(/5h/.test(await statusText(ws)), false, 'the expired window stays off the bar');
  console.log('e2e: limits end to end OK');
} catch (error) {
  failed = true;
  console.error(`e2e FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    console.error(`--- limites.json ---\n${fs.readFileSync(path.join(config, 'limites.json'), 'utf8')}`);
  } catch {
    // none yet
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
  if (failed) process.exitCode = 1;
}
