import { describe, it, expect } from 'vitest';
import { createNarrator } from '../src/main/voice/narration.js';

function setup() {
  let time = 100000;
  const narrator = createNarrator({ now: () => time });
  return { narrate: (event) => narrator.narrate(event), advance: (ms) => (time += ms) };
}
const pre = (tool_name, tool_input) => ({ hook_event_name: 'PreToolUse', tool_name, tool_input });
const post = (tool_name, tool_input, tail = '') => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_output_tail: tail });

describe('narration', () => {
  it('editing a file, at most once every 20 s', () => {
    const { narrate, advance } = setup();
    expect(narrate(pre('Edit', { file_path: '/r/src/auth.js' }))).toEqual({ text: 'mexendo no auth.js', replaceKey: 'edit' });
    advance(5000);
    expect(narrate(pre('Write', { file_path: '/r/src/login.js' }))).toBeNull();
    advance(16000);
    expect(narrate(pre('MultiEdit', { file_path: '/r/src/login.js' }))).toEqual({ text: 'mexendo no login.js', replaceKey: 'edit' });
  });

  it('tests: running, failing, passing', () => {
    const { narrate } = setup();
    expect(narrate(pre('Bash', { command: 'npx vitest run test/a.test.js' }))).toEqual({ text: 'rodando os testes', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'npm test' }, ' Tests  3 failed | 10 passed'))).toEqual({ text: '3 testes falharam', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'pytest -q' }, 'FAILED test_x.py::test_a - assert 1 == 2'))).toEqual({ text: 'os testes falharam', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'npm test' }, ' Tests  10 passed (10)'))).toEqual({ text: 'os testes passaram', replaceKey: 'tests' });
  });

  it('commit and push, after they happen', () => {
    const { narrate } = setup();
    expect(narrate(pre('Bash', { command: 'git commit -m x' }))).toBeNull();
    expect(narrate(post('Bash', { command: 'git commit -m x' }))).toEqual({ text: 'commitei', replaceKey: 'git' });
    expect(narrate(post('Bash', { command: 'git push -u origin feat/x' }))).toEqual({ text: 'subi a branch', replaceKey: 'git' });
  });

  it('a sub-agent', () => {
    const { narrate } = setup();
    expect(narrate(pre('Task', { description: 'Revisar a PR de segurança', prompt: '...' }))).toEqual({
      text: 'chamei um agente pra revisar a PR de segurança',
      replaceKey: 'agent',
    });
  });

  it('a failing build', () => {
    const { narrate } = setup();
    expect(narrate(post('Bash', { command: 'npm run build' }, 'error TS2304: Cannot find name'))).toEqual({ text: 'deu erro no build', replaceKey: 'build' });
  });

  it('ordinary commands say nothing', () => {
    const { narrate } = setup();
    expect(narrate(pre('Bash', { command: 'ls -la' }))).toBeNull();
    expect(narrate(post('Bash', { command: 'cat README.md' }, 'error handling section'))).toBeNull();
    expect(narrate(pre('Read', { file_path: '/r/a.js' }))).toBeNull();
  });

  it('in English, for an English voice', () => {
    let time = 100000;
    const { narrate } = createNarrator({ now: () => time, lang: 'en' });
    expect(narrate(pre('Edit', { file_path: '/r/src/auth.js' }))).toEqual({ text: 'editing auth.js', replaceKey: 'edit' });
    expect(narrate(pre('Bash', { command: 'npm test' }))).toEqual({ text: 'running the tests', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'npm test' }, ' Tests  3 failed | 10 passed'))).toEqual({ text: '3 tests failed', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'npm test' }, 'FAIL src/a.test.js'))).toEqual({ text: 'the tests failed', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'npm test' }, ' Tests  10 passed (10)'))).toEqual({ text: 'the tests passed', replaceKey: 'tests' });
    expect(narrate(post('Bash', { command: 'git commit -m x' }))).toEqual({ text: 'committed', replaceKey: 'git' });
    expect(narrate(post('Bash', { command: 'git push' }))).toEqual({ text: 'pushed the branch', replaceKey: 'git' });
    expect(narrate(post('Bash', { command: 'npm run build' }, 'ERR! failed'))).toEqual({ text: 'the build failed', replaceKey: 'build' });
    expect(narrate(pre('Agent', { description: 'Review the diff' }))).toEqual({ text: 'called an agent to review the diff', replaceKey: 'agent' });
    expect(narrate(pre('Agent', {}))).toEqual({ text: 'called an agent', replaceKey: 'agent' });
    time += 0;
  });
});
