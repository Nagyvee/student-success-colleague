import fs from 'node:fs';
import { confirmedAt, fileTime, localWins, markSynced } from '@/lib/db/syncState';
import path from 'node:path';
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { TenantIntegrations, TenantSummary, UserSummary } from '@/lib/types';
import {
  deleteUserFromDb,
  loadAuthFromDb,
  upsertTenantToDb,
  upsertUserToDb,
  type StoredTenantRow,
  type StoredUserRow,
} from '@/lib/db/postgres';
import { DEFAULT_TENANT_ID, currentTenantId } from './tenantContext';

/* Multi-tenant accounts, workspace profiles, team members & per-tenant configs.
 *
 * Anyone (Melsoft or any other academy) can register a workspace, manage team
 * members, connect their own Moodle / Google Sheet / SMTP / WhatsApp, toggle
 * approval mode before sending, and isolate their learners, workflows, and DB
 * rows from every other workspace. */

export const SESSION_COOKIE = 'thuso_session';
const FILE = path.join(process.cwd(), '.data', 'auth.json');

type AuthStore = {
  tenants: StoredTenantRow[];
  users: StoredUserRow[];
  hydrated: boolean;
};

const g = globalThis as unknown as { __thusoAuth?: AuthStore; __thusoSessionSecret?: string };

/** The demo value that used to ship in .env.example. Never trusted as a real secret. */
const PUBLIC_DEMO_SECRETS = new Set(['thuso-lms-demo-secret', 'thuso-session-dev-secret-key']);

/** LMS_WEBHOOK_SECRET from the environment, unless it is the public demo value. */
function envWebhookSecret(): string {
  const v = (process.env.LMS_WEBHOOK_SECRET || '').trim();
  if (!v) return '';
  if (PUBLIC_DEMO_SECRETS.has(v)) {
    console.warn('[thuso] LMS_WEBHOOK_SECRET is the public demo value; ignoring it. Set a long random value.');
    return '';
  }
  return v;
}

function defaultTenant(): StoredTenantRow {
  return {
    id: DEFAULT_TENANT_ID,
    name: 'Default Workspace',
    slug: 'default',
    webhookSecret: envWebhookSecret() || `whsec_${randomBytes(12).toString('hex')}`,
    integrations: {
      lmsProvider: process.env.MOODLE_URL && process.env.MOODLE_TOKEN ? 'moodle' : process.env.LMS_API_URL ? 'rest' : 'sandbox',
      moodleUrl: process.env.MOODLE_URL || '',
      moodleToken: process.env.MOODLE_TOKEN || '',
      moodleCourseIds: process.env.MOODLE_COURSE_IDS || '',
      lmsApiUrl: process.env.LMS_API_URL || '',
      lmsApiKey: process.env.LMS_API_KEY || '',
      googleSheetUrl: process.env.GOOGLE_SHEET_URL || '',
      sheetWritebackUrl: process.env.SHEET_WRITEBACK_URL || '',
      smtpHost: process.env.SMTP_HOST || '',
      smtpPort: Number(process.env.SMTP_PORT || 465) || 465,
      smtpUser: process.env.SMTP_USER || '',
      smtpPass: process.env.SMTP_PASS || '',
      emailFrom: process.env.EMAIL_FROM || 'Thuso Student Success',
      managerEmail: process.env.MANAGER_EMAIL || '',
      whatsappUrl: process.env.WHATSAPP_API_URL || '',
      whatsappToken: process.env.WHATSAPP_API_TOKEN || '',
      whatsappFrom: process.env.WHATSAPP_FROM || '',
      requireApproval: true,
      autoRunMode: false,
      liveOutreachEnabled: false,
      onboardingCompleted: true,
    },
    createdAt: 1731600000000,
  };
}

