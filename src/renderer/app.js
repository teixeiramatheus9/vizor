const badge = document.getElementById('badge');
const core = document.getElementById('core');
const tooltip = document.getElementById('tooltip');
const tooltipProject = document.getElementById('tooltip-project');
const tooltipText = document.getElementById('tooltip-text');
const panel = document.getElementById('panel');
const sessionsContainer = document.getElementById('sessions');

const bubble = document.getElementById('bubble');
const headerPath = document.getElementById('header-path');

const PATHS = { sessions: '~/.claude/sessions', chat: '~/.claude/chats' };

function renderHeaderPath() {
  if (mirrorSession) {
    headerPath.textContent = `~/.claude/sessions/${mirrorSession.displayName ?? mirrorSession.projectName}`;
    return;
  }
  headerPath.textContent = PATHS[chatOpen ? 'chat' : 'sessions'];
}

// One HTML, two windows: the bubble window never resizes, the overlay window
// carries the panel and the toast and is placed by the main process.
const view = new URLSearchParams(location.search).get('view') ?? 'bubble';
document.body.classList.add(`view-${view}`);
let panelOpen = false;
// managed = X11 session: main process handles drag/click detection on the
// bubble; false = Wayland, where the compositor drags via app-region CSS.
let managed = false;

const STATUS_LABEL = {
  working: 'rodando',
  done: 'concluído',
  waiting: 'esperando você',
  question: 'pergunta',
};

// Fliperama wording for the arcade skin — same states, another language.
const STATUS_LABEL_ARCADE = {
  working: '▶ play',
  done: 'game over',
  waiting: 'continue?',
  question: 'continue?',
};

window.manager.onOverlayMode((mode) => {
  panelOpen = mode === 'panel';
  if (!panelOpen) setMirrorOpen(null);
  panel.style.display = panelOpen ? 'flex' : 'none';
  tooltip.style.display = mode === 'tooltip' ? 'block' : 'none';
  if (panelOpen) window.manager.panelOpened();
});

function hideTooltip() {
  window.manager.closeOverlay();
}

function openPanel() {
  window.manager.openPanel();
}

function closePanel() {
  window.manager.closeOverlay();
}

function togglePanel() {
  window.manager.togglePanel();
}

// Wayland: only the small no-drag core/badge receive DOM clicks.
// Managed/X11: the whole bubble is press-to-drag, and main reports back a
// 'ui:click' when the press didn't move — so DOM clicks are ignored there
// to avoid double toggling.
// Main decides what a click opens: the workspace on Linux (#96), the panel
// elsewhere — the same call the X11 drag path makes.
core.addEventListener('click', () => {
  if (!managed) window.manager.activateBubble();
});
badge.addEventListener('click', () => {
  if (!managed) window.manager.activateBubble();
});
// Right-click always opens the panel — the quick view stays one click away.
bubble.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  togglePanel();
});
// The balloon remembers which session it is about: one born in the Vizor
// opens its workspace tab (#144), anything else opens the panel.
let tooltipSessionId = null;
tooltip.addEventListener('click', () => window.manager.tooltipClick(tooltipSessionId));
document.getElementById('close').addEventListener('click', closePanel);
const quitButton = document.getElementById('quit');
quitButton.addEventListener('click', () => window.manager.quit());

// With a tray icon the button parks the app there and the tray menu is what
// really ends it; without one it stays the only way out, so it says so.
function renderQuitButton(trayAvailable) {
  quitButton.textContent = trayAvailable ? '[fechar]' : '[sair]';
  quitButton.title = trayAvailable
    ? 'Esconder na bandeja — pra encerrar de vez, usa o ícone lá'
    : 'Encerrar o Vizor';
}


bubble.addEventListener('mousedown', (event) => {
  // macOS ctrl-click is a right-click: it also fires contextmenu (panel), so
  // it must not start the drag/click path too, or the panel flashes.
  const macContextClick = event.ctrlKey && navigator.platform.startsWith('Mac');
  if (managed && event.button === 0 && !macContextClick) window.manager.dragStart();
});
window.addEventListener('mouseup', () => {
  if (managed) window.manager.dragEnd();
});

window.manager.onEnv((env) => {
  managed = env.managed;
  document.body.classList.toggle('managed', managed);
});

// Both windows get the broadcast; only the bubble's click may toggle.
window.manager.onClick(() => {
  if (view === 'bubble') togglePanel();
});

// Notification waves, bubble-glow flavor: used when the halo window cannot be
// positioned (Wayland / bubble never placed). Main sends state: null there
// whenever the ring window is doing the job instead.
const HALO_CLASSES = ['halo-done', 'halo-question', 'halo-permission'];
window.manager.onHalo(({ state }) => {
  for (const klass of HALO_CLASSES) bubble.classList.remove(klass);
  if (state) bubble.classList.add(`halo-${state}`);
});

// "Encontrar a bolha": a short pulse so the eye finds the freshly centered
// (or merely revealed, on Wayland) bubble.
let spottedTimer = null;
window.manager.onSpotted(() => {
  bubble.classList.add('spotted');
  clearTimeout(spottedTimer);
  spottedTimer = setTimeout(() => bubble.classList.remove('spotted'), 1900);
});

// --- Notification chimes (synthesized: soft, short, no alarm vibes) ---
const muteButton = document.getElementById('mute');
let muted = false;
let audioContext = null;

function renderMuteButton() {
  muteButton.textContent = muted ? '[mudo]' : '[som]';
}
renderMuteButton();

muteButton.addEventListener('click', () => {
  muted = !muted;
  window.manager.setConfig({ muted });
  renderMuteButton();
  if (!muted) chime('done', true);
});

// --- manager chat view ---
const chatToggle = document.getElementById('chat-toggle');
const chatView = document.getElementById('chat');
const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSend = document.getElementById('chat-send');
let chatOpen = false;

