/* esbuild driver. MV3 needs one self-contained bundle per entry point: the service
   worker, the isolated-world content script, the MAIN-world content script, and the
   options page. They cannot share a chunk, so splitting stays off. */
import * as esbuild from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: [
    'src/background.ts',
    'src/fill.ts',
    'src/setter.ts',
    'src/options.ts',
  ],
  bundle: true,
  outdir: 'dist',
  target: 'chrome120',
  format: 'iife',
  platform: 'browser',
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

await mkdir('dist', { recursive: true });
await cp('manifest.json', 'dist/manifest.json');
await cp('options.html', 'dist/options.html');

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('watching…');
} else {
  await esbuild.build(options);
}
