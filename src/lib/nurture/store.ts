import { tenantDoc } from '@/lib/engine/tenantDoc';
import { currentTenantId } from '@/lib/auth/tenantContext';
import type { LessonSlide } from '@/lib/types';
import type { FitQuiz, MediaItem, NurtureCampaign, NurtureMessage, NurtureResource, NurtureStats, ProgrammeVideo, Voucher, VoucherOffer } from './types';

/* Where lead nurturing keeps its things, per workspace (memory, .data/ and
 * Postgres through tenantDoc): the content bank, the message library, the
 * campaigns, and the once-made pieces (the career-fit quiz, the programme
 * videos) with the counters. */

export const bankDoc = tenantDoc<NurtureResource[]>('nurture-bank', () => []);
export const libraryDoc = tenantDoc<NurtureMessage[]>('nurture-library', () => []);
export const campaignDoc = tenantDoc<NurtureCampaign[]>('nurture-campaigns', () => []);
export const offerDoc = tenantDoc<VoucherOffer[]>('nurture-voucher-offers', () => []);
export const voucherDoc = tenantDoc<Voucher[]>('nurture-vouchers', () => []);
export const mediaDoc = tenantDoc<MediaItem[]>('nurture-media', () => []);

export interface NurtureMeta {
  fit: FitQuiz | null;
  videos: ProgrammeVideo[];
  stats: NurtureStats;
  /** One-time setup steps already done (so a deleted starter is not re-added). */
  seeded: Record<string, number>;
  /** Scenes made for one hot lead, by record key. */
  personal?: Record<string, { slides: LessonSlide[]; createdAt: number }>;
}

export const emptyStats = (): NurtureStats => ({ librarySends: 0, aiSends: 0, aiLines: 0, aiBuilds: 0, opens: 0, clicks: 0, quizzes: 0, videoViews: 0, optOuts: 0 });

export const metaDoc = tenantDoc<NurtureMeta>('nurture-meta', () => ({ fit: null, videos: [], stats: emptyStats(), seeded: {} }));

export function meta(tenantId = currentTenantId()): NurtureMeta {
  const m = metaDoc.get(tenantId);
  m.stats = { ...emptyStats(), ...(m.stats || {}) };
  m.videos ||= [];
  m.seeded ||= {};
  return m;
}

export function bumpStat(key: keyof NurtureStats, by = 1, tenantId = currentTenantId()) {
  const m = meta(tenantId);
  m.stats[key] = (m.stats[key] || 0) + by;
  metaDoc.save(tenantId);
}

export async function hydrateNurture(tenantId = currentTenantId()) {
  await Promise.all([bankDoc.hydrate(tenantId), libraryDoc.hydrate(tenantId), campaignDoc.hydrate(tenantId), metaDoc.hydrate(tenantId), offerDoc.hydrate(tenantId), voucherDoc.hydrate(tenantId), mediaDoc.hydrate(tenantId)]);
}

export const nid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
