// "Retoma a task 22" (#161): which conversation works on which task. A chat
// opened or resumed for a task by voice is linked to it; without a link, the
// worktree's branch and the conversation's title are the clues. Two
// candidates are offered, never guessed.

// In a branch, a task number sits between slashes, dashes or underscores:
// feat/22-login yes, feat/0.22.0 (a version) and feat/122-x no.
const cites = (number) => new RegExp(`(^|[-_/])${number}([-_/]|$)`);
const titleCites = (number) => new RegExp(`(#|\\b(task|tarefa|issue|pr|demanda)\\s+#?)${number}([^0-9]|$)`, 'i');

export function resolveTask({ number, links = [], conversations = [], worktrees = [] }) {
  const byId = new Map(conversations.map((item) => [item.sessionId, item]));
  for (const sessionId of links) {
    const linked = byId.get(sessionId);
    if (linked) return { sessionId, cwd: linked.cwd };
  }
  const worktree = worktrees.find((item) => item.branch && cites(number).test(item.branch));
  if (worktree) {
    const newest = conversations
      .filter((item) => item.cwd === worktree.path)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (newest) return { sessionId: newest.sessionId, cwd: newest.cwd };
  }
  const titled = conversations
    .filter((item) => titleCites(number).test(item.title ?? ''))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  if (titled.length === 1) return { sessionId: titled[0].sessionId, cwd: titled[0].cwd };
  if (titled.length > 1) return { candidates: titled.map(({ sessionId, title, cwd }) => ({ sessionId, title, cwd })) };
  return worktree ? { none: true, cwd: worktree.path } : { none: true };
}

// Persisted in ~/.config/vizor/voz/tasks.json: { "<root>": { "<n>": [sessionId, …newest first] } }.
export function createTaskLinks({ file, readFile, writeFile, rename }) {
  let data = {};
  try {
    data = JSON.parse(readFile(file)) ?? {};
  } catch {
    data = {};
  }
  const save = () => {
    writeFile(`${file}.tmp`, JSON.stringify(data));
    rename(`${file}.tmp`, file);
  };
  return {
    link(root, number, sessionId) {
      const project = (data[root] ??= {});
      project[number] = [sessionId, ...(project[number] ?? []).filter((id) => id !== sessionId)];
      save();
    },
    linksFor(root, number) {
      return data[root]?.[number] ?? [];
    },
    forgetSession(sessionId) {
      for (const project of Object.values(data))
        for (const number of Object.keys(project)) {
          project[number] = project[number].filter((id) => id !== sessionId);
          if (project[number].length === 0) delete project[number];
        }
      save();
    },
  };
}
