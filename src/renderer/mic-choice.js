// Which microphone the mic window opens (#161). Live test: the system default
// switched to a headset that delivered silence, and the voice went deaf. The
// user can pin a mic; it is found again by id, or by name when the id
// changed, and the system default stands in while it is unplugged.
const ALIASES = new Set(['default', 'communications', '']);

export function listMics(devices) {
  return (devices ?? [])
    .filter((device) => device.kind === 'audioinput' && !ALIASES.has(device.deviceId))
    .map((device) => ({ id: device.deviceId, label: device.label || device.deviceId }));
}

// wanted: { id, label } or null (the system default). Returns a deviceId, or
// null for the system default.
export function pickMic(devices, wanted) {
  if (!wanted) return null;
  const mics = listMics(devices);
  return (mics.find((mic) => mic.id === wanted.id) ?? mics.find((mic) => mic.label === wanted.label))?.id ?? null;
}

const MAX_TEXT = 512;
const isText = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT;

// What main accepts over IPC: a pinned mic is { id, label }; anything else
// means the system default.
export function normalizeMic(value) {
  if (!value || !isText(value.id)) return null;
  return { id: value.id, label: isText(value.label) ? value.label : value.id };
}

export function normalizeMicList(list) {
  return Array.isArray(list) ? list.map(normalizeMic).filter(Boolean).slice(0, 32) : [];
}
