/**
 * Prompt Fitness core: pure, dependency-free logic shared by the dashboard,
 * the Capacitor apps and the browser extensions.
 *
 * Nothing in this module touches the DOM, storage or the network.
 * Coefficient sources and assumptions are documented in README.md ("Methodology").
 */

export const COEFFICIENTS_VERSION = '2026.09';

export type ModelClass = 'light' | 'standard' | 'heavy';

export interface Model {
  readonly id: ModelId;
  readonly name: string;
  readonly vendor: 'OpenAI' | 'Anthropic' | 'Google';
  readonly cls: ModelClass;
  /** Litres of water per 10,000 weighted tokens (UC Riverside-based, hybrid cooling, US grid). */
  readonly l10k: number;
  readonly reasoning?: boolean;
}

export type ModelId =
  | 'gpt4o-mini' | 'gemini-flash' | 'haiku'
  | 'gpt4o' | 'sonnet' | 'gemini-pro'
  | 'opus' | 'o1';

export const MODELS: readonly Model[] = Object.freeze([
  { id: 'gpt4o-mini',   name: 'GPT-4o mini',       vendor: 'OpenAI',    cls: 'light',    l10k: 0.10 },
  { id: 'gemini-flash', name: 'Gemini 1.5 Flash',  vendor: 'Google',    cls: 'light',    l10k: 0.09 },
  { id: 'haiku',        name: 'Claude 3.5 Haiku',  vendor: 'Anthropic', cls: 'light',    l10k: 0.11 },
  { id: 'gpt4o',        name: 'GPT-4o',            vendor: 'OpenAI',    cls: 'standard', l10k: 0.50 },
  { id: 'sonnet',       name: 'Claude 3.5 Sonnet', vendor: 'Anthropic', cls: 'standard', l10k: 0.52 },
  { id: 'gemini-pro',   name: 'Gemini 1.5 Pro',    vendor: 'Google',    cls: 'standard', l10k: 0.48 },
  { id: 'opus',         name: 'Claude 3 Opus',     vendor: 'Anthropic', cls: 'heavy',    l10k: 1.45 },
  { id: 'o1',           name: 'OpenAI o1',         vendor: 'OpenAI',    cls: 'heavy',    l10k: 1.50, reasoning: true },
] as const satisfies readonly Model[]);

export const CLASS_META: Readonly<Record<ModelClass, { label: string; rgb: string }>> = Object.freeze({
  light:    { label: 'Light / Flash',     rgb: '61,216,245' },
  standard: { label: 'Standard',          rgb: '129,140,248' },
  heavy:    { label: 'Heavy / Reasoning', rgb: '255,190,85' },
});

export const C = Object.freeze({
  /** Input tokens cost roughly 1/5 of output tokens (prefill vs decode; price ratio as proxy). */
  ALPHA_IN: 0.2,
  /** Litres per facility kWh: (0.55 on-site + 1.17 PUE × 3.14 grid) / 1.17 ≈ 3.6 (Li et al.). */
  L_PER_KWH: 3.6,
  /** Approximate US grid average, g CO2e per kWh (location-based). */
  CO2_G_PER_KWH: 370,
  BOTTLE_L: 0.5,
  FLUSH_L: 6,
  PHONE_KWH: 0.015,
  /** Assumption: reasoning models emit ~3 hidden tokens per visible token. */
  REASONING_MULT: 4,
  PROMPTS_PER_DAY: 20,
  MAX_TOKENS: 5_000_000,
  MAX_PROMPT_CHARS: 200_000,
});

export const MODEL_IDS: readonly ModelId[] = MODELS.map((m) => m.id);
export const isModelId = (v: unknown): v is ModelId => typeof v === 'string' && (MODEL_IDS as readonly string[]).includes(v);
export const getModel = (id: string | null | undefined): Model =>
  MODELS.find((m) => m.id === id) ?? (MODELS.find((m) => m.id === 'gpt4o') as Model);

export const clamp = (v: number, lo = 0, hi = 100): number => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ */
/* Footprint                                                           */
/* ------------------------------------------------------------------ */

export interface Footprint {
  readonly weighted: number;
  readonly waterL: number;
  readonly kWh: number;
  readonly co2g: number;
}

export function compute(model: Model, inTok: number, outTok: number): Footprint {
  const safeIn = Number.isFinite(inTok) ? Math.max(0, inTok) : 0;
  const safeOut = Number.isFinite(outTok) ? Math.max(0, outTok) : 0;
  const weighted = safeOut + C.ALPHA_IN * safeIn;
  const waterL = (weighted / 10_000) * model.l10k;
  const kWh = waterL / C.L_PER_KWH;
  return { weighted, waterL, kWh, co2g: kWh * C.CO2_G_PER_KWH };
}

