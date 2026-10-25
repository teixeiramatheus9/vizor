// Another app recording the microphone (Meet, Zoom, a call) pauses the voice
// mode (#161). Read from `pw-dump`: input streams of other processes; a
// stream that records an output monitor is screen capture, not a meeting.
export function otherRecorders(dump, ownPids) {
  if (!Array.isArray(dump)) return [];
  const names = [];
  for (const object of dump) {
    const props = object?.info?.props;
    if (object?.type !== 'PipeWire:Interface:Node' || !props) continue;
    if (!String(props['media.class'] ?? '').startsWith('Stream/Input/Audio')) continue;
    if (String(props['stream.capture.sink']) === 'true') continue;
    if (ownPids.has(Number(props['application.process.id']))) continue;
    names.push(props['application.name'] ?? props['application.process.binary'] ?? 'outro app');
  }
  return [...new Set(names)];
}

// pw-dump may print more than one JSON array (updates appended after the
// first): read the first complete value, strings and nesting respected.
export function parsePwDump(text) {
  const source = String(text ?? '');
  const start = source.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < source.length; index++) {
    const char = source[index];
    if (inString) {
      if (char === '\\') index++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(source.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
