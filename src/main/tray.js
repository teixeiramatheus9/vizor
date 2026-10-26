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

export function trayMenuTemplate({ bubbleVisible, workspace = false, audio = null }) {
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
    { id: 'toggle', label: bubbleVisible ? 'Esconder a bolha' : 'Mostrar a bolha' },
    { id: 'find', label: 'Encontrar a bolha' },
    { type: 'separator' },
    { id: 'quit', label: 'Encerrar' },
  ];
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