/** Approximate token count (~4 chars/token in English, blended with a word-based estimate). */
export function estTokens(text: string | null | undefined): number {
  if (!text) return 0;
  const t = text.length > C.MAX_PROMPT_CHARS ? text.slice(0, C.MAX_PROMPT_CHARS) : text;
  if (!t.trim()) return 0;
  const words = (t.match(/\S+/g) ?? []).length;
  return Math.max(1, Math.round((t.length / 4 + words * 1.33) / 2));
}

/* ------------------------------------------------------------------ */
/* Log entries (the ONLY persisted shape: numbers, never text)         */
/* ------------------------------------------------------------------ */

export type EntrySource = 'playground' | 'extension' | 'inapp' | 'usage' | 'share';

export interface LogEntry {
  /** Unix ms */
  t: number;
  m: ModelId;
  /** input tokens */
  i: number;
  /** output tokens (incl. hidden reasoning tokens) */
  o: number;
  /** efficiency score 0–100, null when no prompt text was analyzed */
  s: number | null;
  /** model fit 0 | 0.5 | 1, null when unknown */
  f: number | null;
  src: EntrySource;
  demo?: 1;
}

const SOURCES: readonly EntrySource[] = ['playground', 'extension', 'inapp', 'usage', 'share'];

/** Strict validator: rejects anything that isn't the exact numeric shape (defends every storage boundary). */
export function sanitizeEntry(raw: unknown): LogEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const allowed = new Set(['t', 'm', 'i', 'o', 's', 'f', 'src', 'demo']);
  if (Object.keys(e).some((k) => !allowed.has(k))) return null;
  const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= C.MAX_TOKENS;
  if (typeof e.t !== 'number' || !Number.isFinite(e.t) || e.t <= 0) return null;
  if (!isModelId(e.m) || !isCount(e.i) || !isCount(e.o)) return null;
  const s = e.s === null || e.s === undefined ? null : e.s;
  if (s !== null && (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 100)) return null;
  const f = e.f === null || e.f === undefined ? null : e.f;
  if (f !== null && f !== 0 && f !== 0.5 && f !== 1) return null;
  const src = typeof e.src === 'string' && (SOURCES as readonly string[]).includes(e.src) ? (e.src as EntrySource) : null;
  if (!src) return null;
  const out: LogEntry = { t: Math.round(e.t), m: e.m, i: e.i, o: e.o, s: s === null ? null : Math.round(s as number), f: f as number | null, src };
  if (e.demo === 1) out.demo = 1;
  return out;
}

export const MAX_LOG_AGE_MS = 30 * 864e5;
export const MAX_LOG_ENTRIES = 3000;

export function pruneLog(log: readonly LogEntry[], now = Date.now()): LogEntry[] {
  const cutoff = now - MAX_LOG_AGE_MS;
  return log.filter((e) => e.t >= cutoff).sort((a, b) => a.t - b.t).slice(-MAX_LOG_ENTRIES);
}

export const dayStart = (d: Date | number = new Date()): number => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
};

export interface DaySummary {
  count: number;
  waterL: number;
  kWh: number;
  co2g: number;
  avgScore: number | null;
  rightSized: number | null;
}

export function summarize(entries: readonly LogEntry[]): DaySummary {
  let waterL = 0, kWh = 0, co2g = 0, sSum = 0, sN = 0, fSum = 0, fN = 0;
  for (const e of entries) {
    const f = compute(getModel(e.m), e.i, e.o);
    waterL += f.waterL; kWh += f.kWh; co2g += f.co2g;
    if (typeof e.s === 'number') { sSum += e.s; sN++; }
    if (typeof e.f === 'number') { fSum += e.f; fN++; }
  }
  return {
    count: entries.length, waterL, kWh, co2g,
    avgScore: sN ? sSum / sN : null,
    rightSized: fN ? (fSum / fN) * 100 : null,
  };
}

export function ecoFitness(summary: DaySummary, budgetL: number): number | null {
  if (summary.avgScore === null) return null;
  const pct = budgetL > 0 ? (summary.waterL / budgetL) * 100 : 0;
  const budgetScore = pct <= 100 ? 100 : clamp(100 - (pct - 100));
  const right = summary.rightSized ?? 100;
  return Math.round(0.5 * summary.avgScore + 0.25 * right + 0.25 * budgetScore);
}

