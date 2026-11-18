import { getUserDataDirectory } from '../../../../src/apps/nekosearch/catalog.js';

describe('NekoSearch user data directory', () => {
  it('uses XDG_DATA_HOME when set on Linux and macOS', () => {
    expect(
      getUserDataDirectory(
        { XDG_DATA_HOME: '/data/custom' },
        'linux',
        '/home/tester',
      ),
    ).toBe('/data/custom/nekosearch');
    expect(getUserDataDirectory({}, 'darwin', '/Users/tester')).toBe(
      '/Users/tester/.local/share/nekosearch',
    );
  });

  it('uses LOCALAPPDATA on Windows and follows the existing home fallback', () => {
    expect(
      getUserDataDirectory(
        { LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' },
        'win32',
        'C:\\Users\\tester',
      ),
    ).toBe('C:\\Users\\tester\\AppData\\Local\\nekosearch');
    expect(getUserDataDirectory({}, 'win32', 'C:\\Users\\tester')).toBe(
      'C:\\Users\\tester\\nekosearch',
    );
  });
});
