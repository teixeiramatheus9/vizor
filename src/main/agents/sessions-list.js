// The flat session list the Agentes tab draws from (spec, "Dados do kanban").
// Pure: the registry's sessions (already linked to their pty) and the
// workspace tree go in, plain structured-clone-safe objects come out.

// "#169 Título" when the chat is bound to an issue.
function titleOf(session, issue) {
  const base = session.title ?? session.promptPreview ?? null;
  if (issue == null) return base;
  return base ? `#${issue} ${base}` : `#${issue}`;
}

// The pending question as text: the transcript keeps { questions: [{ question }] }.
export function questionText(question) {
  if (!question) return null;
  if (typeof question === 'string') return question;
  if (question.kind === 'text' && question.text) return question.text;
  const first = question.questions?.[0]?.question;
  return typeof first === 'string' && first ? first : 'Esperando sua resposta.';
}

// issueOf(sessionId, projectRoot) -> issue number | null.
export function buildAgentSessions({ sessions, tree, issueOf = () => null }) {
  const placement = new Map();
  for (const project of tree?.projects ?? [])
    for (const worktree of project.worktrees)
      for (const node of worktree.sessions) placement.set(node.id, { root: project.root, branch: worktree.branch ?? null });
  return sessions.map((session) => {
    const project = placement.get(session.id) ?? null;
    const ptyId = session.term?.VIZOR_PTY_ID ?? null;
    return {
      id: session.id,
      status: session.status,
      needsPermission: Boolean(session.needsPermission),
      question: questionText(session.question),
      seenAt: session.seenAt ?? 0,
      updatedAt: session.updatedAt,
      failedAt: session.failedAt ?? null,
      adopted: Boolean(session.adopted),
      alias: session.alias ?? null,
      title: titleOf(session, project ? issueOf(session.id, project.root) : null),
      projectName: session.projectName,
      cwd: session.cwd ?? null,
      ptyId,
      term: ptyId ? { VIZOR_PTY_ID: ptyId } : null,
      project,
    };
  });
}