/* ------------------------------------------------------------------ */
/* Prompt analysis (rule-based, on-device)                             */
/* ------------------------------------------------------------------ */

export type LengthPref = 'auto' | 'short' | 'medium' | 'long';
export type Complexity = 'simple' | 'medium' | 'complex';

const FIT: Readonly<Record<Complexity, Record<ModelClass, 0 | 0.5 | 1>>> = Object.freeze({
  simple:  { light: 1, standard: 0.5, heavy: 0 },
  medium:  { light: 1, standard: 1,   heavy: 0.5 },
  complex: { light: 1, standard: 1,   heavy: 1 },
});

const FILLER_PHRASES = [
  "i hope (?:you(?:['’]re| are) (?:doing )?well|this (?:message|email) finds you well)",
  'sorry to (?:bother|trouble) you',
  'i was (?:just )?wondering if(?: you could)?',
  'would it be possible(?: for you)? to',
  'it would be (?:great|nice|awesome|amazing) if you could',
  "if (?:it['’]s|it is) not too much trouble",
  "if you (?:don['’]t|do not) mind",
  'i would (?:really )?(?:like|love) (?:for )?you to',
  'i want you to',
  'help me (?:out )?with something',
  '(?:could|can|would) you (?:please )?(?:possibly )?(?:kindly )?',
  'thank(?:s| you)(?: so much| very much| a lot)?(?: in advance)?',
  'due to the fact that', 'at this point in time', 'in order to',
  'as an ai(?: language model)?', 'if possible', 'hi there',
  'hello', 'hey', 'hi', 'please', 'kindly', 'possibly', 'basically',
  'actually', 'literally', 'really', 'very', 'just', 'simply',
];
const FILLER_SOURCE = '\\b(?:' + FILLER_PHRASES.join('|') + ')\\b';
const TASK_RE = /\b(write|explain|summari[sz]e|list|fix|compare|translate|generate|create|analy[sz]e|refactor|debug|draft|rewrite|review|describe|outline|suggest|recommend|plan|design|convert|calculate|find|give|show|help|build|make)\b/i;
const COMPLEX_RE = /\b(analy[sz]e|architecture|design an?|debug|refactor|prove|proof|optimi[sz]e|step[- ]by[- ]step|trade-?offs?|in[- ]depth|research|strategy|migrat(e|ion))\b/i;
/** A direct question (ends with "?" and has a question word) is as clear a task as an imperative. */
const QUESTION_RE = /\b(what|why|how|who|when|where|which|is|are|does|do|can|should)\b[^\n]*\?\s*$/i;
const ROLE_RE = /\b(you are an?|act as|pretend to be|your role is|always respond|respond only|from now on)\b/i;
const NUM_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const toNum = (s: string | undefined): number => (s ? NUM_WORDS[s] ?? (parseInt(s, 10) || 0) : 0);

export interface OutputEstimate {
  visible: number;
  why: string;
  hasLengthCtl: boolean;
  hasFormatCtl: boolean;
}

