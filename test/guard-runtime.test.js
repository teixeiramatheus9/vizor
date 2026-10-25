import { describe, it, expect } from 'vitest';
import { guardCommand } from '../src/main/guard-runtime.js';

const SCRIPT = '/home/u/.config/vizor/guard/rule-guard.js';

describe('guardCommand', () => {
  it('deb/rpm: the installed binary runs it, and it keeps guarding offline', () => {
    expect(guardCommand({ platform: 'linux', execPath: '/opt/Vizor/vizor', appImage: undefined, findNode: () => null, scriptPath: SCRIPT })).toEqual({
      command: `ELECTRON_RUN_AS_NODE=1 "/opt/Vizor/vizor" "${SCRIPT}"`,
      offline: true,
    });
  });

  it('AppImage with node on PATH: node runs it, offline too', () => {
    expect(
      guardCommand({ platform: 'linux', execPath: '/tmp/.mount_x/vizor', appImage: '/home/u/Vizor.AppImage', findNode: () => '/usr/bin/node', scriptPath: SCRIPT }),
    ).toEqual({ command: `"/usr/bin/node" "${SCRIPT}"`, offline: true });
  });

  it('AppImage without node: only while the app runs', () => {
    expect(
      guardCommand({ platform: 'linux', execPath: '/tmp/.mount_x/vizor', appImage: '/home/u/Vizor.AppImage', findNode: () => null, scriptPath: SCRIPT }),
    ).toEqual({ command: `ELECTRON_RUN_AS_NODE=1 "/tmp/.mount_x/vizor" "${SCRIPT}"`, offline: false });
  });

  it('win32 goes through a .cmd shim and is not trusted offline', () => {
    const result = guardCommand({ platform: 'win32', execPath: 'C:\\Vizor\\Vizor.exe', appImage: undefined, findNode: () => null, scriptPath: 'C:\\g\\rule-guard.js', shimDir: 'C:\\cfg' });
    expect(result.offline).toBe(false);
    expect(result.command).toBe('"C:\\cfg\\rule-guard.cmd"');
    expect(result.shim.content).toContain('rule-guard.js');
  });
});
