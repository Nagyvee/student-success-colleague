import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { domainOf } from './store';

/* Reading a company's public website ourselves.
 *
 * A page read by the AI's own tools is paid for again at every step it takes;
 * read here, it is sent once, as plain text. Only public web addresses are
 * opened (never this server's own network), a few pages of one site, never
 * what its robots.txt asks to leave alone, and never more than a page's worth. */

const AGENT = 'Mozilla/5.0 (compatible; PageReader/1.0)';
const MAX_BYTES = 1_200_000;
const TIMEOUT_MS = 10_000;

/* ── What may be opened ───────────────────────────────────────────────────── */

const PRIVATE = new net.BlockList();
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]] as const) PRIVATE.addSubnet(a, n, 'ipv4');
for (const [a, n] of [['::', 96], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(a, n, 'ipv6');

/** An address inside a network (this server, its neighbours, the cloud's own): never opened. */
// (An IPv4 address written as IPv6 is refused by how it is written: in the list, that range would match every IPv4 address.)
export const isPrivate = (ip: string): boolean => { const v = net.isIP(ip); return v === 0 || /^::ffff:/i.test(ip) || PRIVATE.check(ip, v === 6 ? 'ipv6' : 'ipv4'); };

/** A public web address by name, on the usual port. */
export function mayRead(url: string): URL | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.port || net.isIP(host) || !host.includes('.') || /\.(local|localhost|internal|lan|home|corp|arpa|test|invalid|onion)$/.test(host)) return null;
    return u;
  } catch { return null; }
}

// Checked at the moment of connecting, so a name cannot point somewhere else in between.
const lookup: net.LookupFunction = (host, options, done) => {
  dns.lookup(host, { all: true, verbatim: true }, (err, list) => {
    if (err) return done(err, '', 4);
    if (!list.length || list.some((x) => isPrivate(x.address))) return done(Object.assign(new Error('not a public address'), { code: 'EACCES' }), '', 4);
    const pick = list.find((x) => x.family === 4) || list[0];
    return options.all ? done(null, list as never, pick.family) : done(null, pick.address, pick.family);
  });
};

export interface Page { url: string; html: string }

function once(u: URL): Promise<{ status: number; location: string; type: string; body: Buffer } | null> {
  return new Promise((resolve) => {
    let over = false;
    const end = (v: { status: number; location: string; type: string; body: Buffer } | null) => { if (!over) { over = true; clearTimeout(timer); resolve(v); } };
    const req = (u.protocol === 'https:' ? https : http).get(u, { lookup, headers: { 'user-agent': AGENT, accept: 'text/html,text/plain;q=0.8', 'accept-language': 'en', 'accept-encoding': 'gzip, deflate, br' } }, (res) => {
      const status = res.statusCode || 0;
      const type = String(res.headers['content-type'] || '').toLowerCase();
      if (status >= 300 && status < 400) { res.resume(); return end({ status, location: String(res.headers.location || ''), type, body: Buffer.alloc(0) }); }
      if (status !== 200 || (type && !/html|text\/plain/.test(type))) { req.destroy(); return end(null); }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const unzip = enc === 'gzip' ? zlib.createGunzip() : enc === 'br' ? zlib.createBrotliDecompress() : enc === 'deflate' ? zlib.createInflate() : null;
      const from = unzip ? res.pipe(unzip) : res;
      const parts: Buffer[] = [];
      let size = 0;
      const done = () => end({ status, location: '', type, body: Buffer.concat(parts) });
      from.on('data', (b: Buffer) => { size += b.length; parts.push(b); if (size > MAX_BYTES) { done(); req.destroy(); unzip?.destroy(); } });
      from.on('end', done);
      from.on('error', () => end(size ? { status, location: '', type, body: Buffer.concat(parts) } : null));
      res.on('error', () => end(null));
    });
    const timer = setTimeout(() => { req.destroy(); end(null); }, TIMEOUT_MS);
    req.on('error', () => end(null));
  });
}

