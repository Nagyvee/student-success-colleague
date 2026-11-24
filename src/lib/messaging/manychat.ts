/* ManyChat's API, the parts the WhatsApp follow-ups need.
 *
 * Every call answers { ok, data, error, status } and never throws.
 * ManyChat can find a contact by its system phone or email, or by a text
 * custom field, but not by WhatsApp number: contacts it made itself from a
 * WhatsApp chat have no system phone, so any text field that holds a phone
 * number ("SA Phone") is searched too. */

const BASE = 'https://api.manychat.com';

export interface McReply<T = unknown> { ok: boolean; status: number; data: T | null; error: string }

export interface McContact {
  id: string | number;
  first_name?: string | null;
  phone?: string | null;
  whatsapp_phone?: string | null;
  optin_whatsapp?: boolean | null;
  last_interaction?: string | null;
  last_input_text?: string | null;
  tags?: { name?: string }[];
}

interface McField { id: number; name: string; type?: string }

/** What ManyChat says when it is the account (an unpaid plan, a switched-off or pending channel, no funds, a template
 *  Meta paused), not the one lead. An error about the contact is theirs, whatever else it mentions. */
export function accountTrouble(error: string): boolean {
  if (/subscriber|contact|recipient|opt(ed)?[- ]?(in|out)|24.?hour/i.test(error)) return false;
  return /channel|disabled|turned off|subscription|billing|payment|past due|expired|\bpro\b|\bplan\b|upgrade|balance|wallet|credit|funds|suspend|restrict|pending|template|permission|access token|api key|\bapi\b.*(off|disabled|not)/i.test(error);
}

/** The last nine digits: the same number written +27…, 27… or 0…. */
export const samePhoneKey = (v: string | null | undefined) => String(v || '').replace(/\D/g, '').slice(-9);

export function manychat(apiKey: string, timeoutMs = 10_000) {
  async function call<T = unknown>(method: 'GET' | 'POST', path: string, o: { query?: Record<string, string>; body?: unknown } = {}): Promise<McReply<T>> {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(o.query || {})) url.searchParams.set(k, v);
    try {
      const res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(o.body ? { 'Content-Type': 'application/json' } : {}) },
        ...(o.body ? { body: JSON.stringify(o.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      const j = (await res.json().catch(() => null)) as { status?: string; data?: T; message?: string; details?: { messages?: { message?: string }[] } } | null;
      if (res.ok && j?.status === 'success') return { ok: true, status: res.status, data: j.data ?? null, error: '' };
      const details = (j?.details?.messages || []).map((m) => m?.message).filter(Boolean).join('; ');
      return { ok: false, status: res.status, data: j?.data ?? null, error: [j?.message || `ManyChat answered HTTP ${res.status}`, details].filter(Boolean).join(': ').slice(0, 300) };
    } catch (e) {
      // No answer: we cannot know whether ManyChat did it.
      return { ok: false, status: 0, data: null, error: `ManyChat did not answer: ${(e as Error).message}` };
    }
  }

  const one = (data: unknown): McContact[] => (Array.isArray(data) ? data : data ? [data] : []).filter((c): c is McContact => Boolean(c && (c as McContact).id));

  return {
    pageInfo: () => call<{ id?: number | string; name?: string }>('GET', '/fb/page/getInfo'),
    async flows(): Promise<McReply<{ ns: string; name: string }[]>> {
      const r = await call<{ flows?: { ns: string; name: string }[] } | { ns: string; name: string }[]>('GET', '/fb/page/getFlows');
      const list = Array.isArray(r.data) ? r.data : r.data?.flows || [];
      return { ...r, data: r.ok ? list : null };
    },
    fields: () => call<McField[]>('GET', '/fb/page/getCustomFields'),
    setField: (id: string | number, name: string, value: string) => call('POST', '/fb/subscriber/setCustomFieldByName', { body: { subscriber_id: Number(id), field_name: name, field_value: value } }),
    /** Tags a contact (the tag is made first when ManyChat does not have it). */
    async tag(id: string | number, name: string): Promise<McReply> {
      const add = () => call('POST', '/fb/subscriber/addTagByName', { body: { subscriber_id: Number(id), tag_name: name } });
      const r = await add();
      if (r.ok || !/tag/i.test(r.error)) return r;
      const made = await call('POST', '/fb/page/createTag', { body: { name } });
      return made.ok || /exist/i.test(made.error) ? add() : r;
    },
    /** A typed WhatsApp. Only to someone who wrote in the last 24 hours (WhatsApp refuses it otherwise). */
    sendText: (id: string | number, text: string) => call('POST', '/fb/sending/sendContent', {
      body: { subscriber_id: Number(id), data: { version: 'v2', content: { type: 'whatsapp', messages: [{ type: 'text', text }] } } },
    }),
    info: (id: string | number) => call<McContact>('GET', '/fb/subscriber/getInfo', { query: { subscriber_id: String(id) } }),
    sendFlow: (id: string | number, ns: string) => call('POST', '/fb/sending/sendFlow', { body: { subscriber_id: Number(id), flow_ns: ns } }),

    /** The contact with this WhatsApp number, or null when ManyChat has none. A contact found some other way
     *  (by email) with a different number is someone else's phone: never used. */
    async find(phone: string, email: string, phoneFieldIds: number[]): Promise<{ contact: McContact | null; error: string; status: number }> {
      const want = samePhoneKey(phone);
      const fits = (c: McContact, trusted: boolean) => {
        const has = [c.whatsapp_phone, c.phone].map(samePhoneKey).filter(Boolean);
        return has.length ? has.includes(want) : trusted;
      };
      const bad = (r: McReply) => r.status === 0 || r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500 || accountTrouble(r.error);
      const byPhone = await call('GET', '/fb/subscriber/findBySystemField', { query: { phone } });
      if (bad(byPhone)) return { contact: null, error: byPhone.error, status: byPhone.status };
      let hit = one(byPhone.data).find((c) => fits(c, true));
      for (const id of hit ? [] : phoneFieldIds.slice(0, 2)) {
        for (const value of [phone, phone.replace(/^\+/, ''), phone.replace(/^\+27/, '0')]) {
          const r = await call('GET', '/fb/subscriber/findByCustomField', { query: { field_id: String(id), field_value: value } });
          if (bad(r)) return { contact: null, error: r.error, status: r.status };
          hit = one(r.data).find((c) => fits(c, true));
          if (hit) break;
        }
        if (hit) break;
      }
      if (!hit && email) {
        const r = await call('GET', '/fb/subscriber/findBySystemField', { query: { email } });
        if (bad(r)) return { contact: null, error: r.error, status: r.status };
        hit = one(r.data).find((c) => fits(c, false));
      }
      return { contact: hit || null, error: '', status: 200 };
    },

    /** Adds a WhatsApp contact. Never marked as agreeing to SMS or ManyChat email: they did not. */
    create: (phone: string, firstName: string, lastName: string) => call<McContact>('POST', '/fb/subscriber/createSubscriber', {
      body: { first_name: firstName, last_name: lastName, whatsapp_phone: phone, phone, has_opt_in_sms: false, has_opt_in_email: false },
    }),
  };
}
