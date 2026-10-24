import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, shell } from 'electron';
import electronUpdaterPackage from 'electron-updater';
import { isNewerVersion } from './version-utils.js';
import { pickPackageAsset } from './update-assets.js';
import { elevationCommand, hasNoNewPrivs, hasSystemdRun } from './privileged-exec.js';

const execFileAsync = promisify(execFile);

const RELEASES_LATEST_API =
  'https://api.github.com/repos/teixeiramatheus9/vizor/releases/latest';
export const RELEASES_PAGE = 'https://github.com/teixeiramatheus9/vizor/releases/latest';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

async function detectInstalledFormat() {
  if (process.platform === 'darwin') return 'dmg';
  try {
    await execFileAsync('dpkg', ['-s', 'vizor']);
    return 'deb';
  } catch {
    // not a deb install
  }
  try {
    await execFileAsync('rpm', ['-q', 'vizor']);
    return 'rpm';
  } catch {
    return null;
  }
}

// macOS: mount the downloaded dmg, swap the .app in /Applications, strip the
// quarantine flag (unsigned build) and relaunch — fully automatic.
async function installDmg(dmgFile) {
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), 'vizor-update-'));
  await execFileAsync('hdiutil', ['attach', dmgFile, '-nobrowse', '-mountpoint', mountPoint]);
  try {
    const appName = fs.readdirSync(mountPoint).find((entry) => entry.endsWith('.app'));
    if (!appName) throw new Error('no .app inside the dmg');
    const targetApp = path.join('/Applications', appName);
    await execFileAsync('rm', ['-rf', targetApp]);
    await execFileAsync('ditto', [path.join(mountPoint, appName), targetApp]);
    await execFileAsync('xattr', ['-dr', 'com.apple.quarantine', targetApp]).catch(() => {});
  } finally {
    await execFileAsync('hdiutil', ['detach', mountPoint, '-force']).catch(() => {});
  }
}

// Hybrid updates:
// - AppImage: true auto-update via electron-updater (swap-on-restart).
// - deb/rpm: downloads the matching package and installs it via pkexec
//   (native auth prompt), then relaunches — no manual uninstall/reinstall.
// - dmg/unknown: opens the latest release page.
// - dev (not packaged): disabled.
// beforeExit: the deb/rpm relaunch uses app.exit, which skips before-quit —
// whatever must be saved on quit is saved here instead.
export function setupUpdater({ onStatus, log, fetchFn = fetch, beforeExit = () => {} }) {
  // checkFailed: the last check could not reach the releases — the settings
  // button must say so instead of "already on the latest" (#55).
  const status = { mode: 'off', available: null, ready: null, installing: false, failed: false, checkFailed: false };
  const notify = () => onStatus({ ...status });

  if (!app.isPackaged) {
    return { status: () => ({ ...status }), apply: () => {}, check: async () => ({ ...status }) };
  }

  // NSIS installs get true electron-updater auto-update, same as AppImage.
  if (process.env.APPIMAGE || process.platform === 'win32') {
    status.mode = 'auto';
    const { autoUpdater } = electronUpdaterPackage;
    autoUpdater.autoDownload = true;
    autoUpdater.logger = null;
    autoUpdater.on('update-available', (info) => {
      status.available = info.version;
      notify();
    });
    autoUpdater.on('update-downloaded', (info) => {
      status.ready = info.version;
      notify();
    });
    autoUpdater.on('error', (error) => log(`updater: ${error}`));
    const check = async () => {
      try {
        await autoUpdater.checkForUpdates();
        status.checkFailed = false;
      } catch (error) {
        status.checkFailed = true;
        log(`updater check: ${error}`);
      }
      return { ...status };
    };
    check();
    setInterval(check, CHECK_INTERVAL_MS);
    return {
      status: () => ({ ...status }),
      check,
      apply: () => {
        if (status.ready) autoUpdater.quitAndInstall();
      },
    };
  }

  status.mode = 'notify';

  const fetchLatestRelease = async () => {
    const response = await fetchFn(RELEASES_LATEST_API, {
      headers: { accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`releases/latest -> ${response.status}`);
    return response.json();
  };

  const check = async () => {
    try {
      const release = await fetchLatestRelease();
      const latest = String(release.tag_name ?? '').replace(/^v/, '');
      status.checkFailed = false;
      if (latest && isNewerVersion(latest, app.getVersion())) {
        status.available = latest;
        notify();
      }
    } catch (error) {
      status.checkFailed = true;
      log(`update check failed: ${error}`);
    }
    return { ...status };
  };
  check();
  setInterval(check, CHECK_INTERVAL_MS);

  const installPackage = async () => {
    const format = await detectInstalledFormat();
    if (!format) {
      shell.openExternal(RELEASES_PAGE);
      return;
    }
    const release = await fetchLatestRelease();
    const asset = pickPackageAsset(release.assets, format, process.arch);
    if (!asset?.browser_download_url) {
      shell.openExternal(RELEASES_PAGE);
      return;
    }
    log(`updater: downloading ${asset.name}…`);
    const response = await fetchFn(asset.browser_download_url);
    if (!response.ok) throw new Error(`asset download -> ${response.status}`);
    const packageFile = path.join(os.tmpdir(), asset.name);
    fs.writeFileSync(packageFile, Buffer.from(await response.arrayBuffer()));
    if (format === 'dmg') {
      log('updater: installing dmg…');
      await installDmg(packageFile);
    } else {
      const installArgs =
        format === 'deb'
          ? ['apt-get', 'install', '-y', packageFile]
          : fs.existsSync('/usr/bin/dnf')
            ? ['dnf', 'install', '-y', packageFile]
            : ['rpm', '-U', packageFile];
      const elevated = elevationCommand({
        file: 'pkexec',
        args: installArgs,
        platform: process.platform,
        noNewPrivs: hasNoNewPrivs(),
        hasSystemdRun: hasSystemdRun(),
      });
      log(`updater: installing via ${elevated.file} ${installArgs[0]}…`);
      await execFileAsync(elevated.file, elevated.args, { timeout: INSTALL_TIMEOUT_MS });
    }
    log('updater: installed, relaunching');
    beforeExit();
    app.relaunch();
    app.exit(0);
  };

  return {
    status: () => ({ ...status }),
    check,
    apply: async () => {
      if (!status.available || status.installing) return;
      status.installing = true;
      status.failed = false;
      notify();
      try {
        await installPackage();
      } catch (error) {
        // user cancelled the auth prompt or something broke — say so in the
        // banner (it used to fail silently) and hand over the release page
        log(`self-install failed: ${error}`);
        status.failed = true;
        shell.openExternal(RELEASES_PAGE);
      } finally {
        status.installing = false;
        notify();
      }
    },
  };
}