function appendChatBubble(role, text, pending = false) {
  const bubble = document.createElement('div');
  bubble.className = `chat-bubble ${role}${pending ? ' pending' : ''}`;
  bubble.textContent = text;
  chatMessages.append(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return bubble;
}

function renderChatEmptyState() {
  if (chatMessages.childElementCount) return;
  const empty = document.createElement('div');
  empty.id = 'chat-empty';
  empty.textContent =
    '# pergunta qualquer coisa sobre teus chats: "resume o dia", "como tá o projeto-alpha?", "quem tá travado?"';
  chatMessages.append(empty);
}

function setChatOpen(open) {
  if (open) setMirrorOpen(null);
  chatOpen = open;
  chatView.classList.toggle('hidden', !open);
  sessionsContainer.classList.toggle('hidden', open);
  if (!open) sessionsContainer.classList.remove('hidden');
  if (open) {
    renderChatEmptyState();
    chatInput.focus();
  }
}

chatToggle.addEventListener('click', () => {
  setChatOpen(!chatOpen);
  renderHeaderPath();
});

async function sendChatMessage() {
  const text = chatInput.value.trim();
  if (!text || chatSend.disabled) return;
  document.getElementById('chat-empty')?.remove();
  chatInput.value = '';
  appendChatBubble('user', text);
  const pendingBubble = appendChatBubble('manager', 'digitando…', true);
  chatSend.disabled = true;
  try {
    const reply = await window.manager.chatWithManager(text);
    pendingBubble.classList.remove('pending');
    pendingBubble.textContent = reply || '…';
  } catch {
    pendingBubble.textContent = '# deu ruim aqui — tenta de novo';
  } finally {
    chatSend.disabled = false;
    chatMessages.scrollTop = chatMessages.scrollHeight;
    chatInput.focus();
  }
}

chatSend.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Enter') sendChatMessage();
});

// --- session mirror: the conversation a chat had, live from its transcript ---
const mirrorView = document.getElementById('mirror');
const mirrorMessages = document.getElementById('mirror-messages');
const mirrorTitle = document.getElementById('mirror-title');
const mirrorRename = document.getElementById('mirror-rename');
const mirrorInput = document.getElementById('mirror-input');
const mirrorSend = document.getElementById('mirror-send');
let mirrorSession = null;
let mirrorTimer = null;

function renderMirrorMessages(messages) {
  const nearBottom =
    mirrorMessages.scrollHeight - mirrorMessages.scrollTop - mirrorMessages.clientHeight < 40;
  const firstRender = !mirrorMessages.childElementCount;
  mirrorMessages.replaceChildren();
  if (!messages.length) {
    const empty = document.createElement('div');
    empty.id = 'chat-empty';
    empty.textContent = '# ainda não achei conversa nesse transcript';
    mirrorMessages.append(empty);
    return;
  }
  for (const message of messages) {
    const bubble = document.createElement('div');
    bubble.className = `chat-bubble${message.role === 'user' ? ' user' : ''}`;
    bubble.textContent = message.text;
    mirrorMessages.append(bubble);
  }
  // Follow the conversation unless the user scrolled up to read something.
  if (nearBottom || firstRender) mirrorMessages.scrollTop = mirrorMessages.scrollHeight;
}

async function refreshMirror() {
  if (!mirrorSession) return;
  const messages = await window.manager.readConversation(mirrorSession.id);
  if (mirrorSession) renderMirrorMessages(messages);
}

function setMirrorOpen(session) {
  mirrorSession = session;
  clearInterval(mirrorTimer);
  mirrorTimer = null;
  const open = Boolean(session);
  mirrorView.classList.toggle('hidden', !open);
  sessionsContainer.classList.toggle('hidden', open);
  if (open) {
    mirrorTitle.textContent =
      session.title ?? session.promptPreview ?? session.displayName ?? session.projectName;
    mirrorRename.onclick = () => {
      const alias = prompt('Apelido deste chat (vazio limpa):', session.alias ?? '');
      if (alias !== null) window.manager.renameSession(session.id, alias);
    };
    mirrorMessages.replaceChildren();
    refreshMirror();
    // The transcript is written by another process, so the mirror polls while
    // (and only while) it is on screen.
    mirrorTimer = setInterval(refreshMirror, 1500);
    mirrorInput.focus();
  }
  renderHeaderPath();
}

document.getElementById('mirror-back').addEventListener('click', () => setMirrorOpen(null));

const MIRROR_FEEDBACK = {
  typed: null, // the message shows up in the conversation itself
  sent: null, // delivered through the session's channel (#147)
  clipboard: '# copiado! cola no chat',
  pasted: '# ficou no terminal, sem Enter — confere lá',
  failed: '# não consegui enviar — tenta de novo',
};

async function sendMirrorReply() {
  if (!mirrorSession) return;
  const text = mirrorInput.value.trim();
  if (!text || mirrorSend.disabled) return;
  mirrorSend.disabled = true;
  const mode = await window.manager.sendReply(mirrorSession.id, text);
  mirrorSend.disabled = false;
  const feedback = MIRROR_FEEDBACK[mode];
  if (mode === 'typed' || mode === 'sent') {
    mirrorInput.value = '';
    setTimeout(refreshMirror, 700);
  }
  if (feedback) {
    mirrorInput.value = '';
    mirrorInput.placeholder = feedback;
    setTimeout(() => {
      mirrorInput.placeholder = 'responder este chat…';
    }, 2500);
  }
  mirrorInput.focus();
}

mirrorSend.addEventListener('click', sendMirrorReply);
mirrorInput.addEventListener('keydown', (event) => {
  event.stopPropagation();
  if (event.key === 'Enter') sendMirrorReply();
});

// --- sound settings (volume + timbre presets, persisted locally) ---
const CHIME_PRESETS = {
  marimba: {
    start: [[440, 0, 0.05]],
    done: [
      [659.25, 0, 0.09],
      [987.77, 0.13, 0.075],
    ],
    question: [
      [587.33, 0, 0.075],
      [783.99, 0.16, 0.065],
    ],
    waiting: [
      [523.25, 0, 0.07],
      [523.25, 0.18, 0.055],
    ],
  },
  cristal: {
    start: [[659.25, 0, 0.04]],
    done: [
      [880, 0, 0.07],
      [1318.51, 0.11, 0.06],
    ],
    question: [
      [987.77, 0, 0.06],
      [1174.66, 0.14, 0.05],
    ],
    waiting: [
      [783.99, 0, 0.055],
      [987.77, 0.15, 0.045],
    ],
  },
  grave: {
    start: [[220, 0, 0.06]],
    done: [
      [329.63, 0, 0.1],
      [493.88, 0.15, 0.085],
    ],
    question: [
      [293.66, 0, 0.085],
      [392, 0.17, 0.07],
    ],
    waiting: [
      [261.63, 0, 0.08],
      [261.63, 0.2, 0.06],
    ],
  },
};

// Sound lives in the shared config, not in this window: the panel changes it
// but the bubble window is the one that chimes and speaks.
const DEFAULT_TYPE_VOLUMES = { start: 60, done: 100, question: 100, waiting: 100 };

let soundVolume = 70;
let voiceVolume = 100;
let soundTimbre = 'marimba';
let typeVolumes = { ...DEFAULT_TYPE_VOLUMES };
let ttsEnabled = false;

const settingsButton = document.getElementById('settings');
const volumeInput = document.getElementById('volume');
const voiceVolumeInput = document.getElementById('voice-volume');
const timbreSelect = document.getElementById('timbre');

