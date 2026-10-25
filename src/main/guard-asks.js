import { randomUUID } from 'node:crypto';

// The rule guard's questions while they wait for the user (#160), and the
// "liberar nesta sessão" grants. Pure apart from the replies it is handed,
// which carry the answer back to the waiting hook.
const SUMMARY_CHARS = 200;

function summaryOf(request) {
  const input = request.input ?? {};
  const text =
    request.tool === 'Bash'
      ? String(input.command ?? '')
      : `${request.tool}${input.file_path || input.notebook_path ? ` ${input.file_path ?? input.notebook_path}` : ''}`;
  return text.slice(0, SUMMARY_CHARS);
}

const grantKey = (sessionId, ruleId, target) => JSON.stringify([sessionId, ruleId, target]);

export function createGuardAsks({ now = Date.now, newId = randomUUID, onChange = () => {} } = {}) {
  const asks = new Map(); // id → { ask, request, reply }
  const grants = new Set();

  function settle(id, answer) {
    const entry = asks.get(id);
    if (!entry) return null;
    asks.delete(id);
    if (answer) entry.reply(answer);
    else entry.reply.end?.();
    onChange();
    return entry.request;
  }

  return {
    add(request, reply) {
      if (!request.irreversible && grants.has(grantKey(request.sessionId, request.ruleId, request.target))) {
        reply({ answer: 'liberar' });
        return { answered: 'liberar' };
      }
      const id = newId();
      const ask = {
        id,
        sessionId: request.sessionId ?? null,
        cwd: request.cwd ?? null,
        tool: request.tool ?? '',
        summary: summaryOf(request),
        ruleSource: request.ruleSource ?? '',
        explain: request.explain ?? '',
        irreversible: Boolean(request.irreversible),
        at: now(),
      };
      asks.set(id, { ask, request, reply });
      // The guard gave up (its own timeout) or Claude Code killed it.
      reply.onClose?.(() => {
        if (asks.delete(id)) onChange();
      });
      onChange();
      return { id };
    },

    answer(id, choice) {
      const entry = asks.get(id);
      if (!entry) return null;
      const { request } = entry;
      if (choice === 'liberar-sessao' && !request.irreversible)
        grants.add(grantKey(request.sessionId, request.ruleId, request.target));
      return settle(id, { answer: choice === 'barrar' ? 'barrar' : 'liberar' });
    },

    dropSession(sessionId) {
      for (const key of [...grants]) if (JSON.parse(key)[0] === sessionId) grants.delete(key);
      for (const [id, entry] of [...asks]) if (entry.request.sessionId === sessionId) settle(id, null);
    },

    pending() {
      return [...asks.values()].map((entry) => entry.ask);
    },
  };
}
