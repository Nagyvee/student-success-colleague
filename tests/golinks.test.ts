import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* A tracked link (/go/<token>) behind Caddy: the app is reached on
 * localhost:3200, but the quiz and video it redirects to must be on the
 * public address, or the lead lands on "localhost" and nothing opens. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-go-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) delete process.env[k];
process.env.PUBLIC_BASE_URL = 'https://thuso.example.org';

let route: typeof import('../src/app/go/[token]/route');
let track: typeof import('../src/lib/nurture/track');

before(async () => {
  track = await import('../src/lib/nurture/track');
  route = await import('../src/app/go/[token]/route');
});

test('a quiz or video link redirects to the public address, not to localhost', async () => {
  for (const x of ['quiz', 'video'] as const) {
    const token = track.signTrack({ t: 'default', s: 'src_leads', k: 'nobody@example.com', m: 'msg_test', x });
    const res = await route.GET(new Request(`http://localhost:3200/go/${token}`, { headers: { 'user-agent': 'Mozilla/5.0' } }), { params: Promise.resolve({ token }) });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `https://thuso.example.org/${x === 'quiz' ? 'fit' : 'watch'}/${token}`);
  }
});
