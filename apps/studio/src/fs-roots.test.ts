// @vitest-environment node
/**
 * W885 follow-up — the fs-browse shortcuts are a PLATFORM question.
 *
 * The roots used to be the POSIX constant ["/src","/tmp","/srv","/home"], so a
 * Windows user's directory picker offered four directories that cannot exist, and
 * the same list supplies the default path when a client sends none. `platform`
 * and `env` are injectable, so the win32 answer is asserted on this Linux host.
 */
import { describe, expect, it } from 'vitest';
import { fsRoots } from './config.js';

describe('fsRoots', () => {
  it('POSIX: byte-identical to the old constant', () => {
    expect(fsRoots('linux', {})).toEqual(['/src', '/tmp', '/srv', '/home']);
    expect(fsRoots('darwin', {})).toEqual(['/src', '/tmp', '/srv', '/home']);
  });

  // B7-6: the ORDER changed, and it is the user-visible half. `handlers/fs.ts`
  // opens the browser at `roots[0]` when the client sends no `?path=` — which
  // `apps/web/src/ui/fsbrowser.ts` 的 `loadDirs('')` does on every open. The
  // list therefore started every Windows user in the DRIVE ROOT, i.e. the first
  // screen of the picker was Windows/, Program Files/, $Recycle.Bin/. The
  // profile now comes first — the same reason POSIX lists /src and /home.
  // The drive root is kept, just not first.
  it('win32: the user profile first, the drive root kept as a shortcut', () => {
    const roots = fsRoots('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\me' });
    expect(roots).toEqual(['C:\\Users\\me', 'C:\\']);
    expect(roots).not.toContain('/src');
  });

  it('win32: tolerates a missing SystemDrive/USERPROFILE and trailing separators', () => {
    // A blank/absent profile falls back to the drive root rather than an empty
    // list, which would leave `roots[0]` undefined and break the fs default.
    expect(fsRoots('win32', {})).toEqual(['C:\\']);
    expect(fsRoots('win32', { SystemDrive: 'D:\\', USERPROFILE: 'D:\\Users\\me\\' })).toEqual(['D:\\Users\\me', 'D:\\']);
  });

  it('win32: the first root is a usable default path', () => {
    // With no USERPROFILE the drive root IS the answer and stays first.
    expect(fsRoots('win32', { SystemDrive: 'C:' })[0]).toBe('C:\\');
    // With one, the picker opens in the user's own home, not in the drive root.
    expect(fsRoots('win32', { SystemDrive: 'C:', USERPROFILE: 'C:\\Users\\me' })[0]).toBe('C:\\Users\\me');
  });
});
