// What a músico runs backstage (#142): its sub-agents (from the hook events
// Claude Code tags with agent_id), its background commands (a Bash run with
// run_in_background writes its output to a file) and the ports its process
// tree listens on. Pure: index.js feeds the events, the `ss` text and the
// process parents.
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function parseBackground(event) {
  if (event?.tool_name !== 'Bash' || event.hook_event_name !== 'PostToolUse' || !event.tool_input?.run_in_background) return null;
  const tail = String(event.tool_output_tail ?? '');
  const file = tail.match(/Output is being written to: (\S+?)\.?$/m);
  if (!file) return null;
  const id = tail.match(/background with ID: (\S+?)[.\s]/)?.[1] ?? file[1];
  return { id, command: String(event.tool_input.command ?? ''), outputFile: file[1] };
}

export function createBackstage() {
  const sessions = new Map(); // sessionId → { agents: Map, order: [], pending: [], background: Map }
  const of = (sessionId) => {
    if (!sessions.has(sessionId)) sessions.set(sessionId, { agents: new Map(), order: [], pending: [], background: new Map() });
    return sessions.get(sessionId);
  };

  return {
    onEvent(event) {
      const sessionId = event?.session_id;
      if (!sessionId) return;
      const phase = event.hook_event_name;
      // The parent's Task/Agent call comes first: its description names the next sub-agent.
      if (phase === 'PreToolUse' && !event.agent_id && (event.tool_name === 'Task' || event.tool_name === 'Agent')) {
        of(sessionId).pending.push(String(event.tool_input?.description ?? '').trim());
        return;
      }
      if (phase === 'SubagentStart' && event.agent_id) {
        const state = of(sessionId);
        if (state.agents.has(event.agent_id)) return;
        state.agents.set(event.agent_id, {
          id: event.agent_id,
          type: event.agent_type ?? 'agente',
          description: state.pending.shift() ?? '',
          running: true,
          files: [],
          lastTool: null,
        });
        state.order.push(event.agent_id);
        return;
      }
      if (phase === 'SubagentStop' && event.agent_id) {
        const agent = sessions.get(sessionId)?.agents.get(event.agent_id);
        if (agent) agent.running = false;
        return;
      }
      if (event.agent_id && phase === 'PreToolUse') {
        const agent = sessions.get(sessionId)?.agents.get(event.agent_id);
        if (!agent) return;
        agent.lastTool = event.tool_name ?? agent.lastTool;
        const file = event.tool_input?.file_path ?? event.tool_input?.notebook_path;
        if (FILE_TOOLS.has(event.tool_name) && file && !agent.files.includes(file)) agent.files.push(file);
        return;
      }
      const background = parseBackground(event);
      if (background) of(sessionId).background.set(background.id, background);
    },

    subagentsOf(sessionId) {
      const state = sessions.get(sessionId);
      return state ? state.order.map((id) => ({ ...state.agents.get(id), files: [...state.agents.get(id).files] })) : [];
    },

    backgroundOf(sessionId) {
      return [...(sessions.get(sessionId)?.background.values() ?? [])].map((item) => ({ ...item }));
    },

    forget(sessionId) {
      sessions.delete(sessionId);
    },

    sessions: () => [...sessions.keys()],
  };
}

// `ss -ltnpH` lines: LISTEN 0 511 *:3000 *:* users:(("node",pid=123,fd=20))
export function parseListeners(text) {
  const listeners = [];
  for (const line of String(text ?? '').split('\n')) {
    const port = line.match(/\s\S*:(\d+)\s+\S+\s+users:/)?.[1];
    const user = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (port && user) listeners.push({ port: Number(port), pid: Number(user[2]), process: user[1] });
  }
  return listeners;
}

export function descendantsOf(rootPid, parents) {
  const children = new Map();
  for (const [pid, ppid] of parents) {
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const tree = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) if (!tree.has(child)) tree.add(child) && queue.push(child);
  return tree;
}

export function portsFor(listeners, pids) {
  const seen = new Map();
  for (const listener of listeners) if (pids.has(listener.pid) && !seen.has(listener.port)) seen.set(listener.port, { port: listener.port, process: listener.process });
  return [...seen.values()].sort((a, b) => a.port - b.port);
}