export function estimateOutput(text: string, pref: LengthPref, promptTok: number, wc: number): OutputEstimate {
  const t = text.toLowerCase();
  const hasFormatCtl = /\b(bullet(?:ed)?|bullet points?|table|json|yaml|csv|numbered list|markdown|headings?|one[- ]liner|code only|no explanation)\b/.test(t);
  let visible = 350, why = 'typical answer', hasLengthCtl = false;
  let m: RegExpMatchArray | null;

  if (/```|\b(code|function|script|implement|refactor|debug|bug|component|sql|regex|unit tests?)\b/.test(t)) { visible = 600; why = 'code request'; }
  else if (/\b(essay|article|story|blog(?: post)?|report|guide|chapter|newsletter|cover letter)\b/.test(t)) { visible = 800; why = 'long-form writing'; }
  else if (/\b(summari[sz]e|summary|tl;?dr)\b/.test(t)) { visible = 250; why = 'summary'; }
  else if (/\btranslat(e|ion)\b/.test(t)) { visible = Math.max(80, Math.round(promptTok * 1.1)); why = 'translation'; }
  else if (/^\s*(what|who|when|where|which|is|are|does|do|can|should)\b/.test(t) && wc <= 25) { visible = 180; why = 'quick question'; }
  else if (/\b(explain|describe|why|how)\b/.test(t)) { visible = 400; why = 'explanation'; }

  const NUM = '(\\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten)';
  if ((m = t.match(new RegExp('\\b' + NUM + '\\s*words?\\b')))) {
    visible = Math.round(toNum(m[1]) * 1.35) + 10; hasLengthCtl = true; why = 'word limit';
  } else if ((m = t.match(new RegExp('\\b' + NUM + '\\s*(?:short\\s+|key\\s+|main\\s+)?(bullets?|bullet points?|points?|items?|tips?|steps?|examples?|ideas?|reasons?)\\b')))) {
    visible = toNum(m[1]) * 35 + 20; hasLengthCtl = true; why = 'item count';
  } else if ((m = t.match(new RegExp('\\b' + NUM + '\\s*(sentences?|lines?|paragraphs?)\\b')))) {
    visible = toNum(m[1]) * (/paragraph/.test(m[2] ?? '') ? 110 : 25) + 10; hasLengthCtl = true; why = 'sentence limit';
  } else if (/\b(briefly|brief|concise(?:ly)?|short|in short|quick(?:ly)?|tl;?dr)\b/.test(t)) {
    visible = Math.round(visible * 0.5); hasLengthCtl = true; why += ', kept brief';
  }
  if (!hasLengthCtl && /\b(detailed|comprehensive|in[- ]depth|thorough(?:ly)?|step[- ]by[- ]step|exhaustive|complete guide)\b/.test(t)) {
    visible = Math.round(visible * 1.8); why += ', detailed';
  }
  if (pref !== 'auto') {
    visible = { short: 150, medium: 400, long: 1000 }[pref];
    why = 'set manually';
  }
  return { visible: Math.max(20, visible), why, hasLengthCtl, hasFormatCtl };
}

/** Splits after sentence punctuation or at line breaks. (No regex lookbehind: it breaks Safari before iOS 16.4.) */
const splitSentences = (text: string): string[] => text.replace(/([.!?])\s+/g, '$1\n').split(/\n+/);

function repetition(words: readonly string[], sentences: readonly string[]): { ratio: number; dups: number } {
  const w = words.map((x) => x.toLowerCase());
  let rep = 0, total = 0;
  if (w.length >= 6) {
    const seen = new Set<string>();
    for (let i = 0; i <= w.length - 3; i++) {
      const g = `${w[i]} ${w[i + 1]} ${w[i + 2]}`;
      total++;
      if (seen.has(g)) rep++; else seen.add(g);
    }
  }
  const seenS = new Set<string>();
  let dups = 0;
  for (const s of sentences) {
    const n = s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '').replace(/\s+/g, ' ').trim();
    if (n.length <= 8) continue;
    if (seenS.has(n)) dups++; else seenS.add(n);
  }
  return { ratio: total ? rep / total : 0, dups };
}

export interface SubScores { conciseness: number; focus: number; clarity: number; control: number; }

export interface Analysis {
  wc: number;
  promptTok: number;
  historyTok: number;
  hasCode: boolean;
  fillerWords: number;
  fillerShare: number;
  fillerFound: string[];
  rep: { ratio: number; dups: number };
  out: OutputEstimate;
  complexity: Complexity;
  fit: 0 | 0.5 | 1;
  sub: SubScores;
  score: number;
  hasRole: boolean;
  inputTok: number;
  outputTok: number;
  hiddenTok: number;
}

/** Analyze prompt text. The text is used transiently and never stored or returned. */
export function analyze(text: string, model: Model, pref: LengthPref = 'auto', historyTok = 0): Analysis | null {
  const raw = (text ?? '').slice(0, C.MAX_PROMPT_CHARS);
  if (!raw.trim()) return null;
  const hasCode = /```/.test(raw) || (/[{};]\s*$/m.test(raw) && /\b(function|const|let|def|class|import|return)\b/.test(raw));
  const prose = raw.replace(/```[\s\S]*?(?:```|$)/g, ' ');
  const words = prose.match(/[\p{L}\p{N}'’-]+/gu) ?? [];
  const wc = words.length;
  const promptTok = Math.min(C.MAX_TOKENS, estTokens(raw));
  const history = Math.min(C.MAX_TOKENS, Math.max(0, Math.round(historyTok)));

  let fillerWords = 0;
  const found = new Set<string>();
  for (const mm of prose.matchAll(new RegExp(FILLER_SOURCE, 'gi'))) {
    const phrase = mm[0].trim().toLowerCase();
    if (!phrase) continue;
    fillerWords += phrase.split(/\s+/).length;
    found.add(phrase);
  }
  const fillerShare = wc ? fillerWords / wc : 0;
  const rep = repetition(words, splitSentences(prose));
  const out = estimateOutput(prose, pref, promptTok, wc);
  const complexity: Complexity = hasCode || wc > 150 || COMPLEX_RE.test(prose) ? 'complex' : wc <= 40 ? 'simple' : 'medium';
  const fit = FIT[complexity][model.cls];

  const sub: SubScores = {
    conciseness: Math.round(clamp(100 - fillerShare * 400)),
    focus: Math.round(clamp(100 - rep.ratio * 250 - rep.dups * 20)),
    clarity: wc < 3 ? (hasCode ? 50 : 20) : wc < 6 ? 55 : TASK_RE.test(prose) || QUESTION_RE.test(prose) || wc >= 12 ? 100 : 75,
    control: out.hasLengthCtl && out.hasFormatCtl ? 100 : out.hasLengthCtl || out.hasFormatCtl ? 85 : 45,
  };
  const ctxPenalty = history > 8000 ? 10 : history > 3000 ? 5 : 0;
  const fitPenalty = fit === 0 ? 10 : fit === 0.5 ? 4 : 0;
  const base = 0.3 * sub.conciseness + 0.25 * sub.focus + 0.25 * sub.clarity + 0.2 * sub.control;
  let score = Math.round(clamp(base - ctxPenalty - fitPenalty));
  if (wc < 3 && !hasCode) score = Math.min(score, 35); // vague prompts cause costly follow-up rounds

  const hidden = model.reasoning ? out.visible * (C.REASONING_MULT - 1) : 0;
  return {
    wc, promptTok, historyTok: history, hasCode, fillerWords, fillerShare,
    fillerFound: [...found], rep, out, complexity, fit, sub, score,
    hasRole: ROLE_RE.test(prose),
    inputTok: promptTok + history,
    outputTok: out.visible + hidden,
    hiddenTok: hidden,
  };
}

/* ------------------------------------------------------------------ */
/* Tips                                                                */
/* ------------------------------------------------------------------ */

export interface Tip {
  icon: string;
  title: string;
  body: string;
  /** litres saved per prompt, when quantifiable */
  save?: number;
  good?: boolean;
}

export function buildTips(a: Analysis, model: Model, pref: LengthPref = 'auto'): Tip[] {
  const tips: Tip[] = [];
  const base = compute(model, a.inputTok, a.outputTok).waterL;
  const mult = model.reasoning ? C.REASONING_MULT : 1;
  const ml = (l: number) => (l * 1000 < 10 ? (l * 1000).toFixed(1) : Math.round(l * 1000).toString());

  if (a.wc < 4 && !a.hasCode) {
    tips.push({ icon: 'target', title: 'Add the goal and context', body: `Very short prompts often need follow-up rounds, and each extra round-trip costs about ${ml(base)} mL with ${model.name}. One clear message is the efficient choice.` });
  }
  if (!a.out.hasLengthCtl && !a.out.hasFormatCtl && a.out.visible > 200 && pref === 'auto') {
    const target = 150;
    const save = base - compute(model, a.inputTok, target * mult).waterL;
    if (save > 0) tips.push({ icon: 'ruler', title: 'Ask for a length or format', body: `Adding "in 5 bullets" or "under 100 words" can cap the reply near ${target} tokens instead of ~${a.out.visible}. Reply length drives most of the footprint.`, save });
  }
  if (a.fit < 1) {
    const lights = MODELS.filter((m) => m.cls === 'light');
    const alt = lights.find((m) => m.vendor === model.vendor) ?? lights.reduce((x, y) => (x.l10k < y.l10k ? x : y));
    const save = base - compute(alt, a.inputTok, a.out.visible).waterL;
    if (save > 0) tips.push({ icon: 'feather', title: `${alt.name} can likely handle this`, body: `This looks like a ${a.complexity} request. A light model would use about ${Math.round((save / base) * 100)}% less water here. Save the bigger models for harder work.`, save });
  }
  if (a.fillerWords >= 3 || (a.fillerShare > 0.08 && a.fillerWords >= 2)) {
    const savedTok = Math.round(a.fillerWords * 1.3);
    const save = base - compute(model, Math.max(0, a.inputTok - savedTok), a.outputTok).waterL;
    const ex = a.fillerFound.slice(0, 3).map((p) => `"${p}"`).join(', ');
    tips.push({ icon: 'scissors', title: `Trim ${Math.round(a.fillerShare * 100)}% filler`, body: `Phrases like ${ex} don't change the answer. Politeness is fine; stacked filler just adds tokens.`, save });
  }
  if (a.rep.dups > 0 || a.rep.ratio > 0.12) {
    const savedTok = Math.round(a.promptTok * Math.min(0.5, Math.max(a.rep.ratio, a.rep.dups * 0.15)));
    const save = base - compute(model, Math.max(0, a.inputTok - savedTok), a.outputTok).waterL;
    tips.push({ icon: 'repeat', title: 'Say it once', body: a.rep.dups ? `${a.rep.dups} sentence${a.rep.dups > 1 ? 's are' : ' is'} repeated. The model reads everything, so one clear statement is enough.` : 'Several phrases repeat. Merging them keeps the request just as clear.', save });
  }
  if (a.historyTok > 3000) {
    const save = base - compute(model, a.promptTok, a.outputTok).waterL;
    tips.push({ icon: 'message-square-plus', title: 'Start a fresh chat for new topics', body: `This chat re-sends ~${a.historyTok.toLocaleString('en-US')} tokens of history with every message.`, save });
  }
  if (a.hasRole && a.wc > 25) {
    tips.push({ icon: 'settings-2', title: 'Move repeated setup into custom instructions', body: 'Write role and format rules once instead of in every prompt. They still count as input, but API prompt caching processes a repeated prefix more cheaply.' });
  }
  if (!tips.length) {
    tips.push({ icon: 'sparkles', title: 'Lean and clear', good: true, body: 'Clear task, controlled reply, no filler, right-sized model. This is what an efficient prompt looks like.' });
  }
  return tips.sort((x, y) => (y.save ?? 0) - (x.save ?? 0)).slice(0, 3);
}

/* ------------------------------------------------------------------ */
/* Coaching: what each sub-score means for this prompt, and a rewrite  */
/* ------------------------------------------------------------------ */

export interface ScoreNote { ok: boolean; text: string; }

/** One actionable sentence per sub-score, specific to the analyzed prompt. */
export function explainScores(a: Analysis): Record<keyof SubScores, ScoreNote> {
  const quoted = a.fillerFound.slice(0, 3).map((p) => `"${p}"`).join(', ');
  const hasLen = a.out.hasLengthCtl, hasFmt = a.out.hasFormatCtl;
  return {
    conciseness: a.fillerWords === 0
      ? { ok: true, text: 'No filler. Every word does work.' }
      : a.sub.conciseness >= 85
        ? { ok: true, text: `Only ${a.fillerWords} filler word${a.fillerWords === 1 ? '' : 's'} (${quoted}). Fine.` }
        : { ok: false, text: `${a.fillerWords} filler words (${quoted}). Cut them; the answer won't change.` },
    focus: a.rep.dups > 0
      ? { ok: false, text: `${a.rep.dups} sentence${a.rep.dups === 1 ? ' is' : 's are'} repeated. Say each thing once.` }
      : a.sub.focus < 85
        ? { ok: false, text: 'The same request appears in different words. Ask once.' }
        : { ok: true, text: 'Nothing important repeated.' },
    clarity: a.sub.clarity >= 100
      ? { ok: true, text: 'The task is clear.' }
      : a.wc < 6
        ? { ok: false, text: 'Too short to be clear. Say what you want, about what, and for whom, e.g. "Write a Python function that removes duplicates from a list."' }
        : { ok: false, text: 'Start with the task: explain, list, compare, fix, summarize…' },
    control: hasLen && hasFmt
      ? { ok: true, text: 'Length and format are set, so the reply stays tight.' }
      : hasLen
        ? { ok: true, text: 'Length is set. A format (bullets, a table) makes it even tighter.' }
        : hasFmt
          ? { ok: false, text: 'Format is set. Add a length, e.g. "under 100 words", to cap the reply.' }
          : a.out.visible <= 200
            ? { ok: false, text: 'Likely a short answer anyway, but "in one sentence" guarantees it.' }
            : { ok: false, text: 'No length or format, so the model guesses (often long). Add "in 3 bullets" or "under 100 words".' },
  };
}

export interface Rewrite {
  text: string;
  /** Plain-language list of what changed, for teaching. */
  changes: string[];
}

const LEADING_REQUEST_RE = /^\s*(?:(?:could|can|would) you|i was (?:just )?wondering if|would it be possible)/i;
const LENGTH_HINTS: ReadonlyArray<[RegExp, string]> = [
  [/^code request/, 'Reply with just the code and brief comments.'],
  [/detailed$/, 'Keep it under 800 words, with headings.'],
  [/^long-form writing/, 'Keep it under 500 words.'],
  [/^summary/, 'Use 3 bullet points.'],
  [/^explanation/, 'Answer in under 120 words.'],
  [/^quick question/, 'Answer in one or two sentences.'],
];

const wordSet = (s: string): Set<string> => new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []));

