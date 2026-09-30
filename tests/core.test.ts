import { describe, expect, it } from 'vitest';
import {
  C, MODELS, analyze, buildTips, compute, ecoFactors, ecoFitness, estTokens, explainScores, getModel, guessModel,
  missingDetail, recommendModel, REPLY_HINTS, EMPTY_LIFETIME, currentStreak, milestones, recordAnalyzed, recordEntries,
  sanitizeLifetime, seedLifetime,
  fmtRange, fmtWaterApprox, fmtWaterRange, parseUsageJson, pruneLog, roundHonest, sanitizeEntry, suggestRewrite, summarize,
  type LogEntry,
} from '../shared/core';

const gpt4o = getModel('gpt4o');
const flash = getModel('gemini-flash');
const o1 = getModel('o1');

describe('compute', () => {
  it('matches the documented calibration (10K output tokens on a standard model ≈ 0.5 L)', () => {
    expect(compute(gpt4o, 0, 10_000).waterL).toBeCloseTo(0.5, 5);
  });
  it('weights input tokens at 0.2', () => {
    expect(compute(gpt4o, 10_000, 0).waterL).toBeCloseTo(0.1, 5);
  });
  it('derives energy and CO2 from water', () => {
    const f = compute(gpt4o, 0, 10_000);
    expect(f.kWh).toBeCloseTo(0.5 / C.L_PER_KWH, 6);
    expect(f.co2g).toBeCloseTo(f.kWh * C.CO2_G_PER_KWH, 6);
  });
  it('treats invalid numbers as zero', () => {
    expect(compute(gpt4o, Number.NaN, -5).waterL).toBe(0);
  });
});

describe('estTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estTokens('')).toBe(0);
    expect(estTokens('   ')).toBe(0);
  });
  it('is roughly 4 characters per token for English', () => {
    const t = estTokens('The quick brown fox jumps over the lazy dog.');
    expect(t).toBeGreaterThanOrEqual(9);
    expect(t).toBeLessThanOrEqual(14);
  });
});

describe('analyze', () => {
  it('scores a concise, controlled prompt highly', () => {
    const a = analyze('Explain REST APIs to a junior developer in 5 bullet points, with one real-world example.', flash);
    expect(a?.score).toBeGreaterThanOrEqual(95);
    expect(a?.out.hasLengthCtl).toBe(true);
  });
  it('penalizes filler and repetition', () => {
    const a = analyze("Hi there! I hope you're doing well. I was wondering if you could please possibly help me out with something. Could you please explain to me what a REST API is? Could you please explain what a REST API is and how it works? Thank you so much in advance!", gpt4o);
    expect(a?.score).toBeLessThan(60);
    expect(a?.sub.conciseness).toBeLessThan(30);
  });
  it('caps vague prompts', () => {
    expect(analyze('code?', flash)?.score).toBeLessThanOrEqual(35);
  });
  it('flags a heavy model on a simple request', () => {
    const a = analyze('What is the capital of France?', o1);
    expect(a?.fit).toBe(0);
    expect(a?.hiddenTok).toBeGreaterThan(0);
  });
  it('adds chat history to input tokens', () => {
    const a = analyze('Summarize this in 3 bullets.', gpt4o, 'auto', 5000);
    expect(a?.inputTok).toBe((a?.promptTok ?? 0) + 5000);
  });
  it('returns null for empty text', () => {
    expect(analyze('  ', gpt4o)).toBeNull();
  });
  it('produces at most three tips, largest saving first', () => {
    const a = analyze('Could you please write a detailed essay about water?', o1);
    const tips = a ? buildTips(a, o1) : [];
    expect(tips.length).toBeGreaterThan(0);
    expect(tips.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < tips.length; i++) expect((tips[i - 1]?.save ?? 0)).toBeGreaterThanOrEqual(tips[i]?.save ?? 0);
  });
});

