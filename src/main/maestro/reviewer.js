// The reviewer (#162): a músico that reads what a task changed and points out
// the risks, changing nothing. Offered once per músico when its task touched
// 3 files or more, or any critical one (the red of the graph). Pure.
const MIN_TOUCHED = 3;

export const REVIEW_TASK_PROMPT = (name) =>
  `Revise o que a task ${name} mudou nesta pasta: rode \`git status\`, \`git diff\` e \`git log --oneline -10\`, aponte os riscos por gravidade com arquivo e linha, e não mude código nem publique nada sem eu pedir.`;

export function shouldSuggest(impact, critical, seen) {
  if (!impact || seen.has(impact.sessionId)) return null;
  const touched = Object.entries(impact.modules ?? {}).filter(([, state]) => state === 'touched').map(([id]) => id);
  const risky = touched.filter((id) => critical.modules.has(id)).length;
  return touched.length >= MIN_TOUCHED || risky >= 1 ? { touched: touched.length, critical: risky } : null;
}
