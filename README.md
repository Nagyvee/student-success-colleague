# Thuso · the academy's AI operations building

> *Thuso* means **help** in Sesotho and Setswana.

**Thuso is a building of AI agents that runs the academy's day-to-day
follow-up work.** Each floor is a department. Each department has a few
agents. Each agent has one job: a workflow of AI steps that starts by itself
(a new lead from an ad, a row in the student tracker, a failed quiz, an
overdue fee), works out what to do, writes to the person, checks its own
work, follows up for days if it has to, and tells the team what happened.

It started as a 24-hour hackathon entry (*Colleague Zero: "Don't build a
chatbot. Build a colleague."*) with one student success team. It is now the
engine for every department.

---

## The building

| Floor | Department | Agents and their jobs |
|---|---|---|
| 5 | **Finance & Operations** | Payment reminders from the fees tracker. **Kagiso** reminds students 3 days before a fee is due. **Refilwe** follows up overdue accounts every 3 days until they are paid, an arrangement is made or the student replies, then hands over to the finance manager. **Musa** sends management a weekly collections report. |
| 4 | **Learning & Assessment** | From Moodle. **Lindiwe** builds a student who failed a quiz a **personal video lesson that greets them by name** ("Hey Nigel, how are you? I noticed…") and a **10-question test** on exactly what they missed, then follows up on the result. **Tumi** sends a revision plan 5 days before an assignment is due. **Thandi** sends the learning team a Monday academic report (results below the pass mark, overdue work, what is due this week, who finished). |
| 3 | **Student Success** | From Moodle. **Bongani** checks in when a student goes quiet (5 days). **Nomsa** names a student's overdue assignments, offers help, checks every 3 days and thanks them when the work is in. **Zodwa** answers students' emails with their real progress and hands anything sensitive to a person. **Mpho** starts placement when Moodle shows a finished course. **Karabo** sends the Monday at-risk report. |
| 2 | **B2B Sales** | Paused: another system does this. **Sipho** (prospect research) and **Lerato** (outreach) can be switched on under Agents & Workflows. |
| 1 | **Admissions** | **Naledi** walks every lead from ads through a journey of saved messages (welcome and career-fit quiz, their programme video, proof, an invitation to apply). **Zinhle** gives a lead who turns hot a personal note and asks a consultant to call. **Thabo** answers enquiries and hands complex ones to a consultant. **Ayanda** helps applicants finish enrolment and welcomes new students. |

These are the starting point. Every department, agent and step can be
changed under **Agents & Workflows**, or you can describe a new job in words
and let the AI build the steps.

## How an agent works

**When it starts** (the trigger):

| Trigger | Example |
|---|---|
| A new row in a sheet | A new company on the prospects sheet |
| A field changes | A lead's status becomes "applied" |
| A scheduled check | Every morning at 09:00: every account where `payment_state` is overdue |
| A lead from ads | Meta lead forms, a website form, Zapier or Make |
| An LMS event | Quiz failed, no login for N days, missed classes |
| A reply | The person replied to an email |
| A schedule | Every Monday at 08:00 (reports) |
| Manual | Only when someone presses Run |

**What it does** (the steps, top to bottom, with branches):

| Step | What happens |
|---|---|
| AI message | The agent writes a personal email and/or WhatsApp from the record, its history and what it knows about the academy. The **reviewer checks it before it goes** (see below). |
| AI task | The agent works something out (qualify a lead, research a company, summarise the tracker) and saves it on the record. |
| Video lesson + test | The tutoring team builds the personal video lesson and N-question test. |
| Condition | Yes/no by a rule (`payment_state is paid`) or by the agent's judgement ("Does this need a human?"). |
| Wait | Real hours or days. Runs are saved and continue after a restart. |
| Repeat | Follow up every N hours, at most N times, until a condition holds. It always stops when the person replies. |
| AI call | A phone call through the dialer's AI caller. |
| Update record | Set a field (and write it back to the sheet if write-back is set up). |
| Notify team | Brief a person with the agent's summary. |
| Webhook | Send the record to another system (CRM, ERP). |

## The reviewer, Approval Mode and Safe Test Mode

- **The reviewer's rules are code** (`src/lib/engine/agentAudit.ts`). A
  message is sent back if it does any of the following:
  - doesn't use the person's name;
  - labels them ("at risk", "debtor", "defaulter");
  - threatens (legal action, suspension, collections);
  - uses pressure tactics;
  - leaves a placeholder unfilled;
  - is too long for WhatsApp;
  - for finance, doesn't state the exact amount or offer an arrangement.

  The agent rewrites it and the rules re-check it. If it still fails, it
  waits for a person, even when Approval Mode is off.
- **Approval Mode** (on by default): every message to a student or a lead
  waits in the Inbox until someone approves it, and the agent then sends it
  and carries on. This covers AI-written messages, saved messages from the
  library, vouchers (the code is made only when approved) and test-result
  emails. A rejected saved message is skipped and the journey carries on; a
  rejected AI message stops that run. Reports and hand-offs to the team are
  internal and are not held.
- **Follow-up loops wait first**: a "repeat" step waits its interval before
  its first round, so a follow-up never lands right after the message before it.
- **Safe Test Mode** (Live Outreach off, the default): nothing leaves the
  building. Emails appear in the Inbox tab; WhatsApp and calls are logged.
- **Autopilot** (off by default): off, agents only run when you press Run;
  on, they start by themselves from their triggers.

## Lead nurturing (Admissions)

**Lead Nurturing** in the menu is the Admissions floor's marketing desk. The
rule is *write once, send to many*, so AI cost per lead stays close to zero:

1. **Everyone gets saved messages.** The message library holds messages for
   each stage (welcome, learn, trust, offer, decide, re-engage). Each one is
   written once (by a person, or by AI from a one-line brief such as "50% off
   the registration fee until 30 November"), checked by the reviewer's rules
   once, and approved by a person once. Sending it merges `{{first_name}}` and
   `{{programme}}`, attaches the guide or video that fits the lead, and tracks
   every link. No AI per send. Offers carry an end date and are never sent
   after it.
2. **Made once, personal for each.** The career-fit quiz ("Which tech path
   fits you?") and one animated video per programme are made once. A lead's
   video opens with a scene made for them alone ("Hey Thandi, I noticed you're
   interested in Data Science and your quiz said you're the Detective…"), from
   their record, without AI. The shared scenes' narration is recorded once.
3. **Hot leads and replies: AI sells.** Opens (+1), clicks (+3), the video
   (+4), the quiz (+5) and replies (+6) score a lead: 3 is warm, 8 is hot. A
   lead turning hot starts Zinhle, who reads what they did, makes them a
   **video of their own** (two or three scenes about their goal and their
   question, then their programme), sends it with a personal note, and asks a
   consultant to call today. Every reply goes to Thabo, who answers it in the
   same email thread like a good admissions consultant: what they asked first,
   then what holds them back, a real offer if one is live, and a concrete next
   step. He respects "please stop", hands sensitive things to a person, and
   flags anyone ready to sign up. The welcome also carries one AI sentence
   about what they wrote on the form.

**Until they buy.** After the first five messages, Naledi keeps in touch:
weekly for two months, then every three weeks, each time with the next thing
that lead has not had (a live offer, another message, a guide or video), or a
short AI check-in when there is nothing new. It pauses while they are talking
with us and stops when they apply or unsubscribe. A lead who turns hot is taken
over by Zinhle (Naledi stops, so they hear from one person), who keeps giving
them new reasons to say yes every three days, then stays close.

**Vouchers** (Lead Nurturing → Vouchers): the team sets up each voucher once
(R or % off, what it is for, a fixed end date or N days, whether it can be
passed on) and makes it active. The agents decide who gets one (Zinhle for hot
leads, Thabo when cost comes up, or a campaign), the code is made by the system
(`MEL-THAN-7K3Q`, never by AI), and every code is tracked until someone marks
it used. A shared voucher opens a page where the friend leaves their details
and becomes a lead with the code.

**Videos that look like video.** Lessons and lead videos play with a moving
camera on every scene, cuts where the old scene hands straight into the next,
a warm light sweep into the big moments, a living backdrop (colour field,
drifting lights, film grain, vignette), titles that rise word by word, and a
soft music bed with a whoosh on cuts (viewers can switch music off). The
academy's own footage (Lead Nurturing → Content bank → Footage and music) plays
behind the greeting and the big moments, slowly zooming and graded into the
brand; each scene picks a clip by its tags (welcome, students, coding,
celebration…), by rules. An uploaded music track replaces the built-in bed.

**Emails that land.** Notes from one person to a lead (Thabo, Zinhle) use a
plain personal layout, come from the agent by name ("Zinhle · Melsoft
Academy"), and carry one-click unsubscribe headers; every email has preview
text for the inbox list.

**See it as a lead** (Lead Nurturing → Journey): pick a programme and the
whole journey lands in your Inbox as a sample lead, in order, with working
quiz and video buttons. Nothing goes to a real lead and nothing is counted.

**Replies** (Lead Nurturing → Journey → Replies): SMTP only sends, so the same
mailbox is read over IMAP once a minute (Gmail: `imap.gmail.com`, the same app
password, IMAP on in Gmail settings). Only mail from leads and students is
answered; auto-replies, bounces, newsletters and strangers are ignored, mail
from before it was switched on is never answered, nothing is marked read, and
after four AI answers to one person in a day a person takes over.

**The content bank** holds what the nurturing shares and learns from: PDF
guides (uploaded, served through tracked links), YouTube videos (imported
from the channel's public feed, no API key), links, notes, and FAQs learned
from a WhatsApp chat export (names, numbers and emails are removed before
anything is read; only the questions and answers are kept). Each item is read
by AI once; choosing what fits a lead is rules.

**Campaigns** send one approved message to a group (all warm leads, everyone
interested in Data Science, leads never messaged) now or later, a few at a
time. Nobody gets the same message twice.

**Consent.** Every marketing email has a "Stop these emails" link (a page with
a button, so mail scanners cannot unsubscribe anyone). Unsubscribing stops the
lead's journeys and campaigns leave them out. Link checkers are not counted as
clicks.

Leads come from the leads sheet (Facebook and TikTok lead forms → Google Sheet
→ Lead Nurturing → Journey → paste the link) or the leads webhook below. The
first read of the sheet imports the leads already on it without messaging
them; welcome them with a campaign to "Leads we have never messaged".

## Connecting the data

**The student tracker** (Channels & API → Data sources): paste the Google
Sheets link of the tab (shared "Anyone with the link: Viewer"). Thuso reads it
every 30 seconds, maps the columns itself (student number, name, email, cell,
course, total fees, paid to date, outstanding balance, next payment date,
account status…), and works out `payment_state` (paid, due, overdue,
arrangement) and `days_overdue` from the balance and the due date. The first
read is a baseline: nobody is messaged because a sheet was connected. Each tab
(fees, prospects…) is its own data source with its own link.

**Leads from ads**: send each lead to

```
POST /api/webhooks/leads?tenant=<workspace slug>
X-Thuso-Token: <inbound token from Channels & API>

{ "full_name": "Thandi Mokoena", "email": "thandi@example.com",
  "phone_number": "082 123 4567", "course": "Data Analytics",
  "campaign": "Nov intake - Facebook" }
```

Zapier, Make and Meta lead forms' `field_data` are understood. Email replies
reach the agents through `/api/webhooks/email-reply` with the same token.

**What the agents know** (Channels & API): programmes, fees, intakes,
policies and the application link. The agents use it and never invent beyond
it.

**Moodle** (Channels & API → LMS): every sync (every 5 minutes, and from
Students → Sync) writes each student to the built-in **Students from Moodle**
list with the fields the agents use: `days_since_login`, `missed_assignments`
and `overdue_work`, `last_score` and `failed_assessment`, `completion` and
`course_completed`, `risk_band`, and the next assignment due
(`next_assessment_date`, `next_assessment_name`). The first sync is a baseline
and contacts nobody. After that, a new failed quiz goes to Lindiwe, new overdue
work to Nomsa, a student who newly goes quiet to Bongani, a finished course to
Mpho; Tumi checks due dates every morning. Students who finished or were
withdrawn are never contacted. Set the course IDs of the intakes studying now,
so past students are not synced at all.

**Go-live checklist** (Control → Go-live checklist): what is connected, what
is missing and where to fix it, read from the live workspace, with a button
that copies the to-do list.

## Architecture

- **Next.js 15 (App Router), TypeScript, Anthropic SDK (Claude), Nodemailer,
  Postgres (optional).**
- One always-on Node process. It reads the sheets, resumes waiting runs, runs
  scheduled checks and pushes live state to every open screen over
  server-sent events.
- **Persistence.** New stores (agent runs, records, schedules) use
  `tenantDoc`: in memory, written to `.data/`, and to Postgres (`tenant_kv`)
  when `DATABASE_URL` is set, so a redeploy keeps waiting runs.

| Path | What it is |
|---|---|
| `src/lib/engine/departments.ts` | The floors, agents and their default jobs; the one-time migration. |
| `src/lib/engine/agentRuns.ts` | The runtime: steps, waits, repeats, approvals, resume after restart. |
| `src/lib/engine/agentTriggers.ts` | What starts an agent: sheet events, schedules, leads, LMS events, replies. |
| `src/lib/engine/agentAudit.ts` | The reviewer's rules for every message. |
| `src/lib/ai/agentMind.ts` | How agents write, judge, do tasks, brief the team and build workflows from words. |
| `src/lib/data/sources.ts`, `records.ts`, `conditions.ts` | Sheets as data sources, column mapping, money/date parsing, rules. |
| `src/lib/engine/scenarios/goal.ts` | The tutoring team's run: diagnose → video lesson + test → review → deliver. |
| `src/app/api/departments/route.ts` | The building's API. |
| `src/lib/nurture/` | Lead nurturing: the message library, content bank, tracked links and scoring, campaigns, the career-fit quiz, programme videos. |
| `src/app/go/[token]`, `src/app/fit/[token]`, `src/app/watch/[token]` | What a lead opens: tracked links (and unsubscribe), the quiz, their video. |

Every model call is validated JSON with a timeout and a deterministic
fallback, so a run always finishes. Without any keys, Thuso runs in
simulation.

## Run it

```bash
npm install
npm run dev          # http://localhost:3200
npm test             # engine tests (no keys, no database needed)
npm run typecheck
```

Copy `.env.example` to `.env.local`. The important variables:

| Variable | Why |
|---|---|
| `SESSION_SECRET` | **Required in production.** 32+ random characters; signs sign-in cookies. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | The agents think with Claude (otherwise the playbook). |
| `SMTP_*`, `EMAIL_FROM` | Real email (still only with Live Outreach on). |
| `DATABASE_URL` | Postgres, so runs, records and settings survive redeploys. |
| `PUBLIC_BASE_URL` | Where lesson and test links open (reachable from a phone). |
| `ELEVENLABS_API_KEY` / `OPENAI_API_KEY` / `DEEPGRAM_API_KEY` | A natural voice for the video lessons (else the browser's voice). |
| `DIALER_URL`, `DIALER_API_KEY` | AI phone calls. |
| `ALLOW_SIGNUPS=false` | Stop strangers registering workspaces on your server. |
| `AGENT_WAIT_SCALE` | Testing only: `360` makes a 1-hour wait take 10 seconds. |

## Deploy it

Melsoft runs Thuso on its own **Windows VPS**: one always-on Node process (the
agents' engine lives inside it), started at boot and restarted if it stops,
with Caddy in front for HTTPS and a nightly backup of `.data`. Step by step:
[deploy/windows/README.md](deploy/windows/README.md) (`install.ps1` once,
`update.ps1` after every push). Set `PUBLIC_BASE_URL` to the public address.
`DATABASE_URL` is optional on a VPS (the disk keeps `.data`), and the sign-in
key is created on the first start. Serverless hosting does not work: the
engine must keep running between requests.

## Security notes

- Every staff API needs a signed-in session. Owners and admins alone change
  integrations, departments, agents, data sources and the team.
- LMS webhooks are HMAC-signed with the workspace's own secret. Leads and
  email-reply webhooks need the workspace's inbound token.
- Sign-in is throttled after repeated failures, and passwords are at least 8
  characters.
- **Not yet done:**
  - integration secrets (SMTP password, Moodle token) are stored
    unencrypted in `.data/` and Postgres;
  - learners' names and marks are sent to the model and the voice provider
    to personalise lessons. Pseudonymise before wider rollout if needed.
