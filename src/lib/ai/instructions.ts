import fs from 'node:fs';
import path from 'node:path';
import type { AgentId } from '@/lib/types';

/* What the manager has taught each agent.
 *
 * Standing instructions, written in Settings, saved to .data/agents.json and
 * added to that agent's prompt on every call. They shape how an agent works
 * (tone, priorities, local examples); they never override the Reviewer's
 * rubric, which stays code. */

export const DEFAULT_INSTRUCTIONS: Record<AgentId, string> = {
  planner: 'Prioritise the learners closest to dropping out. Keep every plan to six steps and name who owns each one.',
  success: "Never tell a learner they are 'at risk'. If someone passes their quizzes but goes quiet, reach out personally before sending more work.",
  learning: 'Use South African examples where they help. Three questions per quiz, all on the exact weak topic, each with an explanation that teaches.',
  coo: 'Be strict on topic: a question that drifts from the weak module fails. Be kind in tone and exact in the critique.',
};

const FILE = path.join(process.cwd(), '.data', 'agents.json');
const g = globalThis as unknown as { __ssTeach?: Record<AgentId, string> };

export function getInstructions(): Record<AgentId, string> {
  if (!g.__ssTeach) {
    let saved: Partial<Record<AgentId, string>> = {};
    try { saved = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
    g.__ssTeach = { ...DEFAULT_INSTRUCTIONS, ...saved };
  }
  return g.__ssTeach;
}

export function setInstructions(patch: Partial<Record<AgentId, string>>) {
  const next = { ...getInstructions() };
  for (const [k, v] of Object.entries(patch) as [AgentId, string][]) {
    if (k in DEFAULT_INSTRUCTIONS && typeof v === 'string') next[k] = v.slice(0, 1200);
  }
  g.__ssTeach = next;
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(next, null, 2)); } catch { /* keep in memory */ }
  return next;
}

/** The line added to an agent's system prompt. */
export function teach(id: AgentId) {
  const t = getInstructions()[id]?.trim();
  return t ? `\n\nStanding instructions from your manager (follow them unless they break the rules above): ${t}` : '';
}
