import { getTenantIntegrations } from '@/lib/auth/accounts';
import { DEFAULT_TENANT_ID, currentTenantId } from '@/lib/auth/tenantContext';
import { PROGRAMMES } from '@/lib/lms/sandboxData';

/* The academy's programmes, and which one a lead means.
 *
 * Programmes come from Settings (academy focus: "Software Development, Data
 * Science, Cybersecurity"). A lead's free-text interest ("coding",
 * "data analytics", "hacking") is matched to the nearest one by words, so
 * messages and videos fit without asking the model. */

export function programmeList(tenantId = currentTenantId()): string[] {
  const focus = getTenantIntegrations(tenantId).academyFocus || '';
  const list = focus.split(/[,;\n]+/).map((x) => x.replace(/\s+/g, ' ').trim()).filter((x) => x.length >= 2 && x.length <= 80);
  if (list.length) return [...new Set(list)].slice(0, 12);
  if (tenantId === DEFAULT_TENANT_ID) return Object.values(PROGRAMMES).map((p) => p.name);
  return [];
}

const SYNONYMS: Record<string, string> = {
  coding: 'software', code: 'software', coder: 'software', programming: 'software', programmer: 'software', developer: 'software',
  development: 'software', web: 'software', fullstack: 'software', 'full-stack': 'software', app: 'software', apps: 'software', engineering: 'software',
  analytics: 'data', analyst: 'data', analysis: 'data', science: 'data', scientist: 'data', sql: 'data', python: 'data', bi: 'data',
  cyber: 'security', cybersecurity: 'security', hacking: 'security', hacker: 'security', ethical: 'security', network: 'security', networks: 'security',
  artificial: 'ai', intelligence: 'ai', machine: 'ai', learning: 'ai', ml: 'ai', chatgpt: 'ai',
  design: 'design', ux: 'design', ui: 'design', marketing: 'marketing',
};
const STOP = new Set(['and', 'the', 'with', 'for', 'of', 'in', 'to', 'a', 'an', 'course', 'courses', 'programme', 'program', 'essentials', 'fundamentals', 'diploma', 'certificate']);

function concepts(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9+-]+/)) {
    if (!raw || STOP.has(raw)) continue;
    out.add(SYNONYMS[raw] || raw);
  }
  return out;
}

/** The programme a free-text interest is closest to, or null when nothing matches. */
export function matchProgramme(text: string | undefined, list = programmeList()): string | null {
  const want = concepts(text || '');
  if (!want.size || !list.length) return null;
  let best: { name: string; score: number; extra: number } | null = null;
  for (const name of list) {
    const have = concepts(name);
    let score = 0;
    for (const c of want) if (have.has(c)) score++;
    if (!score) continue;
    const extra = have.size - score;
    if (!best || score > best.score || (score === best.score && extra < best.extra)) best = { name, score, extra };
  }
  return best?.name || null;
}

/** The programme to talk to a lead about: what the quiz said, else their interest. */
export function leadProgramme(fields: Record<string, string>, list = programmeList()): string {
  if (fields.fit_programme) return fields.fit_programme;
  const said = fields.interest || fields.programme || fields.course || '';
  return matchProgramme(said, list) || said.trim();
}
