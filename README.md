# Thuso · the student success colleague

> *Thuso* means **help** in Sesotho and Setswana.

**Thuso is an always-on team of four AI agents that notices when a learner is
quietly falling behind, works out *why*, prepares the right help, checks its
own work, fixes its own mistakes, delivers the help by email and by phone,
and tells the school what happened, with no human in the loop.**

Built in 24 hours for **Colleague Zero**, a hackathon on multi-agent workflows
for education: *"Don't build a chatbot. Build a colleague."*

---

## Contents

1. [The problem](#1-the-problem)
2. [What Thuso does, in one minute](#2-what-thuso-does-in-one-minute)
3. [The team](#3-the-team)
4. [How it works](#4-how-it-works)
5. [How it reasons](#5-how-it-reasons)
6. [How it corrects itself](#6-how-it-corrects-itself)
7. [What reaches the learner](#7-what-reaches-the-learner)
8. [What the school sees](#8-what-the-school-sees)
9. [Against the judging criteria](#9-against-the-judging-criteria)
10. [Architecture](#10-architecture)
11. [Run it](#11-run-it)
12. [Deploy it](#12-deploy-it)
13. [Safety, privacy and honest notes](#13-safety-privacy-and-honest-notes)
14. [What we would build next](#14-what-we-would-build-next)

---

## 1. The problem

Learners in online programmes rarely say they are struggling. **They go
quiet.** By the time a facilitator notices, the learner is weeks behind, and
the conversation is about dropping out instead of a five-minute catch-up.

Worse, two learners can look identical in the LMS (no logins, a high risk
score) for **opposite reasons**:

| | Learner A | Learner B |
|---|---|---|
| What the LMS shows | Silent for 9 days, risk 80 | Silent for 12 days, risk 57 |
| What is actually wrong | Failed the JS-07 checkpoint on one topic and is avoiding it | Passes every quiz, but life got in the way |
| What helps | Re-teach that exact topic, then a short quiz | A person reaching out. **A quiz would make it worse.** |

A dashboard shows both as red. A colleague knows the difference, and acts on
it. That is what Thuso is.

## 2. What Thuso does, in one minute

1. **A learner's record changes.** Their JS-07 checkpoint comes in at 38%.
   The LMS sends Thuso a signed webhook. Nobody types anything.
2. **Zanele, the Planner**, reads the event and writes a plan: scope, owners,
   and what "done" means.
3. **Bongani, Student Success**, reads the record and decides *why* the
   learner is behind: a topic gap, not disengagement.
4. **Lindiwe, Learning & Assessment**, writes a **3-minute narrated video
   lesson** and a **3-question quiz** on exactly that topic, for that learner
   by name.
5. **Musa, the Reviewer**, checks every question against the learner's weak
   topic, finds one that drifts off topic, **stops the line** and sends it
   back. Lindiwe fixes it, Musa re-checks and approves.
6. **The study pack is emailed**: the lesson, key points, a video and docs
   on the topic, and the quiz.
7. **The learner's phone rings.** Our dialer's AI caller greets them by name,
   says the call is recorded, and tells them what was just sent. Under a
   minute.
8. **The learner takes the quiz.** The score syncs back. Passed: *At-Risk →
   On Track* on the screen. Below the pass mark: the missed answers
   explained, the lesson again and a tutor catch-up are emailed at once.
9. **Musa reports to the head of school**, every day at 17:00.

Total: about 75 seconds of agent work. **Human interventions: 0.**

## 3. The team

| Agent | Role (in the brief's words) | What it does |
|---|---|---|
| **Zanele** · Planner | Planner | Turns an event or a goal into a plan: which learners, which language, what "done" means, who owns each step. |
| **Bongani** · Student Success | Worker | Reads the LMS, works out **why** each learner is behind, writes personal check-ins for learners who went quiet, phones learners through the dialer, and closes the loop on quiz results. |
| **Lindiwe** · Learning & Assessment | Worker | For each topic gap: a narrated 8-slide lesson, a study pack and a 3-question quiz on the exact weak topic (optionally with isiZulu or Sesotho alongside English). |
| **Musa** · Reviewer | Reviewer | Audits every output against the learner's record before it is sent, sends back what is wrong with the rule it broke, and writes the school's reports. |

You can **teach** each agent: Settings → Your agents holds standing
instructions (for example *"Use South African examples where they help"*)
that go into that agent's prompt on every task.

## 4. How it works

```
   ┌──────────────────────────── what starts it (nobody types) ───────────────────────────┐
   │  LMS webhook (signed)   ·   Google Sheet change   ·   weekly sweep   ·   manager goal  │
   └──────────────────────────────────────────┬────────────────────────────────────────────┘
                                              ▼
   GOAL ──▶ PLAN (Zanele) ──▶ ACT ───────────────────────────────▶ CHECK (Musa) ──▶ DELIVER
                               │ Bongani: why is each learner behind?    │  rubrics in code   │ email: study pack,
                               │   topic gap ──▶ Lindiwe: lesson + quiz  │  ✗ ──▶ CORRECT ──┘ │ lesson, quiz
                               │   went quiet ──▶ Bongani: check-in      │     (sent back,    │ phone: dialer's
                               │                                         │      fixed,        │ AI caller
                               │                                         │      re-checked)   │ LMS: status updated
                                                                                              ▼
                                       learner takes the quiz ──▶ score syncs back ──▶ On Track, or next steps
                                                                                              ▼
                                                                         Musa's report to the head of school
```

The screen is a live 3D office: every handoff is a person walking to a room,
every thought is a note above a head, every mistake the Reviewer catches stops
the floor with a card showing **the rule, what was wrong, and the rejected
text crossed out**, then the fixed version. The brief's own loop (**Goal →
Plan → Act → Check → Correct → Deliver**) lights up along the bottom as the
team works.

### What starts it

| Trigger | How |
|---|---|
| **LMS webhook** | `POST /api/webhooks/lms`, signed with HMAC-SHA256 (`X-LMS-Signature: sha256=<hex>`). The built-in **Learner records** page (`/lms`) is a sandbox LMS that sends exactly this webhook when you change a mark or the days since login. |
| **Google Sheet** | Paste a sheet link in Settings. Thuso reads it every few seconds; a changed score, a changed login count or a new row starts the team. Optional write-back of each learner's status via a small Apps Script. |
| **Weekly sweep** | Every Monday at 07:00, every cohort, on a scheduler. |
| **Manager's goal** | "Check every cohort and help the three learners most at risk", in plain words, from Settings. |

## 5. How it reasons

- **The diagnosis decides the action, per learner.** A failed checkpoint means
  a topic gap, so the learner gets a lesson and quiz from Lindiwe. Passing
  marks with silence means disengagement, so the learner gets a personal
  check-in from Bongani instead. In the sandbox, Kabelo passes every quiz but
  has not logged in for 12 days, so Thuso writes to him rather than quizzing
  him.
- **The plan is the model's.** The Planner scopes each run from the event or
  goal ("Data Analytics only, in isiZulu" changes the cohort and the tutoring
  language) and writes what "done" means.
- **It never acts without evidence.** Every decision cites the learner's
  record (marks, logins, progress) and is checked against it.

## 6. How it corrects itself

The Reviewer's verdicts are **code, not vibes** (`src/lib/engine/audit.ts`).
The same draft always gets the same verdict, whichever model wrote it. The
model writes the critique and the fix; the rubric decides whether the fix
passes. Nothing reaches a learner until it does.

Real mistakes it catches:

- a diagnosis that contradicts the learner's marks;
- a quiz question that drifts off the weak topic;
- a duplicate option or an answer that does not exist;
- a check-in that labels the learner ("at risk", "failing") or runs too long.

**Test error** (Settings, on by default for demos) plants one off-topic
question in the first quiz, so a short demo always shows the catch. We say so
openly; switch it off and the Reviewer still audits every output exactly as
the model wrote it.

## 7. What reaches the learner

- **The study pack email**: the key points, a "Watch your 3-minute lesson"
  button, a video and documentation links on the exact topic, and the quiz.
- **The 3-minute lesson** (`/learn/[quizId]`): eight slides Claude wrote for
  this learner, with narration read aloud by the browser, captions and a
  progress bar, ending on "Take the quiz". It plays like a video on any phone.
- **The quiz** (`/quiz/[quizId]`): three questions, graded instantly. The
  score is pushed back to the LMS.
- **The phone call**: our dialer's AI caller (Deepgram for voice and
  listening, Claude for the conversation) opens with *"Hi Sipho, it's Thuso
  from the student success team. Just so you know, this call is recorded. I
  saw JS-07 has been a bit tough lately, so I've just emailed you a
  three-minute video lesson and a short quiz…"*, keeps it under a minute and
  never labels the learner.
- **The result**: passed means a well-done email and *At-Risk → On Track*.
  Below the pass mark means the missed questions explained, the lesson again
  and a tutor catch-up, emailed straight away.

## 8. What the school sees

**Reports** (`/reports`, or the Reports sign in Musa's office): today, this
week, or everything. Learners checked and helped, study packs and check-ins
sent, quizzes taken and the pass rate, every mistake the Reviewer caught and
whether it was fixed, every learner's status and every run with what started
it. All counted from what actually happened, nothing estimated.

**Musa's report** is written by Claude from those numbers only, can be emailed
on request, and is emailed every day at 17:00 to `MANAGER_EMAIL`.

## 9. Against the judging criteria

| Criterion | Where to see it |
|---|---|
| **Reasons** | Bongani decides *why* each learner is behind, and the action follows (Kabelo gets a check-in, not a quiz). The Planner scopes the run from the event or goal. |
| **Self-corrects** | Musa's rubric rejects the off-topic question; the "Mistake caught" card shows the rule and the rejected text; the fix is re-checked; *Correct* lights up on the loop. |
| **Executes** | A real email with a real lesson and quiz, a real phone call, a real quiz graded and synced back, the learner's status updated. Finished work, not a suggestion. |
| **Collaborates** | Four agents with clear roles, handing work across a live office; every handoff visible. |
| **Serves education** | It finds learners who are quietly falling behind, tells a topic gap from disengagement, and re-teaches the exact topic, with isiZulu and Sesotho support. |

## 10. Architecture

- **Next.js 15 (App Router) · TypeScript · Tailwind v4 · Framer Motion ·
  Anthropic SDK (Claude) · Nodemailer.** The office is drawn in 2.5D with CSS
  3D transforms; no canvas, no images. Light and dark themes.
- One always-on Node process: an in-memory world, pushed to every open screen
  over server-sent events, with a small archive in `.data/`.

| Path | What it is |
|---|---|
| `src/lib/engine/automation.ts` | The always-on pump: job queue, weekly sweep, Google Sheet watcher, daily report, webhook signatures, keep-awake. |
| `src/lib/engine/scenarios/goal.ts` | One run, from the event to the follow-up call. |
| `src/lib/engine/orchestrator.ts` | The verbs every run uses (walk, think, draft, review, revise, send) and the plan tracking. |
| `src/lib/engine/audit.ts` | The Reviewer's rubrics. |
| `src/lib/ai/agents.ts` | Each agent's prompt and validator, with a playbook fallback so a run always finishes. |
| `src/lib/ai/instructions.ts` | What you taught each agent. |
| `src/lib/lms/lmsAdapter.ts` | The LMS interface, a live HTTP adapter and the sandbox. `sheet.ts` is the Google Sheet source. |
| `src/lib/calls/dialer.ts` | The follow-up call through our dialer's API (`POST /api/v1/ai-calls`). |
| `src/lib/email/send.ts` | SMTP (Nodemailer), and every email template. |
| `src/lib/engine/quiz.ts` | Grading, the LMS score sync, the result card and the next steps. |
| `src/lib/reports.ts`, `src/lib/musaReport.ts` | The numbers and Musa's written report. |

Every model call is validated JSON with a hard timeout. If the model is off,
slow or wrong, that agent falls back to a deterministic playbook, so a run
always finishes. Without any keys at all, Thuso runs fully in simulation.

## 11. Run it

```bash
npm install
npm run dev          # http://localhost:3200 (development)
npm run demo         # build and serve, fastest for presenting
```

Copy `.env.example` to `.env.local` and switch on what you need:

| Variable | Switches on |
|---|---|
| `ANTHROPIC_API_KEY` (+ `ANTHROPIC_MODEL`) | The agents think with Claude (otherwise the playbook). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | Real email through Nodemailer. Gmail: `smtp.gmail.com`, `465`, an App Password. |
| `MANAGER_EMAIL` | Musa's daily report. |
| `PUBLIC_BASE_URL` | Where lesson and quiz links open. Must be reachable from a phone. |
| `DIALER_URL`, `DIALER_API_KEY` | The follow-up call (a dialer key with the "Start AI calls" scope). |
| `LMS_WEBHOOK_SECRET` | The secret LMS webhooks are signed with. |
| `LMS_API_URL`, `LMS_API_KEY` | A real LMS instead of the sandbox. |
| `GOOGLE_SHEET_URL`, `SHEET_WRITEBACK_URL` | A Google Sheet as the learner record, and status write-back. |
| `DEMO_RECIPIENT_EMAIL` | Send every email to one inbox while presenting. |

Then open **Learner records** (`/lms`), add yourself with a real email and
phone number, change your mark to 38 and press **Save**. Watch the office.

## 12. Deploy it

Thuso is **one always-on server** (live updates, background runs, the
scheduler), so host it on **Render, Railway, Fly or a VPS**, not on
per-request serverless.

On Render: build `npm install && npm run build`, start `npm start`, paste the
environment, and set `PUBLIC_BASE_URL` to the service address. On Render's
free plan Thuso pings its own `/api/health` every 10 minutes so it does not
sleep, but **the free plan blocks mail ports**: use a paid instance for Gmail
SMTP, or an SMTP provider on port 2525 (for example Brevo). If an email cannot
be sent, the activity feed says exactly why.

## 13. Safety, privacy and honest notes

- **Learners are never labelled.** No message or call says "at risk" or
  mentions a score; the Reviewer rejects drafts that do.
- **Calls are disclosed and bounded.** Every call says it is recorded, stays
  under a minute, and the dialer's own rules still apply: AI caller switched
  on, calling hours, do-not-call list, minutes.
- **Keys stay in the environment.** No secret is in this repository.
- **What is a demo choice:**
  - the learner records are a sandbox LMS by default, using the same adapter
    a real LMS plugs into;
  - the planted test error is labelled;
  - the "video" lesson is a narrated slide lesson rendered in the browser,
    not a video file.
- **Today, names and marks are sent to the model** to write personal
  material. In production we would pseudonymise learners before any model
  call.

## 14. What we would build next

- Connect a real LMS (Moodle, Canvas) through the same adapter.
- WhatsApp delivery for learners who never open email.
- Pseudonymise learner data before it reaches the model.
- A facilitator approval step, for schools that want one.
- More colleagues on the same loop: admissions, marking, career support.

---

*Thuso finds the learners who are quietly falling behind and helps them,
before anyone has to ask.*
