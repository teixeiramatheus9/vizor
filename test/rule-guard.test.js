import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contextFor, decide, loadRules } from '../src/hook/rule-guard.js';

const GUARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook', 'rule-guard.js');

const DROP = {
  id: 'drop',
  source: 'nunca de drop em nada de banco de dados',
  kind: 'forbid',
  irreversible: true,
  explain: 'DROP em banco',
  match: [{ type: 'sql', statements: ['DROP'] }],
};
const PROD = {
  id: 'prod',
  source: 'quando ver PROD pergunte',
  kind: 'ask',
  irreversible: false,
  explain: 'menciona PROD',
  match: [{ type: 'keyword', words: ['prod'] }],
};
const AGENT = { id: 'co', source: 'não se autoreferencie no commit', kind: 'agent', irreversible: false, explain: '', match: [] };
const RULES = { version: 3, global: [DROP, AGENT], repos: { '/repo': [PROD] } };

const preTool = (command) => ({
  hook_event_name: 'PreToolUse',
  session_id: 's1',
  cwd: '/repo/sub',
  tool_name: 'Bash',
  tool_input: { command },
});

function run(event, { ask = async () => 'offline', headless = false, repoRoot = '/repo', rules = RULES } = {}) {
  return decide({ event, rules, repoRoot, gitContext: () => null, ask, headless });
}

