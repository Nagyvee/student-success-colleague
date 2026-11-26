import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* B2B outbound against a pretend AI, Discord and mail server: only companies
 * and addresses that were really read, never more than the budget, never
 * someone on our own list or asked before, one email until they answer, and
 * no means no. */

const REPO = process.cwd();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-outbound-'));
process.chdir(dir);
for (const k of ['DATABASE_URL', 'PGHOST', 'OPENAI_API_KEY', 'SMTP_HOST', 'DISCORD_LEADS_WEBHOOK', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL']) delete process.env[k];
process.env.ANTHROPIC_API_KEY = 'test-key';
process.env.SENDING_PAUSED = 'false';
process.env.PUBLIC_BASE_URL = 'https://thuso.example.org';

// Wednesday 25 November 2026, 09:00 in South Africa.
const NOW = Date.parse('2026-11-25T07:00:00Z');
const H = 3_600_000;
const DAY = 24 * H;

type Block = Record<string, unknown>;
type Req = { model: string; system: string; messages: { content: unknown }[]; tools?: { type: string; max_uses?: number }[] };
let ai: (r: Req) => { content: Block[]; usage?: Record<string, unknown>; stop_reason?: string } | { status: number; message: string };
const asked: Req[] = [];
const posts: { content?: string; embeds?: { title: string; description: string; fields?: { value: string }[]; footer?: { text: string } }[] }[] = [];
type Mail = { to: string; subject: string; text: string; html: string; from: string; inReplyTo?: string; headers: Record<string, string> };
const mails: Mail[] = [];
let mailError = '';

const text = (t: string): Block => ({ type: 'text', text: t, citations: null });
const json = (o: unknown) => text(`Here it is.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``);
const searched = (...urls: string[]): Block => ({ type: 'web_search_tool_result', tool_use_id: 't', content: urls.map((url) => ({ type: 'web_search_result', url, title: 'x', encrypted_content: 'x', page_age: null })) });
const read = (url: string, data: string): Block => ({ type: 'web_fetch_tool_result', tool_use_id: 't', content: { type: 'web_fetch_result', url, retrieved_at: null, content: { type: 'document', title: null, citations: null, source: { type: 'text', media_type: 'text/plain', data } } } });

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  acc: typeof import('../src/lib/auth/accounts');
  st: typeof import('../src/lib/outbound/store');
  re: typeof import('../src/lib/outbound/research');
  run: typeof import('../src/lib/outbound/run');
  out: typeof import('../src/lib/outbound/outreach');
  ask: typeof import('../src/lib/outbound/ask');
  dis: typeof import('../src/lib/outbound/discord');
  pg: typeof import('../src/lib/outbound/pages');
};
/** The pretend web: address → page. Nothing else can be opened. */
let sites: Record<string, string> = {};
const opened: string[] = [];
let m: M;
const T = <R>(fn: () => Promise<R> | R) => m.ctx.withTenant('default', fn);

before(async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (u.host === 'discord.com') { posts.push(JSON.parse(String(init?.body || '{}'))); return new Response('{}', { status: 200 }); }
    if (u.host !== 'api.anthropic.com') return realFetch(input, init);
    const body = JSON.parse(String(init?.body || '{}')) as Req;
    asked.push(body);
    const r = ai(body);
    const head = { 'content-type': 'application/json' };
    if ('status' in r) return new Response(JSON.stringify({ type: 'error', error: { type: 'x', message: r.message } }), { status: r.status, headers: head });
    return new Response(JSON.stringify({ id: 'msg', type: 'message', role: 'assistant', model: body.model, content: r.content, stop_reason: r.stop_reason || 'end_turn', stop_sequence: null, usage: { input_tokens: 20_000, output_tokens: 1000, ...(r.usage || {}) } }), { status: 200, headers: head });
  }) as typeof fetch;
  m = {
    ctx: await import('../src/lib/auth/tenantContext'), acc: await import('../src/lib/auth/accounts'), st: await import('../src/lib/outbound/store'), re: await import('../src/lib/outbound/research'),
    run: await import('../src/lib/outbound/run'), out: await import('../src/lib/outbound/outreach'), ask: await import('../src/lib/outbound/ask'), dis: await import('../src/lib/outbound/discord'), pg: await import('../src/lib/outbound/pages'),
  };
  m.pg.web.get = async (u) => { opened.push(u); return m.pg.mayRead(u) && sites[u] !== undefined ? { url: u, html: sites[u] } : null; };
  m.out.mailer.make = (() => ({
    sendMail: async (x: Mail) => { if (mailError) throw new Error(mailError); mails.push(x); return { messageId: `<${mails.length}@us>` }; },
    verify: async () => true,
  })) as unknown as typeof m.out.mailer.make;
});

const READY = {
  addressOnly: false, researchOn: true, perDay: 2, showPerDay: 10, hour: 7, budgetUsd: 50, services: 'Learnerships and team training in software, data and cybersecurity', ideal: 'Growing firms that employ many juniors', sectors: 'Logistics, Retail', provinces: 'Gauteng, KwaZulu-Natal', sizeMin: 20, sizeMax: 200, avoid: 'Blocked Co, never.co.za', searchIdeas: [], signals: '', rules: '', never: '',
  discordWebhook: 'https://discord.com/api/webhooks/9/b2b', sendingOn: true, checkFirst: true, checkReplies: true, sendPerDay: 2, smtpHost: 'smtp.example.org', smtpPort: 465, smtpUser: 'team@out.example.org', smtpPass: 'pw', fromName: 'Naledi M', fromTitle: 'Partnerships', bookingLink: 'https://cal.example.org/team', address: '1 Main Road, Durban', callsWith: 'Thabile',
  magnets: [{ id: 'mg_report', name: 'The free report', about: 'What training juniors costs and returns', link: 'https://melsoft.example/report', when: 'open', on: true }, { id: 'mg_toolkit', name: 'The toolkit', about: '', link: 'https://melsoft.example/toolkit', when: 'yes', on: true }, { id: 'mg_12h', name: 'The 12H calculator', about: 'What you could claim back', link: 'https://melsoft.example/12h', when: 'yes', on: true }],
};

beforeEach(() => T(() => {
  sites = {}; opened.length = 0;
  asked.length = 0; posts.length = 0; mails.length = 0; mailError = '';
  ai = () => ({ content: [text('nothing')] });
  for (const c of m.st.companies()) { c.id = c.id; delete (globalThis as unknown as Record<string, Map<string, { value: Record<string, unknown> }>>).__thusoDoc_outbound_x; }
  const docs = globalThis as unknown as Record<string, Map<string, { value: unknown }>>;
  docs['__thusoDoc_outbound-companies']?.forEach((x) => { x.value = {}; });
  m.st.saveIdeals([]); m.st.savePool([]);
  docs['__thusoDoc_outbound-spend']?.forEach((x) => { x.value = { month: '', usd: 0, searches: 0, calls: 0, companies: 0, days: {} }; });
  Object.assign(m.st.runState(), { day: '', researched: 0, kept: 0, extra: 0, done: false, dry: 0, posted: false, angle: 0, doing: '', lastError: '', lastSendAt: 0, sentDay: '', sentToday: 0, pausedUntil: 0 });
  m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: true });
  m.st.saveSettings(READY);
}));

const company = (o: Partial<import('../src/lib/outbound/types').Company> = {}) => {
  const c = m.st.blankCompany({ name: 'Fast Freight', domain: 'fastfreight.co.za', website: 'https://fastfreight.co.za/', facts: [{ text: 'They opened a depot in Durban in October', url: 'https://fastfreight.co.za/news' }], fit: ['They hire juniors'], service: 'Data learnership', magnetId: 'mg_report', score: 8, contact: { name: 'Sipho Khumalo', role: 'HR', email: 'hr@fastfreight.co.za', phone: '', source: 'https://fastfreight.co.za/contact' }, ...o });
  return m.st.saveCompany(c);
};
const FIRST = { subject: 'A report for your Durban depot', text: 'Hi Sipho,\n\nI read that you opened a depot in Durban in October, and that you take on a lot of juniors there.\n\nWe put together a free report on what training juniors costs and returns. It may help with the new team. May I send it to you?' };

test('our ideal list is read from a paste, a CSV or just names, and never contacted unless someone says so', () => T(() => {
  const csv = m.re.readIdeals('Company,Website,Industry,Employees,Use\nAcme (Pty) Ltd,https://www.acme.co.za/about,Retail,1500,\nBeta Logistics,beta.co.za,Logistics,80,ok to contact\nAcme,acme.co.za,,,');
  assert.deepEqual(csv.map((x) => [x.name, x.domain, x.sector, x.size, x.use]), [['Acme (Pty) Ltd', 'acme.co.za', 'Retail', '1500', 'pattern'], ['Beta Logistics', 'beta.co.za', 'Logistics', '80', 'research']]);
  assert.deepEqual(m.re.readIdeals('Shoprite\nPick n Pay\tpicknpay.co.za\n\nShoprite').map((x) => [x.name, x.domain]), [['Shoprite', ''], ['Pick n Pay', 'picknpay.co.za']]);
  assert.equal(m.re.addIdeals('Company,Website\nAcme,acme.co.za').added, 1);
  assert.equal(m.re.addIdeals('Company,Website\nAcme Pty Ltd,\nNew One,new.co.za').added, 1, 'the same company is not added twice');
  assert.match(m.st.blockedReason({ name: 'ACME (Pty) Ltd', domain: '' }), /learn from it only/);
  m.st.saveIdeals(m.st.ideals().map((x) => ({ ...x, use: 'research' as const })));
  assert.equal(m.st.blockedReason({ name: 'Acme', domain: 'acme.co.za' }), '');
  assert.match(m.st.blockedReason({ name: 'Blocked Co', domain: '' }), /never-contact/);
  assert.match(m.st.blockedReason({ name: 'Something', domain: 'never.co.za' }), /never-contact/);
}));

test('a company on our list is left alone by any of its names, its brands and its group; an ordinary word is not a name', () => T(() => {
  m.re.addIdeals(['Company,Website', 'Shoprite Holdings,shopriteholdings.co.za', '"FirstRand Group (FNB, RMB, WesBank)",firstrand.co.za', 'Massmart (Walmart SA - Game/Makro/Builders),massmart.co.za', 'Imperial / Motus Holdings,motus.co.za', 'Discovery Group,discovery.co.za', 'Capitec Bank,', 'BCX (Telkom subsidiary),bcx.co.za', 'Spar Group (corporate + franchise),', 'Valterra Platinum (formerly Amplats),', 'Super Group,supergroup.co.za', 'Premier Foods,', 'iOCO (EOH rebranded),'].join('\n'));
  const no = (name: string, domain = '') => m.st.blockedReason({ name, domain });
  for (const x of ['Shoprite', 'SHOPRITE (Pty) Ltd', 'FNB', 'WesBank', 'RMB', 'FirstRand', 'Massmart', 'Makro', 'Game', 'Walmart', 'Motus', 'Imperial', 'Discovery Health', 'Discovery Bank', 'Capitec', 'BCX', 'Telkom', 'Spar', 'Amplats', 'Valterra', 'Super Group', 'Premier Foods SA', 'EOH', 'iOCO Holdings']) assert.match(no(x), /learn from it only/, x);
  assert.match(no('Anything', 'motus.co.za'), /learn from it only/);
  for (const x of ['Super Glass Durban', 'Premier Logistics', 'Gamehaven Lodge', 'Sparkle Cleaning', 'Motusi Traders', 'Builders Yard Vaal', 'First Freight', 'Discover Travel']) assert.equal(no(x), '', x);
  // Their own mark decides when it is the very company.
  m.st.saveIdeals([...m.st.ideals(), { id: 'x', name: 'Discovery Vitality Labs', domain: 'vitalitylabs.co.za', sector: '', size: '', province: '', note: '', use: 'research' }]);
  assert.equal(no('Discovery Vitality Labs', 'vitalitylabs.co.za'), '');
  m.st.saveSettings({ avoid: 'Checkers\nBidvest Group' });
  assert.match(no('Checkers Sixty60'), /never-contact/);
  assert.match(no('Bidvest'), /never-contact/);
  // The columns with people's names in a list are not read.
  assert.doesNotMatch(JSON.stringify(m.re.readIdeals('#,Owner,Company,Sector,Chief of People / HR,CIO / CTO\n1,Kennedy,Acme,Retail,Some Person SEQUENCE,Other Person')), /Person|Kennedy/);
}));

test('what the ideal companies have in common is learnt, kept as words people can change', () => T(async () => {
  m.re.addIdeals('Shoprite\nImperial Logistics\nBidvest');
  ai = () => ({ content: [json({ profile: 'Large employers of juniors.', sectors: ['Retail', 'Logistics'], searchIdeas: ['growing courier companies Gauteng'] })] });
  m.st.saveSettings({ sectors: '' });
  assert.equal((await m.re.learnIdeals()).ok, true);
  assert.equal(m.st.settings().profile, 'Large employers of juniors.');
  assert.equal(m.st.settings().sectors, 'Retail, Logistics');
  assert.match(m.re.angleOf(m.st.settings(), 1), /growing courier companies/);
  assert.notEqual(m.re.angleOf(m.st.settings(), 0), m.re.angleOf(m.st.settings(), 2), 'it does not look in the same place each time');
  assert.equal(asked[0].model, 'claude-haiku-5-5');
}));

test('only companies that came up in the searches, with their own site, not known and not blocked', () => T(async () => {
  company({ name: 'Known One', domain: 'known.co.za' });
  ai = () => ({
    content: [searched('https://www.good.co.za/careers', 'https://news.example/list', 'https://linkedin.com/company/social'), json({ companies: [
      { name: 'Good Co', website: 'https://good.co.za', sign: 1, why: 'hiring juniors', url: 'https://www.good.co.za/careers' },
      { name: 'Big Enough', website: 'https://good2.co.za', sign: 0, why: 'the right size', url: 'https://news.example/list' },
      { name: 'Named In News', website: 'named.co.za', sign: '3. growing', why: 'growing', url: 'https://news.example/list' },
      { name: 'Made Up', website: 'https://madeup.co.za', sign: 1, why: 'x', url: 'https://nowhere.example' },
      { name: 'Social', website: 'https://linkedin.com/company/social', sign: 1, why: 'x', url: 'https://linkedin.com/company/social' },
      { name: 'Known One (Pty) Ltd', website: 'https://known.co.za', sign: 1, why: 'x', url: 'https://news.example/list' },
      { name: 'Blocked Co', website: 'https://blocked.co.za', sign: 1, why: 'x', url: 'https://news.example/list' },
    ] })],
    usage: { server_tool_use: { web_search_requests: 6, web_fetch_requests: 0 } },
  });
  const found = await m.re.discover(0);
  assert.deepEqual(found.map((x) => x.name), ['Good Co', 'Named In News']);
  assert.equal(asked[0].tools![0].type, 'web_search_20250305');
  assert.match(String((asked[0].messages[0].content)), /20 to 200 employees/);
  // 6 searches are 6 cents; 20,000 tokens in and 1,000 out are a quarter of a cent.
  assert.ok(Math.abs(m.st.spend().usd - 0.0625) < 1e-9, String(m.st.spend().usd));
}));

const CAND = { name: 'Good Co', website: 'https://good.co.za/', domain: 'good.co.za', why: 'hiring', url: '', from: 'research' as const };
const ANSWER = { name: 'Good Co', what: 'A courier company.', sector: 'Logistics', city: 'Durban', province: 'KwaZulu-Natal', employees: 'about 80', facts: [{ text: 'It has about 80 people', url: 'https://good.co.za/careers', sign: 0 }, { text: 'Advertising six junior roles', url: 'https://good.co.za/careers', sign: 1 }, { text: 'Invented', sign: 1, url: 'https://good.co.za/never-opened' }], fit: ['Hires juniors'], concerns: '', service: 'Data learnership', magnet: 'mg_report', like: ['Imperial Logistics', 'Nobody'], contact: { name: 'Ann Botha', role: 'HR manager', email: 'HR@good.co.za', phone: '031 000 0000' }, score: 9, scoreWhy: 'Hiring now' };

test('a fact needs a page that was opened, and an address must be written on one', () => T(async () => {
  m.re.addIdeals('Imperial Logistics');
  ai = () => ({ content: [read('https://good.co.za/careers', 'Join us! Six junior roles.'), read('https://good.co.za/contact', 'Write to hr (at) good.co.za'), json(ANSWER)] });
  const { company: c } = await m.re.research(CAND);
  assert.deepEqual(c!.facts.map((x) => x.text), ['Advertising six junior roles', 'It has about 80 people'], 'the sign first: an email starts with it');
  assert.match(c!.facts[0].sign!, /advertising for juniors/);
  assert.equal(c!.contact.email, 'hr@good.co.za');
  assert.equal(c!.contact.source, 'https://good.co.za/contact');
  assert.equal(c!.employees, 80);
  assert.deepEqual(c!.like, ['Imperial Logistics']);
  // A guessed address is dropped; nothing that can be checked is not a company for the list.
  ai = () => ({ content: [read('https://good.co.za/careers', 'Join us!'), json(ANSWER)] });
  assert.equal((await m.re.research(CAND)).company!.contact.email, '');
  ai = () => ({ content: [json(ANSWER)] });
  assert.match((await m.re.research(CAND)).why, /could be checked/);
}));

test('small ones first: one far too big is left out, unless it is on our own list', () => T(async () => {
  const big = { ...ANSWER, employees: '1 200 employees' };
  ai = () => ({ content: [read('https://good.co.za/careers', 'hr@good.co.za'), json(big)] });
  assert.match((await m.re.research(CAND)).why, /too big/);
  assert.equal((await m.re.research({ ...CAND, from: 'ideal' })).company!.employees, 1200);
  assert.deepEqual(['about 80', '50-100', '1,200', '2k+', '', 'unknown'].map(m.re.headcount), [80, 75, 1200, 2000, null, null]);
}));

test('only good ones are put on the list: a sign on a page, not just the right size, and never someone who sells training', () => T(async () => {
  const page = read('https://good.co.za/careers', 'Join us!');
  const is = async (o: Record<string, unknown>, cand: Partial<typeof CAND> = {}) => { ai = () => ({ content: [page, json({ ...ANSWER, ...o })] }); return m.re.research({ ...CAND, ...cand } as typeof CAND); };
  const noSign = { facts: [{ text: 'It has 250+ experts', url: 'https://good.co.za/careers', sign: 0 }] };
  assert.equal((await is({ ...noSign, score: 9 })).company!.score, 5, 'right on paper only');
  assert.equal((await is({ score: 9 })).company!.score, 9);
  assert.equal((await is({ ...noSign, score: 9, facts: [{ text: 'x', url: 'https://good.co.za/never-opened', sign: 1 }, ...noSign.facts] })).company!.score, 5, 'a sign on a page nobody opened is none');
  assert.equal((await is({ sellsTraining: true })).why, 'it sells training or staff itself');
  m.st.saveSettings({ sizeMin: 100 });
  assert.equal((await is({ score: 8, employees: '11-50' })).company!.score, 5, 'far too small');
  assert.equal((await is({ score: 8, employees: '' })).company!.score, 8, 'a size nobody publishes lowers nothing');
  m.st.saveSettings({ sizeMin: 20 });
  // Short where it is shown, never cut inside a word.
  const c = (await is({ employees: '160+ (global, across five offices; South African count not stated)', service: 'Learnerships and structured skills development (pipeline building), with AI upskilling', concerns: 'word '.repeat(60) })).company!;
  assert.equal(c.size, '160+');
  assert.equal(c.service, 'Learnerships and structured skills development');
  assert.match(c.concerns, /word$/);
  const t = await import('../src/lib/outbound/types');
  assert.deepEqual(['160+ (global, across five offices; South African count not s', 'over 200', '250+ experts', 'not published', ''].map(t.peopleOf), ['160+ people', 'over 200 people', '250+ experts', '', '']);
  const to = (email: string) => ({ email });
  assert.equal(t.onList({ listedOn: 'x', score: 4, from: 'research', contact: to('a@b.co.za') }, { minScore: 6 }), false, 'one listed before today is not shown either');
  assert.equal(t.onList({ listedOn: 'x', score: 0, from: 'manual', contact: to('') }, { minScore: 6, addressOnly: true }), true, 'one a person added always is');
  assert.equal(t.onList({ listedOn: 'x', score: 8, from: 'research', contact: to('') }, { minScore: 6, addressOnly: true }), false, 'nobody has to look for an address');
  assert.equal(t.onList({ listedOn: 'x', score: 8, from: 'research', contact: to('') }, { minScore: 6, addressOnly: false }), true);
}));

test('Find 5 now finds that many good ones, looks at three times as many at most, and leaves what was found before without a sign', () => T(async () => {
  m.st.saveSettings({ researchOn: false, perDay: 1 });
  m.st.savePool([{ ...CAND, name: 'Old Co', domain: 'old.co.za', website: 'https://old.co.za/' }]);
  const score: Record<string, number> = {};
  for (let i = 0; i < 12; i++) score[`Co${i}x`] = i % 3 === 0 ? 8 : 4;
  ai = (r) => {
    const p = String(r.messages[0].content);
    if (/List up to 15 companies/.test(p)) return { content: [searched('https://n.example/a'), json({ companies: Object.keys(score).map((n) => ({ name: n, website: `https://${n.toLowerCase()}.co.za`, sign: 1, why: 'x', url: 'https://n.example/a' })) })] };
    const n = Object.keys(score).find((x) => p.includes(`The company: ${x} `))!;
    return { content: [read(`https://${n.toLowerCase()}.co.za/x`, 'x'), json({ ...ANSWER, name: n, facts: [{ text: 'A fact', sign: 1, url: `https://${n.toLowerCase()}.co.za/x` }], contact: {}, score: score[n] })] };
  };
  assert.match(m.run.findNow(2, 'default', NOW).detail, /2 good ones now, in up to 12 companies, for about \$0\.20 at most/);
  const steps: string[] = [];
  for (let i = 0; i < 12; i++) { const x = await m.run.researchStep('default', NOW + i * 20_000); if (!x) break; steps.push(x); }
  assert.deepEqual(steps, ['found 12', 'kept Co0x', 'not good enough: Co1x', 'not good enough: Co2x', 'kept Co3x']);
  assert.deepEqual(m.st.companies().filter((c) => c.listedOn).map((c) => c.name).sort(), ['Co0x', 'Co3x']);
  assert.equal(m.st.runState().kept, 2);
  // Nobody good: it stops when nobody is left, or at six times as many.
  for (const k of Object.keys(score)) score[k] = 3;
  m.run.findNow(2, 'default', NOW);
  let n = 0;
  while (n < 20 && await m.run.researchStep('default', NOW + 600_000 + n * 20_000)) n++;
  assert.equal(m.st.companies().length, 12, 'each one once');
  assert.ok(n < 13);
  assert.equal(m.st.runState().extra, 0);
  // A click costs no more than it said, one step over at most.
  for (const k of Object.keys(score)) score[k] = 3;
  m.st.savePool([]);
  for (const c of m.st.companies()) c.domain = `gone-${c.domain}`;
  for (const c of m.st.companies()) c.name = `Gone ${c.name}`;
  const old = ai;
  ai = (r) => ({ ...(old(r) as { content: Block[] }), usage: { server_tool_use: { web_search_requests: 15, web_fetch_requests: 0 } } });
  m.run.findNow(2, 'default', NOW);
  const from = m.st.spend().usd;
  let last = '';
  for (let i = 0; i < 20; i++) { const x = await m.run.researchStep('default', NOW + 1_200_000 + i * 20_000); if (!x) break; last = x; }
  assert.equal(last, 'the limit for this search');
  assert.ok(m.st.spend().usd - from < 0.2 + 0.16, String(m.st.spend().usd - from));
  assert.ok(m.st.spend().kinds!.find!.calls >= 1 && m.st.spend().kinds!.read!.calls >= 1);
  // Nobody new: two searches, then it stops.
  ai = () => ({ content: [searched('https://n.example/a'), json({ companies: [] })] });
  m.st.savePool([]);
  m.run.findNow(5, 'default', NOW);
  const before = asked.length;
  for (let i = 0; i < 6; i++) await m.run.researchStep('default', NOW + 2_000_000 + i * 20_000);
  assert.equal(asked.length - before, 2);
  assert.equal(m.st.runState().extra, 0);
}));

