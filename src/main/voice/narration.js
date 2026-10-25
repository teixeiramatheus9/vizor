import path from 'node:path';
import { parseGitAction, splitCommand } from '../../hook/rule-guard.js';

// The bound chat's important steps, as one short line each (#161) — fixed
// phrases from hook events, no tokens. Edits are said at most every 20 s.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EDIT_GAP_MS = 20000;
const TEST_RUNNER = /\b(npm (run )?test|npx (vitest|jest|playwright)|vitest|jest|pytest|go test|cargo test|mvn test|gradle test|yarn test|pnpm test|bun test|rspec|phpunit)\b/;
const BUILD = /\b(npm run build|yarn build|pnpm build|tsc|cargo build|go build|mvn (package|compile)|gradle build|make)\b/;

// The spoken language follows the voice: an English voice narrates in English.
const LINES = {
  pt: {
    edit: (file) => `mexendo no ${file}`,
    agent: (what) => (what ? `chamei um agente pra ${what}` : 'chamei um agente'),
    testsRunning: 'rodando os testes',
    testsFailedCount: (count) => `${count} testes falharam`,
    testsFailed: 'os testes falharam',
    testsPassed: 'os testes passaram',
    commit: 'commitei',
    push: 'subi a branch',
    buildFailed: 'deu erro no build',
  },
  en: {
    edit: (file) => `editing ${file}`,
    agent: (what) => (what ? `called an agent to ${what}` : 'called an agent'),
    testsRunning: 'running the tests',
    testsFailedCount: (count) => `${count} tests failed`,
    testsFailed: 'the tests failed',
    testsPassed: 'the tests passed',
    commit: 'committed',
    push: 'pushed the branch',
    buildFailed: 'the build failed',
  },
};

function testOutcome(tail, lines) {
  const count = tail.match(/(\d+)\s+(failed|failing|falharam|falhou)/i);
  if (count && Number(count[1]) > 0) return lines.testsFailedCount(count[1]);
  if (/\bFAIL(ED)?\b|\bfailed\b|AssertionError/.test(tail) && !/\b0 failed\b/.test(tail)) return lines.testsFailed;
  if (/\bpassed\b|\bpassing\b|\bok\b/i.test(tail)) return lines.testsPassed;
  return null;
}

// A test run's verdict, for the conducting gerente (#162): 'passed',
// 'failed', or null when the event is not a finished test run.
export function testOutcomeOf(event) {
  const phase = event?.hook_event_name;
  if (event?.tool_name !== 'Bash' || (phase !== 'PostToolUse' && phase !== 'PostToolUseFailure')) return null;
  if (!TEST_RUNNER.test(String(event.tool_input?.command ?? ''))) return null;
  // A test command that exited with an error failed, whatever its tail says.
  if (phase === 'PostToolUseFailure') return 'failed';
  const line = testOutcome(String(event.tool_output_tail ?? ''), LINES.pt);
  if (!line) return null;
  return line === LINES.pt.testsPassed ? 'passed' : 'failed';
}

const lower = (text) => (text ? text.charAt(0).toLowerCase() + text.slice(1) : text);

export function createNarrator({ now = Date.now, lang = 'pt' } = {}) {
  const lines = LINES[lang] ?? LINES.pt;
  let lastEditAt = -Infinity;

  function narrate(event) {
    const tool = event?.tool_name;
    const input = event?.tool_input ?? {};
    const phase = event?.hook_event_name;
    if (EDIT_TOOLS.has(tool) && phase === 'PreToolUse') {
      if (now() - lastEditAt < EDIT_GAP_MS) return null;
      lastEditAt = now();
      const file = path.basename(String(input.file_path ?? input.notebook_path ?? ''));
      return file ? { text: lines.edit(file), replaceKey: 'edit' } : null;
    }
    if ((tool === 'Task' || tool === 'Agent') && phase === 'PreToolUse') {
      const what = String(input.description ?? '').trim();
      return { text: lines.agent(lower(what)), replaceKey: 'agent' };
    }
    if (tool !== 'Bash') return null;
    const command = String(input.command ?? '');
    const tail = String(event.tool_output_tail ?? '');
    if (TEST_RUNNER.test(command)) {
      if (phase === 'PreToolUse') return { text: lines.testsRunning, replaceKey: 'tests' };
      const outcome = testOutcome(tail, lines) ?? (phase === 'PostToolUseFailure' ? lines.testsFailed : null);
      return outcome ? { text: outcome, replaceKey: 'tests' } : null;
    }
    if (phase !== 'PostToolUse') return null;
    const git = splitCommand(command).map(parseGitAction).find(Boolean);
    if (git?.action === 'commit') return { text: lines.commit, replaceKey: 'git' };
    if (git?.action === 'push') return { text: lines.push, replaceKey: 'git' };
    if (BUILD.test(command) && /\berror\b|\bfailed\b|ERR!/i.test(tail)) return { text: lines.buildFailed, replaceKey: 'build' };
    return null;
  }

  return { narrate };
}
