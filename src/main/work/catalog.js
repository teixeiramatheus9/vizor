// What the Ctrl+K bar lists from GitHub, only ever for the project it was read
// for: picking "#12" in project B must never start A's #12. Pure.
const pick = (list) => (Array.isArray(list) ? list : []).map(({ number, title }) => ({ number, title }));

export function catalogFrom({ results, resultsRoot, root }) {
  if (!results || !root || resultsRoot !== root) return { issues: [], prs: [], error: true, issuesError: true, prsError: true };
  // A key that came back as `{ error }` lists nothing and says so in its own
  // group; losing both is the catalog's error.
  const issuesError = !Array.isArray(results.openIssues);
  const prsError = !Array.isArray(results.prs);
  return { issues: pick(results.openIssues), prs: pick(results.prs), error: issuesError && prsError, issuesError, prsError };
}

export const catalogStale = ({ resultsRoot, root, at, now, maxAge }) => resultsRoot !== root || now - at > maxAge;
