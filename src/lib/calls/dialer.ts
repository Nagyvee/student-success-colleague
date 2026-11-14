/* The follow-up call, through the academy's dialer.
 *
 * The dialer's AI caller rings the learner, opens with the greeting Thuso
 * writes, keeps it short, and hangs up. The dialer still applies its own
 * rules (AI caller switched on, do-not-call list, calling hours, minutes).
 *
 *   DIALER_URL       e.g. https://dialer.melsoft.org (or http://localhost:3000)
 *   DIALER_API_KEY   a dialer API key with the "Start AI calls" scope */

export function dialerReady() {
  return Boolean(process.env.DIALER_URL && process.env.DIALER_API_KEY);
}

const base = () => String(process.env.DIALER_URL || '').replace(/\/$/, '');
const headers = () => ({ Authorization: `Bearer ${process.env.DIALER_API_KEY}`, 'Content-Type': 'application/json' });

export interface CallRequest { name: string; phone: string; email?: string; greeting: string; instructions: string; maxSeconds?: number }

export async function placeCall(r: CallRequest): Promise<{ ok: true; callId: string } | { ok: false; error: string }> {
  if (!dialerReady()) return { ok: false, error: 'The dialer is not connected (set DIALER_URL and DIALER_API_KEY).' };
  try {
    const res = await fetch(`${base()}/api/v1/ai-calls`, {
      method: 'POST', headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ name: r.name, phone: r.phone, email: r.email, source: 'thuso', greeting: r.greeting, instructions: r.instructions, max_seconds: r.maxSeconds ?? 90 }),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; call_id?: string; error?: string };
    if (!res.ok || !data.ok || !data.call_id) return { ok: false, error: data.error || `The dialer answered HTTP ${res.status}.` };
    return { ok: true, callId: data.call_id };
  } catch (e) {
    return { ok: false, error: `The dialer could not be reached: ${(e as Error).message}` };
  }
}

export interface CallState { state: string; outcome: string | null; duration_seconds: number | null; outcome_notes: string | null }

export async function callStatus(id: string): Promise<CallState | null> {
  if (!dialerReady()) return null;
  try {
    const res = await fetch(`${base()}/api/v1/ai-calls?id=${encodeURIComponent(id)}`, { headers: headers(), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; call?: CallState };
    return data.ok && data.call ? data.call : null;
  } catch { return null; }
}

/** A phone number for a big screen: enough to recognise, not enough to copy. */
export function maskPhone(p: string) {
  const d = p.replace(/[^\d+]/g, '');
  return d.length > 6 ? `${d.slice(0, d.length - 7)} ••• ${d.slice(-4)}` : p;
}
