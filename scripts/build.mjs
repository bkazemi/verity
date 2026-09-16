import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });

execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], {
  stdio: 'inherit',
});

await build({
  entryPoints: ['src/browser.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Verity',
  platform: 'browser',
  outfile: 'dist/verity.js',
});
