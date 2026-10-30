// The user's rules file is free Portuguese, one rule per line. Approval is per
// line: a rule stays active only while its exact source line is in the file,
// so an edit can never carry an old approval over to new text (#160).

const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/;

export function ruleLines(markdown) {
  const text = String(markdown ?? '').replace(/<!--[\s\S]*?-->/g, '');
  const lines = [];
  let fenced = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```') || line.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line || line.startsWith('#')) continue;
    const rule = line.replace(LIST_MARKER, '').trim();
    if (rule && !lines.includes(rule)) lines.push(rule);
  }
  return lines;
}

export function diffRules({ lines, approved, drafts }) {
  const present = new Set(lines);
  const active = approved.filter((rule) => present.has(rule.source));
  const activeSources = new Set(active.map((rule) => rule.source));
  return {
    active,
    pending: lines.filter((line) => !activeSources.has(line)),
    drafts: drafts.filter((draft) => present.has(draft.source) && !activeSources.has(draft.source)),
  };
}
