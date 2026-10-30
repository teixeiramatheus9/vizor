// Kept free of electron imports on purpose: the decisions are testable here and
// index.js does the Tray/Menu wiring.

// GNOME dropped the legacy systray, so an icon only shows up when something
// implements the StatusNotifierItem host — on GNOME that means the appindicator
// extension. Without a host the icon silently goes nowhere, which would make
// "hide to tray" a trap: no bubble, no menu, no way back.
const TRAY_HOST_NAME = 'org.kde.StatusNotifierWatcher';

export function hasTrayHostIn(dbusNames) {
  return String(dbusNames ?? '').includes(TRAY_HOST_NAME);
}

// The tray is the only handle left when the bubble is parked, so it opens the
// app and its settings directly — a menu that could only toggle the bubble
// still made you click the bubble to get anywhere.
// audio (Linux): { mics, mic, outputs, output } — the devices found and the
// pinned ones (null = the system default). A pinned device that is unplugged
// stays listed, marked, so the choice is not lost.
function deviceMenu(prefix, devices, pinned, keyOf, emptyLabel) {
  const items = [{ id: `${prefix}:default`, label: 'Padrão do sistema', type: 'radio', checked: !pinned }];
  devices.forEach((device, index) =>
    items.push({ id: `${prefix}:${index}`, label: device.label, type: 'radio', checked: Boolean(pinned) && keyOf(device) === keyOf(pinned) }),
  );
  if (pinned && !devices.some((device) => keyOf(device) === keyOf(pinned)))
    items.push({ id: `${prefix}:pinned`, label: `${pinned.label} (desconectado)`, type: 'radio', checked: true });
  if (!devices.length) items.push({ id: `${prefix}:none`, label: emptyLabel, enabled: false });
  return items;
}

// The same template feeds the workspace's "vzr" menu (#169), which also runs with no
// tray at all — there canHide is false, since a hidden bubble would leave no
// way back.
export function trayMenuTemplate({ bubbleVisible, workspace = false, audio = null, canHide = true }) {
  return [
    ...(workspace ? [{ id: 'workspace', label: 'Abrir o workspace' }] : []),
    { id: 'panel', label: 'Abrir o painel' },
    { id: 'settings', label: 'Configurações' },
    { id: 'rules', label: 'Regras…' },
    { type: 'separator' },
    ...(audio
      ? [
          { id: 'mic-menu', label: 'Microfone', submenu: deviceMenu('mic', audio.mics, audio.mic, (mic) => mic.id, 'ligue a voz pra listar os microfones') },
          { id: 'output-menu', label: 'Saída de áudio', submenu: deviceMenu('output', audio.outputs, audio.output, (sink) => sink.name, 'nenhuma saída encontrada') },
          { type: 'separator' },
        ]
      : []),
    ...(canHide || !bubbleVisible ? [{ id: 'toggle', label: bubbleVisible ? 'Esconder a bolha' : 'Mostrar a bolha' }] : []),
    { id: 'find', label: 'Encontrar a bolha' },
    { type: 'separator' },
    { id: 'quit', label: 'Encerrar' },
  ];
}

// What a device entry of either menu picks: mic:<n> / output:<n> a listed
// device, :default the system default (clears the pin). The unplugged pin and
// the "nothing found" notice pick nothing.
export function deviceChoice(id) {
  const match = /^(mic|output):(default|\d+)$/.exec(String(id ?? ''));
  if (!match) return null;
  return { kind: match[1], index: match[2] === 'default' ? 'default' : Number(match[2]) };
}

// Where the workspace's menu pops up, in its window's coordinates: right under
// the clicked label (its client rect, sent by the renderer). A rect that makes
// no sense gives {} — popup() then opens at the cursor. Near a screen edge the
// toolkit shifts the menu back in.
export function actionMenuAnchor(rect) {
  const { left, bottom } = rect ?? {};
  if (![left, bottom].every((value) => Number.isFinite(value) && value >= 0)) return {};
  return { x: Math.round(left), y: Math.round(bottom) };
}

// Linux and Windows. On macOS closing the app is meant to end it — and to
// take this app's Claude Code hooks with it — so there is nothing to park in
// the menu bar.
export async function detectTrayHost({ platform, execFn }) {
  // The Windows shell always has a notification area; no host to probe.
  if (platform === 'win32') return true;
  if (platform !== 'linux') return false;
  try {
    const { stdout } = await execFn('gdbus', [
      'call',
      '--session',
      '--dest',
      'org.freedesktop.DBus',
      '--object-path',
      '/org/freedesktop/DBus',
      '--method',
      'org.freedesktop.DBus.ListNames',
    ]);
    return hasTrayHostIn(stdout);
  } catch {
    return false;
  }
}
