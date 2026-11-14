# Thuso · the student success colleague

*Thuso* means "help" in Sesotho and Setswana.

Thuso is a team of four AI agents that keeps learners from quietly dropping
out. It is always on: when a learner's record changes (a failed checkpoint,
two weeks without logging in), Thuso notices by itself, works out **why** the
learner is behind, prepares the right help, checks its own work, fixes its
own mistakes, and sends the help to the learner. Nobody types a prompt and
nobody steps in.

> A teammate changes Naledi's JS-07 checkpoint to 40% in the learner records.
> → The LMS sends a signed webhook → Thuso plans, diagnoses a topic gap,
> writes a study pack and a 3-question quiz, the Reviewer catches an
> off-topic question and sends it back, the fix is approved, the email goes
> out. Naledi takes the quiz on her phone, passes, and flips to On Track.
> **0 human interventions.**

## The problem

Learners in online programmes rarely say they are struggling. They go quiet.
By the time someone notices, they are weeks behind.

Two learners can look the same in the LMS for opposite reasons. One failed a
checkpoint on a specific topic and is avoiding it: they need that topic
re-taught. The other passes every quiz but life got in the way: a quiz would
make it worse; a person needs to reach out. Getting the reason right is what
turns a dashboard into a rescue.

## Which agent does what

| Agent | Role | What it does |
|---|---|---|
| **Zanele · Planner** | Planner | Reads the event or goal, decides the scope (which learners, which language) and what "done" means, and writes the plan. |
| **Bongani · Student Success** | Worker | Reads the learner record, works out **why** each learner is behind (topic gap or disengagement), and writes personal check-ins for learners who went quiet. |
| **Lindiwe · Learning & Assessment** | Worker | For each topic gap, writes a 3-minute narrated video lesson (8 slides, read aloud in the browser), a study pack (key points, a video and documentation links on the exact topic) and a 3-question quiz. |
| **Musa · Reviewer** | Reviewer | Checks every output against the learner's record before it is sent. Sends back anything wrong, with the rule it broke, until it passes. Writes the daily and weekly reports for the head of school. |

The loop on screen is the hackathon's own: **Goal → Plan → Act → Check →
Correct → Deliver**, with "Human interventions: 0" beside it.

## What starts Thuso (nobody types anything)

- **LMS webhook.** `POST /api/webhooks/lms`, signed with HMAC-SHA256
  (`X-LMS-Signature: sha256=<hex>`, secret `LMS_WEBHOOK_SECRET`). The
  **Learner records** page (`/lms`) is a sandbox LMS: change a mark or the
  days since login, press Save, and it sends exactly that webhook.
- **Google Sheet (optional).** Paste a sheet link in Settings (shared as
  "Anyone with the link: Viewer"). Thuso reads it every few seconds; a changed
  score, a changed login count or a new row starts the colleague. Download the
  starter sheet from Settings (`/api/sheet/template`).
- **Weekly sweep.** Every Monday at 07:00, all cohorts, on a scheduler.
- **A manager's goal.** Still possible from Settings, in plain words.

## How it reasons

- **The diagnosis decides the action, per learner.** A failed checkpoint is a
  topic gap: study pack and quiz. Passing marks and silence is disengagement:
  a personal check-in instead. In the sandbox, Kabelo passes every quiz but has
  not logged in for 12 days, so Thuso writes to him rather than quizzing him.
- **The plan is the model's.** The Planner scopes each run from the event or
  goal ("Data Analytics only, in isiZulu" changes cohort and language).
- **You can teach the agents.** Settings → Your agents: standing instructions
  for each agent go into its prompt on every task.

## How it corrects itself

The Reviewer's verdicts are **code, not vibes** (`src/lib/engine/audit.ts`):
the same draft always gets the same verdict, whichever model wrote it. The
model writes the critique and the fix; the rubric decides whether the fix
passes. When something fails, the screen stops on a card that shows the rule,
what was wrong, and the rejected text crossed out, then the fixed version.

Real mistakes it catches: a diagnosis that contradicts the marks, a quiz
question that drifts off the weak topic, a check-in that labels a learner "at
risk" or runs too long. **Test error** (Settings, on by default) also plants
one off-topic question in the first quiz so a short demo always shows the
catch. It is labelled in the top bar.

## How to run it

```bash
npm install
npm run dev          # http://localhost:3200
```

Copy `.env.example` to `.env.local` and fill in what you want live:

- `ANTHROPIC_API_KEY`: the agents think with Claude (otherwise a built-in playbook).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: real email via Nodemailer.
  For Gmail: `smtp.gmail.com`, `465`, your address, and an App Password.
- `PUBLIC_BASE_URL`: where quiz links point. Use your laptop's network address
  or a tunnel so phones can open them.