describe('specificity and model sizing', () => {
  it('rewards audience, goal and constraints', () => {
    const vague = analyze('Can you help me make a workout plan?', gpt4o)!;
    const specific = analyze('Create a 4-day beginner hypertrophy workout for a standard gym, with sets, reps and rest periods.', gpt4o)!;
    expect(vague.sub.specificity).toBeLessThan(60);
    expect(specific.sub.specificity).toBeGreaterThanOrEqual(80);
    expect(specific.score).toBeGreaterThan(vague.score);
  });
  it('treats a direct factual question as specific enough', () => {
    expect(analyze('In two sentences, why does saving water matter?', gpt4o)!.sub.specificity).toBeGreaterThanOrEqual(85);
  });
  it('offers detail chips only for what is missing', () => {
    const keys = missingDetail(analyze('Can you help me make a workout plan?', gpt4o)!).map((c) => c.key);
    expect(keys).toContain('audience');
    expect(keys).toContain('constraints');
    expect(missingDetail(analyze('Explain REST APIs to a junior developer in 5 bullet points, with one real-world example.', gpt4o)!)
      .map((c) => c.key)).not.toContain('audience');
  });
  it('recommends the smallest tier that fits, with task-fit wording', () => {
    const simple = analyze('What is the capital of France?', o1)!;
    const adv = recommendModel(simple, o1);
    expect(adv.tier).toBe('light');
    expect(adv.fits).toBe(false);
    expect(adv.alt?.vendor).toBe('OpenAI');
    expect(adv.savePct).toBeGreaterThan(50);
    const complex = analyze('Refactor this module and explain the trade-offs step by step.', gpt4o)!;
    expect(recommendModel(complex, gpt4o)).toMatchObject({ tier: 'standard', fits: true, savePct: null });
  });
});

describe('reply endings', () => {
  const base = 'Help me plan a trip to Japan.';
  it('every ending counts as reply control and adds no fake specificity', () => {
    const spec0 = analyze(base, gpt4o)!.sub.specificity;
    for (const hint of Object.values(REPLY_HINTS).flat()) {
      const a = analyze(`${base} ${hint}`, gpt4o)!;
      expect.soft(a.sub.control, hint).toBeGreaterThanOrEqual(85);
      expect.soft(a.sub.specificity, hint).toBe(spec0);
    }
  });
  it('fits the kind of request and varies between prompts', () => {
    const endOf = (p: string) => { const r = suggestRewrite(p, analyze(p, gpt4o)!)!; return r.text.slice(r.text.lastIndexOf('. ') + 2); };
    expect(REPLY_HINTS.howTo).toContain(endOf('Could you please tell me how can I set up a Python virtual environment on my Mac?'));
    expect(REPLY_HINTS.compare).toContain(endOf('Can you please compare PostgreSQL and MySQL for a small web app?'));
    const endings = new Set(['what a REST API is', 'what a closure is in JavaScript', 'what DNS is', 'what inflation is', 'what a hash map is', 'what a vaccine does']
      .map((x) => endOf(`Could you please explain ${x} and how it works?`)));
    expect(endings.size).toBeGreaterThan(1);
  });
  it('coaches a vague question instead of rewarding it', () => {
    const a = analyze('How can I do this?', gpt4o)!;
    expect(a.sub.specificity).toBeLessThanOrEqual(40);
    expect(missingDetail(a).length).toBeGreaterThan(0);
    const r = suggestRewrite('How can I do this?', a);
    if (r) expect(analyze(r.text, gpt4o)!.score).toBeGreaterThanOrEqual(a.score);
  });
  it('is stable: the same prompt always gets the same ending', () => {
    const p = 'Could you please explain what DNS is and how it works?';
    expect(suggestRewrite(p, analyze(p, gpt4o)!)!.text).toBe(suggestRewrite(p, analyze(p, gpt4o)!)!.text);
  });
});