// The settings live in their own window now — the button and the tray menu
// both land there through the main process.
settingsButton.addEventListener('click', () => window.manager.openSettings());

document
  .getElementById('settings-close')
  .addEventListener('click', () => window.manager.closeSettings());
if (view === 'settings') {
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') window.manager.closeSettings();
  });
}

// Sidebar: one section on screen at a time.
const settingsContent = document.getElementById('settings-content');
const settingsNavItems = [...document.querySelectorAll('#settings-nav .nav-item')];
const settingsSections = [...document.querySelectorAll('.settings-section')];

function showSettingsSection(id) {
  for (const item of settingsNavItems) item.classList.toggle('active', item.dataset.section === id);
  for (const section of settingsSections) {
    section.classList.toggle('active', section.dataset.section === id);
  }
  settingsContent.scrollTop = 0;
}

for (const item of settingsNavItems) {
  item.addEventListener('click', () => showSettingsSection(item.dataset.section));
}
showSettingsSection('som');

// --- GNOME bridge (Wayland only): install/uninstall the shell extension ---
const bridgeSection = document.getElementById('bridge-section');
const bridgeState = document.getElementById('bridge-state');
const bridgeInstallButton = document.getElementById('bridge-install');
const bridgeUninstallButton = document.getElementById('bridge-uninstall');

async function refreshBridgeSection() {
  try {
    const status = await window.manager.bridgeStatus();
    bridgeSection.classList.toggle('hidden', !status.relevant);
    if (!status.relevant) return;
    bridgeState.textContent = !status.installed
      ? '# ponte não instalada'
      : status.responding
        ? '# ponte ativa — foco de aba liberado ✓'
        : '# instalada, mas dormindo — sai e entra da sessão pra ativar';
    bridgeInstallButton.classList.toggle('hidden', status.installed);
    bridgeUninstallButton.classList.toggle('hidden', !status.installed);
  } catch {
    bridgeSection.classList.add('hidden');
  }
}

bridgeInstallButton.addEventListener('click', async () => {
  bridgeInstallButton.disabled = true;
  bridgeState.textContent = '# instalando…';
  try {
    const result = await window.manager.bridgeInstall();
    if (result.installed && !result.active && ttsEnabled && !muted) {
      speakSample('Instalei a ponte! Sai e entra da sessão que aí eu alcanço teu terminal.');
    }
  } finally {
    bridgeInstallButton.disabled = false;
    await refreshBridgeSection();
  }
});

bridgeUninstallButton.addEventListener('click', async () => {
  await window.manager.bridgeUninstall();
  await refreshBridgeSection();
});

// The settings window carries the section now; probe once at startup so it
// arrives painted (the buttons re-probe after every action).
refreshBridgeSection();

window.manager.onOpenChat(() => {
  setChatOpen(true);
  renderHeaderPath();
});
// The preview plays right away, so the local value moves first: waiting for
// the config round trip would preview the volume you just left behind.
volumeInput.addEventListener('change', () => {
  soundVolume = Number(volumeInput.value);
  window.manager.setConfig({ soundVolume });
  chime('done', true);
});
voiceVolumeInput.addEventListener('change', () => {
  voiceVolume = Number(voiceVolumeInput.value);
  window.manager.setConfig({ voiceVolume });
  speakSample('Volume da voz do gerente.');
});
timbreSelect.addEventListener('change', () => {
  soundTimbre = timbreSelect.value;
  window.manager.setConfig({ timbre: soundTimbre });
  chime('done', true);
});
document.getElementById('sound-test').addEventListener('click', () => chime('done', true));

for (const slider of document.querySelectorAll('.type-row input[type="range"]')) {
  const kind = slider.dataset.kind;
  slider.addEventListener('change', () => {
    typeVolumes = { ...typeVolumes, [kind]: Number(slider.value) };
    window.manager.setConfig({ typeVolumes });
    chime(kind, true);
  });
}

const ttsCheckbox = document.getElementById('tts');
const ttsState = document.getElementById('tts-state');
const renderTtsState = () => {
  ttsState.textContent = ttsEnabled ? '[on]' : '[off]';
};
ttsCheckbox.addEventListener('change', () => {
  ttsEnabled = ttsCheckbox.checked;
  window.manager.setConfig({ ttsEnabled });
  renderTtsState();
  if (ttsEnabled) speakSample('Notificação por voz ativada.');
});

// The manager's voice answers to its own slider and to the master volume.
function speakSample(text) {
  window.manager.speak(text, Math.round((voiceVolume * soundVolume) / 100));
}

document.getElementById('voice-test').addEventListener('click', () => {
  speakSample('Testando a voz do gerente.');
});

// Sliders paint their own fill and print the value beside them.
function renderSlider(slider) {
  const min = Number(slider.min) || 0;
  const max = Number(slider.max) || 100;
  // The fill has to start where the thumb does, or a slider that does not
  // begin at zero paints a value it is not showing.
  const percent = Math.round(((Number(slider.value) - min) / (max - min)) * 100);
  slider.style.setProperty('--pct', `${percent}%`);
  const label = document.querySelector(`.slider-value[data-for="${slider.id}"]`);
  if (label) label.textContent = `${slider.value}%`;
}

for (const slider of document.querySelectorAll('#settings-window input[type="range"]')) {
  renderSlider(slider);
  slider.addEventListener('input', () => renderSlider(slider));
}

// Native selects are drawn by the OS: they ignore the theme and open over
// the current value. These wrap them in a dropdown of our own — the select
// stays in the DOM as the value holder, so reads and change events work.
const dropdowns = [];

function enhanceSelect(select) {
  const wrapper = select.parentElement;
  const trigger = document.createElement('button');
  trigger.className = 'dd-trigger';
  const menu = document.createElement('div');
  menu.className = 'dd-menu hidden';
  wrapper.append(trigger, menu);

  const close = () => menu.classList.add('hidden');
  const render = () => {
    trigger.textContent = `[${select.selectedOptions[0]?.text ?? ''} ▾]`;
    menu.replaceChildren(
      ...[...select.options].map((option) => {
        const item = document.createElement('button');
        item.className = `dd-option${option.value === select.value ? ' selected' : ''}`;
        item.textContent = option.text;
        item.addEventListener('click', (event) => {
          event.stopPropagation();
          select.value = option.value;
          select.dispatchEvent(new Event('change'));
          render();
          close();
        });
        return item;
      }),
    );
  };

  trigger.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const opening = menu.classList.contains('hidden');
    for (const other of dropdowns) other.close();
    if (!opening) return;
    const box = trigger.getBoundingClientRect();
    menu.style.left = `${box.left}px`;
    menu.style.top = `${box.bottom + 4}px`;
    menu.classList.remove('hidden');
  });

  dropdowns.push({ render, close });
  render();
}

