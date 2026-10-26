import { describe, expect, it } from 'vitest';
import { buildVerdict } from '../src/main/review/verdict.js';

const base = { files: [{ added: 300, removed: 80 }, { added: 40, removed: 5 }], tsc: { status: 'ok' }, tests: { status: 'ok' }, untestedChanged: 0, contract: 0, approved: 5, totalHunks: 14 };
const text = (input, key) => buildVerdict(input).find((i) => i.key === key)?.text;

describe('buildVerdict', () => {
  it('summarises files and review progress', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ added: i === 0 ? 340 : 0, removed: i === 0 ? 85 : 0 }));
    expect(text({ ...base, files: twelve }, 'files')).toBe('12 arquivos (+340 −85)');
    expect(text({ ...base, files: [{ added: 1, removed: 0 }] }, 'files')).toBe('1 arquivo (+1 −0)');
    expect(text(base, 'review')).toBe('revisado 5/14 hunks');
  });
  it('words every tsc state', () => {
    expect(text(base, 'tsc')).toBe('tsc ✓');
    expect(text({ ...base, tsc: { status: 'fail', errors: [1, 2, 3] } }, 'tsc')).toBe('tsc: 3 erros');
    expect(text({ ...base, tsc: { status: 'fail', errors: [1] } }, 'tsc')).toBe('tsc: 1 erro');
    expect(text({ ...base, tsc: { status: 'skipped', reason: 'sem tsconfig.json' } }, 'tsc')).toBe('tsc: não verificado (sem tsconfig.json)');
    expect(text({ ...base, tsc: { status: 'running' } }, 'tsc')).toBe('tsc: rodando…');
    expect(text({ ...base, tsc: null }, 'tsc')).toBe('tsc: não verificado');
  });
  it('words every tests state', () => {
    expect(text(base, 'tests')).toBe('testes ✓');
    expect(text({ ...base, tests: { status: 'fail' } }, 'tests')).toBe('testes ✗');
    expect(text({ ...base, tests: null }, 'tests')).toBe('testes: não rodados');
    expect(text({ ...base, tests: { status: 'running' } }, 'tests')).toBe('testes: rodando…');
  });
  it('omits untested and contract at zero, pluralises otherwise', () => {
    const keys = buildVerdict(base).map((i) => i.key);
    expect(keys).not.toContain('untested');
    expect(keys).not.toContain('contract');
    expect(text({ ...base, untestedChanged: 2 }, 'untested')).toBe('2 funções alteradas sem teste por perto');
    expect(text({ ...base, contract: 1 }, 'contract')).toBe('1 mudança de contrato');
    expect(text({ ...base, contract: 3 }, 'contract')).toBe('3 mudanças de contrato');
  });
  it('uses ok only for what passed', () => {
    const tone = (key, input) => buildVerdict(input).find((i) => i.key === key).tone;
    expect(tone('tsc', base)).toBe('ok');
    expect(tone('tsc', { ...base, tsc: { status: 'fail', errors: [1] } })).toBe('bad');
    expect(tone('tests', { ...base, tests: null })).toBe('muted');
  });
});
