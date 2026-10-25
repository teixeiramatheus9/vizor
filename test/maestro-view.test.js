import { describe, expect, it } from 'vitest';
import {
  balloonText,
  renderBalloon,
  renderConsequences,
  renderImpact,
  renderOrchestra,
  renderOrder,
} from '../src/renderer/maestro-view.js';

const musician = (sessionId, number, extra = {}) => ({ sessionId, number, ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status: 'working', color: '#ebcb8b', files: [], ...extra });

describe('the Maestro stage markup', () => {
  it('balloonText cuts at 280 and keeps the full text', () => {
    const long = 'palavra '.repeat(60).trim();
    const text = balloonText(long);
    expect(text.cut).toBe(true);
    expect(text.short.length).toBeLessThanOrEqual(281);
    expect(text.short.endsWith('…')).toBe(true);
    expect(text.full).toBe(long);
    expect(balloonText('curto')).toEqual({ short: 'curto', full: 'curto', cut: false });
  });

  it('balloon escapes HTML, drops emoji and line breaks', () => {
    const html = renderBalloon({ source: 's22', text: '<script>x</script> **ok** 🎉\nfim' }, (id) => (id === 's22' ? musician('s22', 22) : null));
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('🎉');
    expect(html).not.toContain('\n');
    expect(html).toContain('#22:');
    expect(renderBalloon({ source: 'manager', text: 'oi' }, () => null)).toContain('gerente:');
    expect(renderBalloon(null, () => null)).toBe('');
    const cut = renderBalloon({ source: 'manager', text: 'x '.repeat(200) }, () => null);
    expect(cut).toContain('data-balloon-more');
  });

  it('orchestra marks the focused músico and shows its number and color', () => {
    const html = renderOrchestra([musician('a', 22), musician('b', 2, { color: '#a3be8c', status: 'waiting' })], 'b');
    expect(html).toContain('data-musician="a"');
    expect(html).toMatch(/data-musician="b"[^>]*aria-current="true"/);
    expect(html).not.toMatch(/data-musician="a"[^>]*aria-current="true"/);
    expect(html).toContain('#22');
    expect(html).toContain('#a3be8c');
    expect(html).toContain('esperando você');
  });

  it('empty orchestra says why, and the gerente is always the last row', () => {
    const empty = renderOrchestra([], null);
    expect(empty).toContain('nenhum chat do Claude aberto no workspace');
    expect(empty).toContain('gerente · segue suas ordens');
    const full = renderOrchestra([musician('a', 1)], 'a');
    expect(full.lastIndexOf('gerente')).toBeGreaterThan(full.indexOf('data-musician="a"'));
  });

  it('order shows what was understood and the seconds left', () => {
    const html = renderOrder({ label: 'interromper a 22', until: 3000 }, 1000);
    expect(html).toContain('entendi: interromper a 22');
    expect(html).toContain('2s');
    expect(renderOrder(null)).toBe('');
    expect(renderOrder({ label: '<b>', until: 2000 }, 1000)).toContain('&lt;b&gt;');
  });

  it('impact lists the touched files with their counts', () => {
    const html = renderImpact(musician('a', 22, { files: [{ filePath: '/r/src/main/tts.js', added: 4, removed: 1, writing: true }] }));
    expect(html).toContain('área de impacto');
    expect(html).toContain('o grafo chega na parte 2');
    expect(html).toContain('tts.js');
    expect(html).toContain('+4');
    expect(html).toContain('−1');
    expect(renderImpact(null)).toContain('área de impacto');
  });

  it('consequences: the last three narration lines, escaped', () => {
    const html = renderConsequences(['a', 'b', 'c', '<d>']);
    expect(html).not.toContain('>a<');
    expect(html).toContain('&lt;d&gt;');
    expect(renderConsequences([])).toContain('consequências');
  });
});
