import { describe, expect, it } from 'vitest';
import { renderReviewTabs } from '../src/renderer/review/tabs-view.js';
import { renderSummary, renderVerdict } from '../src/renderer/review/summary-view.js';

describe('the verdict strip', () => {
  it('marks each item with its key and tone class', () => {
    const html = renderVerdict([
      { key: 'tsc', text: 'tsc ✓', tone: 'ok' },
      { key: 'tests', text: 'testes ✗', tone: 'bad' },
      { key: 'untested', text: '2 sem teste', tone: 'warn' },
      { key: 'files', text: '3 arquivos', tone: 'muted' },
    ]);
    for (const [key, tone] of [['tsc', 'ok'], ['tests', 'bad'], ['untested', 'warn'], ['files', 'muted']]) {
      expect(html).toMatch(new RegExp(`class="verdict-item tone-${tone}" data-verdict="${key}"`));
    }
  });

  it('escapes the text and falls back to muted for an unknown tone', () => {
    const html = renderVerdict([{ key: 'x"', text: '<b>&', tone: 'evil" onclick="' }]);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;&amp;');
    expect(html).toContain('tone-muted');
    expect(html).toContain('data-verdict="x&quot;"');
  });
});

describe('the summary', () => {
  it('composes the strip, the request, the plan and the backstage as given', () => {
    const html = renderSummary({ verdict: [{ key: 'tsc', text: 'ok', tone: 'ok' }], request: 'faça <x>', planHtml: '<div id="plan"></div>', backstageHtml: '<div id="bs"></div>', backstageOpen: true });
    expect(html).toContain('data-verdict="tsc"');
    expect(html).toContain('faça &lt;x&gt;');
    expect(html).toContain('<div id="plan"></div>');
    expect(html).toMatch(/<details[^>]* open>/);
    expect(html).toContain('<div id="bs"></div>');
  });

  it('closed backstage and no request draw nothing extra', () => {
    const html = renderSummary({ verdict: [], planHtml: '', backstageHtml: '<i></i>', backstageOpen: false });
    expect(html).not.toMatch(/<details[^>]* open>/);
    expect(html).not.toContain('summary-request');
    expect(renderSummary({ verdict: [] })).not.toContain('<details');
  });
});

describe('the review tabs', () => {
  it('lists the four tabs and marks the active one', () => {
    const html = renderReviewTabs('impact');
    for (const id of ['summary', 'changes', 'impact', 'live']) expect(html).toContain(`data-review-tab="${id}"`);
    for (const label of ['Resumo', 'Mudanças', 'Impacto', 'Ao vivo']) expect(html).toContain(label);
    expect(html.match(/review-tab active/g)).toHaveLength(1);
    expect(html).toMatch(/review-tab active" data-review-tab="impact"/);
  });
});
