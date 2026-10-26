// Where the Vizor speaks (tray menu › saída de áudio). The outputs come from
// PipeWire (pw-dump, already used to spot a call); the voice plays on the
// chosen one with pw-play --target. Pure: the dump comes in parsed.
const MAX_TEXT = 512;
const isText = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;

export function listSinks(objects) {
  if (!Array.isArray(objects)) return [];
  return objects
    .filter((object) => object?.type === 'PipeWire:Interface:Node' && object.info?.props?.['media.class'] === 'Audio/Sink')
    .map((object) => ({ name: object.info.props['node.name'], label: object.info.props['node.description'] || object.info.props['node.name'] }))
    .filter((sink) => isText(sink.name))
    .sort((a, b) => a.label.localeCompare(b.label));
}

// What main accepts as the pinned output: { name, label }; anything else means
// the system default.
export function normalizeOutput(value) {
  if (!value || !isText(value.name)) return null;
  return { name: value.name, label: isText(value.label) ? value.label : value.name };
}

// The bubble's chimes play through WebAudio, which only takes Chromium's own
// device id: the pinned sink is found among Chromium's outputs by its name.
export function chromiumSinkId(chromiumOutputs, output) {
  if (!output) return '';
  return (chromiumOutputs ?? []).find((device) => device.label === output.label)?.id ?? '';
}