/**
 * Suggests a leaner version of the prompt: removes filler, drops repeated or near-duplicate
 * sentences, and adds a reply length when none is set. Code blocks are left untouched.
 * Returns null when there's nothing worth changing (or the prompt is too short to rewrite safely).
 * Runs on the device; the result is shown to the user and never stored.
 */
export function suggestRewrite(text: string, a: Analysis, pref: LengthPref = 'auto'): Rewrite | null {
  const raw = (text ?? '').slice(0, C.MAX_PROMPT_CHARS);
  if (!raw.trim() || (a.wc < 4 && !a.hasCode)) return null;

  const changes: string[] = [];
  const parts = raw.split(/(```[\s\S]*?(?:```|$))/g);
  const filler = new RegExp(FILLER_SOURCE, 'gi');
  let removedFiller = 0, removedSentences = 0;

  const cleanProse = (prose: string): string => {
    const sentences = splitSentences(prose).map((s) => s.trim()).filter(Boolean);
    const kept: string[] = [];
    for (const s of sentences) {
      const wasRequest = LEADING_REQUEST_RE.test(s);
      let t = s.replace(filler, (m) => { removedFiller += m.trim().split(/\s+/).length; return ' '; });
      t = t.replace(/\s+([,.!?;:])/g, '$1').replace(/^[\s,;:.!?-]+/, '').replace(/,\s*(?=[.!?]|$)/g, '').replace(/\s{2,}/g, ' ').trim();
      if ((t.match(/[\p{L}\p{N}]+/gu) ?? []).length < 2) { if (s.trim()) removedSentences++; continue; }
      if (wasRequest) t = t.replace(/\?$/, '.');
      if (!/[.!?:]$/.test(t)) t += '.';
      kept.push(t.charAt(0).toUpperCase() + t.slice(1));
    }
    // Drop exact and near-duplicate sentences (≥70% of the shorter one's words appear in another kept sentence).
    const out: string[] = [];
    let dups = 0;
    kept.forEach((s, i) => {
      const w = wordSet(s);
      const dup = w.size >= 4 && kept.some((o, j) => {
        if (j === i) return false;
        const ow = wordSet(o);
        if (ow.size < w.size || (ow.size === w.size && j > i)) return false;
        let hit = 0;
        w.forEach((x) => { if (ow.has(x)) hit++; });
        return hit / w.size >= 0.7;
      });
      if (dup) dups++; else out.push(s);
    });
    if (dups) changes.push(`Merged ${dups} repeated request${dups === 1 ? '' : 's'} into one.`);
    return out.join(' ');
  };

  let result = parts.map((p, i) => (i % 2 === 1 ? p : cleanProse(p))).filter((p) => p.trim()).join('\n\n').trim();
  if (removedFiller) changes.unshift(`Removed ${removedFiller} filler word${removedFiller === 1 ? '' : 's'} (greetings, "please", "could you"…).`);
  if (removedSentences) changes.push(`Dropped ${removedSentences} sentence${removedSentences === 1 ? '' : 's'} that asked nothing (like "thanks in advance").`);

  if (!a.out.hasLengthCtl && !a.out.hasFormatCtl && pref === 'auto' && a.out.visible > 200) {
    const hint = LENGTH_HINTS.find(([re]) => re.test(a.out.why))?.[1] ?? 'Keep the answer under 150 words.';
    result = `${result}${a.hasCode ? '\n\n' : ' '}${hint}`;
    changes.push(`Asked for a length ("${hint}") so the reply doesn't run long.`);
  }

  if (!changes.length || result === raw.trim()) return null;
  return { text: result, changes };
}