test('a page is read as words, in one pass, and only from the public web', () => T(async () => {
  const { toText, linksOf, allowedBy, isPrivate, mayRead, readSite, readPage } = m.pg;
  const html = '<html><head><title>Good Co</title><meta name="description" content="Couriers &amp; more"><style>.x{}</style></head><body><!-- hidden --><script>var a = "<b>not text</b>";</script><h1>We move</h1><p>Call&nbsp;us</p><a href="mailto:hr@good.co.za?subject=x">Email us</a> <a href="/careers">Join us</a><a href="https://other.example/x">Other</a><a href="brochure.pdf">PDF</a><a href="https://careers.good.co.za/now">Vacancies</a></body></html>';
  assert.equal(toText(html), 'Good Co\nCouriers & more\nWe move\nCall us\nhr@good.co.za Email us Join us Other PDF Vacancies');
  assert.deepEqual(linksOf(html, 'https://www.good.co.za/').map((l) => `${l.url} ${l.words}`), ['https://www.good.co.za/careers Join us', 'https://careers.good.co.za/now Vacancies']);
  // Pages made to hold a reader up are done in a moment.
  const t0 = Date.now();
  for (const bad of ['<!--'.repeat(200_000), '<a href="x'.repeat(100_000), '<script>'.repeat(120_000), '<'.repeat(900_000), '&a'.repeat(400_000), '<p>'.repeat(300_000), '('.repeat(900_000)]) { toText(bad); linksOf(bad, 'https://good.co.za/'); }
  assert.ok(Date.now() - t0 < 6000, `${Date.now() - t0} ms`);
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '224.0.0.1', 'x']) assert.equal(isPrivate(ip), true, ip);
  for (const ip of ['154.0.162.205', '104.26.5.50', '8.8.8.8', '2606:4700::1111', '172.67.68.226']) assert.equal(isPrivate(ip), false, ip);
  for (const u of ['http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://2130706433/', 'https://good.co.za:8443/', 'https://a:b@good.co.za/', 'file:///etc/passwd', 'ftp://good.co.za/', 'http://server.internal/', 'x']) assert.equal(mayRead(u), null, u);
  assert.ok(mayRead('https://good.co.za/a'));
  const robots = 'User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /private\nAllow: /private/jobs\nDisallow: /*?s=';
  assert.deepEqual(['/', '/private/x', '/private/jobs', '/a?s=1'].map((p) => allowedBy(robots, p)), [true, false, true, false]);
  assert.equal(allowedBy('User-agent: *\nDisallow: /', '/'), false);
  assert.equal(allowedBy('<html>not a robots file</html>', '/'), true);
  // The pages that matter, never what robots.txt keeps, never another site.
  const long = (t: string) => `<p>${t} ${'We deliver parcels across South Africa every day. '.repeat(12)}</p>`;
  sites = {
    'https://good.co.za/': `${long('Good Co')}<a href="/learnerships">Learnerships</a><a href="/contact">Contact</a><a href="/private/jobs-list">Jobs</a><a href="https://evil.example/about">About</a><a href="/about-us">About us</a>`,
    'https://good.co.za/robots.txt': 'User-agent: *\nDisallow: /private',
    'https://good.co.za/learnerships': long('Six learnerships'), 'https://good.co.za/contact': long('hr@good.co.za'), 'https://good.co.za/about-us': long('Since 1999'), 'https://good.co.za/private/jobs-list': long('secret'),
  };
  assert.deepEqual([...(await readSite('https://good.co.za/')).keys()], ['https://good.co.za/', 'https://good.co.za/learnerships', 'https://good.co.za/contact', 'https://good.co.za/about-us']);
  assert.ok(!opened.some((u) => /private\/|evil/.test(u)));
  assert.equal(await readPage('https://good.co.za/private/jobs-list'), '');
  sites = { 'https://good.co.za/': '<div id="root"></div>' };
  assert.equal((await readSite('https://good.co.za/')).size, 0, 'a site made by scripts says nothing here');
}));

