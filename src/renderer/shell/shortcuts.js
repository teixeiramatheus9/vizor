// Keyboard shortcuts of the window. The rule: Ctrl+digit works everywhere (it
// is caught before xterm, like Ctrl+K); bare digits and "?" never fire with the
// terminal or a text field focused, so they cannot steal what is being typed.
import { escapeHtml } from '../workspace-view.js';

export const SHORTCUTS = [
  { keys: 'Ctrl+1 … 4', label: 'Workspace, Agentes, GitHub, Automações' },
  { keys: '1 … 4', label: 'abas da revisão (Resumo, Mudanças, Impacto, Ao vivo)' },
  { keys: 'Ctrl+K', label: 'barra de comandos' },
  { keys: 'Ctrl+`', label: 'abrir e fechar o terminal' },
  { keys: 'Ctrl+Shift+E', label: 'recolher o inspetor' },
  { keys: '?', label: 'esta lista' },
];

// → { top: 1..4 } | { inner: 1..4 } | { help: true } | null
export function keyAction(event, { focusInTerminal = false, focusInField = false, composing = false } = {}) {
  if (composing || event.altKey) return null;
  const mod = event.ctrlKey || event.metaKey;
  if (mod) {
    if (event.shiftKey) return null;
    return /^[1-4]$/.test(event.key) ? { top: Number(event.key) } : null;
  }
  if (focusInTerminal || focusInField) return null;
  if (event.key === '?') return { help: true };
  if (event.shiftKey) return null;
  return /^[1-4]$/.test(event.key) ? { inner: Number(event.key) } : null;
}

export function renderShortcuts() {
  return `<h2>Atalhos</h2><dl>${SHORTCUTS.map((item) => `<dt><kbd>${escapeHtml(item.keys)}</kbd></dt><dd>${escapeHtml(item.label)}</dd>`).join('')}</dl>`;
}