/* ------------------------------------------------------------------ */
/* Provider usage objects (metadata import)                            */
/* ------------------------------------------------------------------ */

export interface ParsedUsage { inT: number; outT: number; modelName: string; }

export function parseUsageJson(text: string): ParsedUsage {
  if (text.length > 50_000) throw new Error('That JSON is too large. Paste a single response or usage object.');
  let obj: unknown;
  try { obj = JSON.parse(text); } catch { throw new Error("This isn't valid JSON. Check for missing quotes or commas."); }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Expected a JSON object with a usage field.');
  const root = obj as Record<string, unknown>;
  const u = (root.usage ?? root.usageMetadata ?? root) as Record<string, unknown>;
  const num = (...vals: unknown[]): number | undefined => vals.find((v): v is number => Number.isInteger(v) && (v as number) >= 0) as number | undefined;
  const inT = num(u.input_tokens, u.prompt_tokens, u.promptTokenCount);
  let outT = num(u.output_tokens, u.completion_tokens, u.candidatesTokenCount);
  if (inT === undefined || outT === undefined) {
    throw new Error('No token counts found. Expected input_tokens/output_tokens, prompt_tokens/completion_tokens or promptTokenCount/candidatesTokenCount.');
  }
  if (Number.isInteger(u.thoughtsTokenCount)) outT += u.thoughtsTokenCount as number;
  if (inT > C.MAX_TOKENS || outT > C.MAX_TOKENS) throw new Error('Token counts look unrealistically large for one request.');
  const modelName = typeof root.model === 'string' ? root.model : typeof root.modelVersion === 'string' ? root.modelVersion : '';
  return { inT, outT, modelName };
}

