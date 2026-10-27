// What the Ctrl+K bar lists from GitHub, only ever for the project it was read
// for: picking "#12" in project B must never start A's #12. Pure.
const pick = (list) => (Array.isArray(list) ? list : []).map(({ number, title }) => ({ number, title }));

export function catalogFrom({ results, resultsRoot, root }) {
  if (!results || !root || resultsRoot !== root) return { issues: [], prs: [], error: true };
  // A key that came back as `{ error }` lists nothing; only losing both is an error.
  const lost = !Array.isArray(results.openIssues) && !Array.isArray(results.prs);
  return { issues: pick(results.openIssues), prs: pick(results.prs), error: lost };
}

export const catalogStale = ({ resultsRoot, root, at, now, maxAge }) => resultsRoot !== root || now - at > maxAge;