describe('decide', () => {
  it('a forbid denies with the rule in the reason, without asking', async () => {
    let asked = false;
    const output = await run(preTool('psql -c "drop table x"'), { ask: async () => ((asked = true), 'liberar') });
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain(DROP.source);
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('DROP em banco. Não tente contornar.');
    expect(asked).toBe(false);
  });

  it('an ask follows the answer from the Vizor', async () => {
    expect(await run(preTool('kubectl --context prod apply'), { ask: async () => 'liberar' })).toBeNull();
    const barred = await run(preTool('kubectl --context prod apply'), { ask: async () => 'barrar' });
    expect(barred.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(barred.hookSpecificOutput.permissionDecisionReason).toContain('barrado no Vizor');
    const late = await run(preTool('kubectl --context prod apply'), { ask: async () => 'timeout' });
    expect(late.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(late.hookSpecificOutput.permissionDecisionReason).toContain('sem resposta no Vizor');
    const offline = await run(preTool('kubectl --context prod apply'), { ask: async () => 'offline' });
    expect(offline.hookSpecificOutput.permissionDecision).toBe('ask');
  });

  it('sends the Vizor what it needs to show and to grant', async () => {
    let request;
    await run(preTool('kubectl --context prod apply'), { ask: async (sent) => ((request = sent), 'liberar') });
    expect(request).toMatchObject({
      type: 'guard-ask',
      sessionId: 's1',
      cwd: '/repo/sub',
      tool: 'Bash',
      ruleId: 'prod',
      ruleSource: PROD.source,
      irreversible: false,
      target: 'kubectl --context prod apply',
    });
  });

  it('a session without a terminal and no Vizor is denied, not left asking', async () => {
    const output = await run(preTool('kubectl --context prod apply'), { headless: true });
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('sem terminal');
  });

  it('tells the Vizor about a forbid, for the history', async () => {
    const notes = [];
    await decide({ event: preTool('drop table x'), rules: RULES, repoRoot: '/repo', gitContext: () => null, ask: async () => 'offline', headless: false, notify: (note) => notes.push(note) });
    expect(notes).toEqual([
      expect.objectContaining({ type: 'guard-event', sessionId: 's1', ruleSource: DROP.source, outcome: 'barrado', summary: 'drop table x' }),
    ]);
  });

  it('no match prints nothing', async () => {
    expect(await run(preTool('ls -la'))).toBeNull();
  });

  it('repo rules apply only inside that repo', async () => {
    expect(await run(preTool('echo prod'), { repoRoot: '/other' })).toBeNull();
    expect((await run(preTool('drop table x'), { repoRoot: '/other' })).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('loadRules', () => {
  const dir = '/r';
  it('falls back to the previous good copy, and gives up when both are bad', () => {
    const files = { '/r/compiladas.json': '{oops', '/r/compiladas.anterior.json': JSON.stringify(RULES) };
    const read = (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    };
    expect(loadRules(read, dir)).toEqual(RULES);
    files['/r/compiladas.anterior.json'] = 'null';
    expect(loadRules(read, dir)).toBeNull();
  });
});

describe('contextFor', () => {
  const start = { hook_event_name: 'SessionStart', session_id: 's1', cwd: '/repo' };
  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd: '/repo' };

  it('SessionStart lists every rule, after telling the agent to read them all first', () => {
    const { output, version } = contextFor({ event: start, rules: RULES, repoRoot: '/repo', seenVersion: null });
    const text = output.hookSpecificOutput.additionalContext;
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(text.split('\n')[0]).toMatch(/leia todas/i);
    for (const rule of [DROP, AGENT, PROD]) expect(text).toContain(rule.source);
    expect(version).toBe(3);
  });

  it('UserPromptSubmit repeats them only when they changed', () => {
    expect(contextFor({ event: prompt, rules: RULES, repoRoot: '/repo', seenVersion: 3 })).toBeNull();
    const { output } = contextFor({ event: prompt, rules: RULES, repoRoot: '/repo', seenVersion: 2 });
    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain(PROD.source);
  });

  it('stays under the 10 000 character cap', () => {
    const many = Array.from({ length: 400 }, (_, n) => ({ ...AGENT, id: `a${n}`, source: `regra comprida número ${n} `.repeat(3) }));
    const { output } = contextFor({ event: start, rules: { version: 1, global: many, repos: {} }, repoRoot: null, seenVersion: null });
    expect(output.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(10000);
  });
});

describe('rule-guard script', () => {
  let home;
  let server;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzguard-'));
    const dir = path.join(home, '.config', 'vizor', 'regras');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compiladas.json'), JSON.stringify({ version: 1, global: [DROP, PROD], repos: {} }));
  });
  afterEach(() => {
    server?.close();
    server = null;
    fs.rmSync(home, { recursive: true, force: true });
  });

  function guard(stdin, env = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], {
        env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), ...env },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', (code) => resolve({ code, stdout }));
      child.stdin.end(stdin);
    });
  }
  const decision = (stdout) => JSON.parse(stdout).hookSpecificOutput.permissionDecision;
  const event = (command) => JSON.stringify({ ...preTool(command), cwd: home });

  it('ignores stdin that is not JSON', async () => {
    expect(await guard('not json')).toEqual({ code: 0, stdout: '' });
  });

  it('denies a forbidden command, even with VIZOR_INTERNAL set', async () => {
    const result = await guard(event('psql -c "drop table x"'), { VIZOR_INTERNAL: '1' });
    expect(result.code).toBe(0);
    expect(decision(result.stdout)).toBe('deny');
  });

  it('falls back to the terminal prompt when the Vizor is not listening', async () => {
    const result = await guard(event('echo prod'), { CLAUDE_CODE_ENTRYPOINT: 'cli' });
    expect(decision(result.stdout)).toBe('ask');
  });

  it('a Vizor that never answers, or hangs up, ends in a deny', async () => {
    const socketPath = path.join(home, 'v.sock');
    server = net.createServer(() => {}).listen(socketPath);
    const silent = await guard(event('echo prod'), { VIZOR_SOCKET: socketPath, VIZOR_GUARD_ASK_MS: '200' });
    expect(decision(silent.stdout)).toBe('deny');
    expect(JSON.parse(silent.stdout).hookSpecificOutput.permissionDecisionReason).toContain('sem resposta no Vizor');
    server.close();
    server = net.createServer((socket) => socket.end()).listen(socketPath);
    const hangUp = await guard(event('echo prod'), { VIZOR_SOCKET: socketPath });
    expect(decision(hangUp.stdout)).toBe('deny');
  });

  it('a Vizor answer of liberar prints no decision', async () => {
    const socketPath = path.join(home, 'v.sock');
    server = net
      .createServer((socket) => socket.once('data', () => socket.end(`${JSON.stringify({ answer: 'liberar' })}\n`)))
      .listen(socketPath);
    const result = await guard(event('echo prod'), { VIZOR_SOCKET: socketPath });
    expect(result).toEqual({ code: 0, stdout: '' });
  });
});

describe('rule-guard script entrypoints (I9)', () => {
  let home;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'vzguard-'));
    const dir = path.join(home, '.config', 'vizor', 'regras');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compiladas.json'), JSON.stringify({ version: 1, global: [PROD], repos: {} }));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function decisionWith(entrypoint) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [GUARD], {
        env: { PATH: process.env.PATH, HOME: home, VIZOR_SOCKET: path.join(home, 'none.sock'), CLAUDE_CODE_ENTRYPOINT: entrypoint },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('close', () => resolve(JSON.parse(stdout).hookSpecificOutput.permissionDecision));
      child.stdin.end(JSON.stringify({ ...preTool('echo prod'), cwd: home }));
    });
  }

  it('only sdk entrypoints count as headless; IDE extensions keep the permission prompt', async () => {
    expect(await decisionWith('claude-vscode')).toBe('ask');
    expect(await decisionWith('sdk-cli')).toBe('deny');
    expect(await decisionWith('sdk-ts')).toBe('deny');
  });
});

describe('rule-guard as a module of the packaged app', () => {
  it('importing it with a flag as argv[1] does not throw (packaged Electron boot)', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `process.argv[1] = '--no-sandbox'; await import(${JSON.stringify(pathToFileURL(GUARD).href)}); console.log('ok');`], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe('ok');
  });
});
