import { describe, it, expect } from 'vitest';
import { diffRules, ruleLines } from '../src/main/rules-file.js';

const MD = `# Minhas regras

- nunca dar push nem merge na main sem me perguntar
- nunca de drop em nada de banco de dados
* quando ver o termo PROD em algo avise/pergunte se pode mesmo
1. não commite nada em branch dos outros de forma automatica
<!-- rascunho: isso não é regra -->
- não se autoreferencie no commit (co-autoria)

\`\`\`
exemplo dentro de bloco
\`\`\`
- leia todas as regras antes de tudo
- leia todas as regras antes de tudo
`;

const rule = (source, id = source) => ({ id, source, kind: 'ask', irreversible: false, explain: '', match: [] });

describe('ruleLines', () => {
  it('keeps one entry per rule line, without headings, comments, code blocks or duplicates', () => {
    expect(ruleLines(MD)).toEqual([
      'nunca dar push nem merge na main sem me perguntar',
      'nunca de drop em nada de banco de dados',
      'quando ver o termo PROD em algo avise/pergunte se pode mesmo',
      'não commite nada em branch dos outros de forma automatica',
      'não se autoreferencie no commit (co-autoria)',
      'leia todas as regras antes de tudo',
    ]);
  });
});

describe('diffRules', () => {
  const lines = ruleLines(MD);
  const approved = lines.map((line) => rule(line));

  it('an edited line loses its approval and comes back pending', () => {
    const edited = lines.map((line, n) => (n === 2 ? 'quando ver PROD ou HML pergunte' : line));
    const result = diffRules({ lines: edited, approved, drafts: [] });
    expect(result.active).toHaveLength(5);
    expect(result.active.map((r) => r.source)).not.toContain(lines[2]);
    expect(result.pending).toEqual(['quando ver PROD ou HML pergunte']);
  });

  it('drafts of lines that left the file are dropped', () => {
    const result = diffRules({ lines: lines.slice(1), approved: [], drafts: [rule(lines[0], 'd0'), rule(lines[1], 'd1')] });
    expect(result.drafts.map((draft) => draft.id)).toEqual(['d1']);
    expect(result.pending).toHaveLength(5);
  });
});
