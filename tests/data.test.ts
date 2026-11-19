import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysUntil, evalRule, isoDate, matchesAll, parseDate, parseMoney } from '../src/lib/data/conditions';
import { autoMap, liveFields, rowToRecord } from '../src/lib/data/sources';
import type { DataSource } from '../src/lib/types';

test('money in the formats trackers use', () => {
  assert.equal(parseMoney('R 1 500,00'), 1500);
  assert.equal(parseMoney('R1,500.50'), 1500.5);
  assert.equal(parseMoney('2 300'), 2300);
  assert.equal(parseMoney('0'), 0);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('n/a'), null);
});

test('dates: ISO, day-first, month names, sheet serials', () => {
  assert.equal(isoDate(parseDate('2026-11-20')!), '2026-11-20');
  assert.equal(isoDate(parseDate('20/11/2026')!), '2026-11-20');
  assert.equal(isoDate(parseDate('5-1-26')!), '2026-01-05');
  assert.equal(isoDate(parseDate('20 November 2026')!), '2026-11-20');
  assert.equal(isoDate(parseDate('Nov 20, 2026')!), '2026-11-20');
  assert.equal(isoDate(parseDate('46346')!), '2026-11-20');
  assert.equal(parseDate('soon'), null);
});

test('rule conditions, including due-date windows', () => {
  const now = new Date(2026, 10, 16);
  const f = { amount_due: 'R 2 000', due_date: '2026-11-18', status: 'Applied', paid_on: '2026-11-01' };
  assert.equal(evalRule({ mode: 'rule', field: 'amount_due', op: 'gt', value: '0' }, f, now), true);
  assert.equal(evalRule({ mode: 'rule', field: 'status', op: 'eq', value: 'applied' }, f, now), true);
  assert.equal(evalRule({ mode: 'rule', field: 'due_date', op: 'days_until_lte', value: '3' }, f, now), true);
  assert.equal(evalRule({ mode: 'rule', field: 'due_date', op: 'days_until_lte', value: '1' }, f, now), false);
  assert.equal(evalRule({ mode: 'rule', field: 'paid_on', op: 'days_since_gte', value: '14' }, f, now), true);
  assert.equal(evalRule({ mode: 'rule', field: 'missing', op: 'empty' }, f, now), true);
  assert.equal(evalRule({ mode: 'ai', question: 'x' }, f, now), null);
  assert.equal(matchesAll([{ mode: 'rule', field: 'amount_due', op: 'gt', value: '0' }, { mode: 'rule', field: 'status', op: 'eq', value: 'applied' }], f, now), true);
  assert.equal(daysUntil(new Date(2026, 10, 14), now), -2);
});

test('a realistic tracker header row maps itself', () => {
  const headers = ['Student No', 'Name', 'Surname', 'Email Address', 'Cell Number', 'Course', 'Intake', 'Total Fees', 'Paid To Date', 'Outstanding Balance (R)', 'Next Payment Date', 'Account Status'];
  const m = autoMap(headers);
  assert.equal(m.id, 'Student No');
  assert.equal(m.first_name, 'Name');
  assert.equal(m.last_name, 'Surname');
  assert.equal(m.email, 'Email Address');
  assert.equal(m.phone, 'Cell Number');
  assert.equal(m.programme, 'Course');
  assert.equal(m.cohort, 'Intake');
  assert.equal(m.total_fee, 'Total Fees');
  assert.equal(m.amount_paid, 'Paid To Date');
  assert.equal(m.amount_due, 'Outstanding Balance (R)');
  assert.equal(m.due_date, 'Next Payment Date');
  assert.equal(m.payment_status, 'Account Status');
});

test('a tracker row becomes a record with live payment state', () => {
  const headers = ['Student No', 'Name', 'Surname', 'Email Address', 'Cell Number', 'Total Fees', 'Paid To Date', 'Next Payment Date', 'Account Status'];
  const source: DataSource = { id: 's', name: 'Tracker', kind: 'finance', url: 'x', mapping: autoMap(headers), enabled: true, createdAt: 0 };
  const rec = rowToRecord(source, headers, ['MS-104', 'Nigel', 'Dube', 'Nigel@Example.com', '082 555 1234', 'R 42 000', 'R 40 500', '10/11/2026', ''], 0);
  assert.equal(rec.key, 'nigel@example.com');
  assert.equal(rec.name, 'Nigel Dube');
  assert.equal(rec.phone, '+27825551234');
  assert.equal(rec.fields.amount_due, '1500');
  assert.equal(rec.fields.due_date, '2026-11-10');
  const live = liveFields(rec, new Date(2026, 10, 16));
  assert.equal(live.payment_state, 'overdue');
  assert.equal(live.days_overdue, '6');
  assert.equal(live.first_name, 'Nigel');
  assert.match(live.amount_due_display, /^R 1.500,00$/);

  const paid = rowToRecord(source, headers, ['MS-105', 'Ama', 'K', 'ama@example.com', '', '42000', '42000', '10/11/2026', 'Paid in full'], 1);
  assert.equal(liveFields(paid, new Date(2026, 10, 16)).payment_state, 'paid');
  const plan = rowToRecord(source, headers, ['MS-106', 'Bo', 'L', 'bo@example.com', '', '42000', '20000', '10/11/2026', 'Payment arrangement'], 2);
  assert.equal(liveFields(plan, new Date(2026, 10, 16)).payment_state, 'arrangement');
  const soon = rowToRecord(source, headers, ['MS-107', 'Cy', 'M', 'cy@example.com', '', '42000', '41000', '18/11/2026', ''], 3);
  assert.equal(liveFields(soon, new Date(2026, 10, 16)).payment_state, 'due');
});