test('a site is read here and sent once; only one that looks good is searched for; what is said must be on a page', () => T(async () => {
  const long = (t: string) => `<p>${t} ${'We deliver parcels across South Africa every day. '.repeat(12)}</p>`;
  const put = () => { sites = { 'https://good.co.za/': `${long('Good Co couriers')}<a href="/careers">Careers</a><a href="/contact">Contact</a>`, 'https://good.co.za/careers': long('Six junior data roles, November 2026'), 'https://good.co.za/contact': long('Write to hr@good.co.za') }; };
  put();
  const one = { ...ANSWER, score: 7, facts: [{ text: 'Six junior data roles', sign: 1, url: 'https://good.co.za/careers' }], contact: { name: '', role: '', email: 'hr@good.co.za', phone: '' }, employees: '' };
  ai = (r) => ({ content: r.tools?.length ? [searched('https://news.example/good'), json({ ...one, employees: 'about 150', score: 8, facts: [...one.facts, { text: 'Opened a depot', sign: 3, url: 'https://news.example/good' }, { text: 'Made up', sign: 1, url: 'https://good.co.za/never' }] })] : [json(one)] });
  const { company: c } = await m.re.research(CAND);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].tools, undefined, 'the site is read without paid tools');
  assert.match(String(asked[0].messages[0].content), /=== https:\/\/good\.co\.za\/careers\n[\s\S]*Six junior data roles, November 2026/);
  assert.deepEqual(asked[1].tools!.map((t) => [t.type, t.max_uses]), [['web_search_20250305', 1]]);
  assert.deepEqual([c!.score, c!.employees, c!.contact.email, c!.contact.source], [8, 150, 'hr@good.co.za', 'https://good.co.za/contact']);
  assert.deepEqual(c!.facts.map((x) => x.text), ['Six junior data roles', 'Opened a depot'], 'nothing from a page nobody opened');
  // Not promising, or selling training: nothing is paid for.
  for (const o of [{ ...one, score: 2 }, { ...one, sellsTraining: true, score: 9 }]) {
    asked.length = 0;
    ai = () => ({ content: [json(o)] });
    await m.re.research(CAND);
    assert.equal(asked.length, 1);
  }
  // Someone else's website; a page that tries to give orders is only words.
  sites = { 'https://good.co.za/': long('Totally different bakery') + long('Bread') };
  asked.length = 0;
  assert.equal((await m.re.research({ ...CAND, name: 'Zebra Freight', domain: 'good.co.za' })).why, 'that website is not theirs');
  assert.equal(asked.length, 0);
  // The page that named it, when that is another one.
  put();
  sites['https://list.example/learnerships'] = `<p>${'x '.repeat(3000)}</p><p>Good Co: 10 data learnerships, closing 30 November 2026</p>`;
  asked.length = 0;
  ai = () => ({ content: [json({ ...one, score: 3 })] });
  await m.re.research({ ...CAND, url: 'https://list.example/learnerships' });
  assert.match(String(asked[0].messages[0].content), /=== https:\/\/list\.example\/learnerships\n[\s\S]*10 data learnerships, closing 30 November 2026/);
  // A company that costs almost nothing shows as that.
  assert.ok(m.st.spend().usd < 0.02, String(m.st.spend().usd));
}));

