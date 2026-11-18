import type { AuditVerdict, DepartmentKind, MessageChannel } from '@/lib/types';
import { parseMoney } from '@/lib/data/conditions';

/* The reviewer's rules for anything a department agent sends.
 *
 * Code, not vibes: the same draft always gets the same verdict, whichever
 * model wrote it. The model may rewrite a draft that fails; these rules decide
 * whether the rewrite passes. Nothing reaches a person until it does. */

const LABELS = /\b(at[- ]risk|risk score|flagged|failing|defaulter|delinquent|debtor|bad debt|deadbeat|blacklist(ed)?|non[- ]?payer)\b/i;
const THREATS = /\b(legal action|lawyer|attorney|court|summons|debt collect(or|ion)|credit bureau|itc listing|hand(ed)? over to collections|suspend(ed)?|suspension|expel(led)?|terminate (your|the) (studies|enrol))/i;
const PRESSURE = /\b(act now|last chance|final warning|limited spots? left|only \d+ spots?)\b/i;

export function auditAgentMessage(input: {
  body: string;
  subject: string;
  firstName: string;
  channel: MessageChannel;
  department: DepartmentKind | undefined;
  fields: Record<string, string>;
  /** Saved messages (written and approved once) may explain more than a one-off reply. */
  maxWords?: number;
}): AuditVerdict {
  const notes: string[] = [];
  const { body, subject, firstName } = input;
  const text = `${subject}\n${body}`;
  const words = body.split(/\s+/).filter(Boolean).length;
  const wa = input.channel === 'whatsapp';

  if (firstName && !new RegExp(`\\b${firstName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(body)) {
    notes.push(`It never uses ${firstName}'s name; it reads like a mass mailing.`);
  }
  if (/\{\{[^}]*\}\}|\[(name|first name|amount|date|link)\]/i.test(text)) notes.push('It has a placeholder that was never filled in.');
  if (LABELS.test(text)) notes.push('It labels the person (at risk, failing, debtor...). Describe what happened, never what we call them.');
  if (THREATS.test(text)) notes.push('It threatens (legal action, suspension, collections). Our tone is help first; escalation is a person\'s decision, not an email\'s.');
  if (PRESSURE.test(text)) notes.push('It uses pressure tactics (last chance, act now). Give a reason, not a deadline we invented.');
  if (wa && words > 110) notes.push(`At ${words} words it is too long for WhatsApp; keep it under 100.`);
  const cap = input.maxWords ?? 230;
  if (!wa && words > cap) notes.push(`At ${words} words it is too long; keep emails under ${cap - 30} words.`);
  if (words < 25) notes.push('It is too short to feel personal or useful.');

  if (input.department === 'finance') {
    const amount = parseMoney(input.fields.amount_due);
    if (amount !== null && amount > 0) {
      const digits = Math.round(amount).toString();
      const withSpaces = Math.round(amount).toLocaleString('en-ZA').replace(/\s/g, ' ');
      const mentioned = body.includes(digits) || body.replace(/[\s,  ]/g, '').includes(digits) || body.includes(withSpaces);
      if (!mentioned) notes.push(`It does not state the amount on the account (${input.fields.amount_due_display || amount}). Money messages must be exact.`);
    }
    if (!/arrang|plan|reply|contact|call|help/i.test(body)) notes.push('It does not offer a way to talk to us or arrange payment.');
  }
  if (input.department === 'admissions' && !/apply|application|call|reply|question|chat/i.test(body)) {
    notes.push('It gives the lead no clear next step (apply, reply or book a call).');
  }
  return { pass: notes.length === 0, notes };
}
