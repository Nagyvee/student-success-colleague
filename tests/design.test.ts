import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* House rules for how Thuso looks. No sparkle icon (lucide's Sparkles,
 * WandSparkles) and no ✨ anywhere: not in the app, not in an email, not in
 * a message. It reads as "AI-generated", which is the opposite of what the
 * academy wants leads and students to feel. */

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.(tsx?|css|html)$/.test(e.name) ? [p] : [];
  });
}

test('no sparkle icon or ✨ anywhere in the app, its emails or its messages', () => {
  const found: string[] = [];
  for (const f of files(src)) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/Sparkles|WandSparkles|\bsparkles?\b|✨/i.test(line)) found.push(`${path.relative(src, f)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(found, [], `Use another icon:\n${found.join('\n')}`);
});
