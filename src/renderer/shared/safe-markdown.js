// Markdown for GitHub bodies that can never run anything: escape first, then
// format. Links become plain text with the URL beside them, and no <img> is
// ever produced, so a hostile issue body stays inert.
import { escapeHtml } from '../workspace-view.js';

// Run on already-escaped text, so a match can only ever contain entities.
function inline(escaped) {
  const codes = [];
  let text = escaped.replace(/`([^`\n]+)`/g, (_, code) => {
    codes.push(`<code>${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // ![alt](url) and [label](url) both end as text; an image is never loaded.
  text = text.replace(/!?\[([^\]\n]{0,200})\]\(((?:[^()\s]|\([^()\s]{0,200}\)){0,500})\)/g, (_, label, url) => `${label} <span class="md-url">(${url})</span>`);
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<em>$2</em>');
  return text.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

// Past this a line is shown as plain escaped text: nothing to backtrack on.
const MAX_FORMATTED_LINE = 2000;

export function renderSafeMarkdown(text) {
  // NUL is the code-placeholder delimiter: a body must not be able to forge one.
  const lines = escapeHtml(String(text ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')).split('\n');
  const out = [];
  let list = null; // 'ul' | 'ol'
  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) out.push(`<p>${paragraph.join('<br>')}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushParagraph();
      closeList();
      const code = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      out.push(`<pre><code>${code.join('\n')}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      out.push(`<h${heading[1].length} class="md-h">${line.length > MAX_FORMATTED_LINE ? heading[2] : inline(heading[2])}</h${heading[1].length}>`);
    } else if (item) {
      flushParagraph();
      const kind = item[1] ? 'ol' : 'ul';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${line.length > MAX_FORMATTED_LINE ? item[2] : inline(item[2])}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line.length > MAX_FORMATTED_LINE ? line : inline(line));
    }
  }
  flushParagraph();
  closeList();
  return out.join('');
}