describe('coaching', () => {
  const wordy = "Hi there! I hope you're doing well. Could you please explain to me what a REST API is? "
    + 'Could you please explain what a REST API is and how it works? Thank you so much in advance!';

  it('rewrites a wordy prompt into a shorter, higher-scoring one', () => {
    const a = analyze(wordy, gpt4o)!;
    const r = suggestRewrite(wordy, a)!;
    expect(r.text.startsWith('Explain what a REST API is and how it works. ')).toBe(true);
    expect(REPLY_HINTS.explain.some((h) => r.text.endsWith(h))).toBe(true);
    const b = analyze(r.text, gpt4o)!;
    expect(b.score).toBeGreaterThan(a.score);
    expect(compute(gpt4o, b.inputTok, b.outputTok).waterL).toBeLessThan(compute(gpt4o, a.inputTok, a.outputTok).waterL);
    expect(r.changes.length).toBeGreaterThanOrEqual(3);
  });
  it('leaves code blocks untouched', () => {
    const p = 'Please fix this bug:\n```js\nconst very = just(); // please\n```';
    const r = suggestRewrite(p, analyze(p, gpt4o)!)!;
    expect(r.text).toContain('```js\nconst very = just(); // please\n```');
    expect(r.text.startsWith('Fix this bug:')).toBe(true);
  });
  it('keeps "Label: value" detail lines on their own lines', () => {
    const p = 'Can you help me make a workout plan?\nFor: a beginner\nGoal: build muscle\nConstraints: 4 days a week, standard gym';
    const r = suggestRewrite(p, analyze(p, gpt4o)!)!;
    const lines = r.text.split('\n');
    expect(lines.slice(0, 3)).toEqual(['Help me make a workout plan.', 'For: a beginner.', 'Goal: build muscle.']);
    expect(lines[3]?.startsWith('Constraints: 4 days a week, standard gym. ')).toBe(true);
    expect(Object.values(REPLY_HINTS).flat().some((h) => lines[3]?.endsWith(h))).toBe(true);
  });
  it('offers no rewrite for lean or very short prompts', () => {
    const lean = 'Explain REST APIs to a junior developer in 5 bullet points, with one real-world example.';
    expect(suggestRewrite(lean, analyze(lean, gpt4o)!)).toBeNull();
    expect(suggestRewrite('code?', analyze('code?', gpt4o)!)).toBeNull();
  });
  it('explains each sub-score with the specific problem', () => {
    const n = explainScores(analyze(wordy, gpt4o)!);
    expect(n.conciseness.ok).toBe(false);
    expect(n.conciseness.text).toContain('"hi there"');
    expect(n.control.ok).toBe(false);
    expect(explainScores(analyze('In two sentences, why does saving water matter?', gpt4o)!).clarity.ok).toBe(true);
  });
});

describe('honest display', () => {
  it('rounds to justified precision', () => {
    expect(roundHonest(8.73)).toBe(9);
    expect(roundHonest(41.4)).toBe(41);
    expect(roundHonest(0.347)).toBe(0.3);
    expect(roundHonest(0)).toBe(0);
  });
  it('shows ranges instead of single precise values', () => {
    expect(fmtRange(8.8, 'mL')).toBe('~4–18 mL');
    expect(fmtWaterRange(0.0088)).toBe('~4–18 mL');
    expect(fmtWaterRange(0.8)).toBe('~0.4–2 L');
    expect(fmtWaterApprox(0.0088)).toBe('~9 mL');
  });
  it('never shows a meaningless zero', () => {
    expect(fmtRange(0, 'Wh')).toBe('');
    expect(fmtWaterApprox(0)).toBe('–');
  });
});

describe('sanitizeEntry (privacy boundary)', () => {
  const ok = { t: Date.now(), m: 'gpt4o', i: 100, o: 200, s: 80, f: 1, src: 'extension' };
  it('accepts the numeric shape', () => {
    expect(sanitizeEntry(ok)).toEqual(ok);
  });
  it('accepts entries from the in-app browser', () => {
    expect(sanitizeEntry({ ...ok, src: 'inapp' })).toEqual({ ...ok, src: 'inapp' });
  });
  it('rejects any extra field, such as prompt text', () => {
    expect(sanitizeEntry({ ...ok, text: 'secret prompt' })).toBeNull();
    expect(sanitizeEntry({ ...ok, src: 'inapp', text: 'secret prompt' })).toBeNull();
  });
  it('rejects unknown models, negative or fractional counts, bad sources', () => {
    expect(sanitizeEntry({ ...ok, m: 'evil' })).toBeNull();
    expect(sanitizeEntry({ ...ok, i: -1 })).toBeNull();
    expect(sanitizeEntry({ ...ok, o: 1.5 })).toBeNull();
    expect(sanitizeEntry({ ...ok, src: 'network' })).toBeNull();
    expect(sanitizeEntry({ ...ok, f: 0.3 })).toBeNull();
  });
});