async function fetchPage(url: string): Promise<Page | null> {
  let at = mayRead(url);
  for (let hop = 0; at && hop < 5; hop++) {
    const r = await once(at).catch(() => null);
    if (!r) return null;
    if (r.status === 200) return { url: at.toString(), html: r.body.toString(/iso-8859|windows-125/.test(r.type) ? 'latin1' : 'utf8') };
    // Every step of a redirect is checked like the first one.
    try { at = r.location ? mayRead(new URL(r.location, at).toString()) : null; } catch { at = null; }
  }
  return null;
}

/** Replaced by the tests. */
export const web = { get: fetchPage };

/* ── Page → text ──────────────────────────────────────────────────────────── */

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '...', copy: '', reg: '', trade: '', bull: '-', middot: '-' };
const decode = (t: string) => t.replace(/&(#x?[0-9a-f]{1,8}|[a-z]{1,10});/gi, (all, e: string) => {
  if (e[0] !== '#') return ENTITY[e.toLowerCase()] ?? all;
  const n = /^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});
const tidy = (t: string) => decode(t).replace(/[ \t\r\f\v\u00a0]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim();
const attr = (tag: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag); return m ? m[1] ?? m[2] ?? m[3] ?? '' : ''; };
const HIDDEN = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'template']);
const BLOCK = new Set(['br', 'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'section', 'article', 'title', 'option']);

/** What a page says, without its code, and the links in it. One pass from start to end, so no page can hold us up. */
function parse(html: string): { text: string; links: { href: string; words: string }[] } {
  const low = html.toLowerCase();
  const text: string[] = [];
  const links: { href: string; words: string }[] = [];
  let open: { href: string; from: number } | null = null;
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text.push(html.slice(i)); break; }
    if (lt > i) text.push(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); if (e < 0) break; i = e + 3; continue; }
    const gt = html.indexOf('>', lt);
    if (gt < 0) break;
    const tag = html.slice(lt + 1, Math.min(gt, lt + 3000));
    i = gt + 1;
    const name = (/^\/?([a-z0-9]+)/i.exec(tag)?.[1] || '').toLowerCase();
    const closing = tag[0] === '/';
    if (!closing && HIDDEN.has(name) && !tag.endsWith('/')) { const e = low.indexOf(`</${name}`, i); if (e < 0) break; i = e; continue; }
    if (name === 'a') {
      if (open) { links.push({ href: open.href, words: tidy(text.slice(open.from).join('')).slice(0, 60) }); open = null; }
      if (!closing) {
        const href = decode(attr(tag, 'href')).trim();
        if (/^mailto:/i.test(href)) text.push(` ${href.slice(7).split('?')[0]} `);
        else if (/^tel:/i.test(href)) text.push(` ${href.slice(4)} `);
        else if (href && links.length < 600) open = { href, from: text.length };
      }
    }
    if (name === 'meta' && /^description$/i.test(attr(tag, 'name'))) text.push(`\n${attr(tag, 'content')}\n`);
    text.push(BLOCK.has(name) ? '\n' : ' ');
  }
  return { text: tidy(text.join('')), links };
}

/** What a page says. An address behind "email us" is written out. */
export const toText = (html: string): string => parse(html).text;

const within = (url: string, home: string) => { const d = domainOf(url); return d === home || d.endsWith(`.${home}`); };

/** The site's own links: address and words. */
export function linksOf(html: string, base: string): { url: string; words: string }[] {
  const home = domainOf(base);
  const out = new Map<string, string>();
  for (const l of parse(html).links) {
    try {
      const u = new URL(l.href, base);
      u.hash = '';
      if (!within(u.toString(), home) || !mayRead(u.toString()) || /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|ics)$/i.test(u.pathname)) continue;
      if (!out.has(u.toString())) out.set(u.toString(), l.words);
    } catch { /* not a link */ }
  }
  return [...out].map(([url, words]) => ({ url, words }));
}

