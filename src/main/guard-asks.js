import { randomUUID } from 'node:crypto';

// The rule guard's questions while they wait for the user (#160), and the
// "liberar nesta sessão" grants. Pure apart from the replies it is handed,
// which carry the answer back to the waiting hook.
const SUMMARY_CHARS = 200;

// The only answers the screens can give. Anything else leaves the ask open:
// a typo or a prototype key must never count as "liberar" (#165).
export const GUARD_CHOICES = ['liberar', 'liberar-sessao', 'barrar'];
export const isGuardChoice = (choice) => GUARD_CHOICES.includes(choice);

function summaryOf(request) {
  const input = request.input ?? {};
  const text =
    request.tool === 'Bash'
      ? String(input.command ?? '')
      : `${request.tool}${input.file_path || input.notebook_path ? ` ${input.file_path ?? input.notebook_path}` : ''}`;
  return text.slice(0, SUMMARY_CHARS);
}

const grantKey = (sessionId, ruleId, target) => JSON.stringify([sessionId, ruleId, target]);
const keyOf = (request) => grantKey(request.sessionId, request.ruleId, request.target);

// onReleased(request): an ask answered by a grant made on another ask, for the
// history.
export function createGuardAsks({ now = Date.now, newId = randomUUID, onChange = () => {}, onReleased = () => {} } = {}) {
  const asks = new Map(); // id → { ask, request, reply }
  const grants = new Set();

  function settle(id, answer, { quiet = false } = {}) {
    const entry = asks.get(id);
    if (!entry) return null;
    asks.delete(id);
    if (answer) entry.reply(answer);
    else entry.reply.end?.();
    if (!quiet) onChange();
    return entry.request;
  }

  return {
    // duplicate: an equal ask (same session, rule and target) is already
    // waiting, so the caller should not announce this one again.
    add(request, reply) {
      if (!request.irreversible && grants.has(keyOf(request))) {
        reply({ answer: 'liberar' });
        return { answered: 'liberar' };
      }
      const duplicate = [...asks.values()].some((entry) => keyOf(entry.request) === keyOf(request));
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
      return { id, duplicate };
    },

    answer(id, choice) {
      if (!isGuardChoice(choice)) return null;
      const entry = asks.get(id);
      if (!entry) return null;
      const { request } = entry;
      const granting = choice === 'liberar-sessao' && !request.irreversible;
      if (granting) grants.add(keyOf(request));
      const answered = settle(id, { answer: choice === 'barrar' ? 'barrar' : 'liberar' });
      if (granting) {
        for (const [otherId, other] of [...asks]) {
          if (other.request.irreversible || keyOf(other.request) !== keyOf(request)) continue;
          onReleased(settle(otherId, { answer: 'liberar' }));
        }
      }
      return answered;
    },

    // Every waiting ask gets the same answer at once (the app is quitting).
    releaseAll(answer) {
      if (asks.size === 0) return;
      for (const id of [...asks.keys()]) settle(id, { answer }, { quiet: true });
      onChange();
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
