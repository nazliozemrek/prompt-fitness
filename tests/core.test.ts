import { describe, expect, it } from 'vitest';
import {
  C, MODELS, analyze, buildTips, compute, ecoFitness, estTokens, explainScores, getModel, guessModel,
  parseUsageJson, pruneLog, sanitizeEntry, suggestRewrite, summarize, type LogEntry,
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

describe('coaching', () => {
  const wordy = "Hi there! I hope you're doing well. Could you please explain to me what a REST API is? "
    + 'Could you please explain what a REST API is and how it works? Thank you so much in advance!';

  it('rewrites a wordy prompt into a shorter, higher-scoring one', () => {
    const a = analyze(wordy, gpt4o)!;
    const r = suggestRewrite(wordy, a)!;
    expect(r.text).toBe('Explain what a REST API is and how it works. Answer in under 120 words.');
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
  it('computes eco-fitness from score, model fit and budget', () => {
    const e: LogEntry = { t: Date.now(), m: 'gemini-flash', i: 100, o: 100, s: 80, f: 1, src: 'playground' };
    expect(ecoFitness(summarize([e]), 1)).toBe(90);
    expect(ecoFitness(summarize([{ ...e, s: null }]), 1)).toBeNull();
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
