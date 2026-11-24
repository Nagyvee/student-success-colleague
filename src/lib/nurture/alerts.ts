import { currentTenantId } from '@/lib/auth/tenantContext';
import { getTenantIntegrations } from '@/lib/auth/accounts';
import { KINDS, markTold, untold, type Problem } from '@/lib/engine/problems';
import { discordWebhook, isDiscordHook } from './qualify';
import { whatsappDay } from './whatsapp';

/* Something critical broke: the team hears at once, in Discord, instead of at
 * 17:00. One message when it breaks, one when it works again, nobody pinged.
 * Off until it is switched on (Channels & API → Qualified leads). */

const when = (t: number) => new Date(t).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

const busy = new Set<string>();

/** The message about one problem. Pure. */
export function alertCard(p: Problem, waiting = 0): { title: string; description: string; color: number } {
  const k = KINDS[p.key];
  if (p.fixedAt) return { title: `✅ Working again: ${k.was}`, description: `From **${when(p.firstAt)}** to **${when(p.fixedAt)}**.${p.people.length ? ` Not reached: ${p.people.slice(0, 8).join(', ')}${p.people.length > 8 ? ` and ${p.people.length - 8} more` : ''}.` : ''}`, color: 0x12805c };
  return {
    title: `🚨 Critical: ${k.what}`,
    description: [
      `Since **${when(p.firstAt)}**.`,
      `Why: ${p.why}${/[.!?]$/.test(p.why) ? '' : '.'}`,
      p.people.length ? `Not reached: ${p.people.slice(0, 8).join(', ')}${p.people.length > 8 ? ` and ${p.people.length - 8} more` : ''}.` : '',
      waiting ? `${waiting} lead${waiting === 1 ? ' is' : 's are'} waiting for one.` : '',
      `**What to do:** ${k.fix}`,
    ].filter(Boolean).join('\n'),
    color: 0xd92d20,
  };
}

/** Called once a minute by the always-on pump. Returns how many messages went. */
export async function alertProblems(tenantId = currentTenantId(), now = Date.now()): Promise<number> {
  if (getTenantIntegrations(tenantId).handoff?.alertsOn !== true || busy.has(tenantId)) return 0;
  const hook = discordWebhook(tenantId);
  if (!isDiscordHook(hook)) return 0;
  const { broke, fixed } = untold(tenantId, now);
  let n = 0;
  busy.add(tenantId);
  try {
    for (const p of [...broke, ...fixed]) {
      const waiting = p.key === 'whatsapp' && !p.fixedAt ? whatsappDay(now, now, tenantId, now).waiting : 0;
      const res = await fetch(`${hook}?wait=true`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Thuso', allowed_mentions: { parse: [] }, embeds: [{ ...alertCard(p, waiting), timestamp: new Date(now).toISOString() }] }),
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      // Not posted: next minute.
      if (!res?.ok) break;
      markTold(p, tenantId, now);
      n++;
    }
  } finally {
    busy.delete(tenantId);
  }
  return n;
}
