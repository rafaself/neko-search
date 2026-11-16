#!/usr/bin/env node
import 'reflect-metadata';
import { serve } from './serve.js';

const [command, ...arguments_] = process.argv.slice(2);

if (command === 'serve' && arguments_.length === 0) {
  serve().catch((error: unknown) => {
    process.stderr.write(`nekosearch serve failed: ${formatError(error)}\n`);
    process.exitCode = 1;
  });
} else {
  process.stderr.write(
    command === '--help' || command === '-h' || command === undefined
      ? 'Usage: nekosearch serve\n'
      : `Unknown command: ${command}\nUsage: nekosearch serve\n`,
  );
  if (command !== '--help' && command !== '-h' && command !== undefined)
    process.exitCode = 2;
}

function formatError(error: unknown): string {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}
