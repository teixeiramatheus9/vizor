// The install relaunches the app, so the phrase has to survive the restart:
// the old version leaves a note and the new one reads it out loud.
export const UPDATE_DONE_PHRASE = 'Pronto, terminei de atualizar! Já tô na versão nova.';

// The same lines for an English voice: what is spoken follows the voice.
export function updateDonePhrase(lang = 'pt') {
  return lang === 'en' ? "Done, I'm updated! Running the new version now." : UPDATE_DONE_PHRASE;
}

export function shouldAnnounce(mark, currentVersion) {
  if (!mark?.version || !currentVersion) return false;
  return mark.version === currentVersion;
}

// Whether the app should apply an update by itself, right now. Auto mode
// (AppImage/NSIS) needs the download finished; notify mode (deb/rpm) installs
// from the available version. A version is only ever tried once — a cancelled
// password prompt flips failed, and retrying it in a loop would harass the
// user with auth dialogs.
export function shouldAutoApply({
  autoUpdate,
  mode,
  available,
  ready,
  installing,
  failed,
  attemptedVersion,
  liveTerminals = 0,
}) {
  // Installing restarts the app, and the workspace terminals live in it: a
  // claude mid-task would die. Wait until none is alive (index.js re-checks
  // when the last one ends).
  if (!autoUpdate || installing || failed || liveTerminals > 0) return false;
  const target = mode === 'auto' ? ready : available;
  return Boolean(target) && attemptedVersion !== target;
}

// The manager narrates the update moments, so a password prompt appearing out
// of nowhere (deb/rpm installs go through pkexec) has a voice explaining it.
// Returns the phrase for the transition between two statuses, or null.
export function updateAnnouncement(previous, next, autoUpdate, lang = 'pt') {
  if (lang === 'en') return englishAnnouncement(previous, next, autoUpdate);
  if (next.failed && !previous.failed)
    return 'Tentei me atualizar e deu ruim — te deixei a página da release aberta.';
  if (next.installing && !previous.installing)
    return `Baixando a versão ${next.ready ?? next.available} pra me atualizar — se aparecer pedido de senha, é só confirmar.`;
  if (next.ready && next.ready !== previous.ready)
    return autoUpdate
      ? `Baixei a versão ${next.ready}. Vou dar um reset rapidinho pra me atualizar!`
      : `Atualização ${next.ready} pronta — clica no banner do painel pra reiniciar.`;
  if (next.available && next.available !== previous.available && next.mode === 'auto')
    return `Saiu a versão ${next.available}! Já comecei a baixar aqui.`;
  return null;
}

function englishAnnouncement(previous, next, autoUpdate) {
  if (next.failed && !previous.failed) return 'I tried to update and it went wrong, I left the release page open for you.';
  if (next.installing && !previous.installing)
    return `Downloading version ${next.ready ?? next.available} to update myself. If a password prompt shows up, just confirm it.`;
  if (next.ready && next.ready !== previous.ready)
    return autoUpdate
      ? `I downloaded version ${next.ready}. I'll restart real quick to update!`
      : `Update ${next.ready} is ready. Click the banner in the panel to restart.`;
  if (next.available && next.available !== previous.available && next.mode === 'auto')
    return `Version ${next.available} is out! I've started downloading it.`;
  return null;
}
