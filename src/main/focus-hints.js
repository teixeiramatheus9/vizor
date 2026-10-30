// Windows needs no permission to focus a window, so a miss is either the
// PowerShell layer being unavailable or the terminal hiding its tab titles —
// the one thing the user can turn back on. Same contract as linuxFocusHint:
// null when there is nothing actionable to say.
export function win32FocusHint(result) {
  if (result?.cause === 'powershell-failed') {
    return {
      key: 'powershell',
      title: 'Não consegui falar com o PowerShell',
      body:
        'Uso o PowerShell pra achar a janela do chat e ele não respondeu. ' +
        'Se tiver política de execução travada ou antivírus bloqueando, libera ele pra mim.',
      speech: 'Opa, o PowerShell não respondeu aqui! Sem ele eu não acho a janela do teu chat.',
    };
  }
  // Windows refuses SetForegroundWindow while another app holds focus, so the
  // tab hunt never ran. Nothing was typed (that would have hit the other app).
  if (result?.cause === 'focus-refused') {
    return {
      key: 'focus-refused',
      title: 'O Windows não me deixou trazer o terminal pra frente',
      body:
        'Levantei a janela do chat, mas o Windows manteve o foco em outro app, ' +
        'então parei antes de procurar a aba — teclas ali iriam pro app errado. ' +
        'Clica na janela do terminal e tenta de novo.',
      speech:
        'O Windows não me deixou trazer teu terminal pra frente! Segurei as teclas ' +
        'pra não bagunçar outro app — clica na janela dele e me chama de novo.',
    };
  }
  // A hunt saw every tab of the window and none announced the chat — the
  // fingerprint of a terminal configured to ignore the title the app sets.
  // Only that specific outcome earns this hint: a Wave block that vanished,
  // or a window merely raised with no tab hunt at all, would be misdiagnosed.
  if (result?.focused && !result.tabFound && result.cause === 'no-tab-matched') {
    return {
      key: 'tab-titles',
      title: 'Teu terminal está escondendo o nome das abas',
      body:
        'Achei a janela, mas nenhuma aba diz em qual chat está. No Windows Terminal, ' +
        'desmarca "suppressApplicationTitle" no perfil pra eu ir direto na aba certa.',
      speech:
        'Achei a janela, mas as abas do teu terminal não dizem o nome do chat! ' +
        'Libera o título das abas que eu passo a te levar direto na certa.',
    };
  }
  return null;
}

// Linux has no permission dialog to raise: what breaks focus there is a
// missing tool or a terminal config, and both fail silently. This maps a
// failed focus to the one hint worth showing — null when there is nothing
// actionable to say.
export function linuxFocusHint(result, term, { canInjectInput = true, bridge = 'none' } = {}) {
  // On a Wayland session, GNOME's terminals (GNOME Terminal, Console, Ptyxis)
  // run Wayland-native and never show up to xdotool: the click silently did
  // nothing. Only the Wayland case earns a hint — on plain X11 the same cause
  // just means no terminal window is open, and nagging helps nobody. With an
  // ACTIVE bridge the compositor itself listed the windows, so the terminal
  // really is closed: quiet there too.
  if (result?.cause === 'terminal-not-in-x' && !canInjectInput) {
    if (bridge === 'active') return null;
    if (bridge === 'asleep') {
      return {
        key: 'bridge-asleep',
        title: 'A ponte do GNOME ainda está dormindo',
        body:
          'A ponte está instalada, mas o GNOME só carrega extensão nova quando a ' +
          'sessão reinicia. Sai e entra da sessão (ou reinicia) que eu passo a te ' +
          'levar direto pra aba do chat.',
        speech: 'Instalei a ponte, mas o GNOME só liga ela quando você sair e entrar da sessão!',
      };
    }
    return {
      key: 'wayland-terminal',
      title: 'O Wayland esconde teu terminal de mim',
      body:
        'Nessa sessão Wayland eu não enxergo a janela do teu terminal. Instala a ' +
        '"ponte do GNOME" nas configurações do Vizor que eu volto a te levar direto ' +
        'pra aba certa — a resposta rápida pelo card já funciona mesmo sem ela.',
      speech:
        'O Wayland não me deixa achar teu terminal! Instala a ponte do GNOME nas ' +
        'configurações que eu resolvo isso pra você.',
    };
  }
  if (result?.cause === 'no-x-windows' || result?.cause === 'xdotool-failed') {
    return {
      key: 'xdotool',
      title: 'O gerente precisa do xdotool',
      body:
        'Pra achar a janela do chat eu uso o xdotool e ele não respondeu. ' +
        'Instala com "sudo apt install xdotool" (ou dnf/pacman) e clica de novo.',
      speech: 'Opa, tô sem o xdotool aqui! Instala ele pra mim que aí eu te levo direto pro chat.',
    };
  }
  // kitty only exports KITTY_LISTEN_ON when remote control is on — its
  // presence-without-listener is the fingerprint of the config being off.
  if (!result?.tabFound && term?.KITTY_WINDOW_ID && !term?.KITTY_LISTEN_ON) {
    return {
      key: 'kitty-remote',
      title: 'O kitty está de portas fechadas',
      body:
        'Pra ir direto pra aba certa do kitty, adiciona "allow_remote_control yes" ' +
        'no kitty.conf e reabre o terminal.',
      speech:
        'Teu kitty tá de portas fechadas! Liga o remote control no kitty ponto conf ' +
        'que eu passo a te levar direto pra aba certa.',
    };
  }
  return null;
}

// One hint, three surfaces (issue #62): the balloon shows the actionable body
// (voice is the worst medium for "sudo apt install ..."), the system
// notification mirrors it, and the speech line is spoken by the MAIN process
// only — kind 'hint' tells the renderer to add no speech of its own.
// An English voice says one generic line: the how-to is pt-BR on screen.
const ENGLISH_HINT = 'I need a quick setup tweak from you. The details are on screen.';

export function hintAnnouncement(hint, lang = 'pt') {
  if (!hint) return null;
  return {
    tooltip: { projectName: 'Vizor', text: hint.body, kind: 'hint' },
    notification: { title: hint.title, body: hint.body },
    speech: lang === 'en' ? ENGLISH_HINT : hint.speech,
  };
}
