import {
  isHelpInvocation,
  renderCliHelp,
} from '../../../../src/apps/nekosearch/cli-help.js';

describe('nekosearch CLI help', () => {
  it.each([
    ['help', [], true],
    ['--help', [], true],
    ['-h', [], true],
    [undefined, [], true],
    ['help', ['status'], false],
    ['list', ['--help'], false],
  ] as const)(
    'recognizes the supported help invocation: %s %s',
    (command, arguments_, expected) => {
      expect(isHelpInvocation(command, arguments_)).toBe(expected);
    },
  );

  it('uses a concise Codex-style command reference', () => {
    const help = renderCliHelp();

    expect(help).toContain('NekoSearch\nLocal, read-only MCP server');
    expect(help).toContain('Usage: nekosearch [OPTIONS] <COMMAND> [ARGS]');
    expect(help).toContain('Commands:');
    expect(help).toContain('Options:');
    expect(help.match(/\bnekosearch\b/gu)).toHaveLength(1);
    expect(help).toContain('  help                   Print this message');
    expect(help).toContain('  add --from <snapshot-dir>');
    expect(help).toContain('  update nestjs@<major>');
  });

  it('states which operations need network access and keeps serve offline', () => {
    const help = renderCliHelp();

    expect(help).toContain('Network access:');
    expect(help).toContain('add --github fetches supported files over HTTPS');
    expect(help).toContain('status --check-upstream resolves tracked refs');
    expect(help).toContain('serve is stdio-only, offline, and read-only.');
  });
});
