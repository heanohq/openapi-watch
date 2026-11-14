#!/usr/bin/env node
// Run the same comparison locally, without GitHub:
//   node bin/openapi-watch.js <spec-url-or-file> <baseline-file> [--diff] [--ignore=description,summary]
// Exits 0 when they match and 1 when they differ.
import { run } from '../src/main.js';

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));

if (positional.length !== 2) {
  console.error('Usage: openapi-watch <spec-url-or-file> <baseline-file> [--diff] [--ignore=keys]');
  process.exit(2);
}

const ignore = flag('ignore')?.split('=')[1] ?? '';
const env = {
  'INPUT_SPEC-URL': positional[0],
  'INPUT_BASELINE-PATH': positional[1],
  INPUT_IGNORE: ignore,
  'INPUT_DRY-RUN': 'true',
};

try {
  const { changed, diff } = await run({ env, log: (m) => console.log(m) });
  if (changed && flag('diff')) console.log(diff);
  process.exitCode = changed ? 1 : 0;
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
