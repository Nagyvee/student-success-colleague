import { currentTenantId } from '@/lib/auth/tenantContext';
import { publicUrl } from '@/lib/engine/store';
import { isDiscordHook } from '@/lib/nurture/qualify';
import { fitLines } from '@/lib/nurture/report';
import { peopleOf, type Company } from './types';
import { settings } from './store';

/* B2B's own Discord channel: the morning's companies, and a card when one is
 * ready for a call. Never the Admissions channel. */

const page = (tenantId: string) => `${publicUrl(tenantId).replace(/\/$/, '')}/outbound`;
// Text from the web never formats our card or pings anyone.
const plain = (t: string, max = 200) => t.replace(/[*_~`|<>[\]()@]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

async function post(body: Record<string, unknown>, tenantId: string): Promise<boolean> {
  const hook = settings(tenantId).discordWebhook;
  if (!isDiscordHook(hook)) return false;
  const res = await fetch(`${hook}?wait=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'Thuso', allowed_mentions: { parse: [] }, ...body }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  return Boolean(res?.ok);
}

const facts = (c: Company) => [c.sector, [c.city, c.province].filter(Boolean).join(', '), peopleOf(c.size) || 'size not known'].filter(Boolean).map((x) => plain(x, 60)).join(' · ');

/** The morning's companies, best first. */
export function listCard(list: Company[], o: { found: number; spent: number; budget: number; note?: string }, tenantId = currentTenantId()) {
  return {
    embeds: [{
      title: `🏢 B2B: ${list.length} ${list.length === 1 ? 'company' : 'companies'} to choose from`,
      url: page(tenantId),
      color: 0x0a1733,
      description: fitLines([
        ...list.map((c, i) => `**${i + 1}. ${plain(c.name, 80)}** · ${c.score}/10 · ${facts(c)}\n${plain(c.fit[0] || c.scoreWhy || c.what, 160)}${c.contact.email ? '' : ' _(no email address yet)_'}`),
      ], 3600) || 'Nobody good enough today.',
      fields: [{ name: 'Choose in Thuso', value: `${page(tenantId)}\nSay yes or no to each. Nothing is sent to a company before that.` }],
      footer: { text: `Looked at ${o.found} today · about $${o.spent.toFixed(2)} of $${o.budget} this month${o.note ? ` · ${o.note}` : ''}` },
    }],
  };
}

export const postList = (list: Company[], o: Parameters<typeof listCard>[1], tenantId = currentTenantId()) => post(listCard(list, o, tenantId), tenantId);

/** "Here is a client I got you." */
export function handoverCard(c: Company, tenantId = currentTenantId()) {
  const s = settings(tenantId);
  const said = [['Need', c.said.need], ['People', c.said.people], ['When', c.said.timing], ['Budget', c.said.budget], ['Decides', c.said.decider]].filter(([, v]) => v).map(([k, v]) => `**${k}:** ${plain(String(v), 160)}`);
  const last = [...c.thread].reverse().find((m) => m.who === 'them');
  return {
    content: `🤝 **A client I got you${s.callsWith ? `, ${plain(s.callsWith, 60)}` : ''}:** ${plain(c.name, 80)} is ready for a call.`,
    embeds: [{
      title: plain(c.name, 120), url: page(tenantId), color: 0xff7300,
      description: [
        `${facts(c)}`, plain(c.what, 240), '',
        ...(said.length ? said : ['They asked to talk.']), '',
        `**Who:** ${plain([c.contact.name, c.contact.role].filter(Boolean).join(', ') || 'see the conversation', 120)}${c.contact.phone ? ` · ${plain(c.contact.phone, 40)}` : ''}`,
        last ? `**Last thing they said:** "${plain(last.text, 300)}"` : '',
        c.summary ? `**In short:** ${plain(c.summary, 240)}` : '',
      ].filter((x, i, all) => x || all[i - 1]).join('\n').slice(0, 3900),
      fields: [{ name: 'Everything about them', value: page(tenantId) }],
    }],
  };
}

export const postHandover = (c: Company, tenantId = currentTenantId()) => post(handoverCard(c, tenantId), tenantId);
export const postNote = (text: string, tenantId = currentTenantId()) => post({ content: text.slice(0, 1900) }, tenantId);
export const postTest = (tenantId = currentTenantId()) => post({ content: '🧪 Test from Thuso: the B2B channel works. Nothing to do.' }, tenantId);
