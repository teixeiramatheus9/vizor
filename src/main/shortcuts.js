// Kept free of electron imports on purpose: the decisions are testable here
// and index.js does the globalShortcut wiring.

export const SHORTCUT_ACTIONS = [
  { id: 'panel', label: 'abrir/fechar o painel' },
  { id: 'bubble', label: 'mostrar/esconder a bolha' },
  { id: 'find', label: 'encontrar a bolha' },
  { id: 'chat', label: 'abrir o chat do gerente' },
  { id: 'voiceTalk', label: 'falar com o Vizor (sem dizer o nome)' },
  { id: 'voiceMute', label: 'mudo do microfone' },
];

// Only find ships bound (its combo predates this setting); the rest are off
// until the user picks something — global shortcuts are contested real estate.
export const DEFAULT_SHORTCUTS = {
  panel: '',
  bubble: '',
  find: 'CommandOrControl+Alt+B',
  chat: '',
  voiceTalk: '',
  voiceMute: '',
};

const MODIFIER =
  /^(CommandOrControl|CmdOrCtrl|Command|Cmd|Control|Ctrl|Alt|AltGr|Option|Shift|Super|Meta)$/;
const KEY =
  /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|Up|Down|Left|Right|Space|Tab|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Enter|Return|Esc|Escape|Plus|Minus|[[\]{};:'",.<>/?\\|`~!@#$%^&*()\-=_])$/;

// A bare key would hijack normal typing everywhere, so at least one modifier.
export function isValidAccelerator(accelerator) {
  const parts = String(accelerator ?? '').split('+');
  if (parts.length < 2) return false;
  return parts.slice(0, -1).every((part) => MODIFIER.test(part)) && KEY.test(parts.at(-1));
}

// Merges a change over the current set: only known actions, '' turns one off,
// invalid combos are ignored. A combo can serve one action only — the OS fires
// a single handler per accelerator — so the older holder goes blank.
export function sanitizeShortcuts(partial, current = DEFAULT_SHORTCUTS) {
  const next = { ...DEFAULT_SHORTCUTS, ...current };
  for (const { id } of SHORTCUT_ACTIONS) {
    const value = partial?.[id];
    if (value === '') next[id] = '';
    else if (typeof value === 'string' && isValidAccelerator(value)) {
      for (const { id: other } of SHORTCUT_ACTIONS) {
        if (other !== id && next[other] === value) next[other] = '';
      }
      next[id] = value;
    }
  }
  return next;
}
