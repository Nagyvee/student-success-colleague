/* Where a lead came from, the way the sales team says it. Pure.
 *
 * Read from what the lead carries, the surest first: the ad platform (Meta
 * writes fb or ig on every row), the tab their row is on, what the dialer
 * recorded for a lead the team moved to nurturing, then the list's own source
 * column. Nothing is guessed: a lead that carries none of it is "Not
 * recorded", and "Meta ads" is said when it is Meta but not which of the two. */

export const UNKNOWN_CHANNEL = 'Not recorded';

const word = (s: string) => new RegExp(`(^|[^a-z])(?:${s})([^a-z]|$)`, 'i');
const FB = word('fb|facebook');
const IG = word('ig|insta|instagram');

/** The channel a name stands for ("B2C Meta Ads", "ig", "WhatsApp Leads"), or ''. */
export function channelOf(text: string | undefined): string {
  const t = String(text || '').trim();
  if (!t) return '';
  if (/whats\s*app/i.test(t) || word('wa').test(t)) return 'WhatsApp';
  if (/tik\s*tok/i.test(t)) return 'TikTok';
  if (FB.test(t) && IG.test(t)) return 'Meta ads';
  if (FB.test(t)) return 'Facebook ads';
  if (IG.test(t)) return 'Instagram ads';
  if (word('meta|messenger|audience_network').test(t)) return 'Meta ads';
  if (/linked\s*in/i.test(t)) return 'LinkedIn';
  if (/^google$|google\s*(ads?|search)/i.test(t)) return 'Google';
  if (/you\s*tube/i.test(t)) return 'YouTube';
  if (/openclaw|social/i.test(t)) return 'Social media';
  if (/incomplete/i.test(t)) return 'Website form (not finished)';
  if (/web\s*site|web\s*form/i.test(t) || /^applications?$/i.test(t)) return 'Website form';
  if (/referr|word of mouth/i.test(t)) return 'Referral';
  if (/walk\s*-?\s*in/i.test(t)) return 'Walk-in';
  return '';
}

// How the dialer keeps a lead that came in by hand, and names that say nothing about where they came from.
// ("direct" is what the application form writes for someone who came to the website by themselves.)
const SAID: Record<string, string> = { direct: 'Website form', manual: 'Added by hand', import: 'Imported from a file', quiz: 'Quiz' };
const EMPTY = /^(pipeline|thuso|api|google sheet|not recorded|preview.*)$/i;

/** Where a lead came from ("Instagram ads", "TikTok", "Website form"), or "Not recorded". */
export function leadChannel(f: Record<string, string>): string {
  const get = (k: string) => (f[`agent_${k}`] || f[k] || '').trim();
  const fromTeam = get('dialer_kind') === 'lead';
  // Thuso used to write "Website form" in the dialer for anyone it could not place: that is no record of it.
  const detail = /^thuso qualified/i.test(get('dialer_source_detail')) ? '' : get('dialer_source_detail');
  const guessed = Boolean(get('dialer_source_detail') && !detail);
  const dialer = guessed && /^website form$/i.test(get('dialer_source')) ? '' : get('dialer_source');
  const own = (f.source || f.lead_source || '').trim();
  // Meta's own platform codes ("an" is its audience network, "msg" Messenger).
  const platform = /^(an|msg)$/i.test((f.platform || '').trim()) ? 'meta' : f.platform;
  // For a lead the team moved to nurturing, the "tab" is the stage they are in, not where they came from.
  const tab = fromTeam ? '' : get('sheet_tab');
  // A row with an ad on it: what its campaign says, else Meta (whose export it is).
  const ad = f.ad_name || f.adset_name || f.ad_id || f.adset_id || f.campaign_name ? channelOf(f.campaign_name) || 'Meta ads' : '';
  const found = [platform, tab, f.utm_source].map(channelOf).concat(ad, [own, f.campaign, dialer, detail].map(channelOf)).filter(Boolean);
  // "Social media" only when nothing names which one.
  const known = found.find((c) => c !== 'Social media') || found[0];
  if (known) return known;
  for (const name of [own, dialer, detail]) {
    if (name && !EMPTY.test(name) && !/preview/i.test(name)) return SAID[name.toLowerCase()] || name.slice(0, 40);
  }
  // Sent to Thuso's own address by a form.
  if (f.received_at) return 'Website form';
  return UNKNOWN_CHANNEL;
}
