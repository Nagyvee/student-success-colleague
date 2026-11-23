/* ManyChat tags Thuso reads or sets (plain text: used by the server and the settings screen). */

/** On every contact Thuso messages: ManyChat passes what they type to Thuso, not to another bot. */
export const LEAD_TAG = 'thuso_lead';
/** They asked WhatsApp to stop. */
export const STOP_TAG = 'thuso_whatsapp_stop';
/** Any tag that says they opted out, whichever bot they said it to. */
export const isStopTag = (t: string) => /^(thuso_whatsapp_stop|opt(ed)?[\s_-]*out)$/i.test(t.trim());
/** In a chat with another bot or a person right now. */
export const isChattingTag = (t: string) => /^(wa\s*-\s*replied|wa_open|wa_reply_ping)$/i.test(t.trim());

/** With another bot (its open question would catch their reply), or handed to a person. Changed in Channels & API. */
export const LEAVE_OUT_DEFAULT = 'meta-ads-2026, application-2026, abigail-returned, ai-human-handoff, ai-qualified';
export const tagList = (v: string | undefined) => (v ?? LEAVE_OUT_DEFAULT).split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);

/** "Stop" (WhatsApp only), "unsubscribe me" (everything), or neither. Only when that is all they wrote. */
export function optOutWords(text: string): 'whatsapp' | 'all' | null {
  const t = text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\b(please|pls|hi|hello|thanks|thank you)\b/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 60) return null;
  if (/^(unsubscribe( me)?|remove me( from (your|the|this) list)?|(do not|don't|dont) contact me( again| anymore)?|stop contacting me)$/.test(t)) return 'all';
  if (/^(stop( all| it| now| this)?|opt ?out|stop (messaging|texting|whatsapping) me|stop (the |these |sending )?(messages|whatsapps)|stop sending( me)?( (the |these )?messages)?|(do not|don't|dont) (message|text|whatsapp) me( again| anymore)?)$/.test(t)) return 'whatsapp';
  return null;
}
