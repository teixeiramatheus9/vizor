import { describe, it, expect } from 'vitest';
import { contractChanges, exportsOf, isSchemaPath, packageChanges } from '../src/main/review/contract.js';

const run = (before, after, relPath = 'src/a.ts') => contractChanges({ relPath, before, after });

describe('contractChanges', () => {
  it('flags a new parameter on an exported function as a signature change', () => {
    const r = run('export function f(a: number) { return a; }', 'export function f(a: number, b?: string) { return a; }');
    expect(r).toEqual([{ kind: 'signature', name: 'f', before: 'f(a: number)', after: 'f(a: number, b?: string)' }]);
  });

  it('flags a removed export', () => {
    const r = run('export const a = 1;\nexport const b = 2;', 'export const a = 1;');
    expect(r).toEqual([{ kind: 'removed', name: 'b', before: 'value', after: null }]);
  });

  it('flags a changed annotated return type', () => {
    const r = run('export const f = (a: number): string => String(a);', 'export const f = (a: number): number => a;');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'signature', name: 'f', before: 'f(a: number): string', after: 'f(a: number): number' });
  });

  it('flags a new field on an exported interface as a type change', () => {
    const r = run('export interface U { id: string }', 'export interface U { id: string; name: string }');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: 'type', name: 'U' });
  });

  it('ignores body-only changes', () => {
    expect(run('export function f(a) { return 1; }', 'export function f(a) { return 2; }')).toEqual([]);
  });

  it('ignores changes to non-exported functions', () => {
    expect(run('function g(a) {}\nexport const x = 1;', 'function g(a, b) {}\nexport const x = 1;')).toEqual([]);
  });

  it('parses TSX with JSX', () => {
    const src = 'export const C = (p: { a: number }) => <div>{p.a}</div>;';
    expect(exportsOf(src, 'src/C.tsx').get('C')).toBe('C(p: { a: number })');
  });

  it('treats a new file as no contract change', () => {
    expect(run(null, 'export const a = 1;')).toEqual([]);
  });

  it('tracks export default and re-exports', () => {
    const m = exportsOf('export default function (a) {}\nexport { x as y } from "./z";', 'a.js');
    expect(m.get('default')).toBe('default(a)');
    expect(m.get('y')).toBe('value');
  });

  it('returns [] on broken parse without throwing', () => {
    expect(run('export function f( {', 'export function f(a) {}')).toEqual([]);
    expect(exportsOf('export function f( {', 'a.ts')).toBeNull();
  });
});

describe('packageChanges', () => {
  it('reports added, removed and version-changed deps', () => {
    const before = JSON.stringify({ dependencies: { a: '1.0.0', c: '1.0.0' }, devDependencies: { b: '^1' } });
    const after = JSON.stringify({ dependencies: { a: '2.0.0', d: '3.0.0' }, devDependencies: { b: '^1' } });
    expect(packageChanges(before, after)).toEqual([
      { kind: 'dep-version', name: 'a', before: '1.0.0', after: '2.0.0' },
      { kind: 'dep-removed', name: 'c', before: '1.0.0', after: null },
      { kind: 'dep-added', name: 'd', before: null, after: '3.0.0' },
    ]);
  });

  it('returns [] for invalid JSON', () => {
    expect(packageChanges('{', '{}')).toEqual([]);
  });
});

describe('isSchemaPath', () => {
  it('recognises migrations, sql and prisma schema', () => {
    expect(isSchemaPath('db/migrations/001.sql')).toBe(true);
    expect(isSchemaPath('migrations/x.js')).toBe(true);
    expect(isSchemaPath('prisma/schema.prisma')).toBe(true);
    expect(isSchemaPath('src/a.js')).toBe(false);
  });
});