document.addEventListener('click', () => {
  for (const dropdown of dropdowns) dropdown.close();
});

// The menu is positioned against the viewport, so scrolling would leave it
// floating away from its trigger.
settingsContent.addEventListener('scroll', () => {
  for (const dropdown of dropdowns) dropdown.close();
});

function refreshDropdowns() {
  for (const dropdown of dropdowns) dropdown.render();
}

// --- manager config (terminal + daily token budget) ---
const inboundSelect = document.getElementById('inbound');
const inboundHint = document.getElementById('inbound-hint');

const INBOUND_HINTS = {
  default: 'entrega quando os modos de permissão casam; senão o chat pede sua confirmação.',
  accept: '⚠ entrega sem confirmação — vale pra qualquer processo local, não só pro gerente.',
  hold: 'toda mensagem espera você aprovar no chat.',
  refuse: 'o chat não recebe nada do gerente.',
};

function renderInboundHint(value) {
  const base = INBOUND_HINTS[value] ?? '';
  // The user level is all this app writes; a repo or managed setting can still
  // tighten it, and promising otherwise would be a lie.
  inboundHint.textContent = `# ${base} configurações do repositório ou da organização podem restringir por cima.`;
}

window.manager.getInboundPolicy().then((value) => {
  inboundSelect.value = value;
  renderInboundHint(value);
  refreshDropdowns();
});

inboundSelect.addEventListener('change', async () => {
  const applied = await window.manager.setInboundPolicy(inboundSelect.value);
  // Trust what main reports back, not what was clicked: a rejected or failed
  // write must not leave the panel showing a value that is not on disk.
  inboundSelect.value = applied;
  renderInboundHint(applied);
  refreshDropdowns();
});

const updateCheckButton = document.getElementById('update-check');
const updateCheckFeedback = document.getElementById('update-check-feedback');

updateCheckButton.addEventListener('click', async () => {
  updateCheckButton.disabled = true;
  updateCheckFeedback.textContent = '# buscando…';
  try {
    const status = await window.manager.checkUpdates();
    if (status.ready) {
      updateCheckFeedback.textContent = `# v${status.ready} baixada — clica no banner pra reiniciar`;
    } else if (status.available) {
      updateCheckFeedback.textContent = `# v${status.available} disponível — clica no banner acima`;
    } else if (status.mode === 'off') {
      updateCheckFeedback.textContent = '# modo dev — atualização desligada';
    } else if (status.checkFailed) {
      // The check itself failed (offline, rate limit, missing release asset):
      // never claim "latest" on a failure (#55).
      updateCheckFeedback.textContent = '# não consegui checar agora — tenta mais tarde';
    } else {
      updateCheckFeedback.textContent = `# você já está na mais recente (v${status.currentVersion}) ✓`;
    }
  } catch {
    updateCheckFeedback.textContent = '# não consegui checar agora';
  } finally {
    updateCheckButton.disabled = false;
  }
});

const terminalSelect = document.getElementById('terminal');
const voiceSelect = document.getElementById('voice');
const themeSelect = document.getElementById('theme');
const paletteSelect = document.getElementById('palette');
const panelScaleInput = document.getElementById('panel-scale');

// Every window reads theme + palette off the shared state, so switching them
// in the settings repaints the bubble and the panel at the same time. The
// theme is the skin (classico/arcade); the palette only colours the classic.
let arcadeSkin = false;
function applyTheme(theme, palette) {
  if (theme) document.body.dataset.theme = theme;
  if (palette) document.body.dataset.palette = palette;
  arcadeSkin = document.body.dataset.theme === 'arcade';
  // The cabinet speaks its own dialect — short marquee titles, hotkey-style
  // test buttons. CSS handles colours; the words swap here.
  document.querySelector('#panel header h1').textContent = arcadeSkin ? 'vizor' : 'vzr';
  document.querySelector('#settings-window header h1').textContent = arcadeSkin
    ? 'config'
    : 'configurações';
  document.getElementById('sound-test').textContent = arcadeSkin
    ? '[s]testar som'
    : '[testar som]';
  document.getElementById('voice-test').textContent = arcadeSkin
    ? '[v]testar voz'
    : '[testar voz]';
}

// The tube is orthogonal to the palette: it rides over whichever theme is on.
const crtCheckbox = document.getElementById('crt');
const crtState = document.getElementById('crt-state');

function applyCrt(on) {
  document.body.classList.toggle('crt', Boolean(on));
  crtCheckbox.checked = Boolean(on);
  crtState.textContent = on ? '[on]' : '[off]';
}

crtCheckbox.addEventListener('change', () => {
  applyCrt(crtCheckbox.checked);
  window.manager.setConfig({ crt: crtCheckbox.checked });
});

// --- global shortcuts: click a field, press the combo, done ---------------
const shortcutInputs = [...document.querySelectorAll('.shortcut-input')];
const shortcutsHint = document.getElementById('shortcuts-hint');
const SHORTCUT_LABELS = {
  panel: 'painel',
  bubble: 'bolha',
  find: 'encontrar',
  chat: 'chat',
};

// KeyboardEvent -> electron accelerator ('Ctrl+Alt+B'). Null when the combo
// has no modifier (a bare key would hijack typing) or no real key yet.
function acceleratorFromKeyEvent(event) {
  const modifiers = [];
  if (event.ctrlKey) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey) modifiers.push('Super');
  if (!modifiers.length) return null;
  const special = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Esc',
    '+': 'Plus',
  };
  const { key } = event;
  if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(key)) return null;
  const normalized =
    special[key] ??
    (/^[a-z]$/i.test(key) ? key.toUpperCase() : /^(F\d{1,2}|[0-9]|Tab|Home|End|PageUp|PageDown|Insert|Delete|Enter)$/.test(key) || key.length === 1 ? key : null);
  return normalized ? [...modifiers, normalized].join('+') : null;
}

function applyShortcuts(shortcuts) {
  if (!shortcuts) return;
  const failed = shortcuts.failed ?? [];
  for (const input of shortcutInputs) {
    const id = input.dataset.shortcut;
    // A field being typed into shows the live combo, not the stored one.
    if (document.activeElement !== input) input.value = shortcuts.values?.[id] ?? '';
    input.classList.toggle('failed', failed.includes(id));
  }
  shortcutsHint.textContent = failed.length
    ? `em uso pelo sistema: ${failed.map((id) => SHORTCUT_LABELS[id] ?? id).join(', ')}`
    : 'backspace limpa o atalho';
}