function store(): AuthStore {
  if (!g.__thusoAuth) {
    let tenants: StoredTenantRow[] = [];
    let users: StoredUserRow[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { tenants?: StoredTenantRow[]; users?: StoredUserRow[] };
      if (Array.isArray(raw.tenants)) tenants = raw.tenants;
      if (Array.isArray(raw.users)) users = raw.users;
    } catch { /* fresh start */ }
    if (!tenants.some((t) => t.id === DEFAULT_TENANT_ID)) tenants.unshift(defaultTenant());
    const rotated = rotateDemoSecrets(tenants);
    g.__thusoAuth = { tenants, users, hydrated: false };
    for (const t of rotated) saveAuth(t);
  }
  return g.__thusoAuth;
}

/** A workspace still signed with the public demo secret gets a private one. */
function rotateDemoSecrets(tenants: StoredTenantRow[]): StoredTenantRow[] {
  const changed: StoredTenantRow[] = [];
  for (const t of tenants) {
    if (!t.webhookSecret || PUBLIC_DEMO_SECRETS.has(t.webhookSecret)) {
      t.webhookSecret = (t.id === DEFAULT_TENANT_ID && envWebhookSecret()) || `whsec_${randomBytes(12).toString('hex')}`;
      changed.push(t);
    }
  }
  return changed;
}

function saveAuth(changedTenant?: StoredTenantRow, changedUser?: StoredUserRow) {
  const s = store();
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ tenants: s.tenants, users: s.users }, null, 2), 'utf8');
  } catch { /* read-only disk */ }
  if (changedTenant) void upsertTenantToDb(changedTenant).then((ok) => { if (ok) markSynced('auth', changedTenant.id); });
  if (changedUser) void upsertUserToDb(changedUser);
}

export async function hydrateAuthFromDb(): Promise<void> {
  const s = store();
  if (s.hydrated) return;
  s.hydrated = true;
  const loaded = await loadAuthFromDb();
  if (!loaded) {
    for (const t of s.tenants) void upsertTenantToDb(t).then((ok) => { if (ok) markSynced('auth', t.id); });
    for (const u of s.users) void upsertUserToDb(u);
    return;
  }
  // Per workspace, the newer copy wins: settings changed here while the database was unreachable are sent up, not lost.
  const localMs = fileTime(FILE);
  const byT = new Map(s.tenants.map((t) => [t.id, t]));
  for (const t of loaded.tenants) {
    const mine = byT.get(t.id);
    if (mine && localWins(localMs, confirmedAt('auth', t.id), null)) {
      void upsertTenantToDb(mine).then((ok) => { if (ok) markSynced('auth', t.id); });
      continue;
    }
    byT.set(t.id, t);
    markSynced('auth', t.id);
  }
  for (const t of s.tenants) if (!loaded.tenants.some((x) => x.id === t.id)) void upsertTenantToDb(t).then((ok) => { if (ok) markSynced('auth', t.id); });
  s.tenants = [...byT.values()];
  for (const t of rotateDemoSecrets(s.tenants)) saveAuth(t);

  const byU = new Map(s.users.map((u) => [u.id, u]));
  for (const u of loaded.users) byU.set(u.id, u);
  s.users = [...byU.values()];
}

/* ── Password & Session Crypto ────────────────────────────────────────────── */

/** Signs session cookies. SESSION_SECRET in production; otherwise a random
 *  secret generated once and kept in .data/, never a value from the repo. */
function sessionSecret(): string {
  const env = (process.env.SESSION_SECRET || '').trim();
  if (env.length >= 32 && !PUBLIC_DEMO_SECRETS.has(env)) return env;
  if (g.__thusoSessionSecret) return g.__thusoSessionSecret;
  const file = path.join(process.cwd(), '.data', 'session-secret');
  let secret = '';
  try { secret = fs.readFileSync(file, 'utf8').trim(); } catch { /* first boot */ }
  if (secret.length < 32) {
    secret = randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, secret, { encoding: 'utf8', mode: 0o600 });
    } catch { /* read-only disk: sessions last until restart */ }
  }
  if (process.env.NODE_ENV === 'production') {
    console.warn(`[thuso] SESSION_SECRET is ${env ? 'shorter than 32 characters' : 'not set'}; using a generated secret from .data/. Set SESSION_SECRET (32+ random characters) so sign-ins survive redeploys.`);
  }
  g.__thusoSessionSecret = secret;
  return secret;
}

