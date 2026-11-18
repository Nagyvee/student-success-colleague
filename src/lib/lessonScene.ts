import type { LessonScene, SceneNode, SlideVisual } from '@/lib/types';

/* The rules for what a lesson scene may draw, shared by the writer (agents.ts),
 * the fallback (simulate.ts) and the player.
 *
 * A scene is a visual first: icons, arrows, a split screen, a typed snippet,
 * one big number. Words on screen are labels, never sentences: the narration
 * does the explaining. These limits are enforced whatever the model writes. */

export const SCENE_VISUALS: SlideVisual[] = ['greeting', 'flow', 'branch', 'compare', 'code', 'analogy', 'big', 'recap', 'cta'];

/** Icons a scene may use (lucide names, kebab-case). The player maps each to a drawing. */
export const SCENE_ICONS = [
  'package', 'truck', 'clock', 'hourglass', 'timer', 'check', 'x', 'alert', 'lightbulb', 'database', 'table', 'server',
  'cloud', 'code', 'braces', 'terminal', 'bug', 'wrench', 'settings', 'git-branch', 'merge', 'split', 'workflow', 'link',
  'layers', 'box', 'boxes', 'key', 'lock', 'shield', 'wifi', 'globe', 'mail', 'message', 'phone', 'user', 'users', 'file',
  'folder', 'search', 'filter', 'list', 'calculator', 'chart', 'pie', 'target', 'flag', 'rocket', 'zap', 'repeat', 'refresh',
  'arrow-right', 'play', 'pause', 'stop', 'cart', 'receipt', 'wallet', 'coffee', 'bus', 'home', 'building', 'graduation',
  'book', 'brain', 'eye', 'hand', 'puzzle', 'star', 'heart', 'trophy', 'smartphone', 'monitor', 'cpu',
  'calendar', 'map', 'compass', 'inbox', 'send', 'layout', 'grid', 'columns', 'rows', 'network', 'variable', 'sigma',
] as const;
export type SceneIcon = (typeof SCENE_ICONS)[number];
const ICONS = new Set<string>(SCENE_ICONS);

const DANGLING = /^(to|the|a|an|of|and|or|in|on|for|with|at|by|from|is|are|your|my|that|which|then|but)$/i;

/** At most `max` words. When it has to cut, it never ends on a dangling word ("First taxi to"). */
export function clampWords(t: unknown, max: number): string {
  if (typeof t !== 'string') return '';
  const words = t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ');
  const cut = words.slice(0, max);
  while (cut.length > 1 && DANGLING.test(cut[cut.length - 1].replace(/[,;:.]+$/, ''))) cut.pop();
  return cut.join(' ').replace(/[,;:.]+$/, '');
}

export function cleanIcon(x: unknown): string | undefined {
  if (typeof x !== 'string') return undefined;
  const k = x.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return ICONS.has(k) ? k : undefined;
}

/** A caption: at most `max` words, cut at the last comma or full stop inside the limit when it has to cut. */
export function clampCaption(t: unknown, max: number): string {
  if (typeof t !== 'string') return '';
  const words = t.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (words.length <= max) return words.join(' ');
  const cut = words.slice(0, max);
  for (let i = cut.length - 1; i >= 2; i--) {
    if (/[,;:.!?]$/.test(cut[i])) return cut.slice(0, i + 1).join(' ').replace(/[,;:]+$/, '');
  }
  return clampWords(t, max);
}

/** The visual a model meant: its "visual" when it is one we draw, else the scene's own "type"
 *  (models like to write "learning-flow" as the visual and put "flow" inside the scene). */
export function visualOf(slide: Record<string, unknown>): SlideVisual | null {
  const known = (x: unknown) => {
    if (typeof x !== 'string') return null;
    const v = x.trim().toLowerCase() as SlideVisual;
    return SCENE_VISUALS.includes(v) ? v : null;
  };
  const scene = slide.scene && typeof slide.scene === 'object' ? (slide.scene as Record<string, unknown>) : {};
  return known(slide.visual) || known(scene.type) || known(scene.visual) || null;
}

/** The first of several names a model might use for the same thing. */
const pick = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function node(x: unknown, labelWords = 3, noteWords = 6, withCode = false): SceneNode | null {
  // A bare string is a label.
  if (typeof x === 'string') x = { label: x };
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  const label = clampWords(pick(o, ['label', 'title', 'name', 'text']), labelWords);
  if (!label) return null;
  const n: SceneNode = { label };
  const icon = cleanIcon(o.icon);
  if (icon) n.icon = icon;
  const note = clampWords(o.note, noteWords);
  if (note) n.note = note;
  if (withCode && typeof o.code === 'string' && o.code.trim()) n.code = o.code.replace(/\r\n/g, '\n').split('\n').slice(0, 5).join('\n').slice(0, 240);
  return n;
}

/** Keep only what the visual draws, inside the word limits. */
export function cleanScene(visual: SlideVisual, raw: unknown): LessonScene | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const s: LessonScene = {};
  if (visual === 'flow' || visual === 'recap' || visual === 'steps') {
    const raw = pick(o, ['nodes', 'steps', 'stages', 'items', 'points']);
    const nodes = Array.isArray(raw) ? raw.map((x) => node(x, visual === 'recap' ? 6 : 3, 6)).filter((x): x is SceneNode => Boolean(x)) : [];
    if (nodes.length >= 2) s.nodes = nodes.slice(0, visual === 'recap' ? 4 : 5);
  }
  if (visual === 'branch') {
    const from = node(pick(o, ['from', 'start', 'source'])), yes = node(pick(o, ['yes', 'success', 'left', 'a'])), no = node(pick(o, ['no', 'failure', 'right', 'b']));
    if (from && yes && no) Object.assign(s, { from, yes, no });
  }
  if (visual === 'compare' || visual === 'analogy') {
    const words = visual === 'compare' ? 6 : 4;
    const left = node(pick(o, ['left', 'before', 'mistake', 'from', 'everyday']), words, 6, visual === 'compare');
    const right = node(pick(o, ['right', 'after', 'fix', 'to', 'concept']), words, 6, visual === 'compare');
    if (left && right) Object.assign(s, { left, right });
  }
  if (visual === 'big') {
    const value = clampWords(pick(o, ['value', 'text', 'label']), 3);
    if (value) s.value = value;
  }
  const caption = clampCaption(o.caption, visual === 'code' ? 8 : 10);
  if (caption) s.caption = caption;
  if (visual === 'code' && Array.isArray(o.highlight)) {
    s.highlight = o.highlight.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12).slice(0, 3);
  }
  return Object.keys(s).length ? s : undefined;
}

/** Does the scene have what its visual needs? (If not, the player falls back gracefully.) */
export function sceneComplete(visual: SlideVisual, s: LessonScene | undefined): boolean {
  if (visual === 'flow') return Boolean(s?.nodes && s.nodes.length >= 3);
  if (visual === 'branch') return Boolean(s?.from && s.yes && s.no);
  if (visual === 'compare' || visual === 'analogy') return Boolean(s?.left && s.right);
  if (visual === 'big') return Boolean(s?.value);
  if (visual === 'recap') return Boolean(s?.nodes && s.nodes.length >= 2);
  return true;
}
