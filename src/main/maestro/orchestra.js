// The Maestro's orchestra (#159): every chat tab of the workspace is a
// músico, named by the task linked to it ("#22", "interrompa a task 22") or,
// without one, A1, A2… ("interrompa o A1"). Never by its place: "task 2" must
// not land on whoever sits second. Pure: the tree comes from
// workspace-model, the links from voice/task-links.

export const MUSICIAN_COLORS = ['#ebcb8b', '#a3be8c', '#b48ead', '#88c0d0', '#d08770', '#81a1c1'];

// numberOf(sessionId, projectRoot) → the linked task number, or null.
export function buildOrchestra(tree, numberOf) {
  const placed = (tree?.projects ?? []).flatMap((project) =>
    project.worktrees.flatMap((worktree) => worktree.sessions.map((session) => ({ session, root: project.root, checkout: worktree.path }))),
  );
  const unplaced = (tree?.unplacedSessions ?? []).map((session) => ({ session, root: null, checkout: null }));
  let agents = 0;
  return [...placed, ...unplaced]
    .filter(({ session }) => session.ptyId)
    .map(({ session, root, checkout }, index) => {
      const number = numberOf(session.id, root) ?? null;
      const agent = number === null ? ++agents : null;
      return {
        sessionId: session.id,
        ptyId: session.ptyId,
        root: checkout, // the checkout it works in: its graph's root
        number,
        agent,
        name: number === null ? `A${agent}` : `#${number}`,
        label: session.name,
        status: session.status,
        color: MUSICIAN_COLORS[index % MUSICIAN_COLORS.length],
        files: session.files ?? [],
      };
    });
}

export function findAgent(orchestra, agent) {
  return orchestra.filter((musician) => musician.agent === agent);
}

export function findMusicians(orchestra, number) {
  return orchestra.filter((musician) => musician.number === number);
}

// The focus survives while its tab lives; a closed tab hands it to the first.
export function nextFocus(orchestra, focusedId) {
  if (orchestra.some((musician) => musician.sessionId === focusedId)) return focusedId;
  return orchestra[0]?.sessionId ?? null;
}
