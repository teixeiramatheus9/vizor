import { describe, expect, it } from 'vitest';
import { detectTrayHost, hasTrayHostIn, trayMenuTemplate } from '../src/main/tray.js';

describe('trayMenuTemplate', () => {
  it('opens the workspace first when it is available', () => {
    expect(trayMenuTemplate({ bubbleVisible: true, workspace: true })[0]).toEqual({
      id: 'workspace',
      label: 'Abrir o workspace',
    });
    expect(
      trayMenuTemplate({ bubbleVisible: true, workspace: false }).some((item) => item.id === 'workspace'),
    ).toBe(false);
  });

  const ids = (options) => trayMenuTemplate(options).filter((item) => item.id).map((item) => item.id);

  it('opens the app and its settings straight from the tray', () => {
    // the tray is the only handle when the bubble is parked, so it has to do
    // more than toggle: reaching the panel or the settings took a bubble click
    expect(ids({ bubbleVisible: false })).toContain('panel');
    expect(ids({ bubbleVisible: false })).toContain('settings');
  });

  it('opens the rules window from the tray', () => {
    expect(trayMenuTemplate({ bubbleVisible: true }).find((item) => item.id === 'rules')).toEqual({ id: 'rules', label: 'Regras…' });
  });

  it('offers to find a bubble that got lost off screen', () => {
    expect(ids({ bubbleVisible: true })).toContain('find');
  });

  it('offers to hide the bubble while it is on screen', () => {
    const toggle = trayMenuTemplate({ bubbleVisible: true }).find((item) => item.id === 'toggle');
    expect(toggle.label).toBe('Esconder a bolha');
  });

  it('offers to bring the bubble back once it is hidden', () => {
    const toggle = trayMenuTemplate({ bubbleVisible: false }).find((item) => item.id === 'toggle');
    expect(toggle.label).toBe('Mostrar a bolha');
  });

  it('always keeps a real way out, and keeps it last', () => {
    const items = trayMenuTemplate({ bubbleVisible: true }).filter((item) => item.id);
    expect(items.at(-1)).toMatchObject({ id: 'quit', label: 'Encerrar' });
  });

  it('labels every item — an unlabelled entry renders blank in the menu', () => {
    for (const item of trayMenuTemplate({ bubbleVisible: true })) {
      if (item.id) expect(item.label).toBeTruthy();
    }
  });
});

describe('hasTrayHostIn', () => {
  it('sees the tray host GNOME only has with the appindicator extension', () => {
    expect(hasTrayHostIn("('org.freedesktop.DBus', 'org.kde.StatusNotifierWatcher', ':1.42')")).toBe(
      true,
    );
  });

  it('reports no host on a bare GNOME session', () => {
    expect(hasTrayHostIn("('org.freedesktop.DBus', 'org.gnome.Shell', ':1.7')")).toBe(false);
  });

  it('treats a failed or empty probe as no host', () => {
    expect(hasTrayHostIn('')).toBe(false);
    expect(hasTrayHostIn(null)).toBe(false);
  });
});

describe('detectTrayHost', () => {
  const shouldNotRun = () => {
    throw new Error('probed the bus off Linux');
  };

  it('gives macOS no tray: closing the app there ends it, hooks included', async () => {
    await expect(detectTrayHost({ platform: 'darwin', execFn: shouldNotRun })).resolves.toBe(false);
  });

  it('always has a tray on Windows: the shell notification area is built in', async () => {
    await expect(detectTrayHost({ platform: 'win32', execFn: shouldNotRun })).resolves.toBe(true);
  });

  it('asks the session bus on Linux', async () => {
    const execFn = async () => ({ stdout: "('org.kde.StatusNotifierWatcher',)" });
    await expect(detectTrayHost({ platform: 'linux', execFn })).resolves.toBe(true);
  });

  it('treats a missing gdbus as no tray', async () => {
    const execFn = async () => {
      throw new Error('ENOENT');
    };
    await expect(detectTrayHost({ platform: 'linux', execFn })).resolves.toBe(false);
  });
});


describe('trayMenuTemplate: microphone and audio output', () => {
  const audio = {
    mics: [{ id: 'a1', label: 'Microfone digital' }, { id: 'h510', label: 'H510' }],
    mic: { id: 'h510', label: 'H510' },
    outputs: [{ name: 'spk', label: 'Alto-falantes' }],
    output: null,
  };

  it('two submenus of radio items: the system default first, the chosen one checked', () => {
    const template = trayMenuTemplate({ bubbleVisible: true, audio });
    const mic = template.find((item) => item.id === 'mic-menu');
    const output = template.find((item) => item.id === 'output-menu');
    expect(mic.label).toBe('Microfone');
    expect(mic.submenu.map((item) => [item.id, item.label, item.type, item.checked])).toEqual([
      ['mic:default', 'Padrão do sistema', 'radio', false],
      ['mic:0', 'Microfone digital', 'radio', false],
      ['mic:1', 'H510', 'radio', true],
    ]);
    expect(output.label).toBe('Saída de áudio');
    expect(output.submenu.map((item) => [item.id, item.checked])).toEqual([['output:default', true], ['output:0', false]]);
  });

  it('a pinned device that is unplugged stays listed, marked; no mics yet says why', () => {
    const template = trayMenuTemplate({ bubbleVisible: true, audio: { mics: [], mic: { id: 'z', label: 'Blue Yeti' }, outputs: [], output: null } });
    const mic = template.find((item) => item.id === 'mic-menu');
    expect(mic.submenu.map((item) => [item.id, item.label, item.checked ?? null, item.enabled ?? true])).toEqual([
      ['mic:default', 'Padrão do sistema', false, true],
      ['mic:pinned', 'Blue Yeti (desconectado)', true, true],
      ['mic:none', 'ligue a voz pra listar os microfones', null, false],
    ]);
  });

  it('without audio info (not Linux) there are no audio submenus', () => {
    expect(trayMenuTemplate({ bubbleVisible: true }).some((item) => item.id === 'mic-menu')).toBe(false);
  });
});