/** A key for signing something other than sessions (tracked links in emails),
 *  derived from the session secret so it never needs its own setting. */
export function derivedKey(purpose: string): Buffer {
  return createHmac('sha256', sessionSecret()).update(`thuso-${purpose}-v1`).digest();
}

/** The token external tools (Zapier, Make, Meta lead forms, email forwarders)
 *  send as X-Thuso-Token or ?token= on inbound webhooks. Derived from the
 *  workspace's webhook secret, so rotating that secret rotates this too. */
export function tenantInboundToken(tenantId = currentTenantId()): string {
  return createHmac('sha256', getTenant(tenantId).webhookSecret).update('thuso-inbound-v1').digest('hex').slice(0, 40);
}

export function verifyInboundToken(req: Request, tenantId: string): boolean {
  const url = new URL(req.url);
  const got = (req.headers.get('x-thuso-token') || url.searchParams.get('token') || '').trim();
  if (!got) return false;
  const want = Buffer.from(tenantInboundToken(tenantId));
  const have = Buffer.from(got);
  return want.length === have.length && timingSafeEqual(want, have);
}

/* ── Sign-in throttling ───────────────────────────────────────────────────── */

const attempts = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;

/** Throws when an email has failed to sign in too often in the last 15 minutes. */
export function checkLoginThrottle(key: string) {
  const k = key.trim().toLowerCase();
  const a = attempts.get(k);
  if (a && Date.now() - a.first < WINDOW_MS && a.n >= MAX_ATTEMPTS) {
    throw new Error('Too many sign-in attempts. Wait 15 minutes and try again.');
  }
}

function noteLoginFailure(key: string) {
  const k = key.trim().toLowerCase();
  const a = attempts.get(k);
  if (!a || Date.now() - a.first >= WINDOW_MS) attempts.set(k, { n: 1, first: Date.now() });
  else a.n += 1;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hex] = stored.split(':');
  if (!salt || !hex) return false;
  const want = Buffer.from(hex, 'hex');
  const got = scryptSync(password, salt, 64);
  return want.length === got.length && timingSafeEqual(want, got);
}

export interface SessionPayload {
  userId: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'advisor';
  exp: number;
}

export function signSessionToken(payload: Omit<SessionPayload, 'exp'>): string {
  const full: SessionPayload = { ...payload, exp: Date.now() + 30 * 24 * 3_600_000 };
  const data = Buffer.from(JSON.stringify(full)).toString('base64url');
  const sig = createHmac('sha256', sessionSecret()).update(data).digest('base64url');
  return `${data}.${sig}`;
}

