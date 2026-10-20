import fs from 'node:fs';
import path from 'node:path';

const copies = [
  ['src/onboarding-assets', 'dist/onboarding-assets'],
  ['src/built-ins', 'dist/built-ins'],
  ['src/services/scripts', 'dist/services/scripts'],
  ['../packages/paperclip-runner/dist', 'dist/vendor/paperclip-runner']
];

for (const [src, dst] of copies) {
  if (fs.existsSync(src)) {
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

const fileCopies = [
  '../packages/paperclip-runner/scripts/install-copilot-assets.mjs',
  '../packages/paperclip-runner/scripts/materialize-copilot-binary.mjs',
  '../packages/paperclip-runner/scripts/copilot-inner-distribution.mjs'
];

for (const src of fileCopies) {
  if (fs.existsSync(src)) {
    fs.mkdirSync('dist', { recursive: true });
    fs.copyFileSync(src, path.join('dist', path.basename(src)));
  }
}
