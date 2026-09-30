/**
 * Coaching entry point for the iOS share extension ("Improve prompt").
 *
 * Built to build/share/coach.js and evaluated in JavaScriptCore inside the extension, so the share
 * sheet applies exactly the same rules as the dashboard. JavaScriptCore has no DOM and no network
 * APIs; scripts/check-privacy.mjs also scans the bundle. The prompt text is analyzed in memory and
 * the result goes back to the extension's UI only. Nothing is stored.
 */
import { analyze, compute, explainScores, getModel, isModelId, suggestRewrite, type ModelId } from './core';

export interface CoachNote { label: string; ok: boolean; text: string; }
export type CoachResult =
  | { ok: false; reason: 'empty' }
  | {
      ok: true;
      model: string;
      score: number;
      waterMl: number;
      notes: CoachNote[];
      rewrite: { text: string; changes: string[]; score: number; waterMl: number } | null;
    };

const LABELS = { conciseness: 'Conciseness', focus: 'Focus', clarity: 'Clarity', control: 'Reply control' } as const;

export function coach(text: string, modelId: string): CoachResult {
  const model = getModel(isModelId(modelId) ? modelId : ('gpt4o' satisfies ModelId));
  const a = analyze(text, model);
  if (!a) return { ok: false, reason: 'empty' };
  const waterMl = compute(model, a.inputTok, a.outputTok).waterL * 1000;
  const notes = (Object.keys(LABELS) as (keyof typeof LABELS)[]).map((k) => {
    const n = explainScores(a)[k];
    return { label: LABELS[k], ok: n.ok, text: n.text };
  });
  const r = suggestRewrite(text, a);
  const b = r ? analyze(r.text, model) : null;
  const rewrite = r && b && b.score >= a.score
    ? { text: r.text, changes: r.changes, score: b.score, waterMl: compute(model, b.inputTok, b.outputTok).waterL * 1000 }
    : null;
  return { ok: true, model: model.name, score: a.score, waterMl, notes, rewrite };
}

/** Called from Swift: PromptFitnessCoach.coachJSON(text, modelId) → JSON string. */
(globalThis as unknown as { PromptFitnessCoach: unknown }).PromptFitnessCoach = {
  coachJSON: (text: unknown, modelId: unknown): string =>
    JSON.stringify(coach(typeof text === 'string' ? text : '', typeof modelId === 'string' ? modelId : 'gpt4o')),
};