describe('log helpers', () => {
  it('prunes entries older than 30 days', () => {
    const now = Date.now();
    const log: LogEntry[] = [
      { t: now - 31 * 864e5, m: 'gpt4o', i: 1, o: 1, s: null, f: null, src: 'usage' },
      { t: now, m: 'gpt4o', i: 1, o: 1, s: null, f: null, src: 'usage' },
    ];
    expect(pruneLog(log, now)).toHaveLength(1);
  });
  it('computes eco-fitness from five weighted factors', () => {
    const e: LogEntry = { t: Date.now(), m: 'gemini-flash', i: 100, o: 100, s: 80, f: 1, src: 'playground' };
    // 0.35 × 80 (prompt) + 0.2 × 100 (output) + 0.2 × 100 (model) + 0.1 × 100 (context) + 0.15 × 100 (footprint)
    expect(ecoFitness(summarize([e]), 1)).toBe(93);
    const f = ecoFactors(summarize([e]), 1)!;
    expect(f.map((x) => x.key)).toEqual(['prompt', 'output', 'model', 'context', 'footprint']);
    expect(f.reduce((w, x) => w + x.weight, 0)).toBeCloseTo(1);
    expect(ecoFitness(summarize([{ ...e, s: null }]), 1)).toBeNull();
  });
  it('lowers output and context factors for long replies and long history', () => {
    const e: LogEntry = { t: Date.now(), m: 'gpt4o', i: 8000, o: 1500, s: 80, f: 1, src: 'playground' };
    const f = ecoFactors(summarize([e]), 10)!;
    expect(f.find((x) => x.key === 'output')?.value).toBe(0);
    expect(f.find((x) => x.key === 'context')?.value).toBe(0);
  });
});

describe('habits', () => {
  const day = (d: number, h = 12) => { const x = new Date(2026, 8, 10 + d, h); return x.getTime(); };
  const e = (d: number, extra: Partial<LogEntry> = {}): LogEntry => ({ t: day(d), m: 'gpt4o', i: 100, o: 100, s: 80, f: 1, src: 'playground', ...extra });

  it('counts tracked, optimized and right-sized prompts, never demo data', () => {
    const l = recordEntries(EMPTY_LIFETIME, [e(0, { opt: 1 }), e(0, { f: 0.5 }), e(0, { demo: 1, opt: 1 })]);
    expect(l).toMatchObject({ tracked: 2, analyzed: 2, optimized: 1, rightSized: 1 });
  });
  it('builds a streak day by day and resets after a missed day', () => {
    let l = recordEntries(EMPTY_LIFETIME, [e(0), e(0), e(1), e(2)]);
    expect(l.streakCount).toBe(3);
    l = recordEntries(l, [e(4)]);
    expect(l.streakCount).toBe(1);
    expect(l.streakBest).toBe(3);
  });
  it('keeps the streak alive today and yesterday, zero after that', () => {
    const l = recordEntries(EMPTY_LIFETIME, [e(0), e(1)]);
    expect(currentStreak(l, day(1))).toBe(2);
    expect(currentStreak(l, day(2))).toBe(2);
    expect(currentStreak(l, day(3))).toBe(0);
  });
  it('tracks milestone progress and earning', () => {
    const l = { ...EMPTY_LIFETIME, optimized: 12, analyzed: 3, streakBest: 7 };
    const m = Object.fromEntries(milestones(l).map((x) => [x.id, x]));
    expect(m.runner).toMatchObject({ value: 10, earned: true });
    expect(m.trainer).toMatchObject({ value: 3, earned: false });
    expect(m.week?.earned).toBe(true);
    expect(recordAnalyzed(l).analyzed).toBe(4);
  });
  it('seeds from existing history and rejects bad stored data', () => {
    expect(seedLifetime([e(0), e(1, { opt: 1 })])).toMatchObject({ tracked: 2, optimized: 1, streakCount: 2 });
    expect(sanitizeLifetime({ tracked: -3, optimized: 'x', streakBest: 2.5 })).toEqual(EMPTY_LIFETIME);
  });
});

describe('usage import', () => {
  it('parses Anthropic, OpenAI and Gemini shapes', () => {
    expect(parseUsageJson('{"model":"claude-3-5-sonnet","usage":{"input_tokens":10,"output_tokens":20}}')).toEqual({ inT: 10, outT: 20, modelName: 'claude-3-5-sonnet' });
    expect(parseUsageJson('{"model":"gpt-4o","usage":{"prompt_tokens":5,"completion_tokens":7}}').outT).toBe(7);
    expect(parseUsageJson('{"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"thoughtsTokenCount":6}}').outT).toBe(10);
  });
  it('rejects malformed input', () => {
    expect(() => parseUsageJson('not json')).toThrow();
    expect(() => parseUsageJson('{"usage":{}}')).toThrow();
  });
  it('guesses models from provider names', () => {
    expect(guessModel('gpt-4o-mini-2024-07-18')).toBe('gpt4o-mini');
    expect(guessModel('o1-preview')).toBe('o1');
    expect(guessModel('gemini-1.5-flash')).toBe('gemini-flash');
    expect(guessModel('claude-3-opus')).toBe('opus');
    expect(guessModel('unknown')).toBeNull();
  });
  it('covers every model id', () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length);
  });
});
