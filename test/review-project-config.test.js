import { describe, it, expect } from 'vitest';
import { parseProjectConfig } from '../src/main/review/project-config.js';

describe('parseProjectConfig', () => {
  it('reads base, test and tsc', () => {
    expect(parseProjectConfig('{"base":"develop","test":"pnpm test","tsc":false}')).toEqual({ base: 'develop', test: 'pnpm test', tsc: false });
  });
  it('ignores empty strings and wrong types', () => {
    expect(parseProjectConfig('{"base":"  ","test":"","tsc":"no"}')).toEqual({});
  });
  it('gives {} for garbage', () => {
    expect(parseProjectConfig('nope')).toEqual({});
    expect(parseProjectConfig('[1]')).toEqual({});
    expect(parseProjectConfig('null')).toEqual({});
    expect(parseProjectConfig(undefined)).toEqual({});
  });
});
