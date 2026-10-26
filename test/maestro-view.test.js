import { describe, expect, it } from 'vitest';
import {
  balloonText,
  renderBalloon,
  renderConsequences,
  renderImpact,
  renderOrchestra,
  renderOrder,
} from '../src/renderer/maestro-view.js';

const musician = (sessionId, number, extra = {}) => ({ sessionId, number, agent: null, name: `#${number}`, ptyId: `p-${sessionId}`, label: `chat ${sessionId}`, status: 'working', color: '#ebcb8b', files: [], ...extra });

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

describe('the balloon opened in full ("ver tudo")', () => {
  it('shows the whole text, escaped, without the button', () => {
    const long = `<b>${'x '.repeat(200)}fim</b>`;
    const html = renderBalloon({ source: 'manager', text: long }, () => null, { full: true });
    expect(html).toContain('fim');
    expect(html).not.toContain('data-balloon-more');
    expect(html).not.toContain('<b>');
  });
});

describe('músicos without a task show as A1, A2…', () => {
  it('in the orchestra and in the balloon', () => {
    const a1 = musician('x', null, { agent: 1, name: 'A1' });
    expect(renderOrchestra([a1], 'x')).toContain('<b>A1</b>');
    expect(renderOrchestra([a1], 'x')).not.toContain('#null');
    expect(renderBalloon({ source: 'x', text: 'oi' }, () => a1)).toContain('A1:');
  });
});

describe('the orchestra shows the gerente\'s orders', () => {
  it("the orchestra shows a músico's pending order and the gerente counts them", () => {
    const html = renderOrchestra([musician('a', 22), musician('b', 31)], 'a', { a: 'rodar os testes e abrir a PR' });
    expect(html).toContain('↪ quando terminar: rodar os testes e abrir a PR');
    expect(html).toContain('gerente · segue 1 ordem');
    expect(renderOrchestra([musician('a', 22)], 'a', { a: 'x', b: 'y' })).toContain('segue 2 ordens');
    expect(renderOrchestra([musician('a', 22)], 'a')).toContain('gerente · segue suas ordens');
  });
});

describe('the backstage on the stage (#142)', async () => {
  const { cleanLogLine, renderBackstage } = await import('../src/renderer/maestro-view.js');
  const backstage = {
    subagents: [
      { id: 'ag1', type: 'code-reviewer', description: 'Review the diff', running: true, files: ['/r/src/a.js'], lastTool: 'Read' },
      { id: 'ag2', type: 'Explore', description: 'Find usages', running: false, files: [], lastTool: 'Grep' },
    ],
    background: [{ id: 'b1', command: 'npm run dev', lines: ['VITE ready', 'Local: http://localhost:5173/'], gone: false, idleSeconds: 3 }],
    ports: [{ port: 5173, process: 'node' }],
  };

  it('collapsed by default: one row of chips with counts and ports', () => {
    const html = renderBackstage(backstage, null);
    expect(html).toContain('data-backstage="subagents"');
    expect(html).toContain('⚙ 1 sub-agente rodando');
    expect(html).toContain('▶ 1 em segundo plano');
    expect(html).toContain('⇅ :5173');
    expect(html).not.toContain('VITE ready');
  });

  it('a chip opens its detail: sub-agents with files, a background log, ports', () => {
    expect(renderBackstage(backstage, 'subagents')).toContain('code-reviewer');
    expect(renderBackstage(backstage, 'subagents')).toContain('a.js');
    expect(renderBackstage(backstage, 'subagents')).toContain('terminou');
    expect(renderBackstage(backstage, 'background')).toContain('VITE ready');
    expect(renderBackstage(backstage, 'background')).toContain('npm run dev');
    expect(renderBackstage(backstage, 'ports')).toContain('5173');
    expect(renderBackstage(backstage, 'ports')).toContain('node');
  });

  it('log lines lose ANSI codes, are cut and escaped', () => {
    expect(cleanLogLine('\u001b[32m✓\u001b[0m built <b>')).toBe('✓ built &lt;b&gt;');
    expect(cleanLogLine('x'.repeat(500)).length).toBeLessThanOrEqual(201);
  });

  it('nothing backstage, nothing drawn', () => {
    expect(renderBackstage({ subagents: [], background: [], ports: [] }, null)).toBe('');
    expect(renderBackstage(null, null)).toBe('');
  });
});

describe('a background command gone quiet (review I4)', async () => {
  const { renderBackstage } = await import('../src/renderer/maestro-view.js');
  it('a log idle for more than a minute shows how long it has been quiet', () => {
    const html = renderBackstage({ subagents: [], ports: [], background: [{ id: 'b', command: 'npm test', lines: ['done'], gone: false, idleSeconds: 125 }] }, 'background');
    expect(html).toContain('parado há 2 min');
    const fresh = renderBackstage({ subagents: [], ports: [], background: [{ id: 'b', command: 'npm run dev', lines: ['x'], gone: false, idleSeconds: 10 }] }, 'background');
    expect(fresh).not.toContain('parado');
  });
});
