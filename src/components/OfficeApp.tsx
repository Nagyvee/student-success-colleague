'use client';

import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useOfficeStream } from '@/hooks/useOfficeStream';
import Icon from '@/components/Icon';
import Floorplan from './office/Floorplan';
import GoalBar from './office/GoalBar';
import Sidebar, { TABS, type SideTab } from './side/Sidebar';
import DeliverableModal from './inspect/DeliverableModal';
import MailModal from './inspect/MailModal';

/* Floor first. The office fills the screen; a goal bar sits on top and one
 * caption at the bottom. The plan, the activity, the outputs, the inbox and
 * the cohort live in one drawer that opens only when asked for, and when it
 * opens the camera slides the building aside instead of hiding it. */

const DRAWER_W = 384;

export default function OfficeApp() {
  const { state } = useOfficeStream();
  const [drawer, setDrawer] = useState<SideTab | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [openMail, setOpenMail] = useState<string | null>(null);
  const [stage, setStage] = useState(false);
  const params = useSearchParams();

  useEffect(() => {
    const onFs = () => { if (!document.fullscreenElement) setStage(false); };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);
  const toggleStage = () => {
    if (!stage) {
      setStage(true);
      try { void document.documentElement.requestFullscreen?.().catch(() => { /* stage mode still applies */ }); } catch { /* ignore */ }
    } else {
      setStage(false);
      if (document.fullscreenElement) { try { void document.exitFullscreen().catch(() => {}); } catch { /* ignore */ } }
    }
  };

  useEffect(() => { const o = params.get('open'); if (o) setOpenId(o); }, [params]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openId || openMail) { setOpenId(null); setOpenMail(null); } else setDrawer(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, openMail]);

  const activeTask = state?.tasks.find((t) => t.status === 'running') || state?.tasks[0] || null;
  const deliverable = state?.deliverables.find((d) => d.id === openId) || null;
  const mail = state?.inbox.find((m) => m.id === openMail) || null;
  const inspectId = activeTask?.deliverableIds[activeTask.deliverableIds.length - 1] || state?.deliverables[0]?.id || null;

  // A tab that has something new since it was last opened gets a dot.
  const seen = useRef<Record<string, number>>({});
  const counts: Record<SideTab, number> = {
    plan: activeTask?.plan ? activeTask.plan.steps.filter((s) => s.status === 'done').length : 0,
    feed: state?.feed.length || 0,
    deliverables: state?.deliverables.length || 0,
    inbox: state?.inbox.length || 0,
    learners: state?.learners.filter((l) => l.status !== 'on_track').length || 0,
  };
  if (drawer) seen.current[drawer] = counts[drawer];
  const badge = (t: SideTab) => {
    if (t === 'plan') return activeTask?.plan ? `${counts.plan}/${activeTask.plan.steps.length}` : null;
    if (t === 'feed') return null;
    return counts[t] ? String(counts[t]) : null;
  };
  const fresh = (t: SideTab) => drawer !== t && counts[t] > (seen.current[t] ?? 0) && t !== 'feed';

  const tabs = (
    <div className="cmd-group drawer-tabs" role="tablist" aria-label="Details">
      {TABS.map((t) => (
        <button key={t.id} type="button" role="tab" title={t.label} aria-label={t.label} aria-selected={drawer === t.id} className={`cmd-btn${drawer === t.id ? ' is-open' : ''}${fresh(t.id) ? ' is-fresh' : ''}`}
          onClick={() => setDrawer((d) => (d === t.id ? null : t.id))}>
          <Icon name={t.icon} size={14} /><span className="tab-l">{t.label}</span>{badge(t.id) && <em>{badge(t.id)}</em>}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`shell is-solo${stage ? ' is-stage' : ''}`}>
      <main className="office-main">
        <section className="floor-wrap">
          {state ? (
            <Floorplan state={state} inspectId={inspectId} onInspect={setOpenId} stage={stage} onStage={toggleStage}
              insetRight={drawer ? DRAWER_W + 12 : 0}>
              <GoalBar state={state} stage={stage} onExitStage={toggleStage} right={tabs} />
            </Floorplan>
          ) : (
            <div className="office" aria-busy="true" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontSize: 13, color: '#5b6478' }}>
              <span>Opening the office…</span>
            </div>
          )}
          {drawer && (
            <aside className="drawer-wrap" style={{ width: DRAWER_W }}>
              <Sidebar state={state} tab={drawer} onInspect={setOpenId} onOpenMail={setOpenMail} onClose={() => setDrawer(null)} />
            </aside>
          )}
        </section>
      </main>
      {deliverable && state && <DeliverableModal deliverable={deliverable} state={state} onClose={() => setOpenId(null)} />}
      {mail && <MailModal mail={mail} onClose={() => setOpenMail(null)} onInspect={(id) => { setOpenMail(null); setOpenId(id); }} />}
    </div>
  );
}
