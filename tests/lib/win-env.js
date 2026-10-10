'use strict';
/**
 * Laptop Guardian's protection rules describe WINDOWS locations (C:\Windows, Program Files, the user profile) and read them from the Windows
 * environment variables. The tests of those rules use Windows-style fixture paths, so on any other platform (the Linux CI job) the variables
 * they would normally find are filled in with the usual values. On Windows nothing is touched. Required first by the tests that need it.
 */
if (process.platform !== 'win32') {
  const defaults = {
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    ProgramData: 'C:\\ProgramData', USERPROFILE: 'C:\\Users\\TestUser', LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local', APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
  };
  for (const [k, v] of Object.entries(defaults)) if (!process.env[k]) process.env[k] = v;
}

module.exports = { isWindows: process.platform === 'win32' };
