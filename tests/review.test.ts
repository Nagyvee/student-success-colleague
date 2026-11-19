import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditAgentMessage } from '../src/lib/engine/agentAudit';
import { sanitizeSteps, sanitizeTrigger } from '../src/lib/engine/stepSchema';

const fields = { amount_due: '1500', amount_due_display: 'R 1 500,00' };
const ok = 'Hi Nigel,\n\nThis is a friendly note from the finance team about R1 500 on your account, which was due on 10 November.\n\nIf you have already paid, thank you; please reply with the proof of payment. If now is difficult, reply and we will set up a payment arrangement that works for you.\n\nWarm regards,\nRefilwe';

test('the reviewer passes a respectful, exact finance message', () => {
  const v = auditAgentMessage({ body: ok, subject: 'Your account', firstName: 'Nigel', channel: 'email', department: 'finance', fields });
  assert.deepEqual(v.notes, []);
  assert.equal(v.pass, true);
});

test('the reviewer catches labels, threats, missing amounts and placeholders', () => {
  const threat = ok.replace('If now is difficult', 'As a debtor, failure to pay will result in legal action. If now is difficult');
  const v1 = auditAgentMessage({ body: threat, subject: 'Final notice', firstName: 'Nigel', channel: 'email', department: 'finance', fields });
  assert.equal(v1.pass, false);
  assert.ok(v1.notes.some((n) => /labels/.test(n)));
  assert.ok(v1.notes.some((n) => /threatens/.test(n)));

  const noAmount = ok.replace('R1 500', 'the balance');
  assert.ok(auditAgentMessage({ body: noAmount, subject: 's', firstName: 'Nigel', channel: 'email', department: 'finance', fields }).notes.some((n) => /amount/.test(n)));

  const noName = ok.replace('Hi Nigel', 'Hi there');
  assert.ok(auditAgentMessage({ body: noName, subject: 's', firstName: 'Nigel', channel: 'email', department: 'finance', fields }).notes.some((n) => /name/.test(n)));

  const placeholder = `${ok}\n{{first_name}}`;
  assert.ok(auditAgentMessage({ body: placeholder, subject: 's', firstName: 'Nigel', channel: 'email', department: 'finance', fields }).notes.some((n) => /placeholder/.test(n)));
});

test('the reviewer keeps WhatsApp short and leads pointed at a next step', () => {
  const long = `Hi Thandi, ${'word '.repeat(130)}`;
  assert.ok(auditAgentMessage({ body: long, subject: '', firstName: 'Thandi', channel: 'whatsapp', department: 'admissions', fields: {} }).notes.some((n) => /WhatsApp/.test(n)));
  const noStep = 'Hi Thandi, thank you for your interest in Data Analytics. It is a great programme taught live by people who work in the field, with plenty of support along the way for everyone who joins us.';
  assert.ok(auditAgentMessage({ body: noStep, subject: '', firstName: 'Thandi', channel: 'email', department: 'admissions', fields: {} }).notes.some((n) => /next step/.test(n)));
});

test('saved workflows are cleaned: unknown kinds dropped, numbers clamped, branches kept', () => {
  const steps = sanitizeSteps([
    { id: 'a', kind: 'ai_message', title: 'Hello', channel: 'sms', instructions: 'x' },
    { id: 'b', kind: 'teleport', title: 'nope' },
    { id: 'c', kind: 'ai_lesson', questionCount: 99, passMark: 5 },
    { id: 'd', kind: 'condition', condition: { mode: 'rule', field: 'Payment State', op: 'eq', value: 'paid' }, yes: [{ id: 'e', kind: 'stop' }], no: [{ id: 'a', kind: 'wait', hours: -3 }] },
    { kind: 'repeat', hours: 72, maxTimes: 100, steps: [{ kind: 'ai_message' }] },
  ]);
  assert.deepEqual(steps.map((s) => s.kind), ['ai_message', 'ai_lesson', 'condition', 'repeat']);
  assert.equal(steps[0].channel, 'email');
  assert.equal(steps[0].review, true);
  assert.equal(steps[1].questionCount, 15);
  assert.equal(steps[1].passMark, 30);
  assert.equal(steps[2].condition?.field, 'payment_state');
  assert.equal(steps[2].yes?.[0].kind, 'stop');
  assert.notEqual(steps[2].no?.[0].id, 'a', 'duplicate ids are replaced');
  assert.equal(steps[2].no?.[0].hours, 0.05);
  assert.equal(steps[3].maxTimes, 20);
  assert.equal(steps[3].steps?.length, 1);

  const t = sanitizeTrigger({ kind: 'record.match', sourceId: 'src_tracker', match: [{ mode: 'rule', field: 'payment_state', op: 'eq', value: 'overdue' }, { mode: 'ai', question: 'no AI in filters' }], schedule: { every: 'week', hour: 30 } });
  assert.equal(t.match?.length, 1);
  assert.deepEqual(t.schedule, { every: 'week', hour: 23, weekday: 1 });
  assert.equal(sanitizeTrigger({ kind: 'bogus' }).kind, 'manual');
});
