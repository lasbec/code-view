import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
let bundle;
export function editorBundle() {
  return bundle ??= build({ entryPoints: [fileURLToPath(new URL('./editor-entry.js', import.meta.url))], bundle: true, write: false, format: 'esm', minify: true, target: 'es2022' }).then(result => result.outputFiles[0].text);
}
