import { describe, expect, it } from 'vitest';

import {
  codexManagedEnvironment,
  codexManagedLaunchContext,
} from '../../src/cli/commands/adapters.js';

describe('Codex managed launcher', () => {
  it('passes the app-server URL to every managed child process', () => {
    const input = { PATH: '/test/bin', USER_SETTING: 'preserved' };

    expect(codexManagedEnvironment('ws://127.0.0.1:43210', input)).toEqual({
      PATH: '/test/bin',
      USER_SETTING: 'preserved',
      CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
    });
    expect(input).not.toHaveProperty('CONCORD_CODEX_APP_SERVER_URL');
  });

  it('runs the app-server and TUI from the resolved repository root', () => {
    expect(
      codexManagedLaunchContext('/repos/talking-test', 'ws://127.0.0.1:43210', {
        PATH: '/test/bin',
      }),
    ).toEqual({
      cwd: '/repos/talking-test',
      env: {
        PATH: '/test/bin',
        CONCORD_CODEX_APP_SERVER_URL: 'ws://127.0.0.1:43210',
      },
    });
  });
});
