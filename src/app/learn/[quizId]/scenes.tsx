'use client';

import { Fragment } from 'react';

import { motion } from 'framer-motion';
import {
  AlertTriangle, ArrowRight, BarChart3, BookOpen, Box, Boxes, Braces, Brain, Bug, Building, Bus, Calculator, Calendar, Check,
  Clock, Cloud, Code, Coffee, Columns2, Compass, Cpu, Database, Eye, File, Filter, Flag, Folder, GitBranch, GitMerge, Globe,
  GraduationCap, Grid3x3, Hand, Heart, Home, Hourglass, Inbox, Key, Layers, LayoutGrid, Lightbulb, Link, List, Lock, Mail, Map,
  MessageCircle, Monitor, Network, Package, Pause, Phone, PieChart, Play, Puzzle, Receipt, RefreshCw, Repeat, Rocket, Rows3,
  Search, Send, Server, Settings, Shield, ShoppingCart, Sigma, Smartphone, Split, Square, Star, Table, Target,
  Terminal, Timer, Trophy, Truck, User, Users, Variable, Wallet, Wifi, Workflow, Wrench, X, Zap, type LucideIcon,
} from 'lucide-react';
import type { LessonScene, LessonSlide, SceneNode, SlideVisual } from '@/lib/types';

/* The scenes of the personal video lesson.
 *
 * Each one is an animation that SHOWS the idea while the tutor's voice
 * explains it: things moving through stages, one thing ending two ways, the
 * mistake beside the fix, code typing in with the important line lit up, an
 * everyday thing next to the concept, one big number. Words on screen are
 * labels only. Everything is timed to the narration (progress 0 → 1), in the
 * academy's colours: calm navy, one accent. */

const ICONS: Record<string, LucideIcon> = {
  package: Package, truck: Truck, clock: Clock, hourglass: Hourglass, timer: Timer, check: Check, x: X, alert: AlertTriangle,
  lightbulb: Lightbulb, database: Database, table: Table, server: Server, cloud: Cloud, code: Code, braces: Braces,
  terminal: Terminal, bug: Bug, wrench: Wrench, settings: Settings, 'git-branch': GitBranch, merge: GitMerge, split: Split,
  workflow: Workflow, link: Link, layers: Layers, box: Box, boxes: Boxes, key: Key, lock: Lock, shield: Shield, wifi: Wifi,
  globe: Globe, mail: Mail, message: MessageCircle, phone: Phone, user: User, users: Users, file: File, folder: Folder,
  search: Search, filter: Filter, list: List, calculator: Calculator, chart: BarChart3, pie: PieChart, target: Target,
  flag: Flag, rocket: Rocket, zap: Zap, repeat: Repeat, refresh: RefreshCw, 'arrow-right': ArrowRight, play: Play,
  pause: Pause, stop: Square, cart: ShoppingCart, receipt: Receipt, wallet: Wallet, coffee: Coffee, bus: Bus, home: Home,
  building: Building, graduation: GraduationCap, book: BookOpen, brain: Brain, eye: Eye, hand: Hand, puzzle: Puzzle,
  star: Star, heart: Heart, trophy: Trophy, smartphone: Smartphone, monitor: Monitor, cpu: Cpu,
  calendar: Calendar, map: Map, compass: Compass, inbox: Inbox, send: Send, layout: LayoutGrid, grid: Grid3x3,
  columns: Columns2, rows: Rows3, network: Network, variable: Variable, sigma: Sigma,
};

function Ic({ name, fallback = 'lightbulb', size }: { name?: string; fallback?: string; size?: string | number }) {
  const C = ICONS[name || ''] || ICONS[fallback] || Star;
  return <C size={size as number} strokeWidth={1.8} style={{ width: '1em', height: '1em' }} aria-hidden="true" />;
}

const EASE: [number, number, number, number] = [0.2, 1, 0.3, 1];
/** Appear when the narration reaches `at` (0..1). */
const at = (progress: number, when: number, reduced: boolean) => reduced || progress >= when;
const pop = (on: boolean, reduced: boolean, delay = 0) => ({
  initial: reduced ? false : { opacity: 0, y: 18, scale: 0.94 },
  animate: on ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 18, scale: 0.94 },
  transition: { duration: 0.6, ease: EASE, delay },
});

