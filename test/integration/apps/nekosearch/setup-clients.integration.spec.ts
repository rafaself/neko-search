import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureSetupClient,
  inspectSetupClients,
  removeSetupClient,
} from '../../../../src/apps/nekosearch/setup-clients.js';
import {
  buildWindowsCommandLine,
  providerCommandRunner,
  resolveProviderExecutable,
  runProviderCommand,
  type ProviderCommandRunner,
} from '../../../../src/apps/nekosearch/providers/provider-runner.js';
import type { NekosearchStdioCommand } from '../../../../src/apps/nekosearch/mcp-command.js';

const SERVER_COMMAND: NekosearchStdioCommand = {
  command: '/node runtime with spaces/node',
  args: ['/installed package with spaces/dist/nekosearch/cli.js', 'serve'],
};

describe('NekoSearch MCP provider adapters', () => {
  let root: string;
  let home: string;
  let grokHome: string;
  let registrations: Record<string, unknown>[];
  let calls: string[][];
  let runner: ProviderCommandRunner;

  const options = (
    providerRunner: ProviderCommandRunner = runner,
  ): {
    homeDirectory: string;
    environment: NodeJS.ProcessEnv;
    platform: NodeJS.Platform;
    serverCommand: NekosearchStdioCommand;
    providerRunner: ProviderCommandRunner;
  } => ({
    homeDirectory: home,
    environment: { HOME: home, GROK_HOME: grokHome, PATH: '' },
    platform: process.platform,
    serverCommand: SERVER_COMMAND,
    providerRunner,
  });

  const userRegistration = (
    command = SERVER_COMMAND.command,
    origin: string = join(grokHome, 'config.toml'),
  ): Record<string, unknown> => ({
    name: 'nekosearch',
    origin,
    transport: 'stdio',
    command,
    args: SERVER_COMMAND.args,
  });

  beforeEach(() => {
    root = mkdtempSync(
      join(tmpdir(), 'nekosearch provider setup with spaces '),
    );
    home = join(root, 'user home');
    grokHome = join(root, 'grok home');
    mkdirSync(home);
    mkdirSync(grokHome);
    registrations = [];
    calls = [];
    runner = {
      resolve: () => join(root, 'bin with spaces', 'grok'),
      run: (_executable, arguments_) => {
        calls.push(arguments_);
        if (arguments_[0] === 'inspect') {
          return Promise.resolve({
            stdout: JSON.stringify({ mcpServers: registrations }),
            stderr: '',
          });
        }
        if (arguments_[0] === 'mcp' && arguments_[1] === 'add') {
          const separator = arguments_.indexOf('--');
          registrations.push({
            name: arguments_[separator - 1],
            origin: join(grokHome, 'config.toml'),
            transport: 'stdio',
            command: arguments_[separator + 1],
            args: arguments_.slice(separator + 2),
          });
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        if (arguments_[0] === 'mcp' && arguments_[1] === 'remove') {
          registrations = registrations.filter(
            (registration) => registration.name !== arguments_.at(-1),
          );
          return Promise.resolve({ stdout: '', stderr: '' });
        }
        throw new Error(`Unexpected Grok command: ${arguments_.join(' ')}`);
      },
    };
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('omits a missing CLI and rejects direct configuration requests', async () => {
    const missingRunner: ProviderCommandRunner = {
      ...runner,
      resolve: () => undefined,
    };
    await expect(inspectSetupClients(options(missingRunner))).resolves.toEqual(
      [],
    );
    await expect(
      configureSetupClient('grok-build', options(missingRunner)),
    ).rejects.toThrow(/Grok Build CLI was not detected/u);
  });

  it('detects a compatible CLI and reports an available user registration', async () => {
    await expect(inspectSetupClients(options())).resolves.toEqual([
      {
        id: 'grok-build',
        label: 'Grok Build CLI',
        state: 'ready',
        application: 'detected',
        configuration: 'managed',
        registration: 'missing',
        setupMode: 'automatic',
        scope: 'user',
        target: 'Grok Build user MCP registry (managed by `grok mcp`)',
      },
    ]);
    expect(calls).toEqual([['inspect', '--json']]);
  });

  it('adds through the provider CLI with separately passed arguments and leaves identical registrations unchanged', async () => {
    await expect(configureSetupClient('grok-build', options())).resolves.toBe(
      'added',
    );
    expect(calls).toContainEqual([
      'mcp',
      'add',
      '--scope',
      'user',
      'nekosearch',
      '--',
      SERVER_COMMAND.command,
      ...SERVER_COMMAND.args,
    ]);
    expect(registrations).toEqual([
      {
        name: 'nekosearch',
        origin: join(grokHome, 'config.toml'),
        transport: 'stdio',
        command: SERVER_COMMAND.command,
        args: SERVER_COMMAND.args,
      },
    ]);
    await expect(inspectSetupClients(options())).resolves.toMatchObject([
      { state: 'already-configured', registration: 'configured' },
    ]);
    await expect(configureSetupClient('grok-build', options())).resolves.toBe(
      'unchanged',
    );
    expect(calls.filter(([operation]) => operation === 'mcp')).toHaveLength(1);
  });

  it('removes only the verified NekoSearch user registration', async () => {
    registrations = [userRegistration()];
    await expect(removeSetupClient('grok-build', options())).resolves.toBe(
      'removed',
    );
    expect(registrations).toEqual([]);
    expect(calls).toContainEqual([
      'mcp',
      'remove',
      '--scope',
      'user',
      'nekosearch',
    ]);
  });

  it('preserves unrelated user registrations while adding NekoSearch', async () => {
    const other = {
      name: 'existing-server',
      origin: join(grokHome, 'config.toml'),
      transport: 'stdio',
      command: '/other/mcp-server',
      args: ['--keep'],
    };
    registrations = [other];

    await expect(configureSetupClient('grok-build', options())).resolves.toBe(
      'added',
    );

    expect(registrations).toContainEqual(other);
    expect(registrations).toHaveLength(2);
  });

  it.each<[string, () => Record<string, unknown>]>([
    ['different user command', () => userRegistration('/other/nekosearch')],
    [
      'project scope',
      () => userRegistration(SERVER_COMMAND.command, 'project'),
    ],
    [
      'workspace scope',
      () => userRegistration(SERVER_COMMAND.command, 'workspace'),
    ],
    ['plugin scope', () => userRegistration(SERVER_COMMAND.command, 'plugin')],
    [
      'unknown origin',
      () => ({
        name: 'nekosearch',
        transport: 'stdio',
        command: SERVER_COMMAND.command,
        args: SERVER_COMMAND.args,
      }),
    ],
  ])(
    'preserves a same-name external registration (%s)',
    async (_name, createRegistration) => {
      const registration = createRegistration();
      registrations = [registration];
      const status = await inspectSetupClients(options());
      expect(status[0]).toMatchObject({
        state: 'conflict',
        registration:
          registration.origin === undefined ? 'unknown' : 'conflict',
      });
      await expect(
        configureSetupClient('grok-build', options()),
      ).rejects.toThrow(/registration|scope|origin/u);
      await expect(removeSetupClient('grok-build', options())).rejects.toThrow(
        /registration|scope|origin/u,
      );
      expect(registrations).toEqual([registration]);
      expect(calls.every((call) => call[0] === 'inspect')).toBe(true);
    },
  );

  it('fails closed when the CLI output is invalid or does not identify origins', async () => {
    const invalidOutputRunner: ProviderCommandRunner = {
      ...runner,
      run: () =>
        Promise.resolve({
          stdout: JSON.stringify({ servers: [] }),
          stderr: '',
        }),
    };
    await expect(
      inspectSetupClients(options(invalidOutputRunner)),
    ).resolves.toMatchObject([
      { state: 'unsupported', setupMode: 'unsupported' },
    ]);

    registrations = [userRegistration(SERVER_COMMAND.command, 'unrecognized')];
    const unknownOrigin = await inspectSetupClients(options());
    expect(unknownOrigin[0]).toMatchObject({
      state: 'conflict',
      registration: 'unknown',
    });
  });

  it('does not treat a generic user label as an owned Grok config origin', async () => {
    registrations = [userRegistration(SERVER_COMMAND.command, 'user')];

    await expect(inspectSetupClients(options())).resolves.toMatchObject([
      { state: 'conflict', registration: 'unknown' },
    ]);
    await expect(removeSetupClient('grok-build', options())).rejects.toThrow(
      /origin/u,
    );
    expect(registrations).toHaveLength(1);
  });
});

describe('provider CLI runner', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nekosearch cli runner with spaces '));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves executables from PATH, including paths containing spaces', () => {
    const binDirectory = join(root, 'bin directory with spaces');
    mkdirSync(binDirectory);
    const executable = join(binDirectory, 'grok');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o755);
    expect(
      resolveProviderExecutable(
        'grok',
        { PATH: binDirectory },
        process.platform,
      ),
    ).toBe(executable);
  });

  it('runs without a shell and preserves argument boundaries', async () => {
    const script = join(root, 'echo args.mjs');
    writeFileSync(
      script,
      'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
    );
    const result = await providerCommandRunner.run(
      process.execPath,
      [script, 'value with spaces', 'second;argument'],
      { environment: process.env, platform: process.platform, cwd: root },
    );
    expect(JSON.parse(result.stdout)).toEqual([
      'value with spaces',
      'second;argument',
    ]);
  });

  it('enforces timeouts and output limits', async () => {
    await expect(
      runProviderCommand(
        process.execPath,
        ['-e', 'setTimeout(() => {}, 1000)'],
        {
          environment: process.env,
          platform: process.platform,
          timeoutMs: 30,
        },
      ),
    ).rejects.toThrow(/timed out/u);
    await expect(
      runProviderCommand(
        process.execPath,
        ['-e', 'process.stdout.write("too much")'],
        {
          environment: process.env,
          platform: process.platform,
          maxOutputBytes: 2,
        },
      ),
    ).rejects.toThrow(/exceeded 2 bytes/u);
  });

  it('reports provider process failures without treating them as an empty listing', async () => {
    await expect(
      runProviderCommand(
        process.execPath,
        ['-e', 'process.stderr.write("failure detail"); process.exit(7)'],
        { environment: process.env, platform: process.platform },
      ),
    ).rejects.toThrow(/exit code 7: failure detail/u);
  });

  it('resolves Windows command extensions without requiring a shell', () => {
    const binDirectory = join(root, 'windows bin with spaces');
    mkdirSync(binDirectory);
    const executable = join(binDirectory, 'grok.CMD');
    writeFileSync(executable, '@echo off\r\n');
    expect(
      resolveProviderExecutable(
        'grok',
        { PATH: binDirectory, PATHEXT: '.EXE;.CMD' },
        'win32',
      ),
    ).toBe(executable);
  });

  it('quotes Windows batch paths with spaces and rejects shell metacharacters', () => {
    expect(
      buildWindowsCommandLine('C:\\Program Files\\Grok\\grok.cmd', [
        'mcp',
        'add',
        'name with spaces',
      ]),
    ).toBe(
      '""C:\\Program Files\\Grok\\grok.cmd" "mcp" "add" "name with spaces""',
    );
    expect(() =>
      buildWindowsCommandLine('C:\\Grok\\grok.cmd', ['mcp', '& whoami']),
    ).toThrow(/metacharacters/u);
  });
});