/** May this path be read, by the site's robots.txt (the longest rule wins)? */
export function allowedBy(robots: string, path: string): boolean {
  let mine = false, inAgents = false;
  let best: { len: number; ok: boolean } = { len: -1, ok: true };
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*(user-agent|allow|disallow)\s*:\s*([^#]*)/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), v = m[2].trim();
    if (key === 'user-agent') { mine = inAgents ? mine || v === '*' : v === '*'; inAgents = true; continue; }
    inAgents = false;
    // A rule nobody writes by hand is not worth matching.
    if (!mine || !v || v.length > 200 || (v.match(/\*/g) || []).length > 3) continue;
    const re = new RegExp(`^${v.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\?\$$/, '$')}`);
    if (re.test(path) && (v.length > best.len || (v.length === best.len && key === 'allow'))) best = { len: v.length, ok: key === 'allow' };
  }
  return best.ok;
}

/* ── A site ───────────────────────────────────────────────────────────────── */

// In this order: what shows a need, who to write to, what it is.
const WANTED = [
  /learnership|graduate|internship|bursar|apprentice/i, /career|vacanc|\bjobs?\b|join[- ]?(us|our)|work[- ]with/i, /contact/i, /news|media|press|blog|insight|article/i,
  /about|who-we-are|our-(story|company|business)/i, /team|leadership|management|our-people/i, /skills|training|transformation|sustainab|b-?bb?ee|csi\b|technolog|digital|innovation/i,
];

const robotsOf = async (url: string) => (await web.get(new URL('/robots.txt', url).toString()).catch(() => null))?.html.slice(0, 50_000) || '';
const pathOf = (url: string) => { const u = new URL(url); return u.pathname + u.search; };

/** The pages of a company's site worth reading, as text (address → words). Empty when it cannot be read. */
export async function readSite(website: string, max = 6): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const tries = [website, website.replace(/^http:/, 'https:'), website.replace(/^https?:\/\/(www\.)?/, 'https://www.')].filter((x, i, l) => l.indexOf(x) === i);
  let home: Page | null = null;
  for (const t of tries) { home = await web.get(t).catch(() => null); if (home) break; }
  if (!home) return out;
  const rules = new Map<string, Promise<string>>();
  const may = async (url: string) => { const o = new URL(url).origin; if (!rules.has(o)) rules.set(o, robotsOf(url)); return allowedBy(await rules.get(o)!, pathOf(url)); };
  if (!(await may(home.url))) return out;
  out.set(home.url, toText(home.html).slice(0, 6000));
  const links = linksOf(home.html, home.url).filter((l) => l.url !== home!.url);
  const pick: string[] = [];
  for (const re of WANTED) {
    const l = links.filter((x) => !pick.includes(x.url)).find((x) => re.test(x.words) || re.test(pathOf(x.url)));
    if (l && (await may(l.url))) pick.push(l.url);
    if (pick.length >= max - 1) break;
  }
  // Three at a time: a visitor, not a crowd.
  for (let i = 0; i < pick.length; i += 3) {
    const got = await Promise.all(pick.slice(i, i + 3).map((u) => web.get(u).catch(() => null)));
    for (const p of got) if (p && within(p.url, domainOf(home.url)) && !out.has(p.url)) { const t = toText(p.html); if (t.length > 80) out.set(p.url, t.slice(0, 5000)); }
  }
  // A site that builds its pages with scripts says nothing here.
  return [...out.values()].reduce((n, t) => n + t.length, 0) < 800 ? new Map() : out;
}

/** One page, as text ('' when it cannot or may not be read). */
export async function readPage(url: string, max = 20_000): Promise<string> {
  if (!mayRead(url)) return '';
  const p = await web.get(url).catch(() => null);
  if (!p || !allowedBy(await robotsOf(p.url), pathOf(p.url))) return '';
  return toText(p.html).slice(0, max);
}

/** The part of a page around a name. */
export function around(text: string, name: string, span = 1200): string {
  const i = text.toLowerCase().indexOf(name.toLowerCase());
  return i < 0 ? '' : text.slice(Math.max(0, i - span / 2), i + span);
}
