// The conducting gerente (#162): your orders for a músico, kept until its
// turn ends ("quando a 22 terminar, manda rodar os testes e abrir a PR").
// It hands the order over, checks the tests of the next turn, asks for a fix
// up to MAX_FIX_ATTEMPTS times and calls you when that is not enough. Pure:
// index.js feeds it the end of each turn and runs what it returns. The
// músico acts; the gerente only writes to it.
export const MAX_FIX_ATTEMPTS = 2;

export function parseSteps(text) {
  const said = String(text ?? '').toLowerCase();
  const steps = {
    tests: /\btest/.test(said),
    pr: /\bpr\b|pull request/.test(said),
    review: /revis/.test(said),
  };
  return { ...steps, free: steps.tests || steps.pr || steps.review ? null : String(text ?? '').trim() };
}

// What the músico is told (pt-BR, to Claude).
export function promptFor(steps, attempt) {
  let ask;
  if (steps.tests && steps.pr)
    ask = 'Rode os testes do projeto. Se passarem, abra a PR com `gh pr create` (base: a branch de integração da tarefa) e me diga o link. Se falharem, diga quais falharam e pare.';
  else if (steps.tests) ask = 'Rode os testes do projeto e me diga o resultado.';
  else if (steps.pr) ask = 'Abra a PR com `gh pr create` e me diga o link.';
  else if (steps.review) ask = 'Revise o que você mudou nesta tarefa e aponte os riscos, sem mudar nada.';
  else ask = steps.free;
  return attempt > 0 ? `Os testes falharam. Corrija e rode de novo; ${ask.charAt(0).toLowerCase()}${ask.slice(1)}` : ask;
}

const SAID = {
  pt: {
    done: (label) => `Pronto: ${label}.`,
    failed: (label) => `${label}: os testes não passaram depois de ${MAX_FIX_ATTEMPTS} tentativas. Precisa de você.`,
    noTests: (label) => `${label}: o músico não rodou os testes. Precisa de você.`,
    gone: (label) => `O chat fechou antes de eu cumprir: ${label}.`,
  },
  en: {
    done: (label) => `Done: ${label}.`,
    failed: (label) => `${label}: the tests still fail after ${MAX_FIX_ATTEMPTS} tries. It needs you.`,
    noTests: (label) => `${label}: the músico did not run the tests. It needs you.`,
    gone: (label) => `The chat closed before I could do it: ${label}.`,
  },
};

export function createConductor({ lang = () => 'pt' } = {}) {
  const orders = new Map(); // sessionId → { label, steps, attempt, waiting, askedForTests }
  const said = () => SAID[lang()] ?? SAID.pt;

  return {
    order(sessionId, { label, steps }) {
      const replaced = orders.has(sessionId);
      orders.set(sessionId, { label, steps, attempt: 0, waiting: 'turn', askedForTests: false });
      return { replaced };
    },

    // tests: what the turn's own test runs said ('passed' | 'failed' | null).
    turnEnded(sessionId, { tests = null } = {}) {
      const order = orders.get(sessionId);
      if (!order) return [];
      if (order.waiting === 'turn') {
        order.waiting = 'result';
        return [{ type: 'prompt', sessionId, text: promptFor(order.steps, 0) }];
      }
      const finish = (type, text) => {
        orders.delete(sessionId);
        return [{ type, sessionId, text }];
      };
      if (!order.steps.tests || tests === 'passed') return finish('done', said().done(order.label));
      if (tests === 'failed') {
        if (order.attempt >= MAX_FIX_ATTEMPTS) return finish('call-user', said().failed(order.label));
        order.attempt += 1;
        return [{ type: 'prompt', sessionId, text: promptFor(order.steps, order.attempt) }];
      }
      // A turn that ran no test at all: asked once more, then you decide.
      if (order.askedForTests) return finish('call-user', said().noTests(order.label));
      order.askedForTests = true;
      return [{ type: 'prompt', sessionId, text: 'Você não rodou os testes: rode e me diga o resultado.' }];
    },

    sessionGone(sessionId) {
      const order = orders.get(sessionId);
      if (!order) return [];
      orders.delete(sessionId);
      return [{ type: 'call-user', sessionId, text: said().gone(order.label) }];
    },

    ordersOf(sessionId) {
      const order = orders.get(sessionId);
      return order ? { label: order.label, attempt: order.attempt, waiting: order.waiting } : null;
    },

    list: () => [...orders].map(([sessionId, order]) => ({ sessionId, label: order.label, attempt: order.attempt, waiting: order.waiting })),
  };
}
