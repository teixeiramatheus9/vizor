import { describe, it, expect } from 'vitest';
import { keyAction, SHORTCUTS } from '../src/renderer/shell/shortcuts.js';

const key = (k, extra = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra });
const free = { focusInTerminal: false, focusInField: false };
const inTerminal = { focusInTerminal: true, focusInField: true };
const inField = { focusInTerminal: false, focusInField: true };

describe('keyAction', () => {
  it('Ctrl+1..3 switch the top tab from anywhere, the terminal included', () => {
    for (const focus of [free, inTerminal, inField]) {
      expect(keyAction(key('1', { ctrlKey: true }), focus)).toEqual({ top: 1 });
      expect(keyAction(key('3', { ctrlKey: true }), focus)).toEqual({ top: 3 });
    }
    expect(keyAction(key('2', { metaKey: true }), inTerminal)).toEqual({ top: 2 });
  });

  it('Ctrl+4 is reserved for the automations and does nothing yet', () => {
    expect(keyAction(key('4', { ctrlKey: true }), free)).toBeNull();
  });

  it('bare 1..4 go to the review tabs only outside the terminal and fields', () => {
    expect(keyAction(key('1'), free)).toEqual({ inner: 1 });
    expect(keyAction(key('4'), free)).toEqual({ inner: 4 });
    expect(keyAction(key('2'), inTerminal)).toBeNull();
    expect(keyAction(key('2'), inField)).toBeNull();
    expect(keyAction(key('2'), { focusInTerminal: true, focusInField: false })).toBeNull();
    expect(keyAction(key('5'), free)).toBeNull();
    expect(keyAction(key('0'), free)).toBeNull();
  });

  it('"?" opens the help only outside the terminal and fields (Shift is how it is typed)', () => {
    expect(keyAction(key('?', { shiftKey: true }), free)).toEqual({ help: true });
    expect(keyAction(key('?', { shiftKey: true }), inTerminal)).toBeNull();
    expect(keyAction(key('?', { shiftKey: true }), inField)).toBeNull();
  });

  it('never claims a combination with another modifier', () => {
    expect(keyAction(key('1', { altKey: true }), free)).toBeNull();
    expect(keyAction(key('1', { shiftKey: true }), free)).toBeNull();
    expect(keyAction(key('1', { ctrlKey: true, shiftKey: true }), free)).toBeNull();
    expect(keyAction(key('1', { ctrlKey: true, altKey: true }), free)).toBeNull();
    expect(keyAction(key('2', { ctrlKey: true }), { ...free, composing: true })).toBeNull();
    expect(keyAction(key('a'), free)).toBeNull();
  });

  it('documents the shortcuts it handles', () => {
    expect(SHORTCUTS.map((item) => item.keys)).toEqual(expect.arrayContaining(['Ctrl+1 … 3', '1 … 4', '?', 'Ctrl+K', 'Ctrl+`']));
  });
});