for (const input of shortcutInputs) {
  input.addEventListener('keydown', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Backspace' || event.key === 'Delete') {
      input.value = '';
      window.manager.setConfig({ shortcuts: { [input.dataset.shortcut]: '' } });
      input.blur();
      return;
    }
    const accelerator = acceleratorFromKeyEvent(event);
    if (!accelerator) return;
    input.value = accelerator;
    window.manager.setConfig({ shortcuts: { [input.dataset.shortcut]: accelerator } });
    input.blur();
  });
}

// Autostart mirrors the OS state (main reads the real entry), so the checkbox
// only reflects what came in the last state — no local persistence.
const autostartCheckbox = document.getElementById('autostart');
const autostartState = document.getElementById('autostart-state');

function applyAutostart(on) {
  autostartCheckbox.checked = Boolean(on);
  autostartState.textContent = on ? '[on]' : '[off]';
}

autostartCheckbox.addEventListener('change', () => {
  applyAutostart(autostartCheckbox.checked);
  window.manager.setConfig({ autostart: autostartCheckbox.checked });
});

// Settings › regras (#160): the lock's state in one line, its switch, and the
// way into the rules window.
const guardCheckbox = document.getElementById('guard-enabled');
const guardEnabledState = document.getElementById('guard-enabled-state');

function renderGuardStatus(guard) {
  if (!guard) return;
  const off = !guard.enabled || guard.unreadable;
  document.getElementById('guard-status').textContent = guard.unreadable
    ? '# trava desligada: o arquivo das regras está ilegível'
    : `# ${off ? 'trava desligada' : 'trava ligada'} · ${guard.active} ativas · ${guard.pending} esperando revisão`;
  guardCheckbox.checked = guard.enabled;
  guardEnabledState.textContent = guard.enabled ? '[on]' : '[off]';
  document.getElementById('guard-offline').classList.toggle('hidden', !(guard.enabled && guard.installed && !guard.offline));
}

guardCheckbox.addEventListener('change', () => {
  guardEnabledState.textContent = guardCheckbox.checked ? '[on]' : '[off]';
  window.manager.setGuardEnabled(guardCheckbox.checked);
});
document.getElementById('open-rules').addEventListener('click', () => window.manager.openRules());

const autoUpdateCheckbox = document.getElementById('auto-update');
const autoUpdateState = document.getElementById('auto-update-state');

function applyAutoUpdate(on) {
  autoUpdateCheckbox.checked = Boolean(on);
  autoUpdateState.textContent = on ? '[on]' : '[off]';
}

autoUpdateCheckbox.addEventListener('change', () => {
  applyAutoUpdate(autoUpdateCheckbox.checked);
  window.manager.setConfig({ autoUpdate: autoUpdateCheckbox.checked });
});

const announceUnknownCheckbox = document.getElementById('announce-unknown');
const announceUnknownState = document.getElementById('announce-unknown-state');

function applyAnnounceUnknown(on) {
  announceUnknownCheckbox.checked = Boolean(on);
  announceUnknownState.textContent = on ? '[on]' : '[off]';
}

announceUnknownCheckbox.addEventListener('change', () => {
  applyAnnounceUnknown(announceUnknownCheckbox.checked);
  window.manager.setConfig({ announceWhenFocusUnknown: announceUnknownCheckbox.checked });
});
for (const select of document.querySelectorAll('.sel select')) enhanceSelect(select);
const budgetInput = document.getElementById('budget');
const budgetLabel = document.getElementById('budget-label');
const usageLine = document.getElementById('usage-line');

const formatTokens = (value) =>
  value >= 1000
    ? `${(value / 1000).toFixed(value % 1000 ? 1 : 0).replace('.', ',')}k`
    : String(value);

function renderBudgetLabel(value) {
  budgetLabel.textContent = value <= 0 ? '0' : formatTokens(value);
}

window.manager.getConfig().then((config) => {
  if (Array.isArray(config.terminals) && config.terminals.length) {
    terminalSelect.replaceChildren(
      ...config.terminals.map(({ value, label }) => new Option(label, value)),
    );
  }
  terminalSelect.value = config.terminal;
  if (Array.isArray(config.voices) && config.voices.length) {
    voiceSelect.replaceChildren(
      ...config.voices.map(({ value, label }) => new Option(label, value)),
    );
  }
  voiceSelect.value = config.voice;
  if (Array.isArray(config.themes) && config.themes.length) {
    themeSelect.replaceChildren(
      ...config.themes.map(({ value, label }) => new Option(label, value)),
    );
  }
  themeSelect.value = config.theme;
  if (Array.isArray(config.palettes) && config.palettes.length) {
    paletteSelect.replaceChildren(
      ...config.palettes.map(({ value, label }) => new Option(label, value)),
    );
  }
  paletteSelect.value = config.palette;
  applyTheme(config.theme, config.palette);
  applyCrt(config.crt);
  const range = config.panelScaleRange;
  if (range) {
    panelScaleInput.min = String(range.min);
    panelScaleInput.max = String(range.max);
    panelScaleInput.step = String(range.step);
  }
  panelScaleInput.value = String(config.panelScale);
  renderSlider(panelScaleInput);
  refreshDropdowns();
  budgetInput.value = String(config.tokenBudgetDaily);
  renderBudgetLabel(config.tokenBudgetDaily);
  renderSlider(budgetInput);
});

terminalSelect.addEventListener('change', () => {
  window.manager.setConfig({ terminal: terminalSelect.value });
});

voiceSelect.addEventListener('change', () => {
  window.manager.setConfig({ voice: voiceSelect.value });
});

panelScaleInput.addEventListener('change', () => {
  window.manager.setConfig({ panelScale: Number(panelScaleInput.value) });
});

themeSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value, paletteSelect.value);
  window.manager.setConfig({ theme: themeSelect.value });
});

paletteSelect.addEventListener('change', () => {
  applyTheme(themeSelect.value, paletteSelect.value);
  window.manager.setConfig({ palette: paletteSelect.value });
});

budgetInput.addEventListener('input', () => renderBudgetLabel(Number(budgetInput.value)));

budgetInput.addEventListener('change', () => {
  window.manager.setConfig({ tokenBudgetDaily: Number(budgetInput.value) });
});

const usageDetail = document.getElementById('usage-detail');
const usageBarFill = document.querySelector('#usage-bar > div');

