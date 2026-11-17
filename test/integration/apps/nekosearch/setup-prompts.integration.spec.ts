import { PassThrough, Writable } from 'node:stream';
import type { Key } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import { createSetupPromptApi } from '../../../../src/apps/nekosearch/setup.js';

describe('setup terminal prompts', () => {
  it('prints multiline setup artwork without adding a prompt guide', () => {
    const input = new PassThrough();
    const output = createOutput();
    const prompts = createSetupPromptApi(input, output.stream);
    const banner = String.raw` /\  /\
 \_\/  \

 NekoSearch`;

    prompts.intro(banner);

    expect(output.text()).toBe(`${banner}\n`);
    input.destroy();
    output.stream.destroy();
  });

  it('uses Space to select and unselect multiselect choices', async () => {
    const input = new PassThrough();
    const output = createOutput();
    const prompts = createSetupPromptApi(input, output.stream);
    const options = [{ value: 'nestjs@12', label: 'nestjs@12' }];

    const selected = prompts.multiselect('Choose docs', options);
    press(input, 'down', '\u001b[B');
    press(input, 'space', ' ');
    press(input, 'return', '\r');
    await expect(selected).resolves.toEqual(['nestjs@12']);

    const deselected = prompts.multiselect('Choose docs again', options, [
      'nestjs@12',
    ]);
    press(input, 'down', '\u001b[B');
    press(input, 'space', ' ');
    press(input, 'return', '\r');
    await expect(deselected).resolves.toEqual([]);
    expect(output.text()).toContain('Space: select');
    expect(output.text()).toContain('Space: unselect');
    expect(output.text()).toContain('Backspace: go back');

    input.destroy();
    output.stream.destroy();
  });

  it('maps Backspace to the previous step in selections and review', async () => {
    const input = new PassThrough();
    const output = createOutput();
    const prompts = createSetupPromptApi(input, output.stream);

    const selection = prompts.multiselect('Choose docs', [
      { value: 'nestjs@12', label: 'nestjs@12' },
    ]);
    press(input, 'backspace', '\u007f');
    expect(prompts.isBack(await selection)).toBe(true);

    const review = prompts.confirm('Apply the selected operations?');
    press(input, 'backspace', '\u007f');
    expect(prompts.isBack(await review)).toBe(true);
    expect(output.text()).toContain('Backspace: go back');

    input.destroy();
    output.stream.destroy();
  });

  it('renders the installed and configured check marks beside their names', async () => {
    const input = new PassThrough();
    const output = createOutput();
    const prompts = createSetupPromptApi(input, output.stream);
    const selection = prompts.multiselect('Choose docs and providers', [
      { value: 'nestjs@12', label: 'nestjs@12', hint: '✓', disabled: true },
      { value: 'codex', label: 'Codex', hint: '✓' },
    ]);

    press(input, 'return', '\r');
    await expect(selection).resolves.toEqual([]);
    expect(output.text()).toContain('nestjs@12 (✓)');
    expect(output.text()).toContain('Codex (✓)');

    input.destroy();
    output.stream.destroy();
  });
});

function press(input: PassThrough, name: string, sequence: string): void {
  input.emit('keypress', sequence, { name, sequence } satisfies Key);
}

function createOutput(): { stream: Writable; text: () => string } {
  let rendered = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      rendered += String(chunk);
      callback();
    },
  });
  return {
    stream,
    text: () => stripVTControlCharacters(rendered),
  };
}
