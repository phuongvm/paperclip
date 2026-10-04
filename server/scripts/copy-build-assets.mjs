import fs from 'node:fs';

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
