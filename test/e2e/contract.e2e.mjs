// The contract flow, end to end, in the real Electron app: Ctrl+K → issue →
// the card shows the contract; the real rule-guard.js (as the hook) refuses
// code edits before the contract is approved; approving it makes the chat write
// the tests, which the Vizor runs (✗ for the right reason); approving the tests
// locks them (a shell write and an Edit are both refused); step 1 shows its own
// diff in Mudanças, a new file included; going back before step 1 restores the
// file and lists the new one; a locked test changed from outside shows on the
// card after the Stop, and `git push` is refused. Claude Code and gh are
// stand-ins (fake-bin, issue #149 is the task); the hook, the socket, the pty,
// the guard and the UI are real. Run by scripts/e2e.sh, which gives it a hidden X server.
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

const base = fs.existsSync(`/run/user/${process.getuid()}`) ? `/run/user/${process.getuid()}` : os.tmpdir();
const home = fs.mkdtempSync(path.join(base, 'vizor-e2e-contract-'));
const repo = path.join(home, 'projeto');
const Y_BEFORE = 'export const y = 1;\n';
fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
fs.writeFileSync(path.join(repo, 'src', 'y.js'), Y_BEFORE);
const git = (...args) => execFileSync('git', ['-c', 'user.email=e2e@vizor', '-c', 'user.name=e2e', ...args], { cwd: repo, env: { ...process.env, HOME: home } });
git('init', '-q', '-b', 'main');
git('add', '-A');
git('commit', '-q', '-m', 'init');
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
  DBUS_SESSION_BUS_ADDRESS: 'disabled:',
};
delete env.XDG_CONFIG_HOME;
delete env.CLAUDECODE;
delete env.VIZOR_INTERNAL;

const received = () => {
  try {
    return fs.readFileSync(path.join(home, 'claude-received.log'), 'utf8');
  } catch {
    return '';
  }
};
const until = async (what, check, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
};
const shot = async (page, name) => { if (shots) await page.screenshot({ path: path.join(shots, `e2e-contract-${name}.png`) }); };

// The real guard, as Claude Code runs it before a tool call.
const guard = (sessionId, tool_name, tool_input) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(appRoot, 'src', 'hook', 'rule-guard.js')], {
      env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => resolve({ code, reason: stdout ? JSON.parse(stdout).hookSpecificOutput : null }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: repo, tool_name, tool_input }));
  });
const denied = (result, pattern, what) => {
  assert.equal(result.code, 0, what);
  assert.equal(result.reason?.permissionDecision, 'deny', `${what}: ${JSON.stringify(result.reason)}`);
  assert.match(result.reason.permissionDecisionReason, pattern, what);
};
const rulesFile = path.join(config, 'tarefas', 'regras.json');
const sessionRule = () => {
  try {
    const sessions = JSON.parse(fs.readFileSync(rulesFile, 'utf8')).sessions;
    return Object.values(sessions)[0] ?? null;
  } catch {
    return null;
  }
};

