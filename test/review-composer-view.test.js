import { describe, expect, it } from 'vitest';
import { renderComposer } from '../src/renderer/review/composer-view.js';

const two = [{ id: 's1', label: 'chat <1>' }, { id: 's2', label: 'chat 2' }];

describe('the review composer', () => {
  it('two sessions show the selector, one shows just the label', () => {
    const many = renderComposer({ target: { sessionLabel: 'chat 2', sessions: two }, draft: '' });
    expect(many).toContain('<select');
    expect(many).toContain('chat &lt;1&gt;');
    expect(many).toMatch(/value="s2" selected/);
    const one = renderComposer({ target: { sessionLabel: 'chat 2', sessions: [two[1]] }, draft: '' });
    expect(one).not.toContain('<select');
    expect(one).toContain('chat 2');
  });

  it('says what the comment is about, with a way to clear it', () => {
    const html = renderComposer({ target: { sessionLabel: 'a', sessions: [] }, context: { kind: 'hunk', path: 'src/x.js', newStart: 10, newLines: 5 } });
    expect(html).toContain('contexto: hunk de src/x.js, linhas 10–14');
    expect(html).toContain('data-composer="clear"');
    expect(renderComposer({ target: { sessionLabel: 'a', sessions: [] } })).not.toContain('contexto:');
  });

  it('escapes the draft, the error and the context path', () => {
    const html = renderComposer({ target: { sessionLabel: 'a', sessions: [] }, context: { kind: 'file', path: '<i>' }, draft: '</textarea><script>', error: '<b>falhou' });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<i>');
    expect(html).toContain('&lt;/textarea&gt;');
  });
});