export function guessModel(name: string): ModelId | null {
  const n = name.toLowerCase();
  if (!n) return null;
  if (n.includes('4o-mini')) return 'gpt4o-mini';
  if (/(^|[^a-z0-9])o1([^a-z0-9]|$)/.test(n)) return 'o1';
  if (n.includes('gpt-4o') || n.includes('gpt4o')) return 'gpt4o';
  if (n.includes('haiku')) return 'haiku';
  if (n.includes('opus')) return 'opus';
  if (n.includes('sonnet')) return 'sonnet';
  if (n.includes('flash')) return 'gemini-flash';
  if (n.includes('gemini')) return 'gemini-pro';
  return null;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const nfCache = new Map<number, Intl.NumberFormat>();
export function fmtN(n: number, d = 0): string {
  let nf = nfCache.get(d);
  if (!nf) { nf = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); nfCache.set(d, nf); }
  return nf.format(Number.isFinite(n) ? n : 0);
}
export const digitsFor = (n: number): number => (n === 0 ? 0 : n >= 100 ? 0 : n >= 10 ? 1 : 2);
export const fmtAuto = (n: number): string => fmtN(n, digitsFor(Math.abs(n)));
export const fmtMl = (ml: number): string => fmtN(ml, ml === 0 ? 0 : ml < 1 ? 2 : ml < 10 ? 1 : 0);
export const fmtWater = (L: number): string => (L < 1 ? `${fmtMl(L * 1000)} mL` : `${fmtN(L, 2)} L`);