export interface SceneProps {
  slide: LessonSlide;
  progress: number;
  reduced: boolean;
  first: string;
  n: number;
  pass: number;
  evidenceScore: number | null;
  missed: string[];
  tutor: string;
  /** The closing tiles (a lead's video: "2 min · fit quiz"); a lesson shows the test's. */
  tiles?: [string, string][];
  kicker?: string;
}

/** Older lessons (concept / steps, text points) get the closest visual. */
function upgrade(slide: LessonSlide): { visual: SlideVisual; scene: LessonScene } {
  const v = slide.visual || (slide.code ? 'code' : 'concept');
  if (slide.scene && v !== 'concept' && v !== 'steps') return { visual: v, scene: slide.scene };
  const pts = slide.points || [];
  if (v === 'steps' && pts.length >= 2) return { visual: 'recap', scene: { nodes: pts.map((p) => ({ label: p, icon: 'check' })) } };
  if (v === 'compare' && pts.length >= 2) return { visual: 'compare', scene: { left: { label: pts[0].replace(/^(mistake|wrong)\s*:\s*/i, ''), icon: 'x' }, right: { label: pts[1].replace(/^(fix|right)\s*:\s*/i, ''), icon: 'check' } } };
  if (v === 'recap' && pts.length) return { visual: 'recap', scene: { nodes: pts.map((p) => ({ label: p, icon: 'check' })) } };
  if (v === 'analogy') return { visual: 'big', scene: { value: slide.heading, caption: pts[0] } };
  if (v === 'concept') return { visual: 'big', scene: { value: slide.heading, caption: pts[0] } };
  return { visual: v, scene: slide.scene || {} };
}

export default function Scene(props: SceneProps) {
  const { slide } = props;
  const { visual, scene } = upgrade(slide);
  switch (visual) {
    case 'greeting': return <Greeting {...props} />;
    case 'flow': return <Flow {...props} scene={scene} />;
    case 'branch': return <BranchScene {...props} scene={scene} />;
    case 'compare': return <Compare {...props} scene={scene} />;
    case 'code': return slide.code ? <CodeScene {...props} scene={scene} code={slide.code} /> : <Big {...props} scene={{ value: slide.heading, caption: scene.caption }} />;
    case 'analogy': return <Analogy {...props} scene={scene} />;
    case 'recap': return <Recap {...props} scene={scene} />;
    case 'cta': return <Cta {...props} />;
    case 'photo': return <PhotoScene {...props} scene={scene} />;
    case 'facts': return <Facts {...props} scene={scene} />;
    case 'price': return <Price {...props} scene={scene} />;
    case 'timeline': return <Timeline {...props} scene={scene} />;
    case 'careers': return <Careers {...props} scene={scene} />;
    case 'big':
    default: return <Big {...props} scene={scene.value ? scene : { value: slide.heading, caption: scene.caption }} />;
  }
}

/* ── greeting ─────────────────────────────────────────────────────────── */

function Greeting({ slide, progress, reduced, first, evidenceScore, missed, tutor }: SceneProps) {
  return (
    <div className="sc sc-greet">
      <motion.div className="sc-avatar" {...pop(true, reduced)}>
        <span>{tutor.charAt(0)}</span>
        <i className="sc-avatar-ring" />
      </motion.div>
      <h2 className="sc-hello"><Words text={slide.heading.includes(first) ? stripWave(slide.heading) : `Hey ${first}`} reduced={reduced} delay={0.15} /></h2>
      {evidenceScore === null && missed.length > 0 && (
        <motion.div className="sc-noticed sc-noticed--plain" {...pop(at(progress, 0.3, reduced), reduced)}>
          <div className="sc-noticed-text">
            <small>What I noticed</small>
            <div className="sc-noticed-tags">
              {missed.slice(0, 3).map((m, k) => (
                <motion.em key={m} {...pop(at(progress, 0.36 + k * 0.1, reduced), reduced)}>{m}</motion.em>
              ))}
            </div>
          </div>
        </motion.div>
      )}
      {evidenceScore !== null && (
        <motion.div className="sc-noticed" {...pop(at(progress, 0.3, reduced), reduced)}>
          <Ring pct={evidenceScore} />
          <div className="sc-noticed-text">
            <small>What I noticed</small>
            <b>{evidenceScore}% on your last checkpoint</b>
            {missed.length > 0 && (
              <div className="sc-noticed-tags">
                {missed.slice(0, 3).map((m, k) => (
                  <motion.em key={m} {...pop(at(progress, 0.38 + k * 0.08, reduced), reduced)}>{m}</motion.em>
                ))}
              </div>
            )}
          </div>
        </motion.div>
      )}
    </div>
  );
}

