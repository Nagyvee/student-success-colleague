import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* B2B outbound against a pretend AI, Discord and mail server: only companies
 * and addresses that were really read, never more than the budget, never
 * someone on our own list or asked before, one email until they answer, and
 * no means no. */

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
};
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
    run: await import('../src/lib/outbound/run'), out: await import('../src/lib/outbound/outreach'), ask: await import('../src/lib/outbound/ask'), dis: await import('../src/lib/outbound/discord'),
  };
  m.out.mailer.make = (() => ({
    sendMail: async (x: Mail) => { if (mailError) throw new Error(mailError); mails.push(x); return { messageId: `<${mails.length}@us>` }; },
    verify: async () => true,
  })) as unknown as typeof m.out.mailer.make;
});

const READY = {
  researchOn: true, perDay: 2, showPerDay: 10, hour: 7, budgetUsd: 50, services: 'Learnerships and team training in software, data and cybersecurity', ideal: 'Growing firms that employ many juniors', sectors: 'Logistics, Retail', provinces: 'Gauteng, KwaZulu-Natal', sizeMin: 20, sizeMax: 200, avoid: 'Blocked Co, never.co.za', searchIdeas: [],
  discordWebhook: 'https://discord.com/api/webhooks/9/b2b', sendingOn: true, checkFirst: true, checkReplies: true, sendPerDay: 2, smtpHost: 'smtp.example.org', smtpPort: 465, smtpUser: 'team@out.example.org', smtpPass: 'pw', fromName: 'Naledi M', fromTitle: 'Partnerships', bookingLink: 'https://cal.example.org/team', address: '1 Main Road, Durban', callsWith: 'Thabile',
  magnets: [{ id: 'mg_report', name: 'The free report', about: 'What training juniors costs and returns', link: 'https://melsoft.example/report', when: 'open', on: true }, { id: 'mg_toolkit', name: 'The toolkit', about: '', link: 'https://melsoft.example/toolkit', when: 'yes', on: true }, { id: 'mg_12h', name: 'The 12H calculator', about: 'What you could claim back', link: 'https://melsoft.example/12h', when: 'yes', on: true }],
};

beforeEach(() => T(() => {
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
      { name: 'Good Co', website: 'https://good.co.za', why: 'hiring juniors', url: 'https://www.good.co.za/careers' },
      { name: 'Named In News', website: 'named.co.za', why: 'growing', url: 'https://news.example/list' },
      { name: 'Made Up', website: 'https://madeup.co.za', why: 'x', url: 'https://nowhere.example' },
      { name: 'Social', website: 'https://linkedin.com/company/social', why: 'x', url: 'https://linkedin.com/company/social' },
      { name: 'Known One (Pty) Ltd', website: 'https://known.co.za', why: 'x', url: 'https://news.example/list' },
      { name: 'Blocked Co', website: 'https://blocked.co.za', why: 'x', url: 'https://news.example/list' },
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
const ANSWER = { name: 'Good Co', what: 'A courier company.', sector: 'Logistics', city: 'Durban', province: 'KwaZulu-Natal', employees: 'about 80', facts: [{ text: 'Advertising six junior roles', url: 'https://good.co.za/careers' }, { text: 'Invented', url: 'https://good.co.za/never-opened' }], fit: ['Hires juniors'], concerns: '', service: 'Data learnership', magnet: 'mg_report', like: ['Imperial Logistics', 'Nobody'], contact: { name: 'Ann Botha', role: 'HR manager', email: 'HR@good.co.za', phone: '031 000 0000' }, score: 9, scoreWhy: 'Hiring now' };

test('a fact needs a page that was opened, and an address must be written on one', () => T(async () => {
  m.re.addIdeals('Imperial Logistics');
  ai = () => ({ content: [read('https://good.co.za/careers', 'Join us! Six junior roles.'), read('https://good.co.za/contact', 'Write to hr (at) good.co.za'), json(ANSWER)] });
  const { company: c } = await m.re.research(CAND);
  assert.deepEqual(c!.facts.map((x) => x.text), ['Advertising six junior roles']);
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

test('a day: it looks, reads one company at a time, posts the best in the B2B channel, and stops', () => T(async () => {
  const cos = ['One', 'Two', 'Three'];
  ai = (r) => {
    const p = String(r.messages[0].content);
    if (/list up to 12 companies/.test(p)) return { content: [searched('https://n.example/a'), json({ companies: cos.map((n) => ({ name: `${n} Co`, website: `https://${n.toLowerCase()}.co.za`, why: 'x', url: 'https://n.example/a' })) })] };
    const n = cos.find((x) => p.includes(`${x} Co`))!;
    return { content: [read(`https://${n.toLowerCase()}.co.za/x`, `hi@${n.toLowerCase()}.co.za`), json({ ...ANSWER, name: `${n} Co`, facts: [{ text: 'A fact', url: `https://${n.toLowerCase()}.co.za/x` }], contact: { email: `hi@${n.toLowerCase()}.co.za` }, score: n === 'Two' ? 9 : 6 })] };
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
  assert.match(m.out.sendingBlocked(), /its own, not the Admissions one/);
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