test('the lists a search turned up are read here: many names for one search, each really on the page', () => T(async () => {
  sites = { 'https://list.example/2026': `<p>Learnerships 2026</p>${['Alpha Couriers', 'Beta Foods', 'Gamma Glass'].map((n) => `<p>${n} is taking data learners, closing 30 November 2026. ${'More about it. '.repeat(12)}</p>`).join('')}` };
  ai = (r) => ({ content: r.tools?.length
    ? [searched('https://list.example/2026'), json({ companies: [], lists: ['https://list.example/2026', 'https://never-came-up.example/x', 'http://127.0.0.1/admin'] })]
    : [json({ companies: [{ name: 'Alpha Couriers', website: 'https://alpha.co.za', sign: 2, why: 'x', page: 1 }, { name: 'Beta Foods', website: '', sign: 2, why: 'x', page: 1 }, { name: 'Gamma Glass (Pty) Ltd', website: 'gamma.co.za', sign: 2, why: 'x', page: 1 }, { name: 'Invented Co', website: 'https://invented.co.za', sign: 2, why: 'x', page: 1 }, { name: 'Alpha Couriers', website: 'https://alpha2.co.za', sign: 2, why: 'x', page: 4 }] })] });
  const found = await m.re.discover(0);
  assert.deepEqual(found.map((x) => [x.name, x.domain, x.url]), [['Alpha Couriers', 'alpha.co.za', 'https://list.example/2026'], ['Gamma Glass (Pty) Ltd', 'gamma.co.za', 'https://list.example/2026']]);
  assert.deepEqual(opened.filter((u) => !/robots/.test(u)), ['https://list.example/2026'], 'only what came up in the search');
}));

