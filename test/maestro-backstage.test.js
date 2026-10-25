import { describe, expect, it } from 'vitest';
import { createBackstage, descendantsOf, parseBackground, parseListeners, portsFor } from '../src/main/maestro/backstage.js';

const pre = (extra) => ({ hook_event_name: 'PreToolUse', session_id: 's1', ...extra });

describe('the backstage of a músico', () => {
  it("a sub-agent opens on SubagentStart, takes the parent's Task description, counts its files, closes on SubagentStop", () => {
    const backstage = createBackstage();
    backstage.onEvent(pre({ tool_name: 'Task', tool_input: { description: 'Review the diff', subagent_type: 'code-reviewer' } }));
    backstage.onEvent({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag1', agent_type: 'code-reviewer' });
    backstage.onEvent(pre({ agent_id: 'ag1', tool_name: 'Edit', tool_input: { file_path: '/r/src/a.js' } }));
    backstage.onEvent(pre({ agent_id: 'ag1', tool_name: 'Write', tool_input: { file_path: '/r/src/b.js' } }));
    backstage.onEvent(pre({ agent_id: 'ag1', tool_name: 'Edit', tool_input: { file_path: '/r/src/a.js' } }));
    expect(backstage.subagentsOf('s1')).toEqual([
      { id: 'ag1', type: 'code-reviewer', description: 'Review the diff', running: true, files: ['/r/src/a.js', '/r/src/b.js'], lastTool: 'Edit' },
    ]);
    backstage.onEvent({ hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'ag1' });
    expect(backstage.subagentsOf('s1')[0].running).toBe(false);
    expect(backstage.subagentsOf('nobody')).toEqual([]);
  });

  it('a session forgotten drops its sub-agents and commands', () => {
    const backstage = createBackstage();
    backstage.onEvent({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag1', agent_type: 'x' });
    backstage.forget('s1');
    expect(backstage.subagentsOf('s1')).toEqual([]);
    expect(backstage.backgroundOf('s1')).toEqual([]);
  });

  // The real shape (review C1): the hook only carries backgroundTaskId; the
  // output path is built by the Vizor, never read from the event (review I1).
  const background = {
    hook_event_name: 'PostToolUse',
    session_id: 's1',
    cwd: '/home/u/vizor',
    tool_name: 'Bash',
    tool_input: { command: 'npm run dev', run_in_background: true },
    background_task_id: 'bfn73e9dt',
  };
  const tmpRoot = '/tmp/claude-1000';

  it('a background Bash run is picked up from its task id, the output path built by the Vizor', () => {
    expect(parseBackground(background, { tmpRoot })).toEqual({
      id: 'bfn73e9dt',
      command: 'npm run dev',
      outputFile: '/tmp/claude-1000/-home-u-vizor/s1/tasks/bfn73e9dt.output',
    });
    expect(parseBackground({ ...background, tool_input: { command: 'ls' } }, { tmpRoot })).toBeNull();
    const backstage = createBackstage({ tmpRoot });
    backstage.onEvent(background);
    backstage.onEvent(background); // the same run once
    expect(backstage.backgroundOf('s1')).toHaveLength(1);
  });

  it('a path inside the event is never trusted, nor an odd task id', () => {
    const crafted = { ...background, background_task_id: undefined, tool_output_tail: 'Output is being written to: /home/u/.ssh/id_rsa' };
    expect(parseBackground(crafted, { tmpRoot })).toBeNull();
    expect(parseBackground({ ...background, background_task_id: '../../.ssh/id_rsa' }, { tmpRoot })).toBeNull();
    expect(parseBackground({ ...background, session_id: '../x' }, { tmpRoot })).toBeNull();
  });

  it('only the 8 newest background runs are kept', () => {
    const backstage = createBackstage({ tmpRoot });
    for (let index = 0; index < 12; index++) backstage.onEvent({ ...background, background_task_id: `t${index}` });
    expect(backstage.backgroundOf('s1').map((item) => item.id)).toEqual(['t4', 't5', 't6', 't7', 't8', 't9', 't10', 't11']);
  });

  it('a Task that never started (denied) does not shift the next descriptions: the queue clears at the end of the turn', () => {
    const backstage = createBackstage({ tmpRoot });
    backstage.onEvent(pre({ tool_name: 'Task', tool_input: { description: 'denied one' } }));
    backstage.onEvent({ hook_event_name: 'Stop', session_id: 's1' });
    backstage.onEvent(pre({ tool_name: 'Task', tool_input: { description: 'real one' } }));
    backstage.onEvent({ hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'ag9', agent_type: 'x' });
    expect(backstage.subagentsOf('s1')[0].description).toBe('real one');
  });

  it("listeners are parsed, and only the músico's process tree counts", () => {
    const ss = [
      'LISTEN 0 511 *:3000 *:* users:(("node",pid=210,fd=20))',
      'LISTEN 0 128 127.0.0.1:5432 0.0.0.0:* users:(("postgres",pid=900,fd=7))',
      'LISTEN 0 511 [::]:5173 [::]:* users:(("node",pid=211,fd=22),("node",pid=211,fd=23))',
    ].join('\n');
    const listeners = parseListeners(ss);
    expect(listeners).toEqual([
      { port: 3000, pid: 210, process: 'node' },
      { port: 5432, pid: 900, process: 'postgres' },
      { port: 5173, pid: 211, process: 'node' },
    ]);
    // claude (100) → bash (200) → node (210, 211); postgres (900) is someone else's.
    const parents = new Map([[200, 100], [210, 200], [211, 200], [900, 1], [100, 50]]);
    const tree = descendantsOf(100, parents);
    expect([...tree].sort()).toEqual([100, 200, 210, 211]);
    expect(portsFor(listeners, tree)).toEqual([{ port: 3000, process: 'node' }, { port: 5173, process: 'node' }]);
  });
});
