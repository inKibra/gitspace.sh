#!/usr/bin/env bun

import { createCliRenderer } from '@opentui/core';
import {
  VT_KITTY_KEYBOARD_CONFIG,
  forceDisableKittyKeyboard,
} from '../src/tui/kitty-keyboard.js';

type ProbeResult = {
  label: string;
  useKittyKeyboard: boolean;
  parsedSample: {
    name: string;
    source: string;
    sequence: string;
    raw: string;
  } | null;
};

const SAMPLE_KITTY_BACKSPACE = '\x1b[127;1u';

function visible(value: string): string {
  return JSON.stringify(value)
    .replace(/\\u001b/g, '\\x1b')
    .replace(/\\r/g, '\\x0d')
    .replace(/\\n/g, '\\x0a');
}

async function probe(
  label: string,
  useKittyKeyboard: object | null | undefined,
  applyWorkaround: boolean = false
): Promise<ProbeResult> {
  const renderer = await createCliRenderer({
    useKittyKeyboard,
    useAlternateScreen: false,
    useMouse: false,
    useConsole: false,
    exitOnCtrlC: false,
    targetFps: 1,
  });

  try {
    if (applyWorkaround) {
      forceDisableKittyKeyboard(renderer);
    }

    let parsedSample: ProbeResult['parsedSample'] = null;
    const onKey = (key: { name: string; source: string; sequence: string; raw: string }) => {
      if (!parsedSample) {
        parsedSample = {
          name: key.name,
          source: key.source,
          sequence: key.sequence,
          raw: key.raw,
        };
      }
    };

    renderer.keyInput.on('keypress', onKey);
    (renderer.keyInput as { processInput: (value: string) => boolean }).processInput(SAMPLE_KITTY_BACKSPACE);
    renderer.keyInput.off('keypress', onKey);

    return {
      label,
      useKittyKeyboard: renderer.useKittyKeyboard,
      parsedSample,
    };
  } finally {
    renderer.destroy();
  }
}

const probes: ProbeResult[] = [];
probes.push(await probe('default config (kitty expected)', undefined));
probes.push(await probe('explicit null (vt intent)', null));
probes.push(await probe('workaround path (vt config + forced disable)', VT_KITTY_KEYBOARD_CONFIG, true));

process.stderr.write('\n=== TUI keyboard mode probe ===\n\n');
for (const result of probes) {
  process.stderr.write(`- ${result.label}\n`);
  process.stderr.write(`  renderer.useKittyKeyboard: ${result.useKittyKeyboard}\n`);
  if (result.parsedSample) {
    process.stderr.write(
      `  parsed ${visible(SAMPLE_KITTY_BACKSPACE)} -> name=${result.parsedSample.name || '<empty>'} source=${result.parsedSample.source} sequence=${visible(result.parsedSample.sequence)} raw=${visible(result.parsedSample.raw)}\n`
    );
  } else {
    process.stderr.write(`  parsed ${visible(SAMPLE_KITTY_BACKSPACE)} -> <no key event>\n`);
  }
  process.stderr.write('\n');
}

const workaroundProbe = probes.find((item) => item.label === 'workaround path (vt config + forced disable)');
if (!workaroundProbe) {
  process.stderr.write('Probe failed: missing workaround probe result\n');
  process.exit(1);
}

if (workaroundProbe.useKittyKeyboard) {
  process.stderr.write('FAIL: workaround path still leaves kitty mode enabled.\n');
  process.exit(1);
}

const nullProbe = probes.find((item) => item.label === 'explicit null (vt intent)');
if (nullProbe?.useKittyKeyboard) {
  process.stderr.write('NOTE: upstream null path still enables kitty mode (known OpenTUI behavior).\n');
}

process.stderr.write('PASS: workaround path disables kitty mode as expected.\n');