function renderUsage(tokens) {
  if (!tokens) return;
  const used = formatTokens(tokens.usedToday);
  const budget = formatTokens(tokens.budget);
  // Arcade counts credits, like any cabinet worth its coin slot.
  usageLine.textContent =
    tokens.budget <= 0
      ? 'ia desligada'
      : `${arcadeSkin ? 'credit' : 'tokens'} ${used}/${budget}${tokens.economy ? ' · eco' : ''}`;
  usageDetail.textContent =
    tokens.budget <= 0
      ? '# ia desligada por escolha sua — só frases prontas'
      : `hoje: ${used} / ${budget}`;
  const percent = tokens.budget > 0 ? Math.min(100, (tokens.usedToday / tokens.budget) * 100) : 0;
  usageBarFill.style.width = `${percent}%`;
}

function playNote(frequency, startOffset, peakGain) {
  const now = audioContext.currentTime + startOffset;
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(peakGain, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.55);
}

function chime(kind, force = false) {
  if (muted && !force) return;
  try {
    audioContext ??= new AudioContext();
    const preset = CHIME_PRESETS[soundTimbre] ?? CHIME_PRESETS.marimba;
    const notes = preset[kind] ?? preset.done;
    const typeFactor = (typeVolumes[kind] ?? 100) / 100;
    const volumeFactor = (soundVolume / 70) * typeFactor; // 70 = original calibration
    if (volumeFactor <= 0) return;
    for (const [frequency, startOffset, peakGain] of notes) {
      playNote(frequency, startOffset, peakGain * volumeFactor);
    }
  } catch {
    // audio not available; stay silent
  }
}

window.manager.onBlur(() => {
  if (panelOpen) closePanel();
});

window.manager.onChime(({ kind }) => {
  if (view === 'bubble') chime(kind);
});

// Spoken notifications stay short and instantly understandable — the full
// message lives in the tooltip/panel.
const TTS_PHRASES = {
  done: (projectName) => `Tarefa concluída no ${projectName}.`,
  question: (projectName, optionsCount) =>
    optionsCount > 0
      ? `Tem uma pergunta no ${projectName} com ${optionsCount} ${optionsCount === 1 ? 'opção' : 'opções'} pra escolher.`
      : `Tem uma pergunta no ${projectName}.`,
  waiting: (projectName) => `O chat ${projectName} espera você.`,
};

const toastMark = document.getElementById('toast-mark');
const toastOrigin = document.getElementById('toast-origin');
const TOAST_TITLE = {
  done: 'término de task',
  question: 'pergunta pendente',
  waiting: 'esperando você',
  start: 'início de task',
  hint: 'aviso do gerente',
  guard: 'posso seguir?',
};

// [abrir] does what clicking the balloon does — once (it used to also bubble
// into the balloon click: a panel flash, every badge cleared).
document.getElementById('toast-open').addEventListener('click', (event) => {
  event.stopPropagation();
  window.manager.tooltipClick(tooltipSessionId);
});
document.getElementById('toast-close').addEventListener('click', (event) => {
  event.stopPropagation();
  hideTooltip();
});

window.manager.onTooltip(({ projectName, text, kind, optionsCount, sessionId, speech }) => {
  tooltipSessionId = sessionId ?? null;
  // kind 'hint' is a manager warning: the MAIN process already spoke it
  // (speakAsManager), so the balloon adds no chime and no second voice.
  if (view === 'bubble' && kind !== 'hint') {
    chime(kind === 'guard' ? 'question' : kind);
    if (ttsEnabled && !muted) {
      const phrase = TTS_PHRASES[kind] ?? TTS_PHRASES.waiting;
      speakSample(kind === 'guard' ? speech : phrase(projectName, optionsCount));
    }
  }
  const alert = kind === 'question' || kind === 'waiting' || kind === 'guard';
  toastMark.textContent = kind === 'hint' ? '⚠' : alert ? '●' : '✓';
  toastMark.classList.toggle('warn', alert || kind === 'hint');
  tooltipProject.textContent = TOAST_TITLE[kind] ?? TOAST_TITLE.done;
  toastOrigin.textContent = `${projectName} · agora`;
  tooltipText.textContent = text;
});