/* ------------------------------------------------------------------ */
/* Honest display of modeled numbers                                   */
/* ------------------------------------------------------------------ */

/**
 * Footprints are modeled, not measured, so they're shown as a range around the central estimate:
 * half to double. Published per-prompt figures differ by more than that (Google reports ~0.26 mL
 * on-site water for a median Gemini text prompt; off-site water for electricity multiplies it), so
 * the range is a reminder of uncertainty, not a confidence interval.
 */
export const RANGE = Object.freeze({ LOW: 0.5, HIGH: 2 });

/** Rounds to what the estimate can justify: whole numbers from 1 up (2 significant digits from 10), 1 significant digit below 1. */
export function roundHonest(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (v >= 10) return Number(v.toPrecision(2));
  if (v >= 1) return Math.round(v);
  return Number(v.toPrecision(1));
}

const fmtHonest = (v: number): string => {
  const r = roundHonest(v);
  return r >= 1000 ? fmtN(r) : String(r);
};

/** "~4–18 mL" for a central estimate (unit already applied), or "" when there's nothing to show. */
export function fmtRange(central: number, unit: string): string {
  if (!Number.isFinite(central) || central <= 0) return '';
  const lo = fmtHonest(central * RANGE.LOW), hi = fmtHonest(central * RANGE.HIGH);
  return lo === hi ? `~${hi} ${unit}` : `~${lo}–${hi} ${unit}`;
}

/** Water range with a sensible unit: mL below a litre, L above. */
export const fmtWaterRange = (L: number): string =>
  L * RANGE.HIGH < 1 ? fmtRange(L * 1000, 'mL') : fmtRange(L, 'L');

/** Single approximate value for tight spaces, e.g. "~9 mL". */
export const fmtWaterApprox = (L: number): string => {
  if (!Number.isFinite(L) || L <= 0) return '–';
  return L < 1 ? `~${fmtHonest(L * 1000)} mL` : `~${fmtHonest(L)} L`;
};
