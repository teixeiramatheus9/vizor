import { describe, expect, it } from 'vitest';
import { createRoutines } from '../src/main/voice/routines.js';

function store() {
  const files = {};
  const io = {
    file: '/v/rotinas.json',
    readFile: (file) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
    writeFile: (file, content) => (files[file] = content),
    rename: (from, to) => {
      files[to] = files[from];
      delete files[from];
    },
  };
  return { io, files };
}

describe('routines (#163)', () => {
  it('saved per project, found by name whatever the accents or case, kept across restarts', () => {
    const { io } = store();
    const routines = createRoutines(io);
    routines.save('/r', 'Começar o Dia', ['o que temos pra hoje', 'revisa a PR 166']);
    expect(createRoutines(io).get('/r', 'comecar o dia')).toEqual({ name: 'Começar o Dia', steps: ['o que temos pra hoje', 'revisa a PR 166'] });
    expect(createRoutines(io).get('/other', 'começar o dia')).toBeNull();
    expect(createRoutines(io).list('/r').map((routine) => routine.name)).toEqual(['Começar o Dia']);
  });

  it('saving the same name replaces it; forget removes it', () => {
    const { io } = store();
    const routines = createRoutines(io);
    routines.save('/r', 'fim do dia', ['a']);
    routines.save('/r', 'Fim do dia', ['b']);
    expect(routines.list('/r')).toEqual([{ name: 'Fim do dia', steps: ['b'] }]);
    expect(routines.remove('/r', 'fim do dia')).toBe(true);
    expect(routines.remove('/r', 'fim do dia')).toBe(false);
    expect(routines.list('/r')).toEqual([]);
  });

  it('a broken file starts empty', () => {
    const { io, files } = store();
    files['/v/rotinas.json'] = '{nope';
    expect(createRoutines(io).list('/r')).toEqual([]);
  });
});
