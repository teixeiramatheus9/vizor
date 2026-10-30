import { describe, expect, it } from 'vitest';
import { bootQuery } from '../src/main/workspace-boot.js';

describe('bootQuery', () => {
  it('passes known density, theme and palette', () => {
    expect(bootQuery({ density: 'compact', theme: 'arcade', palette: 'ambar' })).toEqual({ density: 'compact', theme: 'arcade', palette: 'ambar' });
  });
  it('drops unknown or non-string values', () => {
    expect(bootQuery({ density: 'huge', theme: '"><x', palette: 3 })).toEqual({});
    expect(bootQuery({ theme: '__proto__' })).toEqual({});
    expect(bootQuery()).toEqual({});
  });
});
