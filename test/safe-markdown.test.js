import { describe, it, expect } from 'vitest';
import { renderSafeMarkdown } from '../src/renderer/shared/safe-markdown.js';

describe('renderSafeMarkdown', () => {
  it('makes script and onerror inert', () => {
    const html = renderSafeMarkdown('<script>alert(1)</script>\n<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;script&gt;');
  });
  it('never emits an anchor or image, links stay text with the url beside', () => {
    const html = renderSafeMarkdown('[click](javascript:alert(1)) ![pic](http://evil/x.png)');
    expect(html).not.toMatch(/<a\s|<img|href=/i);
    expect(html).toContain('click <span class="md-url">(javascript:alert(1))</span>');
    expect(html).toContain('pic <span class="md-url">(http://evil/x.png)</span>');
  });
  it('formats headings, lists, emphasis and code', () => {
    const html = renderSafeMarkdown('# Title\n- a\n- **b** and _c_\n1. one\n\n`x<y` text\n```\nif (a<b) {}\n```');
    expect(html).toContain('<h1 class="md-h">Title</h1>');
    expect(html).toContain('<ul><li>a</li><li><strong>b</strong> and <em>c</em></li></ul>');
    expect(html).toContain('<ol><li>one</li></ol>');
    expect(html).toContain('<code>x&lt;y</code>');
    expect(html).toContain('<pre><code>if (a&lt;b) {}</code></pre>');
  });
  it('does not format inside inline code and survives empty input', () => {
    expect(renderSafeMarkdown('`**x**`')).toBe('<p><code>**x**</code></p>');
    expect(renderSafeMarkdown(null)).toBe('');
  });
  it('escapes quotes so attributes cannot be broken out of', () => {
    expect(renderSafeMarkdown('"><b onclick=1>')).not.toContain('<b');
  });
  it('renders an adversarial 64 KB body fast', () => {
    const body = `${'['.repeat(60000)}\n${'![a'.repeat(1300)}`;
    const start = performance.now();
    renderSafeMarkdown(body);
    expect(performance.now() - start).toBeLessThan(50);
  });
  it('leaves very long lines as plain escaped text', () => {
    const html = renderSafeMarkdown(`**${'a'.repeat(2100)}** <b>`);
    expect(html).not.toContain('<strong>');
    expect(html).toContain('&lt;b&gt;');
  });
  it('strips NUL so placeholders cannot be forged', () => {
    expect(renderSafeMarkdown('`x` \u00000\u0000')).not.toContain('undefined');
    expect(renderSafeMarkdown('\u00005\u0000')).not.toContain('undefined');
  });
});
