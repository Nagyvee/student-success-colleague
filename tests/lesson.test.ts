import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampWords, cleanIcon, cleanScene, sceneComplete } from '../src/lib/lessonScene';

test('on-screen labels stay short and never end on a dangling word', () => {
  assert.equal(clampWords('First taxi to Sandton', 3), 'First taxi');
  assert.equal(clampWords('Race takes first, all waits for everyone', 6), 'Race takes first, all waits');
  assert.equal(clampWords('Always return', 3), 'Always return');
  assert.equal(clampWords(42, 3), '');
});

test('only known icons get through', () => {
  assert.equal(cleanIcon('Hourglass'), 'hourglass');
  assert.equal(cleanIcon('git branch'), 'git-branch');
  assert.equal(cleanIcon('unicorn'), undefined);
});

test('scenes keep only what their visual draws, within the limits', () => {
  const flow = cleanScene('flow', { nodes: [{ label: 'Fetch the data from the API now', icon: 'cloud' }, { label: 'Parse', icon: 'nope' }, { label: 'Show', icon: 'monitor' }, { nope: 1 }] });
  assert.deepEqual(flow?.nodes?.map((n) => n.label), ['Fetch the data', 'Parse', 'Show']);
  assert.equal(flow?.nodes?.[1].icon, undefined);
  assert.equal(sceneComplete('flow', flow), true);

  const branch = cleanScene('branch', { from: { label: 'Promise', icon: 'hourglass' }, yes: { label: 'Fulfilled', icon: 'check' } });
  assert.equal(sceneComplete('branch', branch), false, 'a branch needs both outcomes');

  const code = cleanScene('code', { highlight: [2, 99, 'x'], caption: 'Return the inner promise or the chain breaks here' });
  assert.deepEqual(code?.highlight, [2]);
  assert.equal(code?.caption, 'Return the inner promise or the chain breaks');

  const cmp = cleanScene('compare', { left: { label: 'Await with no safety net', code: 'a\nb\nc\nd\ne\nf\ng' }, right: { label: 'Wrap it in try and catch' } });
  assert.equal(cmp?.left?.code?.split('\n').length, 5);
  assert.equal(sceneComplete('big', {}), false);
});
