import {
  isHelpInvocation,
  renderCliHelp,
} from '../../../../apps/nekosearch/src/cli-help.js';

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

  it('uses a concise command reference with generic provider management', () => {
    const help = renderCliHelp();

    expect(help).toContain('NekoSearch\nLocal, read-only MCP server');
    expect(help).toContain('Usage: nekosearch [OPTIONS] <COMMAND> [ARGS]');
    expect(help).toContain('Commands:');
    expect(help).toContain('Options:');
    expect(help.match(/\bnekosearch\b/gu)).toHaveLength(1);
    expect(help).toContain('  help                   Print this message');
    expect(help).toContain('  add --from <snapshot-dir>');
    expect(help).toContain('  mcp configure <provider>');
    expect(help).toContain('  mcp remove <provider>');
    expect(help).toContain('  model install [--dir <model-dir>]');
    expect(help).toContain('  model status [--dir <model-dir>]');
    expect(help).toContain('  model remove [--dir <model-dir>]');
    expect(help).toContain('  embeddings build [<source@version>]');
    expect(help).toContain('  embeddings enable');
    expect(help).toContain('  embeddings disable');
    expect(help).toContain('  embeddings status [<source@version>]');
    expect(help).toContain('  update nestjs@<major>');
  });

  it('states which operations need network access and keeps serve offline', () => {
    const help = renderCliHelp();

    expect(help).toContain('Network access:');
    expect(help).toContain('add --github fetches supported files over HTTPS');
    expect(help).toContain('status --check-upstream resolves tracked refs');
    expect(help).toContain('model install downloads pinned');
    expect(help).toContain('serve is stdio-only, offline, and read-only.');
  });
});
