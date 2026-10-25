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
