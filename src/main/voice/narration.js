import path from 'node:path';
import { parseGitAction, splitCommand } from '../../hook/rule-guard.js';

// The bound chat's important steps, as one short line each (#161) — fixed
// phrases from hook events, no tokens. Edits are said at most every 20 s.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EDIT_GAP_MS = 20000;
const TEST_RUNNER = /\b(npm (run )?test|npx (vitest|jest|playwright)|vitest|jest|pytest|go test|cargo test|mvn test|gradle test|yarn test|pnpm test|bun test|rspec|phpunit)\b/;
const BUILD = /\b(npm run build|yarn build|pnpm build|tsc|cargo build|go build|mvn (package|compile)|gradle build|make)\b/;

function testOutcome(tail) {
  const count = tail.match(/(\d+)\s+(failed|failing|falharam|falhou)/i);
  if (count && Number(count[1]) > 0) return `${count[1]} testes falharam`;
  if (/\bFAIL(ED)?\b|\bfailed\b|AssertionError/.test(tail) && !/\b0 failed\b/.test(tail)) return 'os testes falharam';
  if (/\bpassed\b|\bpassing\b|\bok\b/i.test(tail)) return 'os testes passaram';
  return null;
}

const lower = (text) => (text ? text.charAt(0).toLowerCase() + text.slice(1) : text);

export function createNarrator({ now = Date.now } = {}) {
  let lastEditAt = -Infinity;

  function narrate(event) {
    const tool = event?.tool_name;
    const input = event?.tool_input ?? {};
    const phase = event?.hook_event_name;
    if (EDIT_TOOLS.has(tool) && phase === 'PreToolUse') {
      if (now() - lastEditAt < EDIT_GAP_MS) return null;
      lastEditAt = now();
      const file = path.basename(String(input.file_path ?? input.notebook_path ?? ''));
      return file ? { text: `mexendo no ${file}`, replaceKey: 'edit' } : null;
    }
    if ((tool === 'Task' || tool === 'Agent') && phase === 'PreToolUse') {
      const what = String(input.description ?? '').trim();
      return { text: what ? `chamei um agente pra ${lower(what)}` : 'chamei um agente', replaceKey: 'agent' };
    }
    if (tool !== 'Bash') return null;
    const command = String(input.command ?? '');
    const tail = String(event.tool_output_tail ?? '');
    if (TEST_RUNNER.test(command)) {
      if (phase === 'PreToolUse') return { text: 'rodando os testes', replaceKey: 'tests' };
      const outcome = testOutcome(tail);
      return outcome ? { text: outcome, replaceKey: 'tests' } : null;
    }
    if (phase !== 'PostToolUse') return null;
    const git = splitCommand(command).map(parseGitAction).find(Boolean);
    if (git?.action === 'commit') return { text: 'commitei', replaceKey: 'git' };
    if (git?.action === 'push') return { text: 'subi a branch', replaceKey: 'git' };
    if (BUILD.test(command) && /\berror\b|\bfailed\b|ERR!/i.test(tail)) return { text: 'deu erro no build', replaceKey: 'build' };
    return null;
  }

  return { narrate };
}
