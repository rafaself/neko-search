export function isHelpInvocation(
  command: string | undefined,
  arguments_: readonly string[],
): boolean {
  return (
    (command === 'help' && arguments_.length === 0) ||
    command === '--help' ||
    command === '-h' ||
    command === undefined
  );
}

export function renderCliHelp(): string {
  return [
    'NekoSearch',
    'Local, read-only MCP server for documentation snapshots.',
    '',
    'Usage: nekosearch [OPTIONS] <COMMAND> [ARGS]',
    '',
    'Commands:',
    '  add --dir <docs-dir> --id <source@version>',
    '                         Build and install local documentation offline',
    '  add --github <repository-url> --ref <ref> --path <docs-dir>',
    '      --id <source@version>',
    '                         Install documentation from a public GitHub repository',
    '  add --from <snapshot-dir>',
    '                         Install a portable snapshot',
    '  add nestjs@<major>     Install curated NestJS documentation (11 or 12)',
    '  build <docs-dir> --id <source@version> --output <snapshot-dir> [--clean]',
    '                         Build and validate a local SQLite snapshot',
    '  help                   Print this message',
    '  list                   List available documentation snapshots',
    '  mcp configure <provider> Configure NekoSearch with a supported provider CLI',
    '  mcp remove <provider>   Remove the verified NekoSearch registration',
    '  remove <source@version>',
    '                         Remove an installed snapshot',
    '  serve                  Run the MCP server over stdio',
    '  setup                  Configure supported MCP providers and sources',
    '  status [<source@version>] [--check-upstream]',
    '                         Show snapshot status; upstream checks are opt-in',
    '  update nestjs@<major>  Update curated NestJS documentation (11 or 12)',
    '',
    'Options:',
    '  -h, --help             Print help',
    '',
    'Network access:',
    '  add --github fetches supported files over HTTPS and pins the resolved commit.',
    '  add/update nestjs@<major> fetch official documentation over HTTPS.',
    '  status --check-upstream resolves tracked refs without downloading documentation.',
    '  setup uses the network only when installing curated documentation.',
    '  Other commands use local files. serve is stdio-only, offline, and read-only.',
    '  Installed snapshots are validated and stored in the user data directory.',
    '',
  ].join('\n');
}
