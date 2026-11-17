import {
  configureCodexMcp,
  removeCodexMcp,
  type CodexCommandRunner,
} from '../../../../src/apps/nekosearch/codex-config.js';

interface Registration {
  name: string;
  transport: {
    type: string;
    command?: string;
    args?: unknown[];
  };
}

describe('NekoSearch Codex MCP configuration', () => {
  const serverCommand = {
    command: '/opt/node/bin/node',
    args: ['/opt/nekosearch/dist/apps/nekosearch/cli.js', 'serve'] as [
      string,
      'serve',
    ],
  };

  it('reports a missing Codex CLI without attempting a registration', async () => {
    const missingCodex: CodexCommandRunner = () =>
      Promise.reject(
        Object.assign(new Error('spawn codex ENOENT'), {
          code: 'ENOENT',
        }),
      );

    await expect(
      configureCodexMcp({ serverCommand, runCommand: missingCodex }),
    ).rejects.toThrow(/Codex CLI was not found/u);
  });

  it('adds the absolute executable with serve as its only argument', async () => {
    const { registrations, calls, runCommand } = createCodexRunner();

    await expect(
      configureCodexMcp({ serverCommand, runCommand }),
    ).resolves.toBe('added');
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      [
        'mcp',
        'add',
        'nekosearch',
        '--',
        serverCommand.command,
        ...serverCommand.args,
      ],
    ]);
    expect(registrations).toEqual([
      {
        name: 'nekosearch',
        transport: {
          type: 'stdio',
          command: serverCommand.command,
          args: serverCommand.args,
        },
      },
    ]);
  });

  it('leaves an already matching registration unchanged', async () => {
    const { calls, runCommand } = createCodexRunner([
      stdioRegistration(serverCommand.command, serverCommand.args),
    ]);

    await expect(
      configureCodexMcp({ serverCommand, runCommand }),
    ).resolves.toBe('unchanged');
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });

  it('removes the matching registration through Codex MCP commands', async () => {
    const { registrations, calls, runCommand } = createCodexRunner([
      stdioRegistration(serverCommand.command, serverCommand.args),
    ]);

    await expect(removeCodexMcp({ serverCommand, runCommand })).resolves.toBe(
      'removed',
    );
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'remove', 'nekosearch'],
    ]);
    expect(registrations).toEqual([]);
  });

  it('refuses to remove a same-name registration with different settings', async () => {
    const conflicting = stdioRegistration('/another/node', [
      '/another/cli.js',
      'serve',
    ]);
    const { registrations, calls, runCommand } = createCodexRunner([
      conflicting,
    ]);

    await expect(removeCodexMcp({ serverCommand, runCommand })).rejects.toThrow(
      /refusing to remove a different MCP registration/u,
    );
    expect(calls).toEqual([['mcp', 'list', '--json']]);
    expect(registrations).toEqual([conflicting]);
  });

  it('treats an already absent registration as unchanged', async () => {
    const { calls, runCommand } = createCodexRunner();

    await expect(removeCodexMcp({ serverCommand, runCommand })).resolves.toBe(
      'unchanged',
    );
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });

  it('preserves a conflicting registration unless force is set', async () => {
    const conflicting = stdioRegistration('/another/node', [
      '/another/cli.js',
      'serve',
    ]);
    const { registrations, calls, runCommand } = createCodexRunner([
      conflicting,
    ]);

    await expect(
      configureCodexMcp({ serverCommand, runCommand }),
    ).rejects.toThrow(/pass --force to replace it/u);
    expect(registrations).toEqual([conflicting]);
    expect(calls).toEqual([['mcp', 'list', '--json']]);
  });

  it('replaces a conflicting registration through Codex MCP commands with force', async () => {
    const { registrations, calls, runCommand } = createCodexRunner([
      stdioRegistration('/another/node', ['/another/cli.js', 'serve']),
    ]);

    await expect(
      configureCodexMcp({ serverCommand, force: true, runCommand }),
    ).resolves.toBe('replaced');
    expect(calls).toEqual([
      ['mcp', 'list', '--json'],
      ['mcp', 'remove', 'nekosearch'],
      [
        'mcp',
        'add',
        'nekosearch',
        '--',
        serverCommand.command,
        ...serverCommand.args,
      ],
    ]);
    expect(registrations).toEqual([
      {
        name: 'nekosearch',
        transport: {
          type: 'stdio',
          command: serverCommand.command,
          args: serverCommand.args,
        },
      },
    ]);
  });
});

function stdioRegistration(command: string, args: string[]): Registration {
  return { name: 'nekosearch', transport: { type: 'stdio', command, args } };
}

function createCodexRunner(initial: Registration[] = []): {
  registrations: Registration[];
  calls: string[][];
  runCommand: CodexCommandRunner;
} {
  const registrations = [...initial];
  const calls: string[][] = [];
  const runCommand: CodexCommandRunner = (_command, arguments_) => {
    calls.push(arguments_);
    if (arguments_[0] !== 'mcp') {
      throw new Error(`Unexpected Codex command: ${arguments_.join(' ')}`);
    }
    if (arguments_[1] === 'list') {
      return Promise.resolve({
        stdout: JSON.stringify(registrations),
        stderr: '',
      });
    }
    if (arguments_[1] === 'remove') {
      const index = registrations.findIndex(
        (registration) => registration.name === arguments_[2],
      );
      if (index >= 0) registrations.splice(index, 1);
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    if (arguments_[1] === 'add') {
      const separator = arguments_.indexOf('--');
      registrations.push({
        name: arguments_[2] ?? '',
        transport: {
          type: 'stdio',
          command: arguments_[separator + 1],
          args: arguments_.slice(separator + 2),
        },
      });
      return Promise.resolve({ stdout: '', stderr: '' });
    }
    throw new Error(`Unexpected Codex command: ${arguments_.join(' ')}`);
  };
  return { registrations, calls, runCommand };
}
