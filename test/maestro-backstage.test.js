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

  it('a background Bash run is picked up with its id and output file', () => {
    const event = {
      hook_event_name: 'PostToolUse',
      session_id: 's1',
      tool_name: 'Bash',
      tool_input: { command: 'npm run dev', run_in_background: true },
      tool_output_tail: 'Command running in background with ID: bxk2a. Output is being written to: /tmp/claude-1000/x/tasks/bxk2a.output',
    };
    expect(parseBackground(event)).toEqual({ id: 'bxk2a', command: 'npm run dev', outputFile: '/tmp/claude-1000/x/tasks/bxk2a.output' });
    expect(parseBackground({ ...event, tool_input: { command: 'ls' } })).toBeNull();
    const backstage = createBackstage();
    backstage.onEvent(event);
    backstage.onEvent(event); // the same run once
    expect(backstage.backgroundOf('s1')).toEqual([{ id: 'bxk2a', command: 'npm run dev', outputFile: '/tmp/claude-1000/x/tasks/bxk2a.output' }]);
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
