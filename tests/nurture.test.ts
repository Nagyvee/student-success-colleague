import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Lead nurturing: the parts that must be exactly right without the model.
 * Signed links, the engagement score, merge fields, the reviewer on saved
 * messages, WhatsApp scrubbing, programme matching and the career-fit quiz. */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thuso-nurture-'));
process.chdir(dir);
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DATABASE_URL', 'PGHOST', 'SMTP_HOST']) delete process.env[k];

type M = {
  ctx: typeof import('../src/lib/auth/tenantContext');
  track: typeof import('../src/lib/nurture/track');
  lib: typeof import('../src/lib/nurture/library');
  bank: typeof import('../src/lib/nurture/bank');
  prog: typeof import('../src/lib/nurture/programmes');
  fit: typeof import('../src/lib/nurture/fit');
};
let m: M;
before(async () => {
  m = {
    ctx: await import('../src/lib/auth/tenantContext'),
    track: await import('../src/lib/nurture/track'),
    lib: await import('../src/lib/nurture/library'),
    bank: await import('../src/lib/nurture/bank'),
    prog: await import('../src/lib/nurture/programmes'),
    fit: await import('../src/lib/nurture/fit'),
  };
});
const T = <R>(fn: () => R) => m.ctx.withTenant('default', fn);

test('tracked links are signed: they read back, and a changed one is refused', () => {
  const p = { t: 'default', s: 'src_leads', k: 'thandi@example.com', m: 'msg_abc', x: 'quiz' as const };
  const tok = m.track.signTrack(p);
  assert.deepEqual(m.track.readTrack(tok), p);
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...p, k: 'someone@else.com' })).toString('base64url');
  assert.equal(m.track.readTrack(`${forged}.${sig}`), null, 'another lead with the same signature');
  assert.equal(m.track.readTrack(`${body}.AAAAAAAAAAAAAAAA`), null);
  assert.equal(m.track.readTrack('nonsense'), null);
  assert.equal(m.track.readTrack(m.track.signTrack({ ...p, x: 'url', u: 'javascript:alert(1)' })), null, 'only web links redirect');
});