export function verifySessionToken(token?: string | null): SessionPayload | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const data = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', sessionSecret()).update(data).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')) as SessionPayload;
    if (!parsed.userId || !parsed.tenantId || Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function sessionFromRequest(req: Request): SessionPayload | null {
  const token = readCookie(req, SESSION_COOKIE);
  const s = verifySessionToken(token);
  if (!s) return null;
  const exists = store().tenants.some((t) => t.id === s.tenantId);
  return exists ? s : null;
}

/* ── Tenant & Account Queries ─────────────────────────────────────────────── */

function slugify(input: string): string {
  const base = input.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'academy';
  const existing = new Set(store().tenants.map((t) => t.slug));
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}-${i}`)) i += 1;
  return `${base}-${i}`;
}

export function listTenantIds(): string[] {
  return store().tenants.map((t) => t.id);
}

export function getTenant(tenantId = currentTenantId()): StoredTenantRow {
  const s = store();
  return s.tenants.find((t) => t.id === tenantId) || s.tenants[0];
}

export function findTenantBySlugOrId(key?: string | null): StoredTenantRow | null {
  if (!key) return null;
  const k = key.trim().toLowerCase();
  return store().tenants.find((t) => t.id.toLowerCase() === k || t.slug.toLowerCase() === k) || null;
}

export function getTenantSummary(tenantId = currentTenantId()): TenantSummary {
  const t = getTenant(tenantId);
  return {
    id: t.id,
    name: t.name,
    slug: t.slug,
    webhookSecret: t.webhookSecret,
    requireApproval: t.integrations?.requireApproval !== false,
    liveOutreachEnabled: Boolean(t.integrations?.liveOutreachEnabled),
    onboardingCompleted: Boolean(t.integrations?.onboardingCompleted),
    building: t.integrations?.building,
  };
}

/** The summary every staff screen may see: no signing secret. */
export function publicTenantSummary(tenantId = currentTenantId()): TenantSummary {
  return { ...getTenantSummary(tenantId), webhookSecret: '' };
}

export function getTenantIntegrations(tenantId = currentTenantId()): TenantIntegrations {
  return getTenant(tenantId).integrations || { lmsProvider: 'webhook' };
}

export function getAcademyContext(tenantId = currentTenantId()) {
  const t = getTenant(tenantId);
  const ti = t.integrations || { lmsProvider: 'webhook' as const };
  const rawName = (t.name || '').trim();
  const academyName =
    rawName && !/^default workspace$/i.test(rawName)
      ? rawName
      : (process.env.ACADEMY_NAME?.trim() || 'Thuso Academy');
  const senderName = (ti.agentSenderName || '').trim() || 'Student Success Team';
  const senderTitle = (ti.agentSenderTitle || '').trim() || 'Student Success';
  const replyTo = (ti.replyToEmail || ti.smtpUser || '').trim() || '';
  const emailFrom = (ti.emailFrom || '').trim() || `${senderName} · ${academyName}`;
  return { academyName, senderName, senderTitle, replyTo, emailFrom };
}

const mask = (v?: string) => (v && v.trim() ? `••••${v.trim().slice(-4)}` : '');

export function getMaskedIntegrations(tenantId = currentTenantId()): TenantIntegrations {
  const c = getTenantIntegrations(tenantId);
  return {
    ...c,
    moodleToken: mask(c.moodleToken),
    lmsApiKey: mask(c.lmsApiKey),
    smtpPass: mask(c.smtpPass),
    whatsappToken: mask(c.whatsappToken),
    manychatApiKey: mask(c.manychatApiKey),
  };
}

function cleanRoutes(v: TenantIntegrations['escalations']): TenantIntegrations['escalations'] {
  const out: NonNullable<TenantIntegrations['escalations']> = {};
  for (const [k, raw] of Object.entries(v || {})) {
    if (!['admissions', 'support', 'academic', 'placement', 'finance', 'reports'].includes(k)) continue;
    const list = String(raw || '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).slice(0, 5).join(', ');
    if (list) out[k as keyof typeof out] = list;
  }
  return out;
}

function mergeSecret(nextVal: string | undefined, prevVal: string | undefined): string | undefined {
  if (nextVal === undefined) return prevVal;
  const trimmed = nextVal.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('••••')) return prevVal;
  return trimmed;
}

export function updateTenantIntegrations(tenantId: string, patch: Partial<TenantIntegrations> & { academyName?: string }): TenantIntegrations {
  const t = getTenant(tenantId);
  const prev = t.integrations || { lmsProvider: 'webhook' as const };
  if (patch.academyName && patch.academyName.trim()) {
    t.name = patch.academyName.trim().slice(0, 80);
  }
  const next: TenantIntegrations = {
    lmsProvider: patch.lmsProvider || prev.lmsProvider || 'webhook',
    moodleUrl: patch.moodleUrl !== undefined ? patch.moodleUrl.trim().replace(/\/$/, '') : prev.moodleUrl,
    moodleToken: mergeSecret(patch.moodleToken, prev.moodleToken),
    moodleCourseIds: patch.moodleCourseIds !== undefined ? patch.moodleCourseIds.trim() : prev.moodleCourseIds,
    moodleCourseGroups: patch.moodleCourseGroups !== undefined ? patch.moodleCourseGroups : prev.moodleCourseGroups,
    lmsApiUrl: patch.lmsApiUrl !== undefined ? patch.lmsApiUrl.trim().replace(/\/$/, '') : prev.lmsApiUrl,
    lmsApiKey: mergeSecret(patch.lmsApiKey, prev.lmsApiKey),
    googleSheetUrl: patch.googleSheetUrl !== undefined ? patch.googleSheetUrl.trim() : prev.googleSheetUrl,
    sheetWritebackUrl: patch.sheetWritebackUrl !== undefined ? patch.sheetWritebackUrl.trim() : prev.sheetWritebackUrl,
    smtpHost: patch.smtpHost !== undefined ? patch.smtpHost.trim() : prev.smtpHost,
    smtpPort: patch.smtpPort !== undefined ? (Number(patch.smtpPort) || 465) : prev.smtpPort,
    smtpUser: patch.smtpUser !== undefined ? patch.smtpUser.trim() : prev.smtpUser,
    smtpPass: mergeSecret(patch.smtpPass, prev.smtpPass),
    emailFrom: patch.emailFrom !== undefined ? patch.emailFrom.trim() : prev.emailFrom,
    agentSenderName: patch.agentSenderName !== undefined ? patch.agentSenderName.trim() : prev.agentSenderName,
    agentSenderTitle: patch.agentSenderTitle !== undefined ? patch.agentSenderTitle.trim() : prev.agentSenderTitle,
    replyToEmail: patch.replyToEmail !== undefined ? patch.replyToEmail.trim() : prev.replyToEmail,
    managerEmail: patch.managerEmail !== undefined ? patch.managerEmail.trim() : prev.managerEmail,
    whatsappUrl: patch.whatsappUrl !== undefined ? patch.whatsappUrl.trim() : prev.whatsappUrl,
    whatsappToken: mergeSecret(patch.whatsappToken, prev.whatsappToken),
    whatsappFrom: patch.whatsappFrom !== undefined ? patch.whatsappFrom.trim() : prev.whatsappFrom,
    manychatApiKey: mergeSecret(patch.manychatApiKey, prev.manychatApiKey),
    manychatFlowNs: patch.manychatFlowNs !== undefined ? patch.manychatFlowNs.trim() : prev.manychatFlowNs,
    manychatTag: patch.manychatTag !== undefined ? patch.manychatTag.trim() : prev.manychatTag,
    manychatChannel: patch.manychatChannel ?? prev.manychatChannel,
    defaultChannel: patch.defaultChannel ?? prev.defaultChannel,
    tutorLanguage: patch.tutorLanguage ?? prev.tutorLanguage,
    academyFocus: patch.academyFocus !== undefined ? patch.academyFocus.trim() : prev.academyFocus,
    requireApproval: typeof patch.requireApproval === 'boolean' ? patch.requireApproval : prev.requireApproval,
    autoRunMode: typeof patch.autoRunMode === 'boolean' ? patch.autoRunMode : prev.autoRunMode,
    liveOutreachEnabled: typeof patch.liveOutreachEnabled === 'boolean' ? patch.liveOutreachEnabled : prev.liveOutreachEnabled,
    testRecipientEmail: patch.testRecipientEmail !== undefined ? patch.testRecipientEmail.trim() : prev.testRecipientEmail,
    onboardingCompleted: typeof patch.onboardingCompleted === 'boolean' ? patch.onboardingCompleted : prev.onboardingCompleted,
    building: patch.building ? { ...(prev.building || {}), ...patch.building } : prev.building,
    dataSources: patch.dataSources !== undefined ? patch.dataSources : prev.dataSources,
    agentKnowledge: patch.agentKnowledge !== undefined ? patch.agentKnowledge.trim().slice(0, 8000) : prev.agentKnowledge,
    applyUrl: patch.applyUrl !== undefined ? patch.applyUrl.trim() : prev.applyUrl,
    escalations: patch.escalations !== undefined ? cleanRoutes(patch.escalations) : prev.escalations,
  };
  t.integrations = next;
  saveAuth(t);
  return next;
}

export function registerWorkspace(input: {
  academyName: string;
  name: string;
  email: string;
  password: string;
}): { user: UserSummary; tenant: TenantSummary; token: string } {
  const s = store();
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Enter a valid email address.');
  if (!input.password || input.password.length < 8) throw new Error('Password must be at least 8 characters.');
  if (!input.academyName.trim()) throw new Error('Academy / Organization name is required.');
  if (s.users.some((u) => u.email.toLowerCase() === email)) {
    throw new Error('An account with that email already exists.');
  }

  const tenantId = `tnt_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const tenantRow: StoredTenantRow = {
    id: tenantId,
    name: input.academyName.trim().slice(0, 80),
    slug: slugify(input.academyName),
    webhookSecret: `whsec_${randomBytes(12).toString('hex')}`,
    integrations: {
      lmsProvider: 'webhook',
      emailFrom: `${input.academyName.trim()} Student Success`,
      defaultChannel: 'email',
      tutorLanguage: 'en',
      requireApproval: true,
      autoRunMode: false,
      liveOutreachEnabled: false,
      onboardingCompleted: false,
    },
    createdAt: Date.now(),
  };

  const userRow: StoredUserRow = {
    id: `usr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    tenantId,
    email,
    name: (input.name || email.split('@')[0]).trim(),
    passwordHash: hashPassword(input.password),
    role: 'owner',
    createdAt: Date.now(),
  };

  s.tenants.push(tenantRow);
  s.users.push(userRow);
  saveAuth(tenantRow, userRow);

  const token = signSessionToken({
    userId: userRow.id,
    tenantId,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
  });

  return {
    user: { id: userRow.id, email: userRow.email, name: userRow.name, role: userRow.role, tenantId, createdAt: userRow.createdAt },
    tenant: getTenantSummary(tenantId),
    token,
  };
}

export function loginAccount(input: {
  email: string;
  password: string;
}): { user: UserSummary; tenant: TenantSummary; token: string } {
  const s = store();
  const email = input.email.trim().toLowerCase();
  checkLoginThrottle(email);
  const userRow = s.users.find((u) => u.email.toLowerCase() === email);
  if (!userRow || !verifyPassword(input.password, userRow.passwordHash)) {
    noteLoginFailure(email);
    throw new Error('Invalid email or password.');
  }
  attempts.delete(email);
  const token = signSessionToken({
    userId: userRow.id,
    tenantId: userRow.tenantId,
    email: userRow.email,
    name: userRow.name,
    role: userRow.role,
  });
  return {
    user: { id: userRow.id, email: userRow.email, name: userRow.name, role: userRow.role, tenantId: userRow.tenantId, createdAt: userRow.createdAt },
    tenant: getTenantSummary(userRow.tenantId),
    token,
  };
}

export function listTeamMembers(tenantId = currentTenantId()): UserSummary[] {
  return store()
    .users.filter((u) => u.tenantId === tenantId)
    .map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, tenantId: u.tenantId, createdAt: u.createdAt }));
}

export function addTeamMember(
  tenantId: string,
  input: { name: string; email: string; role?: 'admin' | 'advisor'; password: string },
): UserSummary {
  const s = store();
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) throw new Error('Enter a valid member email.');
  if (!input.password || input.password.length < 8) throw new Error('Member password must be at least 8 characters.');
  if (s.users.some((u) => u.email.toLowerCase() === email)) throw new Error('That email already has an account.');

  const userRow: StoredUserRow = {
    id: `usr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`,
    tenantId,
    email,
    name: (input.name || email.split('@')[0]).trim(),
    passwordHash: hashPassword(input.password),
    role: input.role === 'admin' ? 'admin' : 'advisor',
    createdAt: Date.now(),
  };
  s.users.push(userRow);
  saveAuth(undefined, userRow);
  return { id: userRow.id, email: userRow.email, name: userRow.name, role: userRow.role, tenantId, createdAt: userRow.createdAt };
}

export function removeTeamMember(tenantId: string, actorUserId: string, targetUserId: string): boolean {
  const s = store();
  if (actorUserId === targetUserId) throw new Error('You cannot remove yourself while signed in.');
  const target = s.users.find((u) => u.id === targetUserId && u.tenantId === tenantId);
  if (!target) return false;
  if (target.role === 'owner') throw new Error('Workspace owner cannot be removed.');
  s.users = s.users.filter((u) => u.id !== targetUserId);
  saveAuth();
  void deleteUserFromDb(targetUserId);
  return true;
}

