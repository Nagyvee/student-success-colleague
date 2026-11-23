import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* The voice of the videos: served the way iPhones ask for it, and a provider
 * that refuses is noticed. */

process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-voice-')));
for (const k of ['DEEPGRAM_KEY', 'DG_API_KEY', 'ELEVENLABS_API_KEY', 'OPENAI_API_KEY', 'TTS_PROVIDER']) delete process.env[k];
process.env.DEEPGRAM_API_KEY = 'test';

test('sound is served in the pieces a phone asks for', async () => {
  const { serveMedia } = await import('../src/lib/media/serve');
  const data = Buffer.from(Array.from({ length: 100 }, (_, i) => i));
  const ask = (range?: string) => serveMedia(new Request('http://x/a', { headers: range ? { range } : {} }), data, { 'Content-Type': 'audio/mpeg' });
  const whole = ask();
  assert.equal(whole.status, 200);
  assert.equal(whole.headers.get('accept-ranges'), 'bytes');
  assert.equal((await whole.arrayBuffer()).byteLength, 100);
  // What an iPhone asks first.
  const two = ask('bytes=0-1');
  assert.equal(two.status, 206);
  assert.equal(two.headers.get('content-range'), 'bytes 0-1/100');
  assert.equal(two.headers.get('content-length'), '2');
  assert.deepEqual([...new Uint8Array(await two.arrayBuffer())], [0, 1]);
  assert.equal(ask('bytes=90-').headers.get('content-range'), 'bytes 90-99/100');
  assert.equal(ask('bytes=-10').headers.get('content-range'), 'bytes 90-99/100');
  assert.equal(ask('bytes=50-500').headers.get('content-range'), 'bytes 50-99/100');
  assert.equal(ask('bytes=200-').status, 416);
  assert.equal(ask('nonsense').status, 200);
});

test('a provider that refuses is noticed, and forgotten once it works again', async () => {
  const { slideAudio, voiceError, voiceReady } = await import('../src/lib/media/tts');
  const real = globalThis.fetch;
  let answer = 402;
  globalThis.fetch = (async () => (answer === 200 ? new Response(new Uint8Array(2000)) : new Response('{}', { status: answer }))) as typeof fetch;
  try {
    assert.equal(voiceReady(), true);
    assert.equal(await slideAudio('default', 'v1', 0, 'Hello there.'), null);
    assert.equal(voiceReady(), false);
    assert.match(voiceError(), /402/);
    answer = 200;
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await slideAudio('default', 'v1', 0, 'Hello there.'))?.length, 2000);
    assert.equal(voiceReady(), true);
    assert.equal(voiceError(), '');
  } finally { globalThis.fetch = real; }
});
