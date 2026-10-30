import { describe, it, expect } from 'vitest';
import { averageColor, monogramColor, monogramOf, nudgeColor } from '../src/renderer/project-accent.js';

describe('averageColor', () => {
  it('averages only mostly-opaque pixels', () => {
    const data = new Uint8ClampedArray([200, 0, 0, 255, 100, 0, 0, 255, 0, 255, 0, 10]);
    expect(averageColor(data)).toEqual([150, 0, 0]);
  });
  it('is null for a fully transparent image', () => {
    expect(averageColor(new Uint8ClampedArray([1, 2, 3, 0]))).toBeNull();
  });
});

describe('nudgeColor', () => {
  const lightness = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    return (Math.max(r, g, b) + Math.min(r, g, b)) / 2;
  };
  it('lifts a near-black and tames a near-white', () => {
    expect(lightness(nudgeColor(10, 10, 30))).toBeGreaterThanOrEqual(0.44);
    expect(lightness(nudgeColor(250, 250, 255))).toBeLessThanOrEqual(0.63);
  });
  it('returns a hex string', () => expect(nudgeColor(30, 120, 200)).toMatch(/^#[0-9a-f]{6}$/));
});

describe('monogram', () => {
  it('uses the first letter or digit, uppercased', () => {
    expect(monogramOf('vizor')).toBe('V');
    expect(monogramOf('.hidden')).toBe('H');
    expect(monogramOf('')).toBe('?');
  });
  it('derives the same colour from the same name', () => {
    expect(monogramColor('vizor')).toBe(monogramColor('VIZOR'));
    expect(monogramColor('vizor')).not.toBe(monogramColor('synvia-bio'));
    expect(monogramColor('x')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