test('engagement: an open counts once per message, clicks count more, and the score sets the heat', () => {
  let f: Record<string, string> = {};
  const apply = (kind: 'open' | 'click' | 'quiz', key: string) => { const r = m.track.scoreUpdate(f, kind, key); f = { ...f, ...r.updates }; return r.counted; };
  assert.equal(apply('open', 'open:msg_1:open'), true);
  assert.equal(apply('open', 'open:msg_1:open'), false, 'a second open of the same email');
  assert.equal(f.engagement_score, '1');
  assert.equal(f.engagement, 'cold');
  apply('click', 'click:msg_1:quiz');
  assert.equal(f.engagement, 'warm');
  assert.equal(apply('click', 'click:msg_1:quiz'), false, 'clicking the same link again');
  assert.equal(f.nurture_clicks, '2', 'but every click is counted');
  apply('quiz', 'quiz:msg_1:quiz');
  assert.equal(f.engagement_score, '9');
  assert.equal(f.engagement, 'hot');
  assert.equal(m.track.isBot('Mozilla/5.0 (compatible; Microsoft Office SafeLinks)'), true);
  assert.equal(m.track.isBot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148'), false);
});

test('merge fields fill in per lead, and unknown ones stay visible for the check', () => {
  assert.equal(m.lib.mergeText('Hi {{first_name}}, about {{ programme }}', { first_name: 'Thandi', programme: 'Data Science' }), 'Hi Thandi, about Data Science');
  assert.equal(m.lib.mergeText('Hi {{name}}', { first_name: 'Thandi' }), 'Hi {{name}}');
});

test('the reviewer checks a saved message once: name, links, offers, unknown fields', () => T(() => {
  const base = { subject: 'Hello {{first_name}}', channel: 'email' as const, cta: { target: 'quiz' as const, label: 'Find my tech fit' }, programme: '', expiresAt: null };
  const ok = m.lib.checkMessage({ ...base, body: 'Hi {{first_name}},\n\nThank you for asking about {{programme}}. Our live classes and real projects help people start a tech career, and our team supports you all the way. Take the two-minute quiz below and reply with any question.' });
  assert.equal(ok.pass, true, ok.notes.join(' '));
  const noName = m.lib.checkMessage({ ...base, body: 'Hello there,\n\nThank you for asking about our programmes. Our live classes and real projects help people start a tech career. Reply with any question at all.' });
  assert.ok(noName.notes.some((n) => /first_name/.test(n)));
  const link = m.lib.checkMessage({ ...base, body: 'Hi {{first_name}},\n\nRead more at https://example.com about our live classes and projects, and reply with any question you have about applying.' });
  assert.ok(link.notes.some((n) => /button or as resource cards/.test(n)));
  const offer = m.lib.checkMessage({ ...base, body: 'Hi {{first_name}},\n\nThis month we have 50% off the registration fee for everyone who applies, with live classes and real projects. Reply with any question about applying.' });
  assert.ok(offer.notes.some((n) => /end date/.test(n)));
  const typo = m.lib.checkMessage({ ...base, body: 'Hi {{first_name}},\n\nThank you for asking about {{course}}. Our live classes and real projects help people start a tech career. Reply with any question about applying.' });
  assert.ok(typo.notes.some((n) => /\{\{course\}\}/.test(n)));
}));

test('every hand-written starter message passes the reviewer, so it can be approved', () => T(() => {
  for (const canApply of [true, false]) {
    for (const d of m.lib.starterTemplates('Melsoft Academy', canApply)) {
      const target = /application/i.test(d.ctaLabel) ? 'apply' : /reply/i.test(d.ctaLabel) ? 'reply' : /video/i.test(d.ctaLabel) ? 'video' : 'quiz';
      const r = m.lib.checkMessage({ subject: d.subject, body: d.body, waBody: d.waBody, channel: 'email', cta: { target, label: d.ctaLabel }, programme: '', expiresAt: null });
      assert.equal(r.pass, true, `${d.name}: ${r.notes.join(' ')}`);
    }
  }
}));

test('a WhatsApp export loses names, numbers and emails before anything reads it', () => {
  const raw = [
    '12/03/2025, 14:22 - Thandi Mokoena: Hi, how much is the Data Science course?',
    '12/03/2025, 14:25 - Melsoft Admissions: Hi Thandi! Call us on 082 123 4567 or email admissions@melsoft.org',
    '12/03/2025, 14:26 - Thandi Mokoena: <Media omitted>',
    '[13/03/2025, 09:01:12] +27 82 555 1234: Can I study part time?',
    '13/03/2025, 09:02 - Messages and calls are end-to-end encrypted.',
  ].join('\n');
  const { text, people } = m.bank.scrubChat(raw);
  assert.equal(people, 3);
  assert.ok(!/Thandi Mokoena|Melsoft Admissions/.test(text), text);
  assert.ok(!/082 123 4567|555 1234|admissions@melsoft\.org/.test(text), text);
  assert.ok(/Person A: Hi, how much is the Data Science course\?/.test(text));
  assert.ok(!/Media omitted|end-to-end/.test(text));
});

test('a lead\'s free-text interest finds the nearest programme', () => {
  const list = ['Software Development', 'Data Science', 'Cybersecurity', 'AI Software Development'];
  assert.equal(m.prog.matchProgramme('coding', list), 'Software Development');
  assert.equal(m.prog.matchProgramme('Data Analytics', list), 'Data Science');
  assert.equal(m.prog.matchProgramme('ethical hacking', list), 'Cybersecurity');
  assert.equal(m.prog.matchProgramme('AI and machine learning', list), 'AI Software Development');
  assert.equal(m.prog.matchProgramme('web development', list), 'Software Development');
  assert.equal(m.prog.matchProgramme('nursing', list), null);
  assert.equal(m.prog.leadProgramme({ interest: 'coding', fit_programme: 'Cybersecurity' }, list), 'Cybersecurity', 'the quiz result wins');
});

test('the career-fit quiz has a track per programme and scores answers by majority', () => {
  const quiz = m.fit.templateQuiz(['Software Development', 'Data Science', 'Cybersecurity', 'AI Software Development'], 'Melsoft Academy')!;
  assert.deepEqual(quiz.tracks.map((t) => t.programme), ['Software Development', 'Data Science', 'Cybersecurity', 'AI Software Development']);
  assert.ok(quiz.questions.length >= 5);
  for (const q of quiz.questions) assert.equal(q.options.length, 4, q.prompt);
  const protector = quiz.tracks.find((t) => t.programme === 'Cybersecurity')!;
  const answers: Record<string, number> = {};
  for (const q of quiz.questions) answers[q.id] = q.options.findIndex((o) => o.track === protector.id);
  answers.q1 = quiz.questions[0].options.findIndex((o) => o.track !== protector.id);
  assert.equal(m.fit.scoreFit(quiz, answers).track.programme, 'Cybersecurity');
  assert.equal(m.fit.templateQuiz(['Nursing'], 'X'), null, 'no quiz without two matching programmes');
});

test('YouTube feeds are read without an API key', () => {
  const xml = `<feed><entry><yt:videoId>abc123DEF45</yt:videoId><title>A day at Melsoft &amp; friends</title><published>2026-10-01T10:00:00+00:00</published><media:group><media:description>What a week in Software Development looks like.</media:description></media:group></entry></feed>`;
  const v = m.bank.parseYoutubeFeed(xml);
  assert.equal(v.length, 1);
  assert.equal(v[0].id, 'abc123DEF45');
  assert.equal(v[0].title, 'A day at Melsoft & friends');
  assert.equal(m.bank.youtubeId('https://youtu.be/abc123DEF45?t=3'), 'abc123DEF45');
  assert.equal(m.bank.youtubeId('https://www.youtube.com/shorts/abc123DEF45'), 'abc123DEF45');
});

test('replies from the mailbox: only what they wrote, never an auto-reply, the right IMAP server', async () => {
  const w = await import('../src/lib/email/watch');
  assert.equal(w.replyText('Yes please, evenings work for me.\n\nOn Mon, 16 Nov 2026 at 10:02, Naledi <admissions@melsoft.org> wrote:\n> Hi Thandi,\n> Would evenings suit you?'), 'Yes please, evenings work for me.');
  assert.equal(w.replyText('Thanks!\n> quoted line\nSent from my iPhone'), 'Thanks!');
  assert.equal(w.replyText('Sure\n-----Original Message-----\nFrom: x'), 'Sure');
  const headers = (h: Record<string, string>) => new Map(Object.entries(h));
  const mail = (subject: string, h: Record<string, string> = {}, from = 'thandi@example.com') => ({ subject, headers: headers(h) as never, from: { value: [{ address: from, name: '' }], html: '', text: '' } as never });
  assert.equal(w.isAutomatic(mail('Re: your video')), false);
  assert.equal(w.isAutomatic(mail('Automatic reply: Out of office')), true);
  assert.equal(w.isAutomatic(mail('Re: hi', { 'auto-submitted': 'auto-replied' })), true);
  assert.equal(w.isAutomatic(mail('Weekly news', { 'list-id': '<news.example.com>' })), true);
  assert.equal(w.isAutomatic(mail('Delivery Status Notification (Failure)', {}, 'mailer-daemon@googlemail.com')), true);
  assert.equal(w.derivedHost('smtp.gmail.com'), 'imap.gmail.com');
  assert.equal(w.derivedHost('smtp.office365.com'), 'outlook.office365.com');
  assert.equal(w.derivedHost('smtp.example.co.za'), 'imap.example.co.za');
  assert.equal(w.derivedHost('mail.example.com'), 'mail.example.com');
});

test('messages never carry emoji', async () => {
  const { noEmoji } = await import('../src/lib/ai/llm');
  assert.equal(noEmoji('Hi Thandi 👋, great news 🎉!'), 'Hi Thandi, great news!');
  assert.equal(noEmoji('Line one 🚀\nLine two'), 'Line one\nLine two');
});

test('an agent email: greeting first, one introduction, one signature', () => T(() => {
  return import('../src/lib/email/send').then(({ ensureStructuredMessage }) => {
    const s = ensureStructuredMessage({ recipientName: 'Nigel Mafuta', body: 'Hi Nigel,\n\nI made you a short video.\n\nWould a 10-minute call help?\n\nZinhle', agentName: 'Zinhle', officeName: 'Admissions' });
    const paras = s.paragraphsText.split('\n\n');
    assert.equal(paras[0], 'Hi Nigel,');
    assert.match(paras[1], /^This is Zinhle from Admissions/);
    assert.ok(!/\n\nZinhle$/.test(s.paragraphsText), 'the bare name at the end is dropped (the signature adds it)');
    const inline = ensureStructuredMessage({ recipientName: 'Nigel', body: 'Hi Nigel, thanks for writing back.\n\nHere is what I found.', agentName: 'Thabo', officeName: 'Admissions' });
    assert.deepEqual(inline.paragraphsText.split('\n\n').slice(0, 3), ['Hi Nigel,', 'This is Thabo from Admissions at ' + inline.academyName + '.', 'Thanks for writing back.']);
  });
}));

test('voucher codes: the prefix, four letters of the name, four random characters, never twice', async () => {
  const v = await import('../src/lib/nurture/vouchers');
  T(() => {
    const a = v.makeCode('mel', 'Thandi');
    assert.match(a, /^MEL-THAN-[A-HJ-NP-Z2-9]{4}$/);
    assert.match(v.makeCode('BF', 'Jo'), /^BF-JOXX-/);
    assert.equal(v.valueText({ kind: 'amount', value: 1000 }), 'R 1 000 off', 'South African spacing');
    assert.equal(v.valueText({ kind: 'percent', value: 50 }), '50% off');
    const o = { expiry: { kind: 'days', days: 14 } } as Parameters<typeof v.expiresFor>[0];
    const end = v.expiresFor(o, new Date('2026-11-16T10:00:00').getTime());
    assert.equal(new Date(end).getDate(), 30);
  });
});

test('keep in touch picks what they have not had: an offer, then other messages, then something useful', () => T(() => {
  const lib = m.lib;
  const mk = (name: string, stage: 'offer' | 'learn' | 'trust', extra: Record<string, unknown> = {}) => {
    const x = lib.saveMessage({ name, stage, subject: `Hi {{first_name}} ${name}`, body: 'Hi {{first_name}},\n\nOur live classes and real projects help people like you start a tech career, with support from our team all the way through the programme. Reply with any question about applying and we will help.', cta: { target: 'reply', label: 'Just reply' }, ...extra });
    return lib.approveMessage(x.id, 'test').message!;
  };
  const learn = mk('Ongoing learn', 'learn');
  const trust = mk('Ongoing trust', 'trust');
  const offer = mk('Ongoing offer', 'offer', { expiresAt: Date.now() + 86_400_000 });
  const others = lib.listMessages().filter((x) => ![learn.id, trust.id, offer.id].includes(x.id)).map((x) => x.id);
  const fields = (sent: string[]) => ({ first_name: 'Thandi', nurture_sent: [...others, ...sent].join('|') });
  assert.equal(lib.pickOngoing(fields([]))?.id, offer.id, 'a live offer first');
  assert.equal(lib.pickOngoing(fields([offer.id]))?.id, learn.id);
  assert.equal(lib.pickOngoing(fields([offer.id, learn.id]))?.id, trust.id);
  assert.equal(lib.pickOngoing(fields([offer.id, learn.id, trust.id])), null, 'nothing new and no guides: the agent writes a check-in instead');
}));

test('footage goes where it fits: a welcome shot for the greeting, a celebration at the end, diagrams stay clean', async () => {
  const media = await import('../src/lib/nurture/media');
  const { mediaDoc } = await import('../src/lib/nurture/store');
  T(() => {
    const item = (id: string, tags: string[], kind: 'video' | 'photo' = 'video') => ({ id, kind, fileId: `f_${id}`, title: id, tags, description: '', mime: 'video/mp4', size: 1, enabled: true, createdAt: 0 });
    mediaDoc.set([item('wave', ['welcome', 'team']), item('grad', ['graduation', 'celebration']), item('class', ['students', 'classroom']), item('code', ['coding', 'laptop'], 'photo')]);
    const slides = [{ visual: 'greeting' }, { visual: 'flow' }, { visual: 'big' }, { visual: 'recap' }, { visual: 'cta' }] as { visual: 'greeting' | 'flow' | 'big' | 'recap' | 'cta' }[];
    const lead = media.footageFor(slides, 'Software Development', 'lead');
    assert.match(lead[0]!.url, /f_wave(&|$)/, 'greeting: the welcome clip');
    assert.equal(lead[1], null, 'a diagram stays clean');
    assert.match(lead[2]!.url, /f_code(&|$)/, 'a big moment in a software video: coding footage');
    assert.match(lead[4]!.url, /f_grad(&|$)/, 'the ending: the celebration');
    const lesson = media.footageFor(slides, 'JS-07', 'lesson');
    assert.equal(lesson[2], null, 'a lesson keeps teaching scenes clean');
    assert.ok(lesson[0] && lesson[4]);
    mediaDoc.set([]);
    assert.deepEqual(media.footageFor(slides, 'x', 'lead'), [null, null, null, null, null], 'no footage: the animated backdrop');
  });
});

test('a lead profile in plain words, whichever form they filled in', async () => {
  const { leadProfile, fundingOf, budgetOf } = await import('../src/lib/nurture/profile');
  const { leadProgramme } = await import('../src/lib/nurture/programmes');
  // Meta's affordability form
  assert.deepEqual(leadProfile({ how_will_you_finance_the_program: 'i_require_a_student_loan', how_much_can_you_put_towards_your_studies_each_month: 'under_r1,500_per_month' }),
    { funding: 'loan', funding_said: 'Needs a student loan', monthly_budget: 'Under R1 500 a month' });
  assert.equal(leadProfile({ how_will_you_finance_the_program: 'a_family_or_friend_will_sponsor_me' }).funding, 'family');
  assert.equal(leadProfile({ how_will_you_finance_the_program: 'tbd_with_student_advisor' }).funding, 'undecided');
  assert.deepEqual(leadProfile({ how_much_can_you_put_towards_your_studies_each_month: 'i_can_pay_upfront' }), { funding: 'self', funding_said: 'Paying for themselves', monthly_budget: 'Can pay the fee upfront', pay_preference: 'upfront' });
  assert.equal(budgetOf('r1,500_-_r3,000_per_month').band, '1500_3000');
  assert.equal(budgetOf('r3,000+_per_month').band, '3000_plus');
  // TikTok and the WhatsApp bot
  assert.equal(fundingOf('I require a student loan'), 'loan');
  assert.equal(fundingOf('TBD - Advisor to discuss'), 'undecided');
  assert.deepEqual(leadProfile({ payment_plan: '12 installments', track: 'bootcamp' }), { funding: 'self', funding_said: 'Paying for themselves', pay_preference: '12 monthly instalments', track: 'bootcamp' });
  assert.equal(leadProfile({ programme_id: 'cybersecurity-analyst' }).track, 'accredited');
  assert.equal(leadProfile({ programme_id: 'cyber-security' }).track, 'bootcamp');
  // Programme names as each form writes them
  const list = ['Software Development', 'Data Science', 'Cybersecurity', 'AI Software Development'];
  assert.equal(leadProgramme({ interest: 'cyber_security' }, list), 'Cybersecurity');
  assert.equal(leadProgramme({ interest: 'data_science' }, list), 'Data Science');
  assert.equal(leadProgramme({ programme: 'Cybersecurity 101' }, list), 'Cybersecurity');
  assert.equal(leadProgramme({ programme_id: 'ai-software-engineering' }, list), 'AI Software Development');
  assert.equal(leadProgramme({ interest: 'tbd_with_student_advisor' }, list), '');
});

test('a message aimed at a way of paying: Black Friday skips student-loan leads, the loan welcome goes to them', async () => {
  const { fitsFunding } = await import('../src/lib/nurture/library');
  const blackFriday = { funding: ['self', 'family', 'undecided'] as ('self' | 'family' | 'undecided')[] };
  assert.equal(fitsFunding(blackFriday, { how_will_you_finance_the_program: 'i_require_a_student_loan' }), false);
  assert.equal(fitsFunding(blackFriday, { how_will_you_finance_the_program: 'i_will_fund_my_self' }), true);
  assert.equal(fitsFunding(blackFriday, {}), true, 'a lead who did not say still gets it');
  assert.equal(fitsFunding({ funding: ['loan'] }, { payment_plan: 'I require a student loan' }), true);
  assert.equal(fitsFunding({}, { funding: 'loan' }), true, 'no restriction: everyone');
});

test('the voice says rand, percent, times and acronyms the way a South African presenter would', async () => {
  const { forSpeech, numberWords } = await import('../src/lib/media/speech');
  assert.equal(numberWords(37499), 'thirty-seven thousand, four hundred and ninety-nine');
  assert.equal(numberWords(8000), 'eight thousand');
  assert.equal(numberWords(1500), 'one thousand, five hundred');
  assert.equal(numberWords(74999), 'seventy-four thousand, nine hundred and ninety-nine');
  assert.equal(numberWords(2024), 'two thousand and twenty-four');
  assert.equal(forSpeech('Accredited programmes are R 37 499 instead of R 74 999.'), 'Accredited programmes are thirty-seven thousand, four hundred and ninety-nine rand instead of seventy-four thousand, nine hundred and ninety-nine rand.');
  assert.equal(forSpeech('Pay R8 000 by 31 December, then 12 x R 3 997.'), 'Pay eight thousand rand by 31 December, then twelve payments of three thousand, nine hundred and ninety-seven rand.');
  assert.equal(forSpeech('From R1 500 - R3 000 a month'), 'From one thousand, five hundred to three thousand rand a month');
  assert.equal(forSpeech('R37,499.50 total'), 'thirty-seven thousand, four hundred and ninety-nine rand and fifty cents total');
  assert.equal(forSpeech('Save 50% when you pay in full.'), 'Save fifty percent when you pay in full.');
  assert.equal(forSpeech('Live classes Mon–Thu 10:00–16:00 SAST.'), 'Live classes Monday to Thursday ten to four South African time.');
  assert.equal(forSpeech('Pay before 23:59.'), 'Pay before eleven fifty-nine.');
  assert.equal(forSpeech('An NQF Level 5 qualification, SAQA ID 118708, QCTO and MICT SETA accredited.'), 'An N Q F Level 5 qualification, S A Q A I D 118708, Q C T O and M I C T SETA accredited.');
  assert.equal(forSpeech('Takes 12–18 months.'), 'Takes twelve to eighteen months.');
  assert.equal(forSpeech('Learn AI with Python & SQL'), 'Learn A I with Python and sequel');
});
