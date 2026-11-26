import { test } from 'node:test';
import assert from 'node:assert/strict';

/* What ManyChat answers is read whatever its shape: an error it gives is its
 * error, never "ManyChat did not answer" (which is taken for an outage). */

test('a ManyChat error in any shape is read as what it says, and silence only as silence', async () => {
  const { manychat, reasonsOf } = await import('../src/lib/messaging/manychat');
  const real = globalThis.fetch;
  let reply: () => Response = () => new Response('{}');
  globalThis.fetch = (async () => reply()) as typeof fetch;
  try {
    const mc = manychat('k', 2000);
    const as = (status: number, body: unknown) => { reply = () => new Response(JSON.stringify(body), { status }); };
    as(400, { status: 'error', message: 'Validation error', details: { messages: { subscriber_id: ['The subscriber id field is required.'], data: { message: 'Wrong content' } } } });
    let r = await mc.sendText(1, 'hi');
    assert.equal(r.status, 400);
    assert.equal(r.error, 'Validation error: subscriber_id: The subscriber id field is required.; data: Wrong content');
    as(400, { status: 'error', message: 'Permission denied', details: { messages: [{ message: 'Subscriber does not exist' }] } });
    assert.equal((await mc.sendText(1, 'hi')).error, 'Permission denied: Subscriber does not exist');
    as(400, { status: 'error', details: 'odd' });
    assert.equal((await mc.sendText(1, 'hi')).error, 'ManyChat answered HTTP 400: odd');
    reply = () => new Response('not json', { status: 502 });
    r = await mc.sendText(1, 'hi');
    assert.deepEqual([r.status, r.error], [502, 'ManyChat answered HTTP 502']);
    as(200, { status: 'success', data: { ok: 1 } });
    assert.deepEqual((await mc.sendText(1, 'hi')).data, { ok: 1 });
    reply = () => { throw new TypeError('fetch failed'); };
    r = await mc.sendText(1, 'hi');
    assert.deepEqual([r.status, r.error], [0, 'ManyChat did not answer: fetch failed']);
    assert.deepEqual(reasonsOf({ a: { b: { c: { d: { e: { f: 'too deep' } } } } } }), []);
  } finally {
    globalThis.fetch = real;
  }
});