test('the best address its own pages give, never one to look for: a person, HR, then info, sales last; a general inbox is asked to pass it on', () => T(async () => {
  const pages = (o: Record<string, string>) => ({ pages: new Map(Object.entries(o)) });
  const best = (o: Record<string, string>, person = '', said = '') => m.re.bestAddress(pages(o), 'good.co.za', person, said);
  assert.deepEqual(best({ 'https://good.co.za/contact': 'sales@good.co.za info@good.co.za', 'https://good.co.za/careers': 'Send your CV to careers (at) good.co.za' }), { email: 'careers@good.co.za', source: 'https://good.co.za/careers' });
  assert.equal(best({ 'https://good.co.za/': 'sales@good.co.za info@good.co.za' }).email, 'info@good.co.za');
  assert.equal(best({ 'https://good.co.za/': 'sales@good.co.za' }).email, 'sales@good.co.za', 'sales only when nothing else is there');
  assert.equal(best({ 'https://good.co.za/': 'hr@good.co.za thandi.mokoena@good.co.za' }, 'Thandi Mokoena').email, 'thandi.mokoena@good.co.za');
  assert.equal(best({ 'https://good.co.za/': 'privacy@good.co.za noreply@good.co.za logo@2x.png' }).email, '', 'a POPIA or no-reply address is never written to');
  assert.equal(best({ 'https://list.example/x': 'info@list.example hr@good.co.za' }).email, '', 'not from another site');
  assert.equal(best({ 'https://good.co.za/': 'info@good-group.co.za' }, '', 'info@good-group.co.za').email, 'info@good-group.co.za', 'the group address on its own site, when named');
  assert.equal(best({}).email, '');
  // Only companies with an address are put on the list, when that is asked for.
  m.st.saveSettings({ addressOnly: true });
  const page = read('https://good.co.za/careers', 'Join us!');
  ai = () => ({ content: [page, json({ ...ANSWER, score: 8, contact: {} })] });
  const { company: none } = await m.re.research(CAND);
  assert.equal(none!.contact.email, '');
  const t = await import('../src/lib/outbound/types');
  assert.equal(t.writable(none!, m.st.settings()), false);
  // A general inbox: "Hello … team", and a line asking them to pass it on (the AI gets another try without it).
  const tries: string[] = [];
  const plain = { ...FIRST, text: FIRST.text.replace('Hi Sipho', 'Hello Fast Freight team') };
  ai = (r) => { tries.push(String(r.messages[0].content)); return { content: [json(tries.length === 1 ? plain : { ...plain, text: plain.text.replace('May I send', 'If this is not yours, could you pass it to whoever looks after training? May I send') })] }; };
  const c = m.out.approve(company({ contact: { name: '', role: '', email: 'sales@fastfreight.co.za', phone: '', source: 'x' } }), 'Nigel');
  await m.out.draftNext();
  assert.match(tries[0], /general inbox \(sales@fastfreight\.co\.za\)[\s\S]*pass it to whoever looks after training or HR/);
  assert.match(tries[1], /no line asking them to pass it on/);
  assert.match(c.thread[0].text, /^Hello Fast Freight team,[\s\S]*could you pass it to whoever looks after training\?/);
  assert.deepEqual(['info@x.co.za', 'sales@x.co.za', 'enquiries@x.co.za', 'hr@x.co.za', 'thandi@x.co.za', 'careers@x.co.za'].map(t.generalAddress), [true, true, true, false, false, false]);
}));

test('a day: it looks, reads one company at a time, posts the best in the B2B channel, and stops', () => T(async () => {
  const cos = ['One', 'Two', 'Three'];
  ai = (r) => {
    const p = String(r.messages[0].content);
    if (/List up to 15 companies/.test(p)) return { content: [searched('https://n.example/a'), json({ companies: cos.map((n) => ({ name: `${n} Co`, website: `https://${n.toLowerCase()}.co.za`, sign: 2, why: 'x', url: 'https://n.example/a' })) })] };
    const n = cos.find((x) => p.includes(`${x} Co`))!;
    return { content: [read(`https://${n.toLowerCase()}.co.za/x`, `hi@${n.toLowerCase()}.co.za`), json({ ...ANSWER, name: `${n} Co`, facts: [{ text: 'A fact', sign: 1, url: `https://${n.toLowerCase()}.co.za/x` }], contact: { email: `hi@${n.toLowerCase()}.co.za` }, score: n === 'Two' ? 9 : 6 })] };
  };
  const steps: string[] = [];
  for (let i = 0; i < 6; i++) steps.push(await m.run.researchStep('default', NOW + i * 20_000));
  assert.deepEqual(steps, ['found 3', 'kept One Co', 'kept Two Co', 'done', '', ''], 'two a day, then done');
  assert.equal(posts.length, 1);
  assert.match(posts[0].embeds![0].title, /2 companies to choose from/);
  assert.match(posts[0].embeds![0].description, /1\. Two Co\*\* · 9\/10[\s\S]*2\. One Co/);
  assert.ok(m.st.companies().every((c) => c.listedOn === '2026-11-25'));
  assert.equal(await m.run.researchStep('default', NOW + 4 * H), '');
  assert.equal(m.run.researchBlocked('default', NOW + 3 * DAY), 'It looks for companies on weekdays.');
  assert.equal(await m.run.researchStep('default', NOW + DAY + 60_000), 'kept Three Co', 'the next day carries on from what was found');
}));