function Ring({ pct }: { pct: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  return (
    <svg className="sc-ring" viewBox="0 0 64 64" aria-label={`${pct}%`}>
      <circle cx="32" cy="32" r={r} className="sc-ring-bg" />
      <motion.circle
        cx="32" cy="32" r={r} className="sc-ring-fg"
        initial={{ strokeDasharray: `0 ${c}` }}
        animate={{ strokeDasharray: `${(Math.max(0, Math.min(100, pct)) / 100) * c} ${c}` }}
        transition={{ duration: 1.4, ease: EASE, delay: 0.3 }}
      />
      <text x="32" y="37" textAnchor="middle">{pct}%</text>
    </svg>
  );
}

/* ── flow: things moving through stages ───────────────────────────────── */

function Flow({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const nodes = scene.nodes || [];
  const active = reduced ? nodes.length - 1 : Math.min(nodes.length - 1, Math.floor(progress * (nodes.length + 0.25)));
  return (
    <div className="sc sc-flow">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-flow-row">
        {nodes.map((nd, k) => (
          <div key={k} className="sc-flow-cell">
            <motion.div className={`sc-node${k < active ? ' is-done' : k === active ? ' is-now' : ''}`} {...pop(k <= active, reduced)}>
              <span className="sc-node-ic"><Ic name={nd.icon} /></span>
              <b>{nd.label}</b>
              {nd.note && <small>{nd.note}</small>}
            </motion.div>
            {k < nodes.length - 1 && (
              <div className={`sc-link${k < active ? ' is-on' : ''}`} aria-hidden="true">
                <i className="sc-link-line" />
                {k < active && !reduced && <i className="sc-packet" />}
                <ArrowRight className="sc-link-head" />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── branch: one thing, two outcomes ──────────────────────────────────── */

function BranchScene({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const showYes = at(progress, 0.3, reduced);
  const showNo = at(progress, 0.6, reduced);
  const nodeEl = (nd: SceneNode | undefined, cls: string, on: boolean, badge?: 'yes' | 'no') => nd && (
    <motion.div className={`sc-bnode ${cls}`} {...pop(on, reduced)}>
      <span className="sc-node-ic"><Ic name={nd.icon} /></span>
      <b>{nd.label}</b>
      {badge && <span className={`sc-badge is-${badge}`}>{badge === 'yes' ? <Check /> : <X />}</span>}
    </motion.div>
  );
  return (
    <div className="sc sc-branch">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-branch-stage">
        {/* The stage is 78 × 25 cqw, so this viewBox keeps its proportions: arrows meet the icons' edges. */}
        <svg className="sc-branch-svg" viewBox="0 0 100 32" aria-hidden="true">
          <motion.path d="M 22.5 16 C 45 16, 55 5.8, 76.5 5.8" className="sc-bpath is-yes" initial={{ pathLength: 0 }} animate={{ pathLength: showYes ? 1 : 0 }} transition={{ duration: 0.9, ease: EASE }} />
          <motion.path d="M 22.5 16 C 45 16, 55 24.3, 76.5 24.3" className="sc-bpath is-no" initial={{ pathLength: 0 }} animate={{ pathLength: showNo ? 1 : 0 }} transition={{ duration: 0.9, ease: EASE }} />
        </svg>
        {nodeEl(scene.from, 'is-from', true)}
        {nodeEl(scene.yes, 'is-yes', showYes, 'yes')}
        {nodeEl(scene.no, 'is-no', showNo, 'no')}
      </div>
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.75, reduced)} reduced={reduced} />}
    </div>
  );
}

/* ── compare: the mistake beside the fix ──────────────────────────────── */

function Compare({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const fix = at(progress, 0.42, reduced);
  return (
    <div className="sc sc-compare">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-compare-row">
        <motion.div className={`sc-side is-mistake${fix ? ' is-faded' : ''}`} {...pop(true, reduced)}>
          <span className="sc-badge is-no"><X /></span>
          <small>The common mistake</small>
          <span className="sc-side-ic"><Ic name={scene.left?.icon} fallback="bug" /></span>
          <b>{scene.left?.label}</b>
          {scene.left?.code && <pre className="sc-mini-code is-wrong">{scene.left.code}</pre>}
        </motion.div>
        <motion.span className="sc-compare-arrow" {...pop(fix, reduced)} aria-hidden="true"><ArrowRight /></motion.span>
        <motion.div className="sc-side is-fix" {...pop(fix, reduced, 0.1)}>
          <span className="sc-badge is-yes"><Check /></span>
          <small>The fix</small>
          <span className="sc-side-ic"><Ic name={scene.right?.icon} fallback="check" /></span>
          <b>{scene.right?.label}</b>
          {scene.right?.code && <pre className="sc-mini-code">{scene.right.code}</pre>}
        </motion.div>
      </div>
    </div>
  );
}

/* ── code: typed in, the important line lit up ────────────────────────── */

function CodeScene({ slide, progress, reduced, scene, code }: SceneProps & { scene: LessonScene; code: string }) {
  const typed = reduced ? code.length : Math.min(code.length, Math.floor(code.length * Math.min(1, progress / 0.5)));
  const lines = code.slice(0, typed).split('\n');
  const total = code.split('\n').length;
  const lit = new Set((scene.highlight || []).filter((n) => n <= total));
  const showLit = at(progress, 0.55, reduced);
  const firstLit = [...lit][0];
  return (
    <div className="sc sc-code">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-code-wrap">
        <div className="sc-editor">
          <div className="sc-editor-bar" aria-hidden="true"><i /><i /><i /></div>
          <pre aria-label={code}>
            {lines.map((ln, k) => (
              <div key={k} className={`sc-line${showLit && lit.has(k + 1) ? ' is-lit' : ''}${showLit && lit.size && !lit.has(k + 1) ? ' is-dim' : ''}`}>
                <span className="sc-ln">{k + 1}</span>
                <code>{ln || ' '}{k === lines.length - 1 && typed < code.length && <span className="sc-caret" />}</code>
              </div>
            ))}
          </pre>
        </div>
        {scene.caption && firstLit && (
          <motion.div className="sc-callout" style={{ ['--line' as string]: firstLit }} {...pop(showLit, reduced)}>
            <Lightbulb />{scene.caption}
          </motion.div>
        )}
      </div>
    </div>
  );
}

/* ── analogy: an everyday thing ≈ the concept ─────────────────────────── */

function Analogy({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const eq = at(progress, 0.3, reduced);
  const right = at(progress, 0.45, reduced);
  return (
    <div className="sc sc-analogy">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-analogy-row">
        <motion.div className="sc-medal" {...pop(true, reduced)}>
          <span className="sc-medal-ic is-float"><Ic name={scene.left?.icon} fallback="package" /></span>
          <b>{scene.left?.label}</b>
        </motion.div>
        <motion.span className="sc-approx" {...pop(eq, reduced)}>≈</motion.span>
        <motion.div className="sc-medal is-concept" {...pop(right, reduced)}>
          <span className="sc-medal-ic is-float is-late"><Ic name={scene.right?.icon} fallback="lightbulb" /></span>
          <b>{scene.right?.label}</b>
        </motion.div>
      </div>
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.6, reduced)} reduced={reduced} />}
    </div>
  );
}

/* ── big: one thing that sticks ───────────────────────────────────────── */

function Big({ progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const words = (scene.value || '').split(/\s+/).filter(Boolean);
  return (
    <div className="sc sc-big">
      <h2 className="sc-bigword" aria-label={scene.value}>
        {words.map((w, k) => (
          <motion.span
            key={`${w}-${k}`}
            initial={reduced ? false : { opacity: 0, y: '0.5em', filter: 'blur(8px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            transition={{ duration: 0.7, ease: EASE, delay: 0.12 + k * 0.14 }}
          >{w}</motion.span>
        ))}
      </h2>
      <motion.i className="sc-underline" initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 0.9, ease: EASE, delay: 0.5 }} />
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.25, reduced)} reduced={reduced} />}
    </div>
  );
}

/* ── recap ────────────────────────────────────────────────────────────── */

function Recap({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const items = scene.nodes || [];
  const shown = reduced ? items.length : Math.min(items.length, Math.floor(progress * (items.length + 0.6)) + 1);
  return (
    <div className="sc sc-recap">
      <Title text={slide.heading} reduced={reduced} />
      <ul>
        {items.map((it, k) => (
          <motion.li key={k} className={k < shown ? 'is-on' : ''} {...pop(k < shown, reduced)}>
            <span className="sc-tick"><Check /></span>
            <span className="sc-recap-ic"><Ic name={it.icon === 'check' ? undefined : it.icon} fallback="star" /></span>
            <b>{it.label}</b>
          </motion.li>
        ))}
      </ul>
    </div>
  );
}

/* ── cta ──────────────────────────────────────────────────────────────── */

function Cta({ slide, progress, reduced, first, n, pass, tiles: given, kicker }: SceneProps) {
  const tiles: [string, string][] = given?.length ? given : [[String(n), 'questions'], [`${pass}%`, 'to pass'], [`~${Math.max(3, Math.round(n * 0.75))}`, 'minutes']];
  return (
    <div className="sc sc-cta">
      <motion.small {...pop(true, reduced)}>{kicker || `Your turn, ${first}`}</motion.small>
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-tiles">
        {tiles.map(([b, s], k) => (
          <motion.div key={s} {...pop(at(progress, 0.15 + k * 0.15, reduced), reduced)}><b>{b}</b><span>{s}</span></motion.div>
        ))}
      </div>
    </div>
  );
}

/* ── photo: a real moment from the academy, with a lower third ─────────── */

function PhotoScene({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  return (
    <div className="sc sc-photo">
      <div className="sc-lower">
        {scene.kicker && <motion.small className="sc-kicker" {...pop(true, reduced)}>{scene.kicker}</motion.small>}
        <h2 className="sc-photo-title"><Words text={stripWave(slide.heading)} reduced={reduced} delay={0.2} /></h2>
        {scene.caption && <motion.p className="sc-photo-cap" {...pop(at(progress, 0.3, reduced), reduced)}>{scene.caption}</motion.p>}
      </div>
    </div>
  );
}

/* ── facts: the numbers that matter, as tiles ─────────────────────────── */

function Facts({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const items = scene.nodes || [];
  return (
    <div className="sc sc-facts">
      <Title text={slide.heading} reduced={reduced} />
      <div className={`sc-facts-grid n${items.length}`}>
        {items.map((it, k) => (
          <motion.div key={k} className="sc-fact" {...pop(at(progress, 0.08 + k * (0.7 / Math.max(1, items.length)), reduced), reduced)}>
            <b>{it.label}</b>
            {it.note && <span>{it.note}</span>}
          </motion.div>
        ))}
      </div>
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.82, reduced)} reduced={reduced} />}
    </div>
  );
}

/* ── price: the standard fee struck through, the price they would pay ─── */

function Price({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const rows = scene.rows || [];
  return (
    <div className="sc sc-price">
      <Title text={slide.heading} reduced={reduced} />
      <div className={`sc-price-row n${rows.length}`}>
        {rows.map((r, k) => {
          const on = at(progress, 0.1 + k * 0.22, reduced);
          const struck = at(progress, 0.2 + k * 0.22, reduced);
          return (
            <motion.div key={k} className="sc-price-card" {...pop(on, reduced)}>
              <small>{r.label}</small>
              {r.was && (
                <span className={`sc-was${struck ? ' is-struck' : ''}`}>
                  {r.was}
                  <motion.i initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: struck ? 1 : 0 }} transition={{ duration: 0.5, ease: EASE }} />
                </span>
              )}
              <motion.b initial={reduced ? false : { opacity: 0, y: 12 }} animate={struck || !r.was ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }} transition={{ duration: 0.6, ease: EASE }}>{r.now}</motion.b>
              {r.note && <em>{r.note}</em>}
            </motion.div>
          );
        })}
      </div>
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.7, reduced)} reduced={reduced} />}
    </div>
  );
}