- `LMS_API_URL`, `LMS_API_KEY`: a real LMS instead of the sandbox (see
  `src/lib/lms/lmsAdapter.ts` for the routes it expects).

Then:

1. Open **Learner records** (`/lms`) and **Add a learner** with a real email (or put a teammate's email on a demo learner). Hide the demo learners if you only want your own. Learners you add are saved in `.data/learners.json`.
2. Change that learner's checkpoint to 40 and press **Save**.
3. Watch the office. The study pack and quiz arrive by email. Take the quiz
   on a phone; the result syncs back and the learner flips to On Track.

### Google Sheet write-back (optional)

In the sheet: Extensions → Apps Script, paste this, Deploy → New deployment →
Web app (execute as you, access: anyone), and put the URL in
`SHEET_WRITEBACK_URL`. Thuso then writes each learner's status into the sheet.

```js
function doPost(e) {
  const d = JSON.parse(e.postData.contents);
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const v = sh.getDataRange().getValues();
  const h = v[0].map(String);
  const id = h.indexOf('learner_id'), st = h.indexOf('status'), up = h.indexOf('last_update');
  for (let r = 1; r < v.length; r++) {
    if (String(v[r][id]) === d.learner_id) {
      if (st >= 0) sh.getRange(r + 1, st + 1).setValue(d.status);
      if (up >= 0) sh.getRange(r + 1, up + 1).setValue(d.last_update);
    }
  }
  return ContentService.createTextOutput('{"ok":true}').setMimeType(ContentService.MimeType.JSON);
}
```

## Reports

`/reports` (or the **Reports** sign in Musa's office): today, this week or
everything. Learners checked and helped, study packs and check-ins sent,
quizzes taken and the pass rate, every mistake the Reviewer caught and whether
it was fixed, every learner's status and every run with what started it. All
counted from what actually happened. **Musa's report** is written by Claude
from those numbers only, can be emailed on request, and is emailed every day
at 17:00 to `MANAGER_EMAIL`.

## The video lesson

Claude writes each learner an 8-slide lesson with narration on their exact
weak topic, in parallel with the quiz. `/learn/[quizId]` plays it like a
video: slides animate in, the browser reads the narration aloud (Web Speech),
captions run underneath, and it ends on "Take the quiz". It is a narrated
slide lesson rendered in the browser, not a video file.

## The follow-up call

After the email, the academy's dialer phones the learner. Its AI caller
(Deepgram for the voice and listening, Claude for the conversation) opens with
a line Thuso writes: the learner's name, that the call is recorded, and what
was just emailed. It keeps the call under a minute and never labels the
learner. The dialer's own rules still apply (AI caller on, calling hours,
do-not-call list). Set `DIALER_URL` and `DIALER_API_KEY` (a dialer key with
the "Start AI calls" scope); the call and its result appear on the floor and
in the activity feed.

## The quiz result

When the learner submits, the office shows it at once. Passed: At-Risk → On
Track and a well-done email. Below the pass mark: the missed questions with
explanations, the lesson again and a tutor catch-up are emailed straight away,
and the learner stays flagged as being helped.

## Hosting

Thuso is one always-on Node server (live updates, background runs, the
scheduler), so host it on Render, Railway, Fly or a VPS, not on per-request
serverless. On Render: build `npm install && npm run build`, start
`npm start`. On Render's free plan Thuso pings its own `/api/health` every 10
minutes so it does not sleep, but the free plan blocks mail ports: use a paid
instance for Gmail SMTP, or an SMTP provider on port 2525 (for example Brevo).

## How it is built

- **Next.js 15 · TypeScript · Tailwind v4 · Framer Motion · Anthropic SDK ·
  Nodemailer.** The office is drawn in 2.5D with CSS 3D transforms.
- `src/lib/engine/automation.ts`: the always-on pump: queue, weekly
  scheduler, sheet watcher, webhook signatures.
- `src/lib/engine/scenarios/goal.ts`: one run, from event to delivery.
- `src/lib/ai/agents.ts`: each agent's prompt and validator, with a
  playbook fallback so a run always finishes.
- `src/lib/ai/instructions.ts`: what you taught each agent.
- `src/lib/engine/audit.ts`: the Reviewer's rubrics.
- `src/lib/lms/lmsAdapter.ts`: the LMS interface, the live HTTP adapter and
  the sandbox. `src/lib/lms/sheet.ts`: the Google Sheet source.
- `src/lib/email/send.ts`: Nodemailer / Resend delivery and the email templates.
- `src/lib/engine/quiz.ts`: grading, score sync and the status flip.

## What we would build next

- Plug into a real LMS (Moodle, Canvas) through the same adapter.
- WhatsApp delivery for learners who never open email.
- Remove names from learner data before it reaches the model.
- A facilitator approval step, for teams that want one.