test('never more than the budget, and a little is kept back to answer people', () => T(async () => {
  m.st.saveSettings({ budgetUsd: 2 });
  assert.ok(m.st.room('default', NOW).today < 0.7, 'the month is shared over its weekdays');
  m.st.addSpend('claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 185 } }, 'default', NOW);
  assert.match(m.run.researchBlocked('default', NOW), /This month's \$2 is spent/);
  assert.equal(await m.run.researchStep('default', NOW), '');
  assert.equal(asked.length, 0);
  assert.equal(m.run.findNow(5, 'default', NOW).ok, false);
  // A model nobody priced counts as an expensive one; a very long prompt costs more.
  assert.ok(m.st.costOf('something-new', { input_tokens: 1e6 }) >= 5);
  assert.ok(m.st.costOf('claude-haiku-5-5', { input_tokens: 150_000 }) > 1.5 * m.st.costOf('claude-haiku-5-5', { input_tokens: 100_000 }));
  assert.equal(m.st.costOf('claude-sonnet-5-5', { input_tokens: 1e6, output_tokens: 1e6 }), 12);
}));

test('nothing starts until someone says what we sell and what we look for; errors never loop', () => T(async () => {
  m.st.saveSettings({ services: '', ideal: '', profile: '' });
  assert.match(m.run.researchBlocked('default', NOW), /Tell Thuso what we sell and what an ideal company/);
  assert.equal(await m.run.researchStep('default', NOW), '');
  m.st.saveSettings(READY);
  ai = () => ({ status: 400, message: 'bad request' });
  for (let i = 0; i < 6; i++) await m.run.researchStep('default', NOW + i * 20_000);
  assert.ok(asked.length <= 6, `${asked.length} calls`);
  assert.match(m.st.runState().lastError, /bad request/);
  assert.equal(m.run.researchBlocked('default', NOW), 'Done for today.');
}));

test('the first email: one thing true, one thing offered, one question; who we are and how to stop; no links of the AI\'s', () => T(async () => {
  const c = m.out.approve(company(), 'Nigel');
  ai = () => ({ content: [json({ ...FIRST, text: `${FIRST.text}\n\nSee https://evil.example/x\n\nKind regards,\nBot` })] });
  await m.out.draftNext();
  const d = c.thread[0];
  assert.equal(d.status, 'draft', 'a person checks it');
  assert.doesNotMatch(d.text, /https?:|Kind regards/);
  assert.deepEqual(m.out.draftProblems(d.subject, d.text, 'first'), []);
  const e = m.out.compose(c, d);
  assert.match(e.text, /Naledi M\nPartnerships/);
  assert.match(e.text, /1 Main Road, Durban/);
  assert.match(e.text, /only email we will send unless you answer/);
  assert.match(e.text, /https:\/\/thuso\.example\.org\/b2b\//);
  assert.doesNotMatch(e.text, /melsoft\.example\/report/, 'the report comes after their yes');
  // The AI down: a plain draft a person can work from, never sent by itself.
  ai = () => ({ status: 400, message: 'x' });
  const c2 = m.out.approve(company({ name: 'Other Co', domain: 'other.co.za', contact: { name: '', role: '', email: 'info@other.co.za', phone: '', source: 'x' } }), 'Nigel');
  await m.out.draftNext();
  assert.match(c2.thread[0].text, /^Hello Other Co team,/);
  assert.deepEqual(m.out.draftProblems('', 'Hi [name], act now', 'first').sort(), ['a blank left to fill in', 'a promise or pressure', 'no subject', 'too short'].sort());
}));

test('what we never say is never sent, the reported figure only as reported, and the AI gets one more try', () => T(async () => {
  m.st.saveSettings({ never: '135%\nfines\nonly provider\n92% only with reported', rules: 'To a head of learning: completion first.', signals: 'Announces an AI strategy' });
  const body = (x: string) => `Hi Sipho,\n\nI read that you opened a depot in Durban and take on juniors there each year.\n\n${x} May I send you our free report?`;
  const p = (x: string) => m.out.draftProblems('A report', body(x), 'first');
  assert.deepEqual(p('Our programmes have a reported 92% completion rate.'), []);
  assert.deepEqual(p('We are Level 1 B-BBEE and 100% Black Female Youth-Owned, and classes are 100% online.'), [], 'who we are is not a promise');
  assert.match(p('Our completion rate is 92%.').join(), /"92%" without "reported"/);
  assert.match(p('Every rand counts at 135%.').join(), /"135%"/);
  assert.match(p('Avoid FINES this year.').join(), /"fines"/);
  assert.match(p('We are the only\nprovider that does it.').join(), /"only provider"/);
  assert.deepEqual(p('We refined the report for you.'), [], 'a word inside another word is not it');
  assert.match(p('It works 100% of the time.').join(), /promise/);
  const tries: string[] = [];
  ai = (r) => { tries.push(String(r.messages[0].content)); return { content: [json(tries.length === 1 ? { ...FIRST, text: body('Every rand counts at 135%.') } : FIRST)] }; };
  const c = m.out.approve(company(), 'Nigel');
  await m.out.draftNext();
  assert.equal(tries.length, 2);
  assert.match(tries[1], /Your last try had: something we never say: "135%"/);
  assert.equal(c.thread[0].text, FIRST.text);
  assert.match(asked[0].system, /How we speak \(always followed\): To a head of learning/);
  assert.match(asked[0].system, /You write to: Sipho Khumalo, HR/);
  // Words nobody would say aloud: another try too, but a person may write what they like.
  tries.length = 0;
  ai = (r) => { tries.push(String(r.messages[0].content)); return { content: [json(tries.length === 1 ? { ...FIRST, text: body('You run a learnership, which means a structured route into work. We work on the same stretch.') } : FIRST)] }; };
  const c2 = m.out.approve(company({ name: 'Plain Co', domain: 'plain.co.za', contact: { name: 'Ann', role: 'HR', email: 'ann@plain.co.za', phone: '', source: 'x' } }), 'Nigel');
  await m.out.draftFirst(c2);
  assert.match(tries[1], /Your last try had: stiff words \(which means, structured route, the same stretch\)/);
  assert.equal(c2.thread[0].text, FIRST.text);
  assert.deepEqual(p('It opens a structured route into work for juniors.'), []);
  assert.match(asked.at(-1)!.messages[0].content as string, /never say or hint that we do the kind of training they already run/i);
  assert.equal(m.out.longList('It includes a scorecard, the 15 numbers worth tracking, where learners drop out and why, a 90-day plan, and how points work.'), true);
  assert.equal(m.out.longList('It has a scorecard to check any provider, and shows where learners drop out and why.'), false);
  assert.deepEqual(m.out.stiffWords('Your learnership caught our eye, because structured learnerships like that are exactly what we work on.'), ['caught our eye', 'structured learnerships', 'exactly what we']);
  assert.deepEqual(m.out.stiffWords('We train people in AI, data and software, and I saw that you hire juniors.'), []);
  // One that still says it waits for a person, and does not go when it is pressed.
  c.thread[0].text = body('Every rand counts at 135%.');
  m.st.saveSettings({ checkFirst: false });
  assert.ok(m.out.draftProblems(c.thread[0].subject, c.thread[0].text, 'first').length);
  c.thread[0].status = 'ready';
  assert.equal(await m.out.pumpSend('default', NOW), 0);
  assert.equal(c.thread[0].status, 'draft');
  assert.match(c.thread[0].error!, /it says "135%"/);
  assert.equal(mails.length, 0);
  assert.match(m.re.angleOf(m.st.settings(), 0), /Announces an AI strategy/);
}));

test('the time left before a date is counted today, and an email that has gone out of date waits for a person', () => T(async () => {
  const k = await import('../src/lib/outbound/clock');
  const at = (d: string) => Date.parse(`${d}T10:00:00+02:00`);
  const left = (d: string) => k.timeLeft('2027-04-01', at(d));
  assert.deepEqual(['2026-11-25', '2026-11-30', '2026-12-01', '2026-12-31', '2027-01-01', '2027-02-28', '2027-03-01', '2027-03-31', '2027-04-01', '2028-01-01'].map(left),
    ['4 months left', '4 months left', '3 months left', '3 months left', '2 months left', '1 month left', 'less than a month left', 'less than a month left', 'closed', 'closed']);
  // The month turns at midnight in South Africa, not in London.
  assert.equal(k.timeLeft('2027-04-01', Date.parse('2026-11-30T22:30:00Z')), '3 months left');
  assert.equal(k.withTime('12H: {time left to 1 April 2027}. {time left to 1 Apr 2027}. {time left to 2027-04-01}.', NOW), '12H: 4 months left. 4 months left. 4 months left.');
  assert.equal(k.withTime('{time left to 31 April 2027} {time left to soon}', NOW), '{time left to 31 April 2027} {time left to soon}', 'what is not a date stays as it is');

  // The AI reads it filled in; the settings keep the words.
  m.st.saveSettings({ rules: 'Section 12H closes 1 April 2027 ({time left to 1 April 2027}).', magnets: [{ ...READY.magnets[0], about: 'Covers 12H, {time left to 1 April 2027}' }, ...READY.magnets.slice(1)] });
  assert.match(m.st.settings().rules, /\{time left/);
  assert.match(m.st.told('default', at('2027-01-10')).rules, /\(2 months left\)/);
  assert.match(m.st.told('default', at('2027-01-10')).magnets[0].about, /2 months left/);
  ai = () => ({ content: [json(FIRST)] });
  const c = m.out.approve(company(), 'Nigel');
  await m.out.draftNext();
  assert.doesNotMatch(JSON.stringify(asked[0]), /\{time left/);
  assert.match(asked[0].system, /Section 12H closes 1 April 2027 \((\d months? left|less than a month left|closed)\)/);

  // Written in November, going out in December.
  const d = c.thread[0];
  Object.assign(d, { at: NOW, status: 'ready', text: `${FIRST.text}\n\nSection 12H has four months left.` });
  assert.equal(m.out.notFit(c, d, 'default', NOW), '');
  const dec = Date.parse('2026-12-02T08:00:00Z');
  assert.match(m.out.notFit(c, d, 'default', dec), /"four months" was true when it was written, and it is now 3 months left/);
  assert.equal(await m.out.pumpSend('default', dec), 0);
  assert.equal(d.status, 'draft');
  assert.match(d.error!, /Not sent: "four months"/);
  assert.equal(mails.length, 0);
  // Put right by a person, or about something else: it goes.
  for (const ok of ['Section 12H has three months left.', 'Your 4-month project sounds useful.']) { d.text = `${FIRST.text}\n\n${ok}`; assert.equal(m.out.notFit(c, d, 'default', dec), '', ok); }
}));

test('the free report: the copy that is true today, to anyone with the link', async () => {
  const { reportName } = await import('../src/lib/outbound/report');
  const name = (d: string) => reportName(Date.parse(`${d}T10:00:00+02:00`));
  assert.deepEqual(['2026-11-25', '2026-12-15', '2027-01-15', '2027-02-15', '2027-03-15', '2027-04-01'].map(name),
    ['skills-2026-4.pdf', 'skills-2026-3.pdf', 'skills-2026-2.pdf', 'skills-2026-1.pdf', 'skills-2026-0.pdf', 'skills-2026-closed.pdf']);
  const { GET } = await import('../src/app/b2b/report/route');
  assert.equal((await GET()).status, 503, 'a missing file says so');
  const here = process.cwd();
  process.chdir(REPO);
  try {
    for (const n of ['4', '3', '2', '1', '0', 'closed']) assert.equal(fs.readFileSync(path.join('assets', 'skills-report', `skills-2026-${n}.pdf`)).subarray(0, 5).toString(), '%PDF-');
    const r = await GET();
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'application/pdf');
    assert.ok((await r.arrayBuffer()).byteLength > 400_000);
  } finally { process.chdir(here); }
});

test('asked once, ever: never a second first email, not to a colleague, not to someone blocked since', () => T(async () => {
  const c = m.out.approve(company(), 'Nigel');
  c.thread.push({ id: 'm1', who: 'us', kind: 'first', subject: FIRST.subject, text: FIRST.text, at: 1, status: 'ready' });
  assert.equal(await m.out.pumpSend('default', NOW), 1);
  assert.equal(c.stage, 'contacted');
  assert.equal(c.consent, 'asked');
  assert.equal(mails[0].to, 'hr@fastfreight.co.za');
  assert.match(mails[0].headers['List-Unsubscribe'], /\/b2b\//);
  assert.match(m.out.mayNotWrite(c, 'first'), /asked once already/);
  assert.match(m.out.mayNotWrite(c, 'nurture'), /not said yes/);
  assert.match(m.out.mayNotWrite(c, 'reply'), /not written to us/);
  const colleague = company({ name: 'Fast Freight Durban', domain: 'fastfreight.co.za', contact: { name: '', role: '', email: 'info@fastfreight.co.za', phone: '', source: 'x' } });
  assert.match(m.out.mayNotWrite(colleague, 'first'), /was asked already/);
  const late = m.out.approve(company({ name: 'Late Co', domain: 'late.co.za', contact: { name: '', role: '', email: 'a@late.co.za', phone: '', source: 'x' } }), 'Nigel');
  late.thread.push({ id: 'm2', who: 'us', kind: 'first', subject: FIRST.subject, text: FIRST.text, at: 1, status: 'ready' });
  m.st.saveSettings({ avoid: 'late.co.za' });
  assert.equal(await m.out.pumpSend('default', NOW + H), 0);
  assert.equal(late.thread[0].status, 'draft');
  assert.match(late.thread[0].error!, /never-contact/);
}));

test('a few a day, spread out, in office hours, only when everything is switched on', () => T(async () => {
  for (let i = 0; i < 4; i++) {
    const c = m.out.approve(company({ name: `Co ${i}`, domain: `co${i}.co.za`, contact: { name: '', role: '', email: `a@co${i}.co.za`, phone: '', source: 'x' } }), 'N');
    c.thread.push({ id: `m${i}`, who: 'us', kind: 'first', subject: FIRST.subject, text: FIRST.text, at: 1, status: 'ready' });
  }
  assert.equal(await m.out.pumpSend('default', NOW - 2 * H), 0, 'too early');
  assert.equal(await m.out.pumpSend('default', NOW + 3 * DAY), 0, 'Saturday');
  m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: false });
  assert.equal(await m.out.pumpSend('default', NOW), 0, 'Live Outreach off');
  m.acc.updateTenantIntegrations('default', { liveOutreachEnabled: true });
  m.st.saveSettings({ sendingOn: false });
  assert.equal(await m.out.pumpSend('default', NOW), 0, 'switched off');
  m.st.saveSettings({ sendingOn: true, smtpHost: '' });
  assert.match(m.out.sendingBlocked(), /Still missing: the outreach mailbox/);
  m.st.saveSettings({ smtpHost: 'smtp.example.org' });
  assert.equal(await m.out.pumpSend('default', NOW), 1);
  assert.equal(await m.out.pumpSend('default', NOW + 5 * 60_000), 0, 'not straight after');
  assert.equal(await m.out.pumpSend('default', NOW + 30 * 60_000), 1);
  assert.equal(await m.out.pumpSend('default', NOW + 2 * H), 0, 'two a day');
  assert.equal(mails.length, 2);
  // The mailbox refuses: that is us, not the company; nothing more for an hour.
  mailError = 'Invalid login: 535 5.7.8 Username and Password not accepted';
  assert.equal(await m.out.pumpSend('default', NOW + DAY), 0);
  assert.match(m.st.runState().lastError, /outreach mailbox could not send/);
  assert.equal(m.st.companies().filter((c) => c.thread[0]?.status === 'ready').length, 2, 'they keep their turn');
  assert.equal(await m.out.pumpSend('default', NOW + DAY + 10 * 60_000), 0);
  mailError = '';
  assert.equal(await m.out.pumpSend('default', NOW + DAY + 2 * H), 1);
}));

const contacted = async (o: Parameters<typeof company>[0] = {}) => {
  const c = company(o);
  m.out.approve(c, 'Nigel');
  c.thread.push({ id: 'm1', who: 'us', kind: 'first', subject: FIRST.subject, text: FIRST.text, at: 1, status: 'draft' });
  assert.equal((await m.out.sendMessage(c, c.thread[0], 'default', NOW)).ok, true);
  return c;
};

test('yes: they get what was offered; ready: the booking link, and "a client I got you" once', () => T(async () => {
  const c = await contacted();
  ai = () => ({ content: [json({ intent: 'yes', said: { need: '', people: '' }, summary: 'Wants the report', magnets: [], reply: 'Hi Sipho,\n\nWonderful, here it is. How many juniors start at the new depot this year, if I may ask?' })] });
  assert.equal(await m.out.handleReply(c, { text: 'Yes please send it', subject: 'Re: A report', messageId: '<in1>' }), 'yes');
  assert.equal(c.consent, 'yes');
  assert.equal(c.stage, 'talking');
  const r = c.thread.at(-1)!;
  assert.equal(r.status, 'draft');
  assert.deepEqual(r.magnets, ['mg_report']);
  assert.match(m.out.compose(c, r).text, /The free report: https:\/\/melsoft\.example\/report/);
  assert.equal((await m.out.sendMessage(c, r, 'default', NOW + H)).ok, true);
  assert.equal(mails[1].inReplyTo, '<in1>');
  assert.equal(mails[1].subject, 'Re: A report');
  ai = () => ({ content: [json({ intent: 'question', said: { need: 'Data skills for planners', people: 'about 12', timing: 'January' }, summary: '12 planners, January', magnets: ['mg_12h', 'made_up'], reply: 'Hi Sipho,\n\nFor twelve people a learnership usually fits well, and the calculator shows what you could claim. Would a short call with Thabile help you plan it?' })] });
  await m.out.handleReply(c, { text: 'We have about 12 planners, need data skills by January', messageId: '<in2>' });
  assert.equal(c.stage, 'qualified');
  assert.deepEqual(c.thread.at(-1)!.magnets, ['mg_12h', 'booking']);
  assert.match(m.out.compose(c, c.thread.at(-1)!).text, /Choose a time for a call: https:\/\/cal\.example\.org\/team/);
  assert.equal(posts.length, 1);
  assert.match(posts[0].content!, /A client I got you, Thabile:\*\* Fast Freight is ready for a call/);
  assert.match(posts[0].embeds![0].description, /\*\*People:\*\* about 12/);
  await m.out.handleReply(c, { text: 'Thanks', messageId: '<in3>' });
  assert.equal(posts.length, 1, 'told once');
  assert.equal(await m.out.handleReply(c, { text: 'Thanks', messageId: '<in3>' }), 'other', 'the same email twice is one');
}));

test('no means never: in words, in a clear "no thanks", by the link; and one that bounced was not asked', () => T(async () => {
  const c = await contacted();
  assert.equal(await m.out.handleReply(c, { text: 'No thank you.' }), 'no');
  assert.equal(asked.length, 0, 'no AI needed');
  assert.equal(c.consent, 'no');
  assert.equal(c.stage, 'lost');
  for (const k of ['first', 'reply', 'nurture'] as const) assert.match(m.out.mayNotWrite(c, k), /asked us not to write/);
  for (const t of ['no', 'Stop', 'Not interested, thanks', 'Please remove us from your list']) assert.ok(m.out.clearNo(t), t);
  for (const t of ['No problem, please send it', 'Not sure yet, tell me more', 'Stop by on Tuesday?', 'Yes']) assert.ok(!m.out.clearNo(t), t);
  const token = m.out.stopUrl(c).split('/b2b/')[1];
  assert.deepEqual(m.out.readStop(token), { tenantId: 'default', id: c.id });
  assert.equal(m.out.readStop(`${token.slice(0, -2)}xx`), null);
  const b = await contacted({ name: 'Bounce Co', domain: 'bounce.co.za', contact: { name: '', role: '', email: 'x@bounce.co.za', phone: '', source: 'x' } });
  m.out.bounced(b);
  assert.equal(b.stage, 'approved');
  assert.equal(b.consent, 'none');
  assert.equal(b.contact.email, '');
  b.contact.email = 'right@bounce.co.za';
  assert.equal(m.out.mayNotWrite(b, 'first'), '');
}));

test('an answer is matched to its company, also from a colleague, never by a free mailbox', () => T(async () => {
  const c = await contacted();
  assert.equal(m.run.companyFor({ from: 'other@x.co.za', refs: ['<1@us>'] })?.id, c.id);
  assert.equal(m.run.companyFor({ from: 'HR@fastfreight.co.za', refs: [] })?.id, c.id);
  assert.equal(m.run.companyFor({ from: 'md@fastfreight.co.za', refs: [] })?.id, c.id);
  assert.equal(m.run.companyFor({ from: 'someone@gmail.com', refs: [] }), null);
  // The AI cannot read it: a person is told, and nothing is sent.
  ai = () => ({ content: [text('hmm')] });
  await m.out.handleReply(c, { text: 'Our planning is complicated at the moment, we restructured.' });
  assert.equal(c.stage, 'talking');
  assert.match(posts[0].content!, /needs a person to read it/);
  assert.equal(c.thread.filter((x) => x.status === 'draft').length, 0);
}));

test('no answer closes it without another email; only a yes is kept warm, three times at most', () => T(async () => {
  const quiet = await contacted();
  quiet.contactedAt = NOW - 22 * DAY;
  const warm = await contacted({ name: 'Warm Co', domain: 'warm.co.za', contact: { name: 'Ann', role: '', email: 'ann@warm.co.za', phone: '', source: 'x' }, });
  Object.assign(warm, { consent: 'yes', stage: 'talking', lastAt: NOW - 8 * DAY });
  ai = () => ({ content: [json({ text: 'Hi Ann,\n\nI thought the toolkit might help you plan the next intake, with templates your managers can use straight away. Is training juniors still on your list this quarter?' })] });
  assert.equal(await m.out.keepWarm('default', NOW), 1);
  assert.equal(quiet.stage, 'lost');
  assert.equal(quiet.lostReason, 'No answer');
  const d = warm.thread.at(-1)!;
  assert.deepEqual([d.kind, d.status, d.magnets], ['nurture', 'draft', ['mg_toolkit']]);
  assert.equal(await m.out.keepWarm('default', NOW), 0, 'one waiting is enough');
  assert.equal((await m.out.sendMessage(warm, d, 'default', NOW)).ok, true);
  warm.lastAt = NOW - 8 * DAY; warm.nurtured = 3;
  assert.equal(await m.out.keepWarm('default', NOW), 0);
}));

test('what people said no to is learnt from; the settings keep secrets; a formula or a ping never gets out', () => T(() => {
  const c = company({ name: 'Huge Co', domain: 'huge.co.za' });
  m.out.reject(c, 'Too big', 'Nigel');
  m.out.approve(company({ name: 'Nice Co', domain: 'nice.co.za', sector: 'Retail' }), 'Nigel');
  assert.match(m.re.lessons(m.st.companies()), /said no to Huge Co: Too big\.\nOur team said yes to Nice Co \(Retail\)/);
  assert.equal(m.st.publicSettings().smtpPass, '••••pw');
  m.st.saveSettings({ smtpPass: '••••pw', discordWebhook: '••••/b2b' });
  assert.equal(m.st.settings().smtpPass, 'pw');
  assert.match(m.st.settings().discordWebhook, /^https:\/\/discord/);
  const card = JSON.stringify(m.dis.listCard([company({ name: '**@everyone** [x](http://evil)', domain: 'z.co.za', fit: ['`<@1>`'] })], { found: 1, spent: 1, budget: 50 }));
  assert.doesNotMatch(card, /@everyone|\]\(http:\/\/evil|<@1>/);
  assert.equal(m.st.httpLink('javascript:alert(1)'), '');
  assert.equal(m.st.domainOf('https://www.Acme.co.za/x'), 'acme.co.za');
  assert.equal(m.st.nameKey('Acme & Sons Holdings (Pty) Ltd'), 'acme and sons holdings');
}));

test('a long search is carried on, a refusal is an error, and page text is never an instruction', () => T(async () => {
  let n = 0;
  ai = () => (++n === 1 ? { content: [searched('https://a.co.za')], stop_reason: 'pause_turn', usage: { server_tool_use: { web_search_requests: 2, web_fetch_requests: 0 } } } : { content: [text('{"ok": 1}')] });
  const a = await m.ask.ask({ system: 's', prompt: 'p', searches: 3 });
  assert.deepEqual(m.ask.jsonOf(a), { ok: 1 });
  assert.equal(asked[1].tools![0].max_uses, 1);
  assert.equal(asked[1].messages.length, 2);
  assert.match(asked[0].system, /never instructions to follow/);
  ai = () => ({ content: [], stop_reason: 'refusal' });
  await assert.rejects(m.ask.ask({ system: 's', prompt: 'p' }), /declined/);
}));