/* ── timeline: the months ahead ───────────────────────────────────────── */

function Timeline({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const items = scene.nodes || [];
  const reached = reduced ? items.length - 1 : Math.min(items.length - 1, Math.floor(progress * (items.length + 0.3)));
  const fill = items.length > 1 ? (reached / (items.length - 1)) * 100 : 100;
  return (
    <div className="sc sc-timeline">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-tl" style={{ ['--n' as string]: items.length }}>
        <div className="sc-tl-track" aria-hidden="true"><motion.i initial={reduced ? false : { width: '0%' }} animate={{ width: `${fill}%` }} transition={{ duration: 0.8, ease: EASE }} /></div>
        {items.map((it, k) => (
          <motion.div key={k} className={`sc-tl-step${k <= reached ? ' is-on' : ''}${k === reached ? ' is-now' : ''}`} {...pop(k <= reached, reduced)}>
            <span className="sc-tl-dot" aria-hidden="true" />
            <b>{it.label}</b>
            {it.note && <small>{it.note}</small>}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

/* ── careers: the jobs this path leads to ─────────────────────────────── */

function Careers({ slide, progress, reduced, scene }: SceneProps & { scene: LessonScene }) {
  const items = scene.nodes || [];
  const shown = reduced ? items.length : Math.min(items.length, Math.floor(progress * (items.length + 0.8)) + 1);
  return (
    <div className="sc sc-careers">
      <Title text={slide.heading} reduced={reduced} />
      <div className="sc-chips">
        {items.map((it, k) => (
          <motion.span key={k} className="sc-chip" {...pop(k < shown, reduced)}>
            <i><Ic name={it.icon} fallback="rocket" /></i>{it.label}
          </motion.span>
        ))}
      </div>
      {scene.caption && <Caption text={scene.caption} on={at(progress, 0.8, reduced)} reduced={reduced} />}
    </div>
  );
}

/** Older lessons saved a wave emoji in the heading; the player never shows emoji. */
const stripWave = (t: string) => t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').trim();

/* ── bits ─────────────────────────────────────────────────────────────── */

function Title({ text, reduced }: { text: string; reduced: boolean }) {
  return <h2 className="sc-title"><Words text={stripWave(text)} reduced={reduced} /></h2>;
}

/** Kinetic type: each word rises out of a mask, one after another, with a sideways drift that
 *  settles (wide for the first word, almost none for the last), like a camera coming to rest. */
function Words({ text, reduced, delay = 0 }: { text: string; reduced: boolean; delay?: number }) {
  const words = text.split(/\s+/).filter(Boolean);
  if (reduced) return <>{text}</>;
  return (
    <>
      {words.map((w, k) => (
        <Fragment key={`${w}-${k}`}>
          <span className="kt-mask">
            <motion.span
              className="kt-word"
              initial={{ y: '108%', x: `${Math.max(0.1, 0.9 - k * 0.22)}em`, opacity: 0 }}
              animate={{ y: '0%', x: '0em', opacity: 1 }}
              transition={{ duration: 0.7, ease: EASE, delay: delay + 0.12 + k * 0.075 }}
            >
              {w}
            </motion.span>
          </span>
          {/* The space sits between the masks (inside one it would collapse). */}
          {k < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </>
  );
}

function Caption({ text, on, reduced }: { text: string; on: boolean; reduced: boolean }) {
  return <motion.p className="sc-caption" {...pop(on, reduced)}>{text}</motion.p>;
}
