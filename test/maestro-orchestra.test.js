import { describe, expect, it } from 'vitest';
import { buildOrchestra, findAgent, findMusicians, MUSICIAN_COLORS, nextFocus } from '../src/main/maestro/orchestra.js';

const session = (id, ptyId = `p-${id}`, extra = {}) => ({ id, name: `chat ${id}`, status: 'working', ptyId, files: [], ...extra });
const tree = (sessions, unplacedSessions = []) => ({
  projects: [{ root: '/r', worktrees: [{ path: '/r', sessions }] }],
  unplacedSessions,
});

describe('the Maestro orchestra', () => {
  it('only chat tabs inside the Vizor are músicos', () => {
    const orchestra = buildOrchestra(tree([session('a'), session('b', null)]), () => null);
    expect(orchestra.map((musician) => musician.sessionId)).toEqual(['a']);
    expect(orchestra[0]).toMatchObject({ sessionId: 'a', ptyId: 'p-a', label: 'chat a', status: 'working', files: [] });
  });

  it('a músico is named by its task, else A1, A2… (never by its place)', () => {
    const roots = [];
    const orchestra = buildOrchestra(tree([session('a'), session('b')], [session('c')]), (id, root) => (roots.push([id, root]), id === 'a' ? 22 : null));
    expect(orchestra.map((musician) => [musician.name, musician.number, musician.agent])).toEqual([
      ['#22', 22, null],
      ['A1', null, 1],
      ['A2', null, 2],
    ]);
    expect(roots).toEqual([['a', '/r'], ['b', '/r'], ['c', null]]);
  });

  it('findAgent finds A2 only', () => {
    const orchestra = buildOrchestra(tree([session('a'), session('b')]), () => null);
    expect(findAgent(orchestra, 2).map((musician) => musician.sessionId)).toEqual(['b']);
    expect(findAgent(orchestra, 3)).toEqual([]);
    expect(findMusicians(orchestra, 2)).toEqual([]);
  });

  it('colors follow the order and wrap', () => {
    const orchestra = buildOrchestra(tree(Array.from({ length: 7 }, (_, index) => session(`s${index}`))), () => null);
    expect(orchestra[0].color).toBe(MUSICIAN_COLORS[0]);
    expect(orchestra[1].color).toBe(MUSICIAN_COLORS[1]);
    expect(orchestra[6].color).toBe(orchestra[0].color);
  });

  it('two músicos on one number are both found', () => {
    const orchestra = buildOrchestra(tree([session('a'), session('b')]), () => 22);
    expect(findMusicians(orchestra, 22).map((musician) => musician.sessionId)).toEqual(['a', 'b']);
    expect(findMusicians(orchestra, 9)).toEqual([]);
  });

  it('the focused músico closing its tab moves the focus to the first one', () => {
    const orchestra = buildOrchestra(tree([session('a'), session('b')]), () => null);
    expect(nextFocus(orchestra, 'b')).toBe('b');
    expect(nextFocus(orchestra, 'gone')).toBe('a');
    expect(nextFocus(orchestra, null)).toBe('a');
    expect(nextFocus([], 'x')).toBeNull();
  });
});

describe('the músico knows its project (for its graph)', () => {
  it('root is the checkout (worktree) it works in; null outside every project', () => {
    const orchestra = buildOrchestra(tree([session('a')], [session('c')]), () => null);
    expect(orchestra.map((musician) => musician.root)).toEqual(['/r', null]);
  });
});