const app = await _electron.launch({ executablePath: electronPath, args: [appRoot, '--no-sandbox', '--ozone-platform=x11'], env, cwd: home });
let failed = false;
try {
  const ws = await (async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = app.windows().find((page) => page.url().includes('workspace.html'));
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('the workspace window never opened');
  })();
  await ws.waitForLoadState('domcontentloaded');
  await ws.waitForSelector('#tabs', { timeout: 15000 });
  const card = () => ws.textContent('#plan-card');

  // ---- 1. Ctrl+K → issue → the card shows the contract --------------------------------
  await ws.keyboard.press('Control+K');
  await ws.waitForSelector('#command-bar:not([hidden])', { timeout: 5000 });
  await ws.waitForSelector('#command-list >> text=Puxar #149', { timeout: 15000 });
  await ws.keyboard.type('149');
  assert.match(await ws.textContent('#command-list [aria-selected="true"]'), /Puxar #149/);
  await ws.keyboard.press('Enter');
  await ws.waitForSelector('#plan-card [data-section="contract"]', { timeout: 30000 });
  // The cases are fields the dev can edit.
  assert.deepEqual(await ws.$$eval('#plan-card .plan-cases input', (inputs) => inputs.map((input) => input.value)), ['clicar no ícone → abre o menu', 'clicar fora → fecha o menu']);
  assert.equal(await ws.getAttribute('#plan-card .task-card', 'data-phase'), 'contract');
  assert.equal(await ws.isVisible('[data-task="approveContract"]'), true);
  await shot(ws, 'contract');

  // ---- 2. Before the approval the guard refuses a code edit ---------------------------
  const rule = await until('the contract gate in the guard rules', sessionRule);
  assert.equal(rule.phase, 'contract');
  const sessionId = fs.readdirSync(path.join(home, '.claude', 'sessions')).map((name) => JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', name), 'utf8')).sessionId)[0];
  assert.ok(sessionId, 'the fake chat registered');
  denied(await guard(sessionId, 'Edit', { file_path: path.join(repo, 'src', 'x.js'), old_string: 'a', new_string: 'b' }), /aprove o contrato antes de mexer no código/, 'a code edit before the contract');
  denied(await guard(sessionId, 'Write', { file_path: path.join(repo, 'src', 'y.js'), content: 'x' }), /aprove o contrato/, 'a Write before the contract');
  // The plan file is the one thing it may still write.
  assert.deepEqual(await guard(sessionId, 'Write', { file_path: path.join(repo, '.vizor', 'plano-149.md'), content: 'x' }), { code: 0, reason: null });

  // ---- 3. Approve the contract → tests and command → the run fails, for the right reason --
  await ws.click('[data-task="approveContract"]');
  await ws.waitForSelector('#plan-card [data-section="tests"]', { timeout: 30000 });
  await until('the tests command on the card', async () => /node test\/x\.test\.js/.test(await card()), 30000);
  assert.match(await card(), /test\/x\.test\.js/);
  assert.equal(await ws.getAttribute('#plan-card .task-card', 'data-phase'), 'tests');
  assert.match(received(), /Contrato aprovado/);
  // Between the tests' approval and the code, the chat may write the test files only.
  assert.equal((await until('the tests phase in the guard', () => (sessionRule()?.phase === 'tests' ? sessionRule() : null))).phase, 'tests');
  denied(await guard(sessionId, 'Edit', { file_path: path.join(repo, 'src', 'x.js'), old_string: 'a', new_string: 'b' }), /só os testes do contrato agora/, 'code in the tests phase');
  assert.equal((await guard(sessionId, 'Write', { file_path: path.join(repo, 'test', 'x.test.js'), content: 'x' })).reason, null, 'the contract test file stays writable');
  await ws.waitForSelector('[data-task="approveTests"]:not([disabled])', { timeout: 30000 });
  await shot(ws, 'tests');

  // ---- 4. Approve the tests: ✗ for the right reason, then locked ----------------------
  await ws.click('[data-task="approveTests"]');
  await ws.waitForSelector('#plan-card .plan-run.bad', { timeout: 30000 });
  assert.match(await ws.textContent('#plan-card .plan-run.bad'), /✗ última execução/);
  await ws.click('#plan-card .plan-tail summary');
  assert.match(await ws.textContent('#plan-card .plan-tail pre'), /Cannot find module '\.\.\/src\/x\.js'/);
  await shot(ws, 'run-failed');
  await ws.waitForSelector('#plan-card [data-section="steps"]', { timeout: 30000 });
  assert.match(await card(), /travado/);
  await until('the locked test in the guard rules', () => {
    try { return JSON.parse(fs.readFileSync(rulesFile, 'utf8')).folders[repo]?.locked.length === 1; } catch { return false; }
  });
  denied(await guard(sessionId, 'Bash', { command: 'echo gotcha > test/x.test.js' }), /é um teste travado do contrato/, 'a shell write to the locked test');
  denied(await guard(sessionId, 'Edit', { file_path: path.join(repo, 'test', 'x.test.js'), old_string: 'double', new_string: 'triple' }), /é um teste travado do contrato/, 'an Edit of the locked test');
  assert.equal(fs.readFileSync(path.join(repo, 'test', 'x.test.js'), 'utf8').includes('gotcha'), false);

  // ---- 5. Step 1 (the approval sent the order): why on the card, its own diff in Mudanças -
  await ws.waitForSelector('#plan-card [data-step="1"].done', { timeout: 40000 });
  assert.match(await ws.textContent('#plan-card [data-step="1"]'), /o passo 1 existe pra criar o menu/);
  await ws.click('[data-ui="step-diff"][data-n="1"]');
  await ws.waitForSelector('#changes-files .step-bar', { timeout: 15000 });
  await ws.waitForSelector('#changes-files .review-file', { timeout: 15000 });
  const stepFiles = await ws.$$eval('#changes-files .review-file', (rows) => rows.map((row) => row.dataset.path));
  assert.deepEqual(new Set(stepFiles), new Set(['src/y.js', 'src/x.js']), 'the step shows its own files, the new one included');
  assert.equal(await ws.textContent('#changes-files .step-label'), 'passo 1');
  await ws.click('#changes-files .review-file[data-path="src/x.js"]');
  assert.match(await ws.textContent('#changes-diff'), /exports\.double/);
  await shot(ws, 'step-diff');
  // The test the step is meant to satisfy runs green once the code exists.
  await until('the test passing after step 1', async () => /✓ última execução/.test(await card()), 30000);

  // ---- 6. Back to before step 1: the file returns, the new one is listed --------------
  await ws.click('[data-review-tab="summary"]');
  await ws.click('[data-ui="confirm"][data-kind="restore"][data-n="1"]');
  await ws.waitForSelector('.plan-confirm >> text=Voltar os arquivos pra antes do passo 1', { timeout: 10000 });
  await ws.click('[data-task="restoreBefore"][data-n="1"]');
  await until('src/y.js back before the step', () => fs.readFileSync(path.join(repo, 'src', 'y.js'), 'utf8') === Y_BEFORE);
  assert.equal(fs.existsSync(path.join(repo, 'src', 'x.js')), true, 'nothing is deleted');
  await until('the chat told which file stayed', () => /Ficaram arquivos criados depois:.*src\/x\.js/.test(received()));
  await until('the steps undone on the card', async () => /Passos · 0\/3/.test(await card()), 30000);
  await shot(ws, 'restored');

  // ---- 7. A locked test changed from outside (the run writes to it) ---------------------
  assert.equal((await guard(sessionId, 'Bash', { command: 'git push origin main' })).reason, null, 'a push passes while the locked test is as approved');
  fs.mkdirSync(path.join(repo, '.vizor'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.vizor', 'mutate'), '');
  // Step 1 again by "ok, segue" from Ctrl+K; the run it starts rewrites the locked test, and only then the fake stops.
  await ws.keyboard.press('Control+K');
  await ws.waitForSelector('#command-bar:not([hidden])', { timeout: 5000 });
  await ws.keyboard.type('seguir');
  assert.match(await ws.textContent('#command-list [aria-selected="true"]'), /Ok, seguir pro próximo passo/);
  await ws.keyboard.press('Enter');
  await ws.waitForSelector('#plan-card >> text=o teste do contrato mudou', { timeout: 40000 });
  assert.match(await card(), /Um arquivo de teste travado foi alterado/);
  assert.match(await ws.textContent('#plan-card [data-section="tests"]'), /test\/x\.test\.js\s*mudou/);
  await shot(ws, 'changed');
  denied(await guard(sessionId, 'Bash', { command: 'git push origin main' }), /o teste do contrato mudou/, 'a push with the locked test changed');
  console.log('e2e: contract OK (card, gate, ✗ run, locks, step diff, restore, changed test)');
} catch (error) {
  failed = true;
  console.error(`e2e contract FAILED: ${error.stack ?? error}`);
  const log = path.join(config, 'log');
  if (fs.existsSync(log)) console.error(`--- app log (tail) ---\n${fs.readFileSync(log, 'utf8').split('\n').slice(-40).join('\n')}`);
  try {
    const page = app.windows().find((item) => item.url().includes('workspace.html'));
    if (page && shots) await page.screenshot({ path: path.join(shots, 'e2e-contract-failure.png') });
  } catch {
    // no screenshot
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(home, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
