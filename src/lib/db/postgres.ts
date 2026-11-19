import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type {
  CustomAgentDef,
  Deliverable,
  FeedEntry,
  FlowEdge,
  FlowNode,
  FlowRunLog,
  FollowUpCase,
  FollowUpHistoryItem,
  InboxMail,
  LearnerCard,
  Metrics,
  MissedQuestion,
  OfficeDef,
  PendingOutreach,
  RemedialQuiz,
  SyncedLearnerRow,
  Task,
  TenantIntegrations,
  WorkflowDef,
  WorkflowDomain,
  WorkflowTrigger,
} from '@/lib/types';
import { currentTenantId } from '@/lib/auth/tenantContext';

/* Multi-tenant PostgreSQL persistence & long-term student memory ("student-success").
 *
 * Every row is isolated by tenant_id so each academy (Melsoft or any signed-up
 * organization) keeps its own learners, Moodle/Sheet integrations, workflows,
 * approvals, and agent memory without affecting other workspaces or Moodle. */

type PgHub = {
  url: string;
  pool: Pool;
  schemaReady: Promise<boolean> | null;
  lastError: string | null;
};

const g = globalThis as unknown as { __thusoPg?: PgHub };

function cleanUrl(): string {
  const raw = (process.env.DATABASE_URL || '').trim().replace(/^["']|["']$/g, '');
  if (raw) {
    // Allow unencoded '@' / '#' / '/' inside passwords by splitting on the last '@' before host:port/db
    const m = /^(postgres(?:ql)?:\/\/)([^:@/]+):(.+)@([^@/]+:\d+\/[^?#]+(?:\?.*)?)$/i.exec(raw)
      || /^(postgres(?:ql)?:\/\/)([^:@/]+):(.+)@([^@/]+\/[^?#]+(?:\?.*)?)$/i.exec(raw);
    if (m && /[@#/?:]/.test(m[3])) {
      return `${m[1]}${m[2]}:${encodeURIComponent(decodeMaybe(m[3]))}@${m[4]}`;
    }
    return raw;
  }
  if (process.env.PGHOST && process.env.PGDATABASE) {
    const u = encodeURIComponent(process.env.PGUSER || 'postgres');
    const p = encodeURIComponent(process.env.PGPASSWORD || '');
    const h = process.env.PGHOST.trim();
    const port = process.env.PGPORT?.trim() || '5432';
    const db = encodeURIComponent(process.env.PGDATABASE.trim());
    return `postgresql://${u}:${p}@${h}:${port}/${db}`;
  }
  return '';
}

function decodeMaybe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

export function dbConfigured(): boolean {
  return Boolean(cleanUrl());
}

/** Where the database is (host:port only, never the password) and whether it answers right now. */
export async function pingDb(timeoutMs = 5000): Promise<{ configured: boolean; where: string; reachable: boolean; error: string | null }> {
  const url = cleanUrl();
  if (!url) return { configured: false, where: '', reachable: false, error: null };
  let where = '';
  try { const u = new URL(url); where = `${u.hostname}:${u.port || '5432'}`; } catch { where = 'the configured server'; }
  const h = getPool();
  if (!h) return { configured: true, where, reachable: false, error: 'not configured' };
  try {
    await Promise.race([
      h.pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`no answer within ${timeoutMs / 1000}s`)), timeoutMs)),
    ]);
    return { configured: true, where, reachable: true, error: null };
  } catch (e) {
    return { configured: true, where, reachable: false, error: (e as Error).message };
  }
}

export function lastDbError(): string | null {
  return g.__thusoPg?.lastError || null;
}

const FALLBACK_SCHEMA_SQL = fs.existsSync(path.join(process.cwd(), 'db', 'schema.sql'))
  ? fs.readFileSync(path.join(process.cwd(), 'db', 'schema.sql'), 'utf8')
  : '';

function schemaSql(): string {
  try {
    const p = path.join(process.cwd(), 'db', 'schema.sql');
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch { /* fall back to inline DDL */ }
  return FALLBACK_SCHEMA_SQL;
}

function getPool(): PgHub | null {
  const url = cleanUrl();
  if (!url) return null;
  if (!g.__thusoPg || g.__thusoPg.url !== url) {
    if (g.__thusoPg?.pool) {
      void g.__thusoPg.pool.end().catch(() => {});
    }
    const isLocal = /localhost|127\.0\.0\.1|::1/i.test(url);
    const pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      ssl: isLocal || !/sslmode=require/i.test(url) ? undefined : { rejectUnauthorized: false },
    });
    pool.on('error', (err) => {
      if (g.__thusoPg) g.__thusoPg.lastError = err.message;
    });
    g.__thusoPg = { url, pool, schemaReady: null, lastError: null };
  }
  return g.__thusoPg;
}

export async function ensureDbReady(): Promise<boolean> {
  const h = getPool();
  if (!h) return false;
  if (!h.schemaReady) {
    h.schemaReady = (async () => {
      try {
        await h.pool.query(schemaSql());
        h.lastError = null;
        return true;
      } catch (e) {
        h.lastError = (e as Error).message;
        h.schemaReady = null;
        return false;
      }
    })();
  }
  return h.schemaReady;
}

export async function testDbConnection(): Promise<
  | {
      ok: true;
      version: string;
      database: string;
      tables: number;
      learners: number;
      events: number;
      interventions: number;
    }
  | { ok: false; error: string }
> {
  const url = cleanUrl();
  if (!url) {
    return {
      ok: false,
      error: 'DATABASE_URL is not set in .env.local (example: postgresql://postgres:PASSWORD@YOUR_VPS_IP:5432/student-success).',
    };
  }
  const h = getPool();
  if (!h) return { ok: false, error: 'Database pool unavailable.' };
  h.schemaReady = null;
  const ok = await ensureDbReady();
  if (!ok) {
    return { ok: false, error: h.lastError || 'Could not connect or create schema.' };
  }
  const tenantId = currentTenantId();
  try {
    const info = await h.pool.query<{ version: string; db: string }>(
      `SELECT split_part(version(), ',', 1) AS version, current_database() AS db`,
    );
    const tables = await h.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    const counts = await h.pool.query<{ learners: number; events: number; interventions: number }>(
      `SELECT
        (SELECT count(*)::int FROM learners WHERE tenant_id = $1) AS learners,
        (SELECT count(*)::int FROM lms_events WHERE tenant_id = $1) AS events,
        (SELECT count(*)::int FROM interventions WHERE tenant_id = $1) AS interventions`,
      [tenantId],
    );
    return {
      ok: true,
      version: info.rows[0]?.version || 'PostgreSQL',
      database: info.rows[0]?.db || 'student-success',
      tables: tables.rows[0]?.n ?? 0,
      learners: counts.rows[0]?.learners ?? 0,
      events: counts.rows[0]?.events ?? 0,
      interventions: counts.rows[0]?.interventions ?? 0,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/* ── Tenants & users ──────────────────────────────────────────────────────── */

export interface StoredTenantRow {
  id: string;
  name: string;
  slug: string;
  webhookSecret: string;
  integrations: TenantIntegrations;
  createdAt: number;
}

export interface StoredUserRow {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  passwordHash: string;
  role: 'owner' | 'admin' | 'advisor';
  createdAt: number;
}

export async function upsertTenantToDb(t: StoredTenantRow): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    await h.pool.query(
      `INSERT INTO tenants (id, name, slug, webhook_secret, integrations, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         slug = EXCLUDED.slug,
         webhook_secret = EXCLUDED.webhook_secret,
         integrations = EXCLUDED.integrations`,
      [t.id, t.name, t.slug, t.webhookSecret, JSON.stringify(t.integrations || {}), t.createdAt || Date.now()],
    );
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

export async function upsertUserToDb(u: StoredUserRow): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query(
      `INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role`,
      [u.id, u.tenantId, u.email.toLowerCase(), u.name, u.passwordHash, u.role, u.createdAt || Date.now()],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function deleteUserFromDb(userId: string): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function loadAuthFromDb(): Promise<{ tenants: StoredTenantRow[]; users: StoredUserRow[] } | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const [tRes, uRes] = await Promise.all([
      h.pool.query<{
        id: string; name: string; slug: string; webhook_secret: string; integrations: TenantIntegrations; created_at: Date;
      }>(`SELECT * FROM tenants ORDER BY created_at ASC`),
      h.pool.query<{
        id: string; tenant_id: string; email: string; name: string; password_hash: string; role: 'owner' | 'admin' | 'advisor'; created_at: Date;
      }>(`SELECT * FROM users ORDER BY created_at ASC`),
    ]);
    if (!tRes.rows.length && !uRes.rows.length) return null;
    return {
      tenants: tRes.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        webhookSecret: r.webhook_secret,
        integrations: r.integrations || { lmsProvider: 'sandbox' },
        createdAt: new Date(r.created_at).getTime(),
      })),
      users: uRes.rows.map((r) => ({
        id: r.id,
        tenantId: r.tenant_id,
        email: r.email,
        name: r.name,
        passwordHash: r.password_hash,
        role: r.role,
        createdAt: new Date(r.created_at).getTime(),
      })),
    };
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

/* ── LMS events & interventions ───────────────────────────────────────────── */

export async function recordLmsEvent(input: {
  tenantId?: string;
  learnerId: string;
  eventType: string;
  source: string;
  moduleCode?: string | null;
  scorePct?: number | null;
  daysSinceLogin?: number | null;
  missedClasses?: number | null;
  missedAssignments?: number | null;
  paymentStatus?: string | null;
  missedQuestions?: MissedQuestion[];
  detail?: string;
  rawPayload?: unknown;
}): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  const tenantId = input.tenantId || currentTenantId();
  try {
    await h.pool.query(
      `INSERT INTO lms_events
       (tenant_id, learner_id, event_type, source, module_code, score_pct, days_since_login, missed_classes, missed_assignments, payment_status, missed_questions, detail, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb)`,
      [
        tenantId,
        input.learnerId,
        input.eventType,
        input.source,
        input.moduleCode ?? null,
        input.scorePct ?? null,
        input.daysSinceLogin ?? null,
        input.missedClasses ?? null,
        input.missedAssignments ?? null,
        input.paymentStatus ?? null,
        JSON.stringify(input.missedQuestions || []),
        input.detail ?? null,
        input.rawPayload !== undefined ? JSON.stringify(input.rawPayload) : null,
      ],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

function learnerIdFromDeliverable(d: Deliverable): string | null {
  const c = d.content as { learner?: { id?: string } } | null;
  return c?.learner?.id || null;
}

export async function recordIntervention(input: {
  tenantId?: string;
  deliverable: Deliverable;
  learnerId: string;
  workflowId?: string | null;
  moduleCode?: string | null;
  weakTopic?: string | null;
  scoreBefore?: number | null;
  quizId?: string | null;
}): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  const tenantId = input.tenantId || currentTenantId();
  const d = input.deliverable;
  try {
    await h.pool.query(
      `INSERT INTO interventions
       (tenant_id, id, task_id, learner_id, kind, workflow_id, title, subject, module_code, weak_topic, score_before, quiz_id, outcome, payload, approved_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'sent', $13::jsonb, to_timestamp($14 / 1000.0), NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         title = EXCLUDED.title,
         subject = EXCLUDED.subject,
         payload = EXCLUDED.payload,
         approved_at = EXCLUDED.approved_at`,
      [
        tenantId,
        d.id,
        d.taskId,
        input.learnerId,
        d.kind,
        input.workflowId ?? null,
        d.title,
        d.subject,
        input.moduleCode ?? null,
        input.weakTopic ?? null,
        input.scoreBefore ?? null,
        input.quizId ?? null,
        JSON.stringify(d),
        d.updatedAt || Date.now(),
      ],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function recordQuizOutcome(quizId: string, scoreAfter: number, passed: boolean, tenantId = currentTenantId()): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query(
      `UPDATE interventions
       SET score_after = $3,
           quiz_passed = $4,
           outcome = $5,
           completed_at = NOW()
       WHERE tenant_id = $1 AND quiz_id = $2`,
      [tenantId, quizId, scoreAfter, passed, passed ? 'passed' : 'failed'],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function syncWorldToDb(
  archive: {
    learners: LearnerCard[];
    deliverables: Deliverable[];
    inbox: InboxMail[];
    metrics: Metrics;
    tasks: Task[];
    feed: FeedEntry[];
    pendingOutreach?: PendingOutreach[];
  },
  tenantId = currentTenantId(),
): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    for (const l of archive.learners) {
      await h.pool.query(
        `INSERT INTO learners
         (tenant_id, id, name, email, cohort, programme, status, quiz_avg, risk_score, days_since_login, weak_topic, last_event, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           cohort = EXCLUDED.cohort,
           programme = EXCLUDED.programme,
           status = EXCLUDED.status,
           quiz_avg = EXCLUDED.quiz_avg,
           risk_score = EXCLUDED.risk_score,
           days_since_login = EXCLUDED.days_since_login,
           weak_topic = EXCLUDED.weak_topic,
           last_event = EXCLUDED.last_event,
           updated_at = NOW()`,
        [
          tenantId,
          l.id,
          l.name,
          l.email,
          l.cohort,
          l.programme,
          l.status,
          l.quizAvg,
          l.riskScore,
          l.lastLoginDays,
          l.weakTopic,
          l.lastEvent,
        ],
      );
    }

    for (const d of archive.deliverables) {
      const learnerId = learnerIdFromDeliverable(d);
      if (!learnerId) continue;
      const quiz = d.kind === 'remedial_quiz' ? (d.content as RemedialQuiz) : null;
      await h.pool.query(
        `INSERT INTO interventions
         (tenant_id, id, task_id, learner_id, kind, title, subject, module_code, weak_topic, quiz_id, score_after, quiz_passed, outcome, payload, approved_at, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, to_timestamp($15 / 1000.0), to_timestamp($16 / 1000.0))
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           title = EXCLUDED.title,
           subject = EXCLUDED.subject,
           score_after = COALESCE(EXCLUDED.score_after, interventions.score_after),
           quiz_passed = COALESCE(EXCLUDED.quiz_passed, interventions.quiz_passed),
           outcome = CASE WHEN EXCLUDED.quiz_passed IS TRUE THEN 'passed' WHEN EXCLUDED.quiz_passed IS FALSE THEN 'failed' ELSE interventions.outcome END,
           payload = EXCLUDED.payload,
           approved_at = EXCLUDED.approved_at`,
        [
          tenantId,
          d.id,
          d.taskId,
          learnerId,
          d.kind,
          d.title,
          d.subject,
          quiz?.module?.code || null,
          quiz?.topic || null,
          quiz?.quizId || null,
          quiz?.result?.pct ?? null,
          quiz?.result?.passed ?? null,
          quiz?.result ? (quiz.result.passed ? 'passed' : 'failed') : (d.status === 'dispatched' ? 'sent' : d.status),
          JSON.stringify(d),
          d.updatedAt || Date.now(),
          d.createdAt || Date.now(),
        ],
      );
    }

    for (const m of archive.inbox) {
      await h.pool.query(
        `INSERT INTO inbox_messages
         (tenant_id, id, to_email, to_name, subject, body, link, delivery, task_id, deliverable_id, payload, sent_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, to_timestamp($12 / 1000.0))
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          tenantId,
          m.id,
          m.to,
          m.toName,
          m.subject,
          m.text,
          m.link,
          m.delivery,
          m.taskId,
          m.deliverableId,
          JSON.stringify(m),
          m.ts || Date.now(),
        ],
      );
    }

    await h.pool.query(
      `INSERT INTO tenant_snapshots (tenant_id, metrics, tasks, feed, pending_outreach, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         metrics = EXCLUDED.metrics,
         tasks = EXCLUDED.tasks,
         feed = EXCLUDED.feed,
         pending_outreach = EXCLUDED.pending_outreach,
         updated_at = NOW()`,
      [
        tenantId,
        JSON.stringify(archive.metrics),
        JSON.stringify(archive.tasks.slice(0, 40)),
        JSON.stringify(archive.feed.slice(-80)),
        JSON.stringify(archive.pendingOutreach || []),
      ],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function loadWorldFromDb(tenantId = currentTenantId()): Promise<{
  learners: LearnerCard[];
  deliverables: Deliverable[];
  inbox: InboxMail[];
  metrics?: Metrics;
  tasks?: Task[];
  feed?: FeedEntry[];
  pendingOutreach?: PendingOutreach[];
} | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const [lRes, iRes, mRes, wRes] = await Promise.all([
      h.pool.query<{
        id: string; name: string; email: string; cohort: string; programme: string;
        status: LearnerCard['status']; risk_score: number | null; days_since_login: number | null;
        weak_topic: string | null; quiz_avg: number | null; last_event: string | null;
        profile_data: Partial<SyncedLearnerRow> | null;
      }>(`SELECT id, name, email, cohort, programme, status, risk_score, days_since_login, weak_topic, quiz_avg, last_event, profile_data FROM learners WHERE tenant_id = $1 ORDER BY id ASC`, [tenantId]),
      h.pool.query<{ payload: Deliverable }>(`SELECT payload FROM interventions WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 80`, [tenantId]),
      h.pool.query<{
        id: string; sent_at: Date; to_email: string; to_name: string; subject: string;
        body: string; link: string | null; delivery: InboxMail['delivery'];
        task_id: string | null; deliverable_id: string | null; payload: InboxMail | null;
      }>(`SELECT id, sent_at, to_email, to_name, subject, body, link, delivery, task_id, deliverable_id, payload FROM inbox_messages WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 100`, [tenantId]),
      h.pool.query<{ metrics: Metrics; tasks: Task[]; feed: FeedEntry[]; pending_outreach: PendingOutreach[] }>(`SELECT metrics, tasks, feed, pending_outreach FROM tenant_snapshots WHERE tenant_id = $1`, [tenantId]),
    ]);

    if (!lRes.rows.length && !iRes.rows.length && !mRes.rows.length && !wRes.rows.length) return null;

    const learners: LearnerCard[] = lRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      cohort: r.cohort,
      programme: r.programme,
      status: r.status || 'on_track',
      riskScore: Number(r.risk_score ?? 10),
      weakTopic: r.weak_topic,
      lastLoginDays: Number(r.days_since_login ?? 0),
      completion: Number(r.profile_data?.completionPct ?? 65),
      quizAvg: Number(r.quiz_avg ?? 75),
      lastEvent: r.last_event,
    }));

    const deliverables = iRes.rows.map((r) => r.payload).filter(Boolean);
    const inbox: InboxMail[] = mRes.rows.map((r) => r.payload || ({
      id: r.id,
      ts: new Date(r.sent_at).getTime(),
      to: r.to_email,
      toName: r.to_name,
      from: 'Thuso <noreply@thuso.local>',
      subject: r.subject,
      html: r.body,
      text: r.body,
      link: r.link,
      delivery: r.delivery,
      providerId: null,
      taskId: r.task_id || '',
      deliverableId: r.deliverable_id,
    }));
    const snap = wRes.rows[0];
    return {
      learners,
      deliverables,
      inbox,
      metrics: snap?.metrics,
      tasks: snap?.tasks,
      feed: snap?.feed,
      pendingOutreach: snap?.pending_outreach || [],
    };
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export async function syncWorkflowsToDb(list: WorkflowDef[], tenantId = currentTenantId()): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    const ids = list.map((w) => w.id);
    if (ids.length) {
      await h.pool.query(`DELETE FROM workflows WHERE tenant_id = $1 AND NOT (id = ANY($2::text[]))`, [tenantId, ids]);
    } else {
      await h.pool.query(`DELETE FROM workflows WHERE tenant_id = $1`, [tenantId]);
    }
    for (const w of list) {
      const graphJson = JSON.stringify({
        domain: w.domain,
        officeId: w.officeId,
        agentId: w.agentId,
        nodes: w.nodes || [],
        edges: w.edges || [],
        version: w.version,
        departmentId: w.departmentId,
        agentTrigger: w.agentTrigger,
        steps: w.steps,
      });
      await h.pool.query(
        `INSERT INTO workflows
         (tenant_id, id, name, office_name, description, enabled, trigger_type, threshold, channel, goal_template, instructions, follow_up_cadence, graph, runs, last_run_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, to_timestamp($16 / 1000.0))
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           office_name = EXCLUDED.office_name,
           description = EXCLUDED.description,
           enabled = EXCLUDED.enabled,
           trigger_type = EXCLUDED.trigger_type,
           threshold = EXCLUDED.threshold,
           channel = EXCLUDED.channel,
           goal_template = EXCLUDED.goal_template,
           instructions = EXCLUDED.instructions,
           follow_up_cadence = EXCLUDED.follow_up_cadence,
           graph = EXCLUDED.graph,
           runs = EXCLUDED.runs,
           last_run_at = EXCLUDED.last_run_at`,
        [
          tenantId,
          w.id,
          w.name,
          w.officeName,
          w.description,
          w.enabled,
          w.trigger,
          w.threshold ?? null,
          w.channel || 'email',
          w.goalTemplate,
          w.instructions,
          JSON.stringify(w.followUpCadence),
          graphJson,
          w.runs,
          w.lastRunAt ? new Date(w.lastRunAt) : null,
          w.createdAt || Date.now(),
        ],
      );
    }
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

export async function loadWorkflowsFromDb(tenantId = currentTenantId()): Promise<WorkflowDef[] | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{
      id: string; name: string; office_name: string; description: string; enabled: boolean;
      trigger_type: WorkflowTrigger; threshold: number | null; channel: WorkflowDef['channel'] | null; goal_template: string; instructions: string;
      follow_up_cadence: WorkflowDef['followUpCadence'];
      graph?: { domain?: WorkflowDomain; officeId?: string; agentId?: string; nodes?: FlowNode[]; edges?: FlowEdge[]; version?: 2; departmentId?: string; agentTrigger?: WorkflowDef['agentTrigger']; steps?: WorkflowDef['steps'] } | null;
      runs: number; last_run_at: Date | null; created_at: Date;
    }>(`SELECT * FROM workflows WHERE tenant_id = $1 ORDER BY created_at ASC`, [tenantId]);
    if (!res.rows.length) return null;
    return res.rows.map((r) => {
      const g = r.graph && typeof r.graph === 'object' ? r.graph : {};
      return {
        id: r.id,
        name: r.name,
        officeName: r.office_name,
        officeId: g.officeId,
        agentId: g.agentId,
        domain: g.domain,
        description: r.description,
        enabled: r.enabled,
        trigger: r.trigger_type,
        threshold: r.threshold ?? undefined,
        channel: r.channel || 'email',
        goalTemplate: r.goal_template,
        instructions: r.instructions,
        followUpCadence: r.follow_up_cadence,
        nodes: Array.isArray(g.nodes) && g.nodes.length ? g.nodes : undefined,
        edges: Array.isArray(g.edges) ? g.edges : undefined,
        runs: r.runs,
        lastRunAt: r.last_run_at ? new Date(r.last_run_at).getTime() : null,
        createdAt: new Date(r.created_at).getTime(),
        ...(g.version === 2 ? { version: 2 as const, departmentId: g.departmentId, agentTrigger: g.agentTrigger, steps: g.steps } : {}),
      };
    });
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export interface StoredWorkspaceConfig {
  offices?: OfficeDef[];
  customAgents?: CustomAgentDef[];
  flowRuns?: FlowRunLog[];
  /** 2 = departments as floors, agents with step workflows. */
  modelVersion?: number;
}

export async function syncTenantWorkspaceConfig(
  cfg: StoredWorkspaceConfig,
  tenantId = currentTenantId(),
): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    await h.pool.query(
      `UPDATE tenants SET workspace_config = $2::jsonb WHERE id = $1`,
      [tenantId, JSON.stringify(cfg)],
    );
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

export async function loadTenantWorkspaceConfig(
  tenantId = currentTenantId(),
): Promise<StoredWorkspaceConfig | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{ workspace_config: StoredWorkspaceConfig | null }>(
      `SELECT workspace_config FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const cfg = res.rows[0]?.workspace_config;
    return cfg && typeof cfg === 'object' ? cfg : null;
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export async function syncFollowUpsToDb(list: FollowUpCase[], tenantId = currentTenantId()): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    for (const c of list) {
      await h.pool.query(
        `INSERT INTO follow_up_cases
         (tenant_id, id, learner_id, learner_name, learner_email, cohort, workflow_id, workflow_name, trigger_kind, reason, link, module_code, topic, attempts, max_attempts, interval_hours, repeat_forever, next_due_at, last_sent_at, status, history)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, to_timestamp($18 / 1000.0), to_timestamp($19 / 1000.0), $20, $21::jsonb)
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           reason = EXCLUDED.reason,
           link = EXCLUDED.link,
           attempts = EXCLUDED.attempts,
           next_due_at = EXCLUDED.next_due_at,
           last_sent_at = EXCLUDED.last_sent_at,
           status = EXCLUDED.status,
           history = EXCLUDED.history`,
        [
          tenantId,
          c.id,
          c.learnerId,
          c.learnerName,
          c.learnerEmail,
          c.cohort,
          c.workflowId,
          c.workflowName,
          c.triggerKind,
          c.reason,
          c.link,
          c.moduleCode,
          c.topic,
          c.attempts,
          c.maxAttempts,
          c.intervalHours,
          c.repeatForever,
          c.nextDueAt,
          c.lastSentAt,
          c.status,
          JSON.stringify(c.history || []),
        ],
      );
    }
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

export async function loadFollowUpsFromDb(tenantId = currentTenantId()): Promise<FollowUpCase[] | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{
      id: string; learner_id: string; learner_name: string; learner_email: string; cohort: string;
      workflow_id: string | null; workflow_name: string; trigger_kind: string; reason: string;
      link: string | null; module_code: string | null; topic: string | null;
      attempts: number; max_attempts: number | null; interval_hours: number; repeat_forever: boolean;
      next_due_at: Date; last_sent_at: Date; status: FollowUpCase['status']; history: FollowUpHistoryItem[];
    }>(`SELECT * FROM follow_up_cases WHERE tenant_id = $1 ORDER BY last_sent_at DESC`, [tenantId]);
    if (!res.rows.length) return null;
    return res.rows.map((r) => ({
      id: r.id,
      learnerId: r.learner_id,
      learnerName: r.learner_name,
      learnerEmail: r.learner_email,
      cohort: r.cohort,
      workflowId: r.workflow_id,
      workflowName: r.workflow_name,
      triggerKind: r.trigger_kind,
      reason: r.reason,
      link: r.link,
      moduleCode: r.module_code,
      topic: r.topic,
      attempts: r.attempts,
      maxAttempts: r.max_attempts,
      intervalHours: r.interval_hours,
      repeatForever: r.repeat_forever,
      nextDueAt: new Date(r.next_due_at).getTime(),
      lastSentAt: new Date(r.last_sent_at).getTime(),
      status: r.status,
      history: Array.isArray(r.history) ? r.history : [],
    }));
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export async function getLearnerMemories(learnerIds: string[], tenantId = currentTenantId()): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!learnerIds.length || !(await ensureDbReady())) return out;
  const h = getPool();
  if (!h) return out;
  try {
    const [intRes, evRes, fuRes] = await Promise.all([
      h.pool.query<{
        learner_id: string; kind: string; module_code: string | null; weak_topic: string | null;
        score_before: number | null; score_after: number | null; outcome: string; sent_at: Date;
      }>(
        `SELECT learner_id, kind, module_code, weak_topic, score_before, score_after, outcome, sent_at
         FROM interventions
         WHERE tenant_id = $1 AND learner_id = ANY($2::text[])
         ORDER BY sent_at DESC
         LIMIT 40`,
        [tenantId, learnerIds],
      ),
      h.pool.query<{
        learner_id: string; event_type: string; module_code: string | null;
        score_pct: number | null; detail: string | null; created_at: Date;
      }>(
        `SELECT learner_id, event_type, module_code, score_pct, detail, created_at
         FROM lms_events
         WHERE tenant_id = $1 AND learner_id = ANY($2::text[])
         ORDER BY created_at DESC
         LIMIT 40`,
        [tenantId, learnerIds],
      ),
      h.pool.query<{
        learner_id: string; workflow_name: string; attempts: number; status: string; reason: string;
      }>(
        `SELECT learner_id, workflow_name, attempts, status, reason
         FROM follow_up_cases
         WHERE tenant_id = $1 AND learner_id = ANY($2::text[])
         ORDER BY last_sent_at DESC
         LIMIT 20`,
        [tenantId, learnerIds],
      ),
    ]);

    for (const id of learnerIds) {
      const ints = intRes.rows.filter((r) => r.learner_id === id).slice(0, 3);
      const evs = evRes.rows.filter((r) => r.learner_id === id).slice(0, 3);
      const fus = fuRes.rows.filter((r) => r.learner_id === id).slice(0, 2);
      const lines: string[] = [];
      if (ints.length) {
        lines.push(
          `Past help sent: ${ints
            .map((x) => {
              const d = new Date(x.sent_at).toLocaleDateString('en-ZA');
              const perf = x.score_after !== null ? `-> scored ${x.score_after}% (${x.outcome})` : `(${x.outcome})`;
              return `${d}: ${x.kind}${x.module_code ? ` ${x.module_code}` : ''}${x.weak_topic ? ` [${x.weak_topic}]` : ''} ${perf}`;
            })
            .join('; ')}`,
        );
      }
      if (evs.length) {
        lines.push(
          `Recent events: ${evs
            .map((e) => `${e.event_type}${e.score_pct !== null ? ` ${e.score_pct}%` : ''}${e.detail ? ` (${e.detail})` : ''}`)
            .join('; ')}`,
        );
      }
      if (fus.length) {
        lines.push(`Follow-ups: ${fus.map((f) => `${f.workflow_name} #${f.attempts} (${f.status})`).join('; ')}`);
      }
      if (lines.length) out.set(id, lines.join(' | '));
    }
  } catch (e) {
    h.lastError = (e as Error).message;
  }
  return out;
}

export async function upsertSyncedLearnersToDb(
  rows: SyncedLearnerRow[],
  source = 'moodle',
  tenantId = currentTenantId(),
): Promise<void> {
  if (!rows.length || !(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    // Load existing billing/attendance overlays so Moodle sync never erases Google Sheet or webhook fields
    const existingRes = await h.pool.query<{
      id: string;
      missed_classes: number | null;
      payment_status: string | null;
      profile_data: Partial<SyncedLearnerRow> | null;
    }>(`SELECT id, missed_classes, payment_status, profile_data FROM learners WHERE tenant_id = $1`, [tenantId]);
    const existingById = new Map(existingRes.rows.map((x) => [x.id, x]));

    // Batch multi-row upsert in chunks of 80 to avoid oversized SQL packets
    for (let i = 0; i < rows.length; i += 80) {
      const chunk = rows.slice(i, i + 80);
      const values: unknown[] = [];
      const placeholders: string[] = [];
      chunk.forEach((r, idx) => {
        const prev = existingById.get(r.id);
        const preservedPayment =
          (r.paymentStatus && r.paymentStatus !== 'ok' ? r.paymentStatus : null) ||
          prev?.payment_status ||
          prev?.profile_data?.paymentStatus ||
          r.paymentStatus ||
          'ok';
        const preservedMissedClasses = Math.max(r.missedClasses ?? 0, prev?.missed_classes ?? 0);
        const mergedProfile: SyncedLearnerRow = {
          ...r,
          paymentStatus: preservedPayment,
          missedClasses: preservedMissedClasses,
          source: r.source || source,
        };
        const base = idx * 16;
        placeholders.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}::jsonb, NOW())`,
        );
        values.push(
          tenantId,
          r.id,
          r.name,
          r.email,
          r.cohort || 'Unassigned',
          r.programme || 'Enrolled Programme',
          r.status || 'on_track',
          r.avgScore ?? r.checkpoint ?? null,
          r.riskScore ?? 0,
          r.daysSinceLogin ?? 0,
          preservedMissedClasses,
          r.missedAssignments ?? 0,
          preservedPayment,
          r.weakTopic ?? null,
          r.lastEvent ?? null,
          JSON.stringify(mergedProfile),
        );
      });
      await h.pool.query(
        `INSERT INTO learners
         (tenant_id, id, name, email, cohort, programme, status, quiz_avg, risk_score, days_since_login, missed_classes, missed_assignments, payment_status, weak_topic, last_event, profile_data, updated_at)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           cohort = EXCLUDED.cohort,
           programme = EXCLUDED.programme,
           status = EXCLUDED.status,
           quiz_avg = EXCLUDED.quiz_avg,
           risk_score = EXCLUDED.risk_score,
           days_since_login = EXCLUDED.days_since_login,
           missed_classes = EXCLUDED.missed_classes,
           missed_assignments = EXCLUDED.missed_assignments,
           payment_status = EXCLUDED.payment_status,
           weak_topic = EXCLUDED.weak_topic,
           last_event = COALESCE(EXCLUDED.last_event, learners.last_event),
           profile_data = EXCLUDED.profile_data,
           updated_at = NOW()`,
        values,
      );
    }
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function findSyncedLearnerByEmailOrId(
  email?: string | null,
  id?: string | null,
  tenantId = currentTenantId(),
): Promise<SyncedLearnerRow | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanId = (id || '').trim();
  if (!cleanEmail && !cleanId) return null;
  try {
    const res = await h.pool.query<{
      id: string;
      name: string;
      email: string;
      cohort: string;
      programme: string;
      status: string;
      quiz_avg: number | null;
      risk_score: number | null;
      days_since_login: number | null;
      missed_classes: number | null;
      missed_assignments: number | null;
      payment_status: string | null;
      weak_topic: string | null;
      last_event: string | null;
      source: string | null;
      profile_data: Partial<SyncedLearnerRow> | null;
    }>(
      `SELECT id, name, email, cohort, programme, status, quiz_avg, risk_score, days_since_login,
              missed_classes, missed_assignments, payment_status, weak_topic, last_event, source, profile_data
       FROM learners
       WHERE tenant_id = $1
         AND (
           ($2 <> '' AND LOWER(email) = $2)
           OR ($3 <> '' AND id = $3)
         )
       ORDER BY CASE WHEN ($2 <> '' AND LOWER(email) = $2) THEN 0 ELSE 1 END
       LIMIT 1`,
      [tenantId, cleanEmail, cleanId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const pd = r.profile_data && typeof r.profile_data === 'object' ? r.profile_data : {};
    return {
      ...pd,
      id: r.id,
      name: pd.name || r.name,
      email: pd.email || r.email,
      phone: pd.phone || '',
      cohort: pd.cohort || r.cohort,
      programme: pd.programme || r.programme,
      checkpoint: pd.checkpoint ?? r.quiz_avg ?? null,
      avgScore: pd.avgScore ?? r.quiz_avg ?? null,
      daysSinceLogin: pd.daysSinceLogin ?? r.days_since_login ?? 0,
      missedClasses: pd.missedClasses ?? r.missed_classes ?? 0,
      missedAssignments: pd.missedAssignments ?? r.missed_assignments ?? 0,
      paymentStatus: pd.paymentStatus || r.payment_status || 'ok',
      riskScore: pd.riskScore ?? r.risk_score ?? 0,
      weakTopic: pd.weakTopic ?? r.weak_topic ?? null,
      status: r.status || pd.status || 'on_track',
      lastEvent: r.last_event ?? pd.lastEvent ?? null,
      source: pd.source || r.source || 'db',
    } as SyncedLearnerRow;
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export async function mergeLearnerPatchByEmailOrId(
  patch: {
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
    cohort?: string;
    programme?: string;
    module?: string | null;
    checkpoint?: number | null;
    daysSinceLogin?: number | null;
    missedClasses?: number | null;
    missedAssignments?: number | null;
    paymentStatus?: 'ok' | 'overdue' | 'arrangement' | null;
    status?: string;
    lastEvent?: string | null;
    source?: string;
  },
  tenantId = currentTenantId(),
): Promise<{ row: SyncedLearnerRow; created: boolean }> {
  const existing = await findSyncedLearnerByEmailOrId(patch.email, patch.id, tenantId);
  const canonicalId =
    existing?.id ||
    (patch.id && !/^ROW-\d+$/i.test(patch.id) ? patch.id : '') ||
    `ST-${Math.floor(1000 + Math.random() * 9000)}`;

  const nextCheckpoint = patch.checkpoint !== undefined && patch.checkpoint !== null ? patch.checkpoint : (existing?.checkpoint ?? null);
  const nextDays = patch.daysSinceLogin !== undefined && patch.daysSinceLogin !== null ? patch.daysSinceLogin : (existing?.daysSinceLogin ?? 0);
  const nextMissedClasses = patch.missedClasses !== undefined && patch.missedClasses !== null ? patch.missedClasses : (existing?.missedClasses ?? 0);
  const nextMissedAssign = patch.missedAssignments !== undefined && patch.missedAssignments !== null ? patch.missedAssignments : (existing?.missedAssignments ?? 0);
  const nextPayment = patch.paymentStatus || (existing?.paymentStatus as 'ok' | 'overdue' | 'arrangement' | undefined) || 'ok';

  let risk = existing?.riskScore ?? 10;
  if (nextCheckpoint !== null && nextCheckpoint < 60) risk = Math.max(risk, 68);
  if (nextDays !== null && nextDays >= 5) risk = Math.max(risk, 60);
  if (nextMissedClasses >= 2) risk = Math.max(risk, 62);
  if (nextMissedAssign >= 1) risk = Math.max(risk, 60);
  if (nextPayment === 'overdue') risk = Math.max(risk, 65);
  else if (nextPayment === 'ok' && patch.paymentStatus === 'ok' && (existing?.paymentStatus === 'overdue')) {
    risk = Math.min(risk, 40);
  }

  const nextStatus =
    patch.status ||
    (existing?.status === 'intervention' || existing?.status === 'recovered'
      ? existing.status
      : risk >= 60
        ? 'at_risk'
        : 'on_track');

  const signals = [...(existing?.signals || []).filter((s) => !/tuition|billing/i.test(s))];
  if (nextPayment === 'overdue') signals.push('tuition / admin check-in flagged on billing sheet');

  const merged: SyncedLearnerRow = {
    ...(existing || {}),
    id: canonicalId,
    name: patch.name?.trim() || existing?.name || 'Learner',
    email: patch.email?.trim() || existing?.email || `${canonicalId.toLowerCase()}@student.local`,
    phone: patch.phone?.trim() || existing?.phone || '',
    cohort: existing?.cohort && existing.cohort !== 'Unassigned' ? existing.cohort : (patch.cohort?.trim() || 'Active Cohort'),
    programme: existing?.programme || patch.programme?.trim() || 'Enrolled Programme',
    module: patch.module !== undefined ? patch.module : (existing?.module ?? null),
    checkpoint: nextCheckpoint,
    avgScore: nextCheckpoint ?? existing?.avgScore ?? null,
    completionPct: existing?.completionPct ?? (nextCheckpoint !== null ? 50 : 0),
    daysSinceLogin: nextDays,
    missedClasses: nextMissedClasses,
    missedAssignments: nextMissedAssign,
    paymentStatus: nextPayment,
    riskScore: risk,
    riskBand: risk >= 60 ? 'at_risk' : risk >= 35 ? 'watch' : 'on_track',
    signals,
    weakTopic: patch.module || existing?.weakTopic || null,
    status: nextStatus,
    lastEvent: patch.lastEvent !== undefined ? patch.lastEvent : (existing?.lastEvent || null),
    source: existing?.source || patch.source || 'sheet',
  };

  await upsertSyncedLearnersToDb([merged], merged.source || 'sheet', tenantId);
  return { row: merged, created: !existing };
}

export async function loadSyncedLearnersFromDb(tenantId = currentTenantId()): Promise<SyncedLearnerRow[]> {
  if (!(await ensureDbReady())) return [];
  const h = getPool();
  if (!h) return [];
  try {
    const res = await h.pool.query<{
      id: string;
      name: string;
      email: string;
      cohort: string;
      programme: string;
      status: string;
      quiz_avg: number | null;
      risk_score: number | null;
      days_since_login: number | null;
      missed_classes: number | null;
      missed_assignments: number | null;
      payment_status: string | null;
      weak_topic: string | null;
      last_event: string | null;
      source: string | null;
      profile_data: Partial<SyncedLearnerRow> | null;
    }>(
      `SELECT id, name, email, cohort, programme, status, quiz_avg, risk_score, days_since_login,
              missed_classes, missed_assignments, payment_status, weak_topic, last_event, source, profile_data
       FROM learners
       WHERE tenant_id = $1
       ORDER BY COALESCE(risk_score, 0) DESC, name ASC`,
      [tenantId],
    );
    return res.rows.map((r) => {
      const pd = r.profile_data && typeof r.profile_data === 'object' ? r.profile_data : {};
      return {
        ...pd,
        id: r.id,
        name: pd.name || r.name,
        email: pd.email || r.email,
        phone: pd.phone || '',
        cohort: pd.cohort || r.cohort,
        programme: pd.programme || r.programme,
        checkpoint: pd.checkpoint ?? r.quiz_avg ?? null,
        avgScore: pd.avgScore ?? r.quiz_avg ?? null,
        daysSinceLogin: pd.daysSinceLogin ?? r.days_since_login ?? 0,
        missedClasses: pd.missedClasses ?? r.missed_classes ?? 0,
        missedAssignments: pd.missedAssignments ?? r.missed_assignments ?? 0,
        paymentStatus: pd.paymentStatus || r.payment_status || 'ok',
        riskScore: pd.riskScore ?? r.risk_score ?? 0,
        weakTopic: pd.weakTopic ?? r.weak_topic ?? null,
        status: r.status || pd.status || 'on_track',
        lastEvent: r.last_event ?? pd.lastEvent ?? null,
        source: pd.source || r.source || 'db',
      } as SyncedLearnerRow;
    });
  } catch (e) {
    h.lastError = (e as Error).message;
    return [];
  }
}

export async function deleteLearnerFromDb(learnerId: string, tenantId = currentTenantId()): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query(`DELETE FROM learners WHERE tenant_id = $1 AND id = $2`, [tenantId, learnerId]);
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function saveMoodleSyncMetaToDb(meta: Record<string, unknown>, tenantId = currentTenantId()): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query(
      `INSERT INTO tenant_snapshots (tenant_id, moodle_sync_meta, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         moodle_sync_meta = EXCLUDED.moodle_sync_meta,
         updated_at = NOW()`,
      [tenantId, JSON.stringify(meta)],
    );
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}

export async function loadMoodleSyncMetaFromDb(tenantId = currentTenantId()): Promise<Record<string, unknown> | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{ moodle_sync_meta: Record<string, unknown> | null }>(
      `SELECT moodle_sync_meta FROM tenant_snapshots WHERE tenant_id = $1`,
      [tenantId],
    );
    return res.rows[0]?.moodle_sync_meta || null;
  } catch {
    return null;
  }
}

/* ── Small per-workspace documents (agent runs, records, leads) ──────────── */

export async function kvGet<T>(key: string, tenantId = currentTenantId()): Promise<T | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{ value: T }>('SELECT value FROM tenant_kv WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
    return res.rows[0]?.value ?? null;
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

/** A document with when the database copy last changed. undefined: the database cannot be reached; null: no row. */
export async function kvGetRow<T>(key: string, tenantId = currentTenantId()): Promise<{ value: T; updatedAt: number } | null | undefined> {
  if (!(await ensureDbReady())) return undefined;
  const h = getPool();
  if (!h) return undefined;
  try {
    const res = await h.pool.query<{ value: T; updated_at: Date }>('SELECT value, updated_at FROM tenant_kv WHERE tenant_id = $1 AND key = $2', [tenantId, key]);
    const r = res.rows[0];
    return r ? { value: r.value, updatedAt: new Date(r.updated_at).getTime() } : null;
  } catch (e) {
    h.lastError = (e as Error).message;
    return undefined;
  }
}

export async function kvSet(key: string, value: unknown, tenantId = currentTenantId()): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    await h.pool.query(
      `INSERT INTO tenant_kv (tenant_id, key, value, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [tenantId, key, JSON.stringify(value)],
    );
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

/* ── Uploaded files (the content bank) ────────────────────────────────────── */

export async function fileGetDb(id: string, tenantId = currentTenantId()): Promise<{ name: string; mime: string; data: Buffer } | null> {
  if (!(await ensureDbReady())) return null;
  const h = getPool();
  if (!h) return null;
  try {
    const res = await h.pool.query<{ name: string; mime: string; data: Buffer }>('SELECT name, mime, data FROM tenant_files WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
    return res.rows[0] || null;
  } catch (e) {
    h.lastError = (e as Error).message;
    return null;
  }
}

export async function filePutDb(file: { id: string; name: string; mime: string; data: Buffer }, tenantId = currentTenantId()): Promise<boolean> {
  if (!(await ensureDbReady())) return false;
  const h = getPool();
  if (!h) return false;
  try {
    await h.pool.query(
      `INSERT INTO tenant_files (tenant_id, id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, id) DO UPDATE SET name = EXCLUDED.name, mime = EXCLUDED.mime, size = EXCLUDED.size, data = EXCLUDED.data`,
      [tenantId, file.id, file.name, file.mime, file.data.length, file.data],
    );
    return true;
  } catch (e) {
    h.lastError = (e as Error).message;
    return false;
  }
}

export async function fileDeleteDb(id: string, tenantId = currentTenantId()): Promise<void> {
  if (!(await ensureDbReady())) return;
  const h = getPool();
  if (!h) return;
  try {
    await h.pool.query('DELETE FROM tenant_files WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  } catch (e) {
    h.lastError = (e as Error).message;
  }
}