// Inline nickname editor (issue #63): swaps the tab name for an input;
// Enter saves (empty clears the nickname), Esc walks away.
function startRename(container, session) {
  const previous = [...container.childNodes];
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = session.alias ?? '';
  input.placeholder = session.projectName;
  input.maxLength = 60;
  container.replaceChildren(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (save) => {
    if (finished) return; // Enter also blurs — send once
    finished = true;
    // Saving re-renders the list off the state event; walking away just
    // puts the original nodes back (the arcade rank span included).
    if (save) window.manager.renameSession(session.id, input.value);
    else container.replaceChildren(...previous);
  };
  input.addEventListener('click', (event) => event.stopPropagation());
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') finish(true);
    if (event.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'agora';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

// Reply drafts survive re-renders (every state change rebuilds the list).
const replyDrafts = new Map();
const replyFeedback = new Map();
let focusedReplySessionId = null;

function replyElement(session) {
  const container = document.createElement('div');
  container.className = 'reply';
  const input = document.createElement('input');
  input.placeholder = 'resposta rápida…';
  input.value = replyDrafts.get(session.id) ?? '';
  const sendButton = document.createElement('button');
  sendButton.textContent = '[enviar]';
  sendButton.title = 'Enviar pro chat no terminal';
  const feedback = document.createElement('div');
  feedback.className = 'reply-feedback';
  feedback.textContent = replyFeedback.get(session.id) ?? '';

  const FEEDBACK_TEXT = {
    typed: '✓ enviado pro chat',
    // the session's own channel (or its Vizor terminal) took it (#147)
    sent: '✓ enviado pro chat',
    clipboard: '# copiado! cola no chat',
    // pasted into the Vizor terminal, but Enter was not safe to press (#143)
    pasted: '# ficou no terminal, sem Enter — confere lá',
    failed: '# não consegui enviar — tenta de novo',
  };

  async function send() {
    const text = input.value.trim();
    if (!text) return;
    sendButton.disabled = true;
    const mode = await window.manager.sendReply(session.id, text);
    sendButton.disabled = false;
    replyFeedback.set(session.id, FEEDBACK_TEXT[mode] ?? '');
    feedback.textContent = replyFeedback.get(session.id);
    if (mode === 'typed' || mode === 'sent') {
      replyDrafts.delete(session.id);
      input.value = '';
    }
  }

  input.addEventListener('input', () => replyDrafts.set(session.id, input.value));
  input.addEventListener('focus', () => {
    focusedReplySessionId = session.id;
  });
  input.addEventListener('blur', () => {
    if (focusedReplySessionId === session.id) focusedReplySessionId = null;
  });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') send();
  });
  for (const element of [container, input, sendButton]) {
    element.addEventListener('click', (event) => event.stopPropagation());
  }
  sendButton.addEventListener('click', send);

  container.append(input, sendButton);
  const wrapper = document.createElement('div');
  wrapper.append(container, feedback);
  wrapper.dataset.sessionId = session.id;
  return { wrapper, input };
}

// Appends the quick-reply UI (when applicable) and returns the finished card.
function finishCard(card, session) {
  if (session.status !== 'working') {
    const { wrapper, input } = replyElement(session);
    card.append(wrapper);
    if (focusedReplySessionId === session.id) {
      queueMicrotask(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
  }
  return card;
}

// Chats opened before the manager was up — or closed on the ✕ — never fire a
// hook, so adoption is the only way back. The rescan is offered on a populated
// list too: a list missing one of five chats looks just as complete as a full
// one, so there is no state where the user can tell they need it.
const RESCAN_LABEL = '[procurar chats abertos]';

function rescanElement() {
  const row = document.createElement('div');
  row.className = 'rescan-row';
  const button = document.createElement('button');
  button.className = 'rescan';
  button.textContent = RESCAN_LABEL;
  const feedback = document.createElement('span');
  feedback.className = 'rescan-feedback';
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.textContent = '[procurando…]';
    feedback.textContent = '';
    try {
      // adopting anything fires a state event, which redraws the whole list
      const adopted = await window.manager.rescanSessions();
      if (!adopted) feedback.textContent = 'nenhum chat aberto além dos que eu já conheço';
    } finally {
      button.disabled = false;
      button.textContent = RESCAN_LABEL;
    }
  });
  row.append(button, feedback);
  return row;
}

function emptyStateElement() {
  const empty = document.createElement('div');
  empty.id = 'empty';
  const text = document.createElement('span');
  text.textContent = '# nenhuma sessão por enquanto — manda o claude trabalhar que eu te aviso';
  empty.append(text, rescanElement());
  return empty;
}

function sessionElement(session, index) {
  const state = session.question ? 'question' : session.status;
  const card = document.createElement('div');
  card.className = `session ${state}${session.unread ? ' unread' : ''}`;
  card.title = 'Abrir no terminal';
  card.addEventListener('click', () => window.manager.focusSession(session.id));

  const top = document.createElement('div');
  top.className = 'session-top';
  const dot = document.createElement('span');
  dot.className = `dot ${state}`;
  const name = document.createElement('span');
  name.className = 'name';
  // The tab's own name (nickname > folder) leads the card, pencil beside it;
  // the AI title lives on the └ line below. No arcade cada chat é um
  // jogador: 1up, 2up, 3up… — em amarelo de placar.
  const hasAlias = session.displayName && session.displayName !== session.projectName;
  const tabName = hasAlias
    ? `${session.displayName} (${session.projectName})`
    : session.projectName;
  if (arcadeSkin) {
    const player = document.createElement('span');
    // Rank colours cycle out after 2UP, like the spec's hi-score board.
    player.className = `player${index < 2 ? ` player-${index + 1}` : ''}`;
    player.textContent = `${index + 1}up `;
    name.append(player, document.createTextNode(tabName));
  } else {
    name.textContent = tabName;
  }
  const rename = document.createElement('button');
  rename.className = 'session-rename';
  rename.textContent = '✎';
  rename.title = 'Renomear este chat';
  rename.addEventListener('click', (event) => {
    event.stopPropagation();
    startRename(name, session);
  });
  const time = document.createElement('span');
  time.className = 'time';
  const statusLabels = arcadeSkin ? STATUS_LABEL_ARCADE : STATUS_LABEL;
  time.textContent = `${statusLabels[state] ?? state} ${relativeTime(session.updatedAt)}`;
  const mirror = document.createElement('button');
  mirror.className = 'session-mirror';
  mirror.textContent = '≡';
  mirror.title = 'Ver a conversa';
  mirror.addEventListener('click', (event) => {
    event.stopPropagation();
    setMirrorOpen(session);
  });
  const close = document.createElement('button');
  close.className = 'session-close';
  close.textContent = '✕';
  close.title = 'Fechar este chat';
  close.addEventListener('click', (event) => {
    event.stopPropagation();
    window.manager.removeSession(session.id);
  });
  top.append(dot, name, rename, time, mirror, close);
  card.append(top);

  // "Tema" do chat na linha de baixo: título gerado pela IA > primeiro
  // prompt. Sem nenhum dos dois a linha some — o nome da guia já está acima.
  const aiTitle = session.title ?? session.promptPreview;
  if (aiTitle) {
    const subtitle = document.createElement('div');
    subtitle.className = 'title';
    subtitle.textContent = `└ ${aiTitle}`;
    card.append(subtitle);
  }

  // One message balloon per chat — the exact text that went out in the
  // tooltip. A pending question adds its options as compact chips INSIDE
  // the same balloon, never as extra message lines.
  // A pending question owns the balloon — its text IS the question. Otherwise
  // the balloon shows what the chat itself last said, and only falls back to
  // the manager's phrase while that digest has not landed yet.
  const messageText =
    (session.question ? session.managerMessage : (session.lastMessage ?? session.managerMessage)) ??
    (session.status === 'done' ? 'Escrevendo o recado…' : null);
  if (messageText) {
    const balloon = document.createElement('div');
    balloon.className = 'message';

    const text = document.createElement('div');
    if (session.question?.questions?.length) {
      text.textContent = messageText;
      text.className = 'question-text';
    } else {
      text.textContent = messageText;
    }
    balloon.append(text);

    const firstQuestion = session.question?.questions?.[0];
    if (firstQuestion?.options?.length) {
      // Clickable only when the answer is a simple single choice we can
      // select with arrow keys; multi-select and multi-question go to the chat.
      const clickable = session.question.questions.length === 1 && !firstQuestion.multiSelect;
      const optionsRow = document.createElement('div');
      optionsRow.className = 'options-row';
      firstQuestion.options.forEach((option, optionIndex) => {
        const chip = document.createElement(clickable ? 'button' : 'span');
        chip.className = `option-chip${clickable ? ' clickable' : ''}`;
        chip.textContent = option;
        if (clickable) {
          chip.title = 'Responder com essa opção';
          chip.addEventListener('click', async (event) => {
            event.stopPropagation();
            chip.disabled = true;
            const result = await window.manager.answerQuestion(session.id, optionIndex);
            chip.disabled = false;
            if (result !== 'answered') {
              const ANSWER_FEEDBACK = {
                'not-found': '# não achei a aba do chat — responde por lá',
                'needs-terminal': '# abri o terminal pra você — escolhe a opção por lá',
              };
              replyFeedback.set(session.id, ANSWER_FEEDBACK[result] ?? '# não consegui responder');
              const feedbackElement = card.querySelector('.reply-feedback');
              if (feedbackElement) feedbackElement.textContent = replyFeedback.get(session.id);
            }
          });
        }
        optionsRow.append(chip);
      });
      balloon.append(optionsRow);
      const extraQuestions = (session.question.questions.length ?? 1) - 1;
      const hint = document.createElement('div');
      hint.className = 'question-hint';
      hint.textContent =
        extraQuestions > 0
          ? `+${extraQuestions} pergunta(s) — abrir o chat pra conferir a fundo →`
          : clickable
            ? 'Clica numa opção pra responder, ou abre o chat pra conferir a fundo →'
            : 'Abrir o chat pra conferir as opções a fundo →';
      balloon.append(hint);
    }
    card.append(balloon);
  }

  return finishCard(card, session);
}

let lastUnreadCount = 0;

// The bubble mirrors the sessions as a whole: someone waiting wins over
// someone working, and an idle bubble carries no badge at all.
function renderBadge(sessions) {
  const waiting = sessions.some((s) => s.question || s.status === 'waiting');
  const working = sessions.some((s) => s.status === 'working');
  badge.className = waiting ? 'waiting' : working ? 'working' : '';
  badge.style.display = waiting || working ? 'block' : 'none';
}

const updateBanner = document.getElementById('update-banner');
updateBanner.addEventListener('click', () => window.manager.applyUpdate());

// A hint balloon evaporates in 8s; the panel keeps the last one until the
// user dismisses it, so whoever was away from the keyboard still finds it.
const hintBanner = document.getElementById('hint-banner');
const hintBannerText = document.getElementById('hint-banner-text');
document.getElementById('hint-banner-close').addEventListener('click', () => {
  window.manager.dismissHint();
});

function renderHintBanner(hint) {
  hintBanner.classList.toggle('hidden', !hint);
  if (hint) hintBannerText.textContent = `⚠ ${hint.body}`;
}

function renderUpdateBanner(update) {
  if (!update || (!update.available && !update.ready)) {
    updateBanner.classList.add('hidden');
    return;
  }
  updateBanner.classList.remove('hidden');
  if (update.installing) {
    updateBanner.textContent = `⇣ instalando v${update.available}… (confirma a senha se o sistema pedir)`;
  } else if (update.ready) {
    updateBanner.textContent = `⇡ v${update.ready} pronta — [reiniciar agora]`;
  } else if (update.failed) {
    updateBanner.textContent = `⚠ não consegui instalar a v${update.available} — abri a página da release`;
  } else if (update.mode === 'auto') {
    updateBanner.textContent = `⇣ baixando v${update.available}…`;
  } else {
    updateBanner.textContent = `⇡ v${update.available} disponível — [instalar]`;
  }
  updateBanner.disabled = Boolean(update.installing);
}

const trayStatusLine = document.getElementById('tray-status');

// GNOME picks up a newly installed extension only when the shell starts, so
// the tray this app just installed can only appear in the next session.
function renderTrayStatus(needsRelogin) {
  trayStatusLine.classList.toggle('hidden', !needsRelogin);
  if (needsRelogin) {
    trayStatusLine.textContent =
      '# bandeja instalada — sai e entra na sessão (logout) pra ela aparecer';
  }
}

const voiceStatusLine = document.getElementById('voice-status');

function renderVoiceStatus(voice) {
  voiceStatusLine.classList.toggle('hidden', !voice);
  if (!voice) return;
  voiceStatusLine.replaceChildren();
  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.textContent = '⇣';
  voiceStatusLine.append(arrow);
  voiceStatusLine.append(
    document.createTextNode(` baixando ${voice}… falo com a voz do sistema até terminar`),
  );
}

// Every state carries the sound settings, so both windows agree on what to
// play and the panel shows what is actually in effect.
function applySound(sound) {
  if (!sound) return;
  muted = sound.muted;
  soundVolume = sound.volume;
  voiceVolume = sound.voiceVolume;
  soundTimbre = CHIME_PRESETS[sound.timbre] ? sound.timbre : 'marimba';
  ttsEnabled = sound.ttsEnabled;
  typeVolumes = { ...DEFAULT_TYPE_VOLUMES, ...sound.typeVolumes };
  renderMuteButton();
  renderTtsState();
  ttsCheckbox.checked = ttsEnabled;
  timbreSelect.value = soundTimbre;
  for (const [input, value] of [
    [volumeInput, soundVolume],
    [voiceVolumeInput, voiceVolume],
  ]) {
    if (document.activeElement !== input) input.value = String(value);
    renderSlider(input);
  }
  for (const slider of document.querySelectorAll('.type-row input[type="range"]')) {
    if (document.activeElement !== slider) slider.value = String(typeVolumes[slider.dataset.kind] ?? 100);
    renderSlider(slider);
  }
  refreshDropdowns();
}

// The rule guard's questions (#160) sit above the sessions until answered.
// guard-card.js is a module, exposed on window by guard-card-global.js.
function renderGuardAsks(asks) {
  if (!asks.length || !window.vizorGuardCard) return;
  const block = document.createElement('div');
  block.className = 'guard-asks';
  block.innerHTML = asks.map((ask) => window.vizorGuardCard.renderGuardCard(ask)).join('');
  sessionsContainer.append(block);
}

sessionsContainer.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-guard-choice]');
  if (!button) return;
  event.stopPropagation();
  button.closest('.guard-card')?.classList.add('answered');
  window.manager.answerGuard(button.dataset.guardId, button.dataset.guardChoice);
});

window.manager.onState((state) => {
  applyTheme(state.theme, state.palette);
  applyCrt(state.crt);
  applyShortcuts(state.shortcuts);
  applyAutostart(state.autostart);
  applyAutoUpdate(state.autoUpdate);
  applyAnnounceUnknown(state.announceWhenFocusUnknown);
  applySound(state.sound);
  renderQuitButton(state.trayAvailable);
  renderUpdateBanner(state.update);
  renderHintBanner(state.hint);
  renderVoiceStatus(state.voiceDownloading);
  renderTrayStatus(state.trayNeedsRelogin);
  renderUsage(state.tokens);
  renderGuardStatus(state.guard);
  renderBadge(state.sessions);
  lastUnreadCount = state.unread;

  sessionsContainer.replaceChildren();
  renderGuardAsks(state.guardAsks ?? []);
  if (!state.sessions.length) {
    sessionsContainer.append(emptyStateElement());
    return;
  }
  state.sessions.forEach((session, index) => {
    sessionsContainer.append(sessionElement(session, index));
  });
  sessionsContainer.append(rescanElement());
});
