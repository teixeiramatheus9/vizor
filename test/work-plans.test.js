import { describe, expect, it } from 'vitest';
import { createPlanTracker } from '../src/main/work/plans.js';

const PLAN = '- [ ] ler\n- [ ] fazer\n- [ ] testar\n';
function setup({ files = {}, known = ['/repo'] } = {}) {
  const reads = [];
  const tracker = createPlanTracker({
    readFile: async (file) => {
      reads.push(file);
      if (!(file in files)) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      return files[file];
    },
    knownCwd: (cwd) => known.includes(cwd),
  });
  return { tracker, reads, files };
}
const write = (file, extra = {}) => ({ hook_event_name: 'PostToolUse', session_id: 's1', cwd: '/repo', tool_name: 'Write', tool_input: { file_path: file }, ...extra });

describe('following a músico plan', () => {
  it('a write to the plan file reads it from the path the Vizor computes', async () => {
    const { tracker, reads } = setup({ files: { '/repo/.vizor/plano.md': PLAN } });
    expect(await tracker.onEvent(write('/repo/.vizor/plano.md'))).toBe(true);
    expect(reads).toEqual(['/repo/.vizor/plano.md']);
    expect(tracker.planOf('s1')).toEqual({ steps: [{ text: 'ler', done: false }, { text: 'fazer', done: false }, { text: 'testar', done: false }], approved: false });
  });

  it('a session outside the workspace projects is never read', async () => {
    const { tracker, reads } = setup({ known: [] });
    expect(await tracker.onEvent(write('/repo/.vizor/plano.md'))).toBe(false);
    expect(reads).toEqual([]);
    expect(tracker.planOf('s1')).toBeNull();
  });

  it('only the dev approves: neither an edit to code nor a ticked step does', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano.md': PLAN } });
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(await tracker.onEvent(write('/repo/src/a.js', { tool_name: 'Edit' }))).toBe(false);
    expect(tracker.planOf('s1').approved).toBe(false);

    const other = setup({ files: { '/repo/.vizor/plano.md': '- [x] ler\n- [ ] fazer\n' } });
    await other.tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(other.tracker.planOf('s1').approved).toBe(false);
  });

  it('the plan file a chat wrote is at hand, for the task it belongs to', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano-169.md': PLAN } });
    await tracker.onEvent(write('/repo/.vizor/plano-169.md'));
    expect(tracker.fileOf('s1')).toBe('plano-169.md');
    expect(tracker.fileOf('s2')).toBeNull();
  });

  it('an edit to code with no plan yet changes nothing', async () => {
    const { tracker, reads } = setup();
    expect(await tracker.onEvent(write('/repo/src/a.js', { tool_name: 'Edit' }))).toBe(false);
    expect(reads).toEqual([]);
  });

  it('a Stop re-reads the file the chat wrote; a file gone drops the plan', async () => {
    const { tracker, files } = setup({ files: { '/repo/.vizor/plano.md': '- [ ] um\n' } });
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    files['/repo/.vizor/plano.md'] = PLAN;
    expect(await tracker.onEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' })).toBe(true);
    expect(tracker.planOf('s1').steps).toHaveLength(3);
    delete files['/repo/.vizor/plano.md'];
    expect(await tracker.onEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' })).toBe(true);
    expect(tracker.planOf('s1')).toBeNull();
  });

  it('a file with no checklist is no plan', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano.md': 'vou pensar ainda' } });
    expect(await tracker.onEvent(write('/repo/.vizor/plano.md'))).toBe(false);
    expect(tracker.planOf('s1')).toBeNull();
  });

  it('approving by hand sticks; forgetting drops it', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano.md': PLAN } });
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    tracker.approve('s1');
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(tracker.planOf('s1').approved).toBe(true);
    expect(tracker.sessions()).toEqual(['s1']);
    tracker.forget('s1');
    expect(tracker.planOf('s1')).toBeNull();
  });

  it('two reads racing: the last event wins, not the slower read', async () => {
    let release;
    const slow = new Promise((resolve) => (release = resolve));
    const contents = ['- [ ] velho\n', '- [x] novo\n'];
    let call = 0;
    const tracker = createPlanTracker({
      readFile: async () => (call++ === 0 ? slow.then(() => contents[0]) : contents[1]),
      knownCwd: () => true,
    });
    const first = tracker.onEvent(write('/repo/.vizor/plano.md'));
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    release();
    await first;
    expect(tracker.planOf('s1').steps).toEqual([{ text: 'novo', done: true }]);
  });

  it('the file text stays at hand, for the Vizor-plano line the graph reads', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano.md': `${PLAN}Vizor-plano: src/a.js#f\n` } });
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(tracker.textOf('s1')).toContain('Vizor-plano: src/a.js#f');
    expect(tracker.textOf('nobody')).toBeNull();
  });

  it('C1: two chats in one folder each follow their own task file; a chat that wrote none sees none', async () => {
    const { tracker } = setup({ files: { '/repo/.vizor/plano-169.md': '- [ ] menu\n', '/repo/.vizor/plano-170.md': '- [ ] outra\n' } });
    await tracker.onEvent(write('/repo/.vizor/plano-169.md'));
    await tracker.onEvent(write('/repo/.vizor/plano-170.md', { session_id: 's2' }));
    await tracker.onEvent({ hook_event_name: 'Stop', session_id: 's1', cwd: '/repo' });
    expect(tracker.planOf('s1').steps).toEqual([{ text: 'menu', done: false }]);
    expect(tracker.planOf('s2').steps).toEqual([{ text: 'outra', done: false }]);
    expect(await tracker.onEvent({ hook_event_name: 'Stop', session_id: 's3', cwd: '/repo' })).toBe(false);
    expect(tracker.planOf('s3')).toBeNull();
  });

  it('I3: a plan rewritten from scratch waits for the ok again', async () => {
    const { tracker, files } = setup({ files: { '/repo/.vizor/plano.md': PLAN } });
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    tracker.approve('s1');
    files['/repo/.vizor/plano.md'] = '- [ ] outro jeito\n- [ ] de fazer\n';
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(tracker.planOf('s1').approved).toBe(false);
    // Ticking a step of the same plan keeps it approved.
    tracker.approve('s1');
    files['/repo/.vizor/plano.md'] = '- [x] outro jeito\n- [ ] de fazer\n';
    await tracker.onEvent(write('/repo/.vizor/plano.md'));
    expect(tracker.planOf('s1').approved).toBe(true);
  });
});
