// Lets `node --test` run the TypeScript sources directly: resolves the "@/"
// path alias to src/ and extensionless relative imports to .ts/.tsx files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const tryFile = (p) => {
  for (const ext of ['', '.ts', '.tsx', '/index.ts']) {
    const f = p + ext;
    if (fs.existsSync(f) && fs.statSync(f).isFile()) return f;
  }
  return null;
};

export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const f = tryFile(path.join(root, specifier.slice(2)));
    if (f) return next(pathToFileURL(f).href, context);
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:') && !path.extname(specifier)) {
    const f = tryFile(fileURLToPath(new URL(specifier, context.parentURL)));
    if (f) return next(pathToFileURL(f).href, context);
  }
  // Next's entry points ("next/server") are plain files without an exports map: give Node the .js.
  if (specifier === 'next/server' || specifier === 'next/headers') return next(`${specifier}.js`, context);
  return next(specifier, context);
}
