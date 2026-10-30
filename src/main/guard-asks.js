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

// Equal asks (same session, rule and target: parallel identical calls) are
// announced once. onReleased(request, choice): a twin answered along with the
// announced one, for the history. onPromote(ask): the announced one left
// without settling its twins, so the next twin must be announced now.
export function createGuardAsks({
  now = Date.now,
  newId = randomUUID,
  onChange = () => {},
  onReleased = () => {},
  onPromote = () => {},
  automationNameOf = () => null,
} = {}) {
  const asks = new Map(); // id → { ask, request, reply, shown }
  const grants = new Set();

  function promoteTwinOf(entry) {
    if (!entry.shown) return;
    const twin = [...asks.values()].find((other) => keyOf(other.request) === keyOf(entry.request));
    if (!twin) return;
    twin.shown = true;
    onPromote(twin.ask);
  }

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
      // An automação's asks are never covered by a session grant.
      if (!request.irreversible && !request.automationId && grants.has(keyOf(request))) {
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
        ...(request.automationId ? { automationId: String(request.automationId), automationName: automationNameOf(String(request.automationId)) ?? undefined } : {}),
        at: now(),
      };
      const entry = { ask, request, reply, shown: !duplicate };
      asks.set(id, entry);
      // The guard gave up (its own timeout) or Claude Code killed it.
      reply.onClose?.(() => {
        if (!asks.delete(id)) return;
        promoteTwinOf(entry);
        onChange();
      });
      onChange();
      return { id, duplicate };
    },

    answer(id, choice) {
      if (!isGuardChoice(choice)) return null;
      const entry = asks.get(id);
      if (!entry) return null;
      const { request } = entry;
      // An automação runs unattended: each step is freed once, never the rest.
      if (choice === 'liberar-sessao' && request.automationId) return null;
      if (choice === 'liberar-sessao' && !request.irreversible) grants.add(keyOf(request));
      const answer = { answer: choice === 'barrar' ? 'barrar' : 'liberar' };
      const answered = settle(id, answer);
      // The twins get the same answer, except that a liberar of something
      // irreversible only ever covers the call the user saw.
      if (choice === 'barrar' || !request.irreversible) {
        for (const [otherId, other] of [...asks]) {
          if (keyOf(other.request) !== keyOf(request)) continue;
          onReleased(settle(otherId, answer), choice);
        }
      }
      promoteTwinOf(entry);
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
