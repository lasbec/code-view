import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

export async function buildBrowser(overrides = {}) {
  const base = fileURLToPath(new URL('.', import.meta.url));
  const runtime = (await readFile(new URL('./src/runtime.mjs', import.meta.url), 'utf8')).trim();
  const source = runtime.slice(runtime.indexOf('export function')).replace(/^export /, '');
  return build({
    entryPoints: [path.join(base, 'src/index.mjs')], bundle: true, platform: 'browser',
    format: 'esm', external: ['fs', 'path', 'crypto', 'node:*'],
    outfile: path.join(base, 'dist/treemap.js'),
    plugins: [{ name: 'stable-snippet-runtime', setup(builder) {
      // Preserve the exact inline renderer text across Node and browser bundles.
      builder.onLoad({ filter: /[/\\]render\.mjs$/ }, async args => ({
        contents: (await readFile(args.path, 'utf8')).replace('mountTreeMap.toString()', JSON.stringify(source)),
        loader: 'js', resolveDir: path.dirname(args.path),
      }));
    } }], ...overrides,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await buildBrowser();
