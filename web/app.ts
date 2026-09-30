/**
 * Prompt Fitness dashboard (web + Capacitor iOS/Android).
 * All processing is local. Only numeric LogEntry records are persisted.
 */
import Chart from 'chart.js/auto';
import {
  createIcons, BookOpen, Braces, CalendarCheck, ChartNoAxesCombined, ChevronDown, Copy, Download, Droplet, Feather, Globe,
  CircleCheck, MessageSquare, MessageSquareShare, Plus, Share, TextSelect, WandSparkles,
  KeyRound, Leaf, Lightbulb, List, Lock, MessageSquarePlus, PenLine, PlugZap, Puzzle, Repeat, Ruler, Scissors,
  Send, Settings2, Share2, ShieldCheck, Shuffle, Sparkles, SquareTerminal, Sprout, Target, Trash2, X, Zap,
} from 'lucide';
import {
  C, CLASS_META, MODELS, analyze, buildTips, compute, dayStart, ecoFactors, ecoFitness, fmtAuto, fmtMl, fmtN, fmtWater,
  missingDetail, recommendModel,
  explainScores, fmtRange, fmtWaterApprox, fmtWaterRange, getModel, guessModel, isModelId, parseUsageJson, pruneLog,
  roundHonest, suggestRewrite, summarize,
  type Analysis, type EntrySource, type LengthPref, type LogEntry, type Model, type ModelId,
} from '../shared/core';
import {
  BUDGET_OPTIONS, eraseAllLocalData, flushLog, loadBudget, loadLog, saveBudget, saveLog,
} from './storage';
import {
  currentPlatform, drainExtensionEntries, initShareTarget, onAppPause, onAppResume, onInAppBrowserClosed, onInAppEntry,
  openInAppBrowser, openSafariExtensionSettings, tapFeedback, type InAppSite,
} from './native';

const ICONS = {
  BookOpen, Braces, CalendarCheck, ChartNoAxesCombined, ChevronDown, Copy, Download, Droplet, Feather, Globe, KeyRound, Leaf,
  CircleCheck, MessageSquare, MessageSquareShare, Plus, Share, TextSelect, WandSparkles,
  Lightbulb, List, Lock, MessageSquarePlus, PenLine, PlugZap, Puzzle, Repeat, Ruler, Scissors, Send, Settings2,
  Share2, ShieldCheck, Shuffle, Sparkles, SquareTerminal, Sprout, Target, Trash2, X, Zap,
};
const renderIcons = (): void => { createIcons({ icons: ICONS }); };

/* ---------------- DOM helpers ---------------- */

function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element ${sel}`);
  return el;
}
const $$ = <T extends HTMLElement = HTMLElement>(sel: string): T[] => Array.from(document.querySelectorAll<T>(sel));
const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const scoreColor = (s: number): string => (s >= 70 ? '#4ef0a8' : s >= 40 ? '#ffbe55' : '#ff7a7a');

/* ---------------- State ---------------- */

interface State {
  modelId: ModelId;
  pref: LengthPref;
  mode: 'playground' | 'extension';
  history: number;
  budget: number;
  log: LogEntry[];
  analysis: Analysis | null;
  view: 'week' | 'models';
  sample: number;
  pendingSource: EntrySource | null;
}

const S: State = {
  modelId: 'gpt4o', pref: 'auto', mode: 'playground', history: 0, budget: 1,
  log: [], analysis: null, view: 'week', sample: 0, pendingSource: null,
};

/* ---------------- Animation ---------------- */

const anims = new Map<string, { cur: number; raf: number }>();
function animateValue(key: string, to: number, render: (v: number) => void, dur = 550): void {
  const prev = anims.get(key);
  const from = prev ? prev.cur : 0;
  if (prev?.raf) cancelAnimationFrame(prev.raf);
  const rec = { cur: from, raf: 0 };
  anims.set(key, rec);
  if (reduceMotion || from === to) { rec.cur = to; render(to); return; }
  const t0 = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / dur);
    rec.cur = from + (to - from) * (1 - Math.pow(1 - p, 3));
    render(rec.cur);
    if (p < 1) rec.raf = requestAnimationFrame(step);
  };
  rec.raf = requestAnimationFrame(step);
}

const RING_C = 2 * Math.PI * 52;
function setRing(el: SVGCircleElement, pct: number, color?: string): void {
  el.style.strokeDashoffset = String(RING_C * (1 - Math.min(100, Math.max(0, pct)) / 100));
  if (color) el.setAttribute('stroke', color);
}

let toastTimer = 0;
function toast(msg: string): void {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------------- Live analysis ---------------- */

const SUBS: ReadonlyArray<[keyof Analysis['sub'], string]> = [
  ['conciseness', 'Conciseness'], ['focus', 'Focus'], ['clarity', 'Clarity'], ['specificity', 'Specificity'], ['control', 'Reply control'],
];

function renderSubScores(a: Analysis | null): void {
  const box = $('#subScores');
  box.replaceChildren();
  const notes = a ? explainScores(a) : null;
  for (const [k, label] of SUBS) {
    const v = a ? a.sub[k] : 0;
    const wrap = document.createElement('div');
    wrap.innerHTML = `<div class="flex justify-between"><span class="muted">${label}</span><span class="font-mono text-slate-200">${a ? v : '–'}</span></div>
      <div class="subbar mt-1.5"><span></span></div><p class="mt-1.5 leading-snug"></p>`;
    const bar = wrap.querySelector<HTMLSpanElement>('.subbar > span');
    if (bar) { bar.style.width = `${v}%`; bar.style.background = scoreColor(v); }
    const note = notes?.[k];
    const p = wrap.querySelector('p');
    if (p && note) {
      p.textContent = `${note.ok ? '✓' : '→'} ${note.text}`;
      p.className += note.ok ? ' muted' : ' text-slate-200';
    }
    box.appendChild(wrap);
  }
}

/** The suggested rewrite is kept only in this card (DOM), never stored. */
let rewriteText = '';

function renderRewrite(a: Analysis | null, model: Model): void {
  const card = $('#rewriteCard');
  const original = $<HTMLTextAreaElement>('#prompt').value;
  const r = a ? suggestRewrite(original, a, S.pref) : null;
  const b = r ? analyze(r.text, model, S.pref, S.history) : null;
  const show = Boolean(a && r && b && b.score >= a.score);
  $('#leanNote').hidden = !(a && !show && a.score >= 85);
  if (!show || !a || !r || !b) { card.hidden = true; rewriteText = ''; updateCopyBar(); return; }
  if (rewriteText !== r.text) resetCopyButtons();
  rewriteText = r.text;
  const before = compute(model, a.inputTok, a.outputTok).waterL;
  const after = compute(model, b.inputTok, b.outputTok).waterL;
  const less = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  // Relative change is meaningful even though absolute footprints are uncertain.
  $('#rewriteImpact').textContent = `Score ${a.score} → ${b.score}` + (less > 0 ? ` · ~${less}% less estimated water` : '');
  $('#beforeText').textContent = original.trim();
  $('#rewriteText').textContent = r.text;
  $('#rewriteVague').hidden = b.sub.specificity > 40;
  $('#rewriteChanges').replaceChildren(...r.changes.slice(0, 4).map((c) => { const li = document.createElement('li'); li.textContent = c; return li; }));
  const rows: [string, string, string][] = [
    ['Prompt length (est. tokens)', fmtN(a.promptTok), fmtN(b.promptTok)],
    ['Clarity', `${a.sub.clarity}`, `${b.sub.clarity}`],
    ['Reply control', `${a.sub.control}`, `${b.sub.control}`],
    ['Expected reply (est. tokens)', fmtN(a.out.visible), fmtN(b.out.visible)],
    ['Efficiency score', `${a.score}`, `${b.score}`],
    ['Water (modeled)', fmtWaterRange(before), fmtWaterRange(after)],
  ];
  $('#compareRows').innerHTML = rows.map(([k, x, y]) =>
    `<tr class="border-t border-white/5"><th scope="row" class="py-1.5 pr-2 text-left font-sans font-normal muted">${esc(k)}</th><td class="py-1.5 text-right">${esc(x)}</td><td class="py-1.5 pl-3 text-right text-mint">${esc(y)}</td></tr>`).join('');
  card.hidden = false;
  updateCopyBar();
}

/* ---------------- Copy (primary action) ---------------- */

const COPY_LABEL = 'Copy optimized prompt';
let copyResetTimer = 0;

function setCopyLabel(text: string, done: boolean): void {
  for (const id of ['#copyRewrite', '#copyBarBtn']) {
    const btn = $(id);
    const span = btn.querySelector('span');
    if (span) span.textContent = text;
    btn.classList.toggle('!bg-white', done);
  }
}

function resetCopyButtons(): void {
  window.clearTimeout(copyResetTimer);
  setCopyLabel(COPY_LABEL, false);
}

async function copyOptimized(): Promise<void> {
  if (!rewriteText) return;
  if (await copyText(rewriteText)) {
    setCopyLabel('Copied ✓', true);
    void tapFeedback();
    window.clearTimeout(copyResetTimer);
    copyResetTimer = window.setTimeout(resetCopyButtons, 2200);
  } else {
    showPromptMsg("Couldn't copy automatically. Select the optimized text and copy it instead.");
  }
}

/** Sticky copy bar on phones: shown while a rewrite exists and its own Copy button is off screen. */
let copyInView = true;
function updateCopyBar(): void {
  const show = Boolean(rewriteText) && !copyInView && !window.matchMedia('(min-width: 1024px)').matches;
  $('#copyBar').hidden = !show;
  document.body.classList.toggle('has-copybar', show);
}

/* ---------------- Prompt messages (errors and limits) ---------------- */

function showPromptMsg(text: string): void {
  const el = $('#promptMsg');
  el.textContent = text;
  el.hidden = !text;
}

function renderTips(a: Analysis | null, model: Model): void {
  const ul = $('#tips');
  if (!a) {
    ul.innerHTML = '<li class="text-sm muted">Tips appear as you type. Try a sample to see a wordy prompt get coached.</li>';
    return;
  }
  ul.innerHTML = buildTips(a, model, S.pref).map((t) => {
    const save = t.save && t.save > 0
      ? `<p class="mt-1 text-xs"><span class="text-mint font-mono">saves ~${fmtMl(t.save * 1000)} mL</span><span class="muted"> per prompt, about ${fmtWater(t.save * C.PROMPTS_PER_DAY * 30)} a month at ${C.PROMPTS_PER_DAY} prompts a day</span></p>`
      : '';
    return `<li class="flex gap-3">
      <span class="mt-0.5 h-7 w-7 shrink-0 grid place-items-center rounded-lg ${t.good ? 'bg-mint/15 text-mint' : 'bg-aqua/10 text-aqua'}"><i data-lucide="${esc(t.icon)}" class="w-4 h-4"></i></span>
      <div><p class="text-sm font-medium text-slate-100">${esc(t.title)}</p><p class="text-sm muted leading-relaxed">${esc(t.body)}</p>${save}</div>
    </li>`;
  }).join('');
  renderIcons();
}

function verdict(s: number): string {
  if (s >= 85) return 'Lean and clear. Great prompt.';
  if (s >= 65) return 'Good, with a little room to trim.';
  if (s >= 40) return 'Could be tighter. See the tips below.';
  return 'Needs a rewrite to be efficient.';
}

function renderLive(): void {
  const model = getModel(S.modelId);
  const a = analyze($<HTMLTextAreaElement>('#prompt').value, model, S.pref, S.history);
  S.analysis = a;
  // Score and tips only mean something once there's a prompt; hiding them keeps the empty screen short.
  $('#scoreBlock').hidden = !a;
  $('#tipsBlock').hidden = !a;
  $('#liveModel').textContent = model.name;
  $('#tHistory').textContent = fmtN(S.history);
  $('#fpEmpty').hidden = Boolean(a);
  $('#sampleWrap').hidden = Boolean(a);
  $('#fpBody').hidden = !a;
  const typed = $<HTMLTextAreaElement>('#prompt').value;
  showPromptMsg(typed.length >= C.MAX_PROMPT_CHARS
    ? `This prompt reached the ${fmtN(C.MAX_PROMPT_CHARS)}-character limit, so the end was cut off. Try a shorter part, or split it.`
    : '');

  if (!a) {
    anims.set('effScore', { cur: 0, raf: 0 });
    $('#tPrompt').textContent = '0';
    $('#tOut').textContent = '0';
    $('#effScore').textContent = '–';
    setRing($<SVGCircleElement & HTMLElement>('#effRing'), 0);
    $('#effVerdict').textContent = 'Paste a prompt to see how clear and lean it is.';
    $('#outWhy').textContent = 'Reply size is estimated from what your prompt asks for.';
    $('#badgeWater').textContent = '–';
    $('#badgeScore').textContent = '–';
    renderSubScores(null);
    renderRewrite(null, model);
    renderDetailChips(null);
    renderRecommendation(null, model);
    renderTips(null, model);
    updateModelChart();
    return;
  }

  const f = compute(model, a.inputTok, a.outputTok);
  $('#pWater').textContent = fmtWaterRange(f.waterL);
  $('#pEnergy').textContent = fmtRange(f.kWh * 1000, 'Wh') || '–';
  $('#pCo2').textContent = fmtRange(f.co2g, 'g CO₂e') || '–';
  animateValue('effScore', a.score, (v) => { $('#effScore').textContent = fmtN(v); });

  $('#tPrompt').textContent = fmtN(a.promptTok);
  $('#tOut').textContent = fmtN(a.outputTok);
  $('#outWhy').textContent = `For one request with ${model.name}. Reply estimated at ~${fmtN(a.out.visible)} tokens (${a.out.why})`
    + (a.hiddenTok ? `, plus ~${fmtN(a.hiddenTok)} hidden reasoning tokens (assumed).` : '.')
    + (a.historyTok ? ` Input includes ${fmtN(a.historyTok)} tokens of chat history.` : '');

  setRing($<SVGCircleElement & HTMLElement>('#effRing'), a.score, scoreColor(a.score));
  $('#effVerdict').textContent = verdict(a.score);
  $('#badgeWater').textContent = fmtWaterApprox(f.waterL);
  $('#badgeScore').textContent = `${a.score}%`;
  renderSubScores(a);
  renderRewrite(a, model);
  renderDetailChips(a);
  renderRecommendation(a, model);
  renderTips(a, model);
  updateModelChart();
}

/* ---------------- Today ---------------- */

function renderToday(): void {
  const today = S.log.filter((e) => e.t >= dayStart());
  const sum = summarize(today);
  const pct = (sum.waterL / S.budget) * 100;

  $('#todayCount').textContent = `${sum.count} prompt${sum.count === 1 ? '' : 's'}`;
  const head = $('#headerToday');
  head.hidden = sum.count === 0;
  head.textContent = `Today: ${sum.count} prompt${sum.count === 1 ? '' : 's'} · ${fmtWaterApprox(sum.waterL)} of water (est.) →`;
  // First use: show the four-step guide and an empty state instead of empty dashboards.
  const empty = S.log.length === 0;
  $('#firstRun').hidden = !empty;
  $('#progressEmpty').hidden = !empty;
  $('#progressWrap').hidden = empty;
  $('#methCard').classList.toggle('lg:col-span-12', empty);
  animateValue('budgetUsed', sum.waterL, (v) => { $('#budgetUsed').textContent = fmtN(v, 2); });
  $('#budgetMax').textContent = fmtN(S.budget, 1);
  const fill = $('#budgetFill');
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.style.background = pct > 100 ? '#ff7a7a' : pct >= 80 ? '#ffbe55' : 'linear-gradient(90deg,#4ef0a8,#3dd8f5)';
  $('#budgetBar').setAttribute('aria-valuenow', String(Math.round(Math.min(100, pct))));
  $('#budgetNote').textContent = pct > 100
    ? `${fmtWater(sum.waterL - S.budget)} over today's goal`
    : `${fmtWater(S.budget - sum.waterL)} left, about ${fmtN(Math.floor(((S.budget - sum.waterL) * 1000) / 20))} typical prompts`;
  $$('#budgetSeg [data-budget]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.budget) === S.budget)));

  // Everyday equivalents: whole or one-digit values only, "<0.1" when tiny, "–" when nothing tracked.
  const eq = (v: number): string => (v <= 0 ? '–' : v < 0.1 ? '<0.1' : `~${roundHonest(v)}`);
  $('#eqBottles').textContent = eq(sum.waterL / C.BOTTLE_L);
  $('#eqPhones').textContent = eq(sum.kWh / C.PHONE_KWH);
  $('#eqFlush').textContent = eq(sum.waterL / C.FLUSH_L);

  const factors = ecoFactors(sum, S.budget);
  const fitness = ecoFitness(sum, S.budget);
  const ring = $<SVGCircleElement & HTMLElement>('#fitRing');
  const list = $('#fitFactors');
  if (fitness === null || !factors) {
    $('#fitScore').textContent = '–';
    setRing(ring, 0);
    $('#fitSummary').textContent = sum.count
      ? 'Tracked prompts today have no prompt score yet (for example, imported API usage). Analyze a prompt to see your Eco-Fitness.'
      : 'Analyze and add a prompt today to see your Eco-Fitness.';
    list.replaceChildren();
    return;
  }
  animateValue('fitScore', fitness, (v) => { $('#fitScore').textContent = fmtN(v); });
  setRing(ring, fitness);
  const weakest = factors.reduce((x, y) => (y.value < x.value ? y : x));
  $('#fitSummary').textContent = weakest.value >= 85
    ? 'Strong habits across the board today.'
    : `Biggest room to improve: ${weakest.label.toLowerCase()}.`;
  // Each factor: value, weight and a bar. Status is also in text ("needs work"), not only in color.
  list.innerHTML = factors.map((f) => `<li>
      <div class="flex items-baseline justify-between gap-2">
        <span class="text-slate-200">${esc(f.label)} <span class="text-[11px] muted">· ${Math.round(f.weight * 100)}%</span></span>
        <span class="font-mono text-slate-100">${f.value}${f.value < 60 ? ' <span class="text-[11px] text-amberx font-sans">needs work</span>' : ''}</span>
      </div>
      <div class="subbar mt-1"><span style="width:${f.value}%;background:${scoreColor(f.value)}"></span></div>
      <p class="mt-1 text-[11px] muted leading-snug">${esc(f.note)}</p>
    </li>`).join('');
}

/* ---------------- Recent activity ---------------- */

const SRC_ICON: Record<EntrySource, string> = { playground: 'pen-line', extension: 'puzzle', inapp: 'globe', usage: 'braces', share: 'share-2' };

function renderLog(): void {
  const list = $('#logList');
  const recent = S.log.slice(-7).reverse();
  $('#demoTag').classList.toggle('hidden', !S.log.some((e) => e.demo));
  $('#demoBtn').classList.toggle('hidden', S.log.length > 0);
  if (!recent.length) {
    list.innerHTML = '<li class="py-6 text-sm muted text-center">No activity yet. Log a prompt from the playground, or load the demo week to explore the charts.</li>';
    return;
  }
  const start = dayStart();
  list.innerHTML = recent.map((e) => {
    const m = getModel(e.m);
    const f = compute(m, e.i, e.o);
    const d = new Date(e.t);
    const when = (e.t >= start ? 'Today ' : `${d.toLocaleDateString('en-US', { weekday: 'short' })} `)
      + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    const score = typeof e.s === 'number'
      ? `<span class="chip" data-score="${e.s}">${e.s}%</span>`
      : '<span class="chip bg-white/5 text-slate-400">no score</span>';
    return `<li class="py-3 flex items-center gap-3">
      <span class="h-8 w-8 shrink-0 grid place-items-center rounded-lg bg-white/5 text-slate-300"><i data-lucide="${SRC_ICON[e.src]}" class="w-4 h-4"></i></span>
      <div class="min-w-0 flex-1">
        <p class="text-sm text-slate-100 truncate">${esc(m.name)}${e.demo ? ' <span class="text-[10px] text-amberx/80">demo</span>' : ''}</p>
        <p class="text-xs muted font-mono">${when}, ${fmtN(e.i)} in / ${fmtN(e.o)} out · ${e.src === 'usage' ? 'measured' : 'est.'}</p>
      </div>
      <span class="font-mono text-sm text-aqua whitespace-nowrap" title="Modeled estimate">${fmtWaterApprox(f.waterL)}</span>
      ${score}
    </li>`;
  }).join('');
  list.querySelectorAll<HTMLElement>('[data-score]').forEach((chip) => {
    const c = scoreColor(Number(chip.dataset.score));
    chip.style.color = c;
    chip.style.background = `${c}1a`;
  });
  renderIcons();
}

/* ---------------- Charts ---------------- */

let weekChart: Chart<'bar' | 'line', (number | null)[], string> | null = null;
let modelChart: Chart<'bar', number[], string> | null = null;

function initCharts(): void {
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.font.family = 'ui-sans-serif, -apple-system, system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  const tooltip = { backgroundColor: 'rgba(6,10,16,.95)', borderColor: 'rgba(78,240,168,.3)', borderWidth: 1, padding: 10 };
  const animation = { duration: reduceMotion ? 0 : 650, easing: 'easeOutCubic' as const };

  weekChart = new Chart<'bar' | 'line', (number | null)[], string>($<HTMLCanvasElement>('#weekChart'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { type: 'line', label: 'Avg efficiency', data: [], yAxisID: 'y1', borderColor: '#3dd8f5', backgroundColor: '#3dd8f5', tension: 0.35, pointRadius: 3, spanGaps: true, order: 0 },
        { type: 'line', label: 'Daily budget', data: [], yAxisID: 'y', borderColor: 'rgba(148,163,184,.55)', borderDash: [6, 6], borderWidth: 1.5, pointRadius: 0, order: 1 },
        { type: 'bar', label: 'Est. water (L)', data: [], yAxisID: 'y', backgroundColor: [], borderRadius: 8, maxBarThickness: 44, order: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, padding: 16 } },
        tooltip: {
          ...tooltip,
          callbacks: {
            label: (c) => c.dataset.yAxisID === 'y1'
              ? ` Avg efficiency: ${c.parsed.y == null ? '–' : `${fmtN(c.parsed.y)}%`}`
              : ` ${c.dataset.label ?? ''}: ${fmtN(c.parsed.y ?? 0, 2)} L`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false } },
        y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.08)' }, border: { display: false }, title: { display: true, text: 'Estimated water (L)' } },
        y1: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, title: { display: true, text: 'Efficiency %' } },
      },
    },
  });

  modelChart = new Chart<'bar', number[], string>($<HTMLCanvasElement>('#modelChart'), {
    type: 'bar',
    data: { labels: MODELS.map((m) => m.name), datasets: [{ data: [], backgroundColor: [], borderColor: [], borderWidth: 1, borderRadius: 6, maxBarThickness: 26 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation,
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (c) => ` ~${fmtMl(c.parsed.x ?? 0)} mL per prompt (modeled)` } } },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.08)' }, border: { display: false }, title: { display: true, text: 'Estimated water per prompt (mL)' } },
        y: { grid: { display: false }, border: { display: false }, ticks: { color: (c) => (MODELS[c.index]?.id === S.modelId ? '#4ef0a8' : '#94a3b8') } },
      },
    },
  });
}

function updateWeekChart(): void {
  if (!weekChart) return;
  const labels: string[] = [], water: number[] = [], eff: (number | null)[] = [];
  for (let d = 6; d >= 0; d--) {
    const s = new Date(); s.setHours(0, 0, 0, 0); s.setDate(s.getDate() - d);
    const e0 = s.getTime(), e1 = e0 + 864e5;
    const sum = summarize(S.log.filter((e) => e.t >= e0 && e.t < e1));
    labels.push(d === 0 ? 'Today' : s.toLocaleDateString('en-US', { weekday: 'short' }));
    water.push(sum.waterL);
    eff.push(sum.avgScore);
  }
  const [effDs, budgetDs, waterDs] = weekChart.data.datasets;
  weekChart.data.labels = labels;
  if (effDs) effDs.data = eff;
  if (budgetDs) budgetDs.data = labels.map(() => S.budget);
  if (waterDs) {
    waterDs.data = water;
    waterDs.backgroundColor = water.map((v) => (v > S.budget ? 'rgba(255,190,85,.8)' : 'rgba(78,240,168,.7)'));
  }
  weekChart.update();
}

let modelChartTimer = 0;
function updateModelChart(): void {
  if (!modelChart) return;
  window.clearTimeout(modelChartTimer);
  modelChartTimer = window.setTimeout(() => {
    if (!modelChart) return;
    const a = S.analysis;
    const inTok = a ? a.inputTok : 500;
    const vis = a ? a.out.visible : 400;
    const ds = modelChart.data.datasets[0];
    if (!ds) return;
    ds.data = MODELS.map((m) => compute(m, inTok, vis * (m.reasoning ? C.REASONING_MULT : 1)).waterL * 1000);
    ds.backgroundColor = MODELS.map((m) => (m.id === S.modelId ? 'rgba(78,240,168,.85)' : `rgba(${CLASS_META[m.cls].rgb},.35)`));
    ds.borderColor = MODELS.map((m) => (m.id === S.modelId ? '#4ef0a8' : `rgba(${CLASS_META[m.cls].rgb},.7)`));
    modelChart.update();
    if (S.view === 'models') {
      $('#chartSub').textContent = a
        ? 'Water for your current prompt on each model. Heavier models and hidden reasoning add up fast.'
        : 'Water for a typical prompt (500 tokens in, 400 out) on each model.';
    }
  }, 120);
}

function setView(v: State['view']): void {
  S.view = v;
  $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  $('#weekWrap').classList.toggle('invisible', v !== 'week');
  $('#modelWrap').classList.toggle('invisible', v !== 'models');
  if (v === 'week') {
    $('#chartSub').textContent = 'Water per day against your budget, with average prompt efficiency.';
    weekChart?.resize();
  } else {
    modelChart?.resize();
    updateModelChart();
  }
}

/* ---------------- Actions ---------------- */

function refreshAll(): void { renderToday(); renderLog(); updateWeekChart(); }

/** Scrolls to the Today card and briefly highlights it. */
function showToday(): void {
  const card = $('#todayCard');
  card.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  card.classList.add('ring-2', 'ring-mint/60');
  window.setTimeout(() => card.classList.remove('ring-2', 'ring-mint/60'), 1600);
}

function addEntries(entries: LogEntry[]): void {
  if (!entries.length) return;
  S.log = pruneLog([...S.log, ...entries]);
  saveLog(S.log);
  refreshAll();
}

function logCurrentPrompt(): void {
  const a = S.analysis;
  if (!a) { showPromptMsg('Paste a prompt first. Then you can add it to your stats.'); $('#prompt').focus(); return; }
  const model = getModel(S.modelId);
  const f = compute(model, a.inputTok, a.outputTok);
  const src: EntrySource = S.pendingSource ?? (S.mode === 'extension' ? 'extension' : 'playground');
  addEntries([{ t: Date.now(), m: model.id, i: a.inputTok, o: a.outputTok, s: a.score, f: a.fit, src }]);
  S.pendingSource = null;
  S.history = Math.min(C.MAX_TOKENS, S.history + a.promptTok + a.out.visible);
  $<HTMLTextAreaElement>('#prompt').value = '';
  renderLive();
  void tapFeedback();
  const todayL = summarize(S.log.filter((e) => e.t >= dayStart())).waterL;
  toast(`Added to your stats (${fmtWaterApprox(f.waterL)} estimated). Today: ${fmtWaterApprox(todayL)}.`);
}

/** One sample per category, each showing a different lesson (filler, vagueness, unbounded length…). */
const SAMPLES: ReadonlyArray<[string, string]> = [
  ['Writing', "Hi! Could you please write me an email to my manager asking if I can take Friday off? I'd really appreciate it, thank you so much!"],
  ['Coding', 'Can you write a function that checks if a string is a palindrome? Please explain how it works in detail too.'],
  ['Research', 'Tell me everything about climate change: the causes, the effects, the history and the solutions, in a detailed and comprehensive way.'],
  ['Planning', 'Can you help me plan a trip to Japan?'],
  ['Learning', "Hi there! I hope you're doing well. I was wondering if you could please possibly help me out with something. Could you please explain to me what a REST API is? Could you please explain what a REST API is and how it works? Thank you so much in advance!"],
  ['Fitness', 'Can you help me make a workout plan?'],
  ['Business', 'Write a detailed business plan for my coffee shop idea.'],
];

function renderSamples(): void {
  $('#samples').innerHTML = SAMPLES.map(([cat], i) =>
    `<button type="button" class="seg !min-h-[40px] border border-white/10 bg-white/[.03]" data-sample="${i}">${esc(cat)}</button>`).join('');
}

/* ---------------- Specificity chips and model advice ---------------- */

function renderDetailChips(a: Analysis | null): void {
  const chips = a && (a.sub.specificity < 80 || a.sub.control < 85) ? missingDetail(a) : [];
  $('#detailWrap').hidden = chips.length === 0;
  $('#detailChips').innerHTML = chips.map((c) =>
    `<button type="button" class="seg !min-h-[40px] border border-mint/25 bg-mint/[.06] text-slate-100" data-insert="${esc(c.insert)}">+ ${esc(c.label)}</button>`).join('');
}

/** Appends a detail line and selects its [placeholder] so the user types straight over it. */
function insertDetail(line: string): void {
  const ta = $<HTMLTextAreaElement>('#prompt');
  const base = ta.value.replace(/\s+$/, '');
  ta.value = `${base}${base ? '\n' : ''}${line}`;
  const open = ta.value.lastIndexOf('[');
  const close = ta.value.lastIndexOf(']');
  ta.focus();
  if (open >= 0 && close > open) ta.setSelectionRange(open, close + 1);
  renderLive();
}

let recAltId: ModelId | null = null;

function renderRecommendation(a: Analysis | null, model: Model): void {
  const card = $('#recCard');
  if (!a) { card.hidden = true; return; }
  const adv = recommendModel(a, model);
  $('#recTier').textContent = adv.label;
  $('#recExamples').textContent = `e.g. ${adv.examples.map((m) => m.name).join(', ')}`;
  $('#recWhy').textContent = adv.why;
  const impact = $('#recImpact');
  const btn = $('#recSwitch');
  if (adv.fits) {
    impact.className = 'text-sm text-mint';
    impact.textContent = `✓ ${model.name} fits this task.`;
    btn.hidden = true;
    recAltId = null;
  } else {
    impact.className = 'text-sm text-slate-200';
    impact.textContent = adv.savePct ? `vs. ${model.name}: ~${adv.savePct}% less estimated water` : `${model.name} is bigger than this task needs.`;
    recAltId = adv.alt?.id ?? null;
    btn.textContent = adv.alt ? `Use ${adv.alt.name}` : '';
    btn.hidden = !adv.alt;
  }
  card.hidden = false;
}

function setMode(mode: State['mode']): void {
  S.mode = mode;
  const ext = mode === 'extension';
  $$('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const chrome = $('#extChrome');
  chrome.classList.toggle('hidden', !ext);
  chrome.classList.toggle('flex', ext);
  const badge = $('#extBadge');
  badge.classList.toggle('hidden', !ext);
  badge.classList.toggle('flex', ext);
  $('#taWrap').classList.toggle('mt-4', !ext);
  const ta = $<HTMLTextAreaElement>('#prompt');
  ta.classList.toggle('rounded-t-none', ext);
  ta.placeholder = ext
    ? 'Message your AI assistant (Enter logs, Shift+Enter for a new line)'
    : 'Type or paste a prompt to see its footprint and efficiency live…';
  $('#kbdHint').textContent = ext ? 'Enter to log' : 'Ctrl/⌘ + Enter to log';
}

function seedDemo(): LogEntry[] {
  let a = 7;
  const rnd = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick: ModelId[] = ['gpt4o', 'gpt4o', 'sonnet', 'sonnet', 'gemini-pro', 'gpt4o-mini', 'gemini-flash', 'haiku', 'o1', 'opus'];
  const out: LogEntry[] = [];
  const now = Date.now();
  for (let d = 6; d >= 0; d--) {
    const n = d === 0 ? 6 : 7 + Math.floor(rnd() * 10);
    const day = new Date(); day.setHours(9, 0, 0, 0); day.setDate(day.getDate() - d);
    for (let k = 0; k < n; k++) {
      const m = getModel(pick[Math.floor(rnd() * pick.length)]);
      const vis = Math.round(150 + rnd() * 650);
      const f: 0 | 0.5 | 1 = m.cls === 'heavy' ? (rnd() < 0.5 ? 0 : 0.5) : m.cls === 'light' ? 1 : (rnd() < 0.5 ? 0.5 : 1);
      out.push({
        t: d === 0 ? now - (n - k) * 22 * 60_000 : day.getTime() + k * 35 * 60_000,
        m: m.id, i: Math.round(400 + rnd() * 9000), o: vis * (m.reasoning ? C.REASONING_MULT : 1),
        s: Math.round(48 + rnd() * 48), f, src: 'playground', demo: 1,
      });
    }
  }
  return out;
}

function importUsage(): void {
  const msg = $('#usageMsg');
  try {
    const { inT, outT, modelName } = parseUsageJson($<HTMLTextAreaElement>('#usageJson').value.trim());
    const choice = $<HTMLSelectElement>('#usageModel').value;
    const id = choice !== 'auto' && isModelId(choice) ? choice : guessModel(modelName);
    if (!id) throw new Error("Couldn't detect the model from this JSON. Pick one from the list.");
    const m = getModel(id);
    addEntries([{ t: Date.now(), m: id, i: inT, o: outT, s: null, f: null, src: 'usage' }]);
    const f = compute(m, inT, outT);
    msg.className = 'mt-2 text-xs text-mint';
    msg.textContent = `Imported ${fmtN(inT)} input and ${fmtN(outT)} output tokens for ${m.name}: about ${fmtMl(f.waterL * 1000)} mL.`;
    $<HTMLTextAreaElement>('#usageJson').value = '';
  } catch (err) {
    msg.className = 'mt-2 text-xs text-coral';
    msg.textContent = err instanceof Error ? err.message : 'Import failed.';
  }
}

/* ---------------- Wiring ---------------- */

function buildSelects(): void {
  const fill = (sel: HTMLSelectElement, withAuto: boolean) => {
    if (withAuto) sel.appendChild(new Option('Auto-detect model', 'auto'));
    for (const [cls, meta] of Object.entries(CLASS_META)) {
      const og = document.createElement('optgroup');
      og.label = meta.label;
      MODELS.filter((m) => m.cls === cls).forEach((m) => og.appendChild(new Option(`${m.name} (${m.vendor})`, m.id)));
      sel.appendChild(og);
    }
  };
  fill($<HTMLSelectElement>('#model'), false);
  fill($<HTMLSelectElement>('#usageModel'), true);
  $<HTMLSelectElement>('#model').value = S.modelId;
}

function configurePlatformCopy(): void {
  const platform = currentPlatform(); // 'web' | 'ios' | 'android'
  $$('[data-platform]').forEach((el) => {
    const list = (el.dataset.platform ?? '').split(/\s+/);
    el.hidden = !list.includes(platform);
  });
  const steps = platform === 'ios'
    ? [
        'Tap Open Safari extension settings below (or follow the path in Settings) and turn on Prompt Fitness.',
        'Allow it on chatgpt.com, claude.ai and gemini.google.com only.',
        'Chat as usual in Safari. Replies are measured on your device as they finish.',
        'Counts appear here the next time you open the app. Only numbers are shared, through a private on-device App Group.',
      ]
    : [
        'The Prompt Fitness browser extension for Chrome, Firefox and Safari is coming soon. Until then, paste prompts into the editor.',
        'Allow access on chatgpt.com, claude.ai and gemini.google.com. It asks for no other sites.',
        'Replies are measured on your device as they finish streaming.',
        'Only the numbers are saved in your browser: time, model, token counts and score.',
      ];
  const ol = $('#extSteps');
  ol.replaceChildren(...steps.map((s) => { const li = document.createElement('li'); li.textContent = s; return li; }));
  if (platform === 'ios') {
    $('#tabA').textContent = 'Your chats';
    $('#extHeading').textContent = 'Or track in Safari with the extension';
  }
  if (platform === 'android') {
    $('#tabA').textContent = 'Share to improve';
    $('#connectLabel').textContent = 'Use with your AI apps';
  }
  renderWhereSteps(platform);
}

/** "Use it where you chat": the way to reach this platform's AI apps, as three visual steps. */
const WHERE_STEPS: Record<string, { heading: string; steps: [string, string][] }> = {
  ios: {
    heading: 'Use it in ChatGPT & Claude',
    steps: [
      ['text-select', 'Select your prompt in ChatGPT, Claude or any app.'],
      ['share', 'Tap Share, then Prompt Fitness.'],
      ['copy', 'Copy the improved prompt and paste it back.'],
    ],
  },
  android: {
    heading: 'Use it in your AI apps',
    steps: [
      ['text-select', 'Select your prompt in ChatGPT, Claude or any app.'],
      ['share', 'Tap Share, then Prompt Fitness.'],
      ['wand-sparkles', 'It opens here with a tighter version to copy back.'],
    ],
  },
  web: {
    heading: 'Use it with any AI chat',
    steps: [
      ['pen-line', 'Write your prompt as you normally would.'],
      ['text-select', 'Paste it into Prompt Fitness.'],
      ['wand-sparkles', 'Review the optimized version.'],
      ['copy', 'Tap Copy optimized prompt.'],
      ['send', 'Paste it into ChatGPT, Claude or Gemini and send.'],
    ],
  },
};

function renderWhereSteps(platform: string): void {
  const cfg = WHERE_STEPS[platform] ?? WHERE_STEPS.web!;
  $('#whereHeading').textContent = cfg.heading;
  $('#whereSteps').innerHTML = cfg.steps.map(([icon, text], i) => `<li class="flex items-start gap-3">
      <span class="mt-0.5 h-8 w-8 shrink-0 grid place-items-center rounded-xl bg-mint/10 text-mint"><i data-lucide="${esc(icon)}" class="w-4 h-4"></i></span>
      <p class="text-sm text-slate-200"><span class="font-mono text-mint mr-1">${i + 1}.</span>${esc(text)}</p>
    </li>`).join('');
}

/** Clipboard with a fallback for web views that don't expose navigator.clipboard. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function wire(): void {
  let t = 0;
  const ta = $<HTMLTextAreaElement>('#prompt');
  ta.addEventListener('input', () => { window.clearTimeout(t); t = window.setTimeout(renderLive, 90); });
  ta.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.metaKey || e.ctrlKey || (S.mode === 'extension' && !e.shiftKey)) {
      e.preventDefault(); window.clearTimeout(t); renderLive(); logCurrentPrompt();
    }
  });
  $<HTMLSelectElement>('#model').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (isModelId(v)) { S.modelId = v; renderLive(); }
  });
  $<HTMLSelectElement>('#lengthPref').addEventListener('change', (e) => {
    const v = (e.target as HTMLSelectElement).value as LengthPref;
    S.pref = (['auto', 'short', 'medium', 'long'] as const).includes(v) ? v : 'auto';
    renderLive();
  });
  $('#sendBtn').addEventListener('click', () => { window.clearTimeout(t); renderLive(); logCurrentPrompt(); });
  $('#newChatBtn').addEventListener('click', () => { S.history = 0; renderLive(); toast('New chat started. History no longer counts toward input.'); });
  $('#useRewrite').addEventListener('click', () => {
    if (!rewriteText) return;
    ta.value = rewriteText;
    renderLive();
    ta.focus();
    toast('Rewrite applied. Edit it if anything is missing.');
  });
  $('#copyRewrite').addEventListener('click', () => { void copyOptimized(); });
  $('#copyBarBtn').addEventListener('click', () => { void copyOptimized(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      copyInView = entries.some((e) => e.isIntersecting);
      updateCopyBar();
    }).observe($('#copyRewrite'));
  }
  window.matchMedia('(min-width: 1024px)').addEventListener('change', updateCopyBar);
  $('#peStart').addEventListener('click', () => {
    $('#playground').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    ta.focus();
  });
  $('#peDemo').addEventListener('click', () => { addEntries(seedDemo()); toast('Demo week loaded. It is labeled "demo" and can be cleared.'); });
  $$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
    document.getElementById(b.dataset.goto ?? '')?.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }));
  $('#headerToday').addEventListener('click', () => showToday());
  $('#samples').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-sample]');
    const sample = btn ? SAMPLES[Number(btn.dataset.sample)] : undefined;
    if (!sample) return;
    ta.value = sample[1];
    renderLive();
    $('#rewriteCard').hidden ? ta.focus() : $('#playground').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  });
  $('#detailChips').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-insert]');
    if (btn?.dataset.insert) insertDetail(btn.dataset.insert);
  });
  $('#recSwitch').addEventListener('click', () => {
    if (!recAltId) return;
    S.modelId = recAltId;
    $<HTMLSelectElement>('#model').value = recAltId;
    renderLive();
    toast(`Switched to ${getModel(recAltId).name}. Pick it in your AI app too.`);
  });
  $$('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode === 'extension' ? 'extension' : 'playground')));
  $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view === 'models' ? 'models' : 'week')));
  $$('#budgetSeg [data-budget]').forEach((b) => b.addEventListener('click', () => {
    const v = Number(b.dataset.budget);
    if (!(BUDGET_OPTIONS as readonly number[]).includes(v)) return;
    S.budget = v;
    void saveBudget(v);
    renderToday();
    updateWeekChart();
  }));

  // Two-step delete: no window.confirm (blocked in some web views, and not HIG-styled).
  const clearBtn = $('#clearBtn');
  const clearLabel = clearBtn.innerHTML;
  let armed = 0;
  const disarm = () => { armed = 0; clearBtn.innerHTML = clearLabel; clearBtn.classList.remove('text-coral'); renderIcons(); };
  clearBtn.addEventListener('click', async () => {
    if (!armed) {
      clearBtn.textContent = 'Tap again to delete';
      clearBtn.classList.add('text-coral');
      armed = window.setTimeout(disarm, 3000);
      return;
    }
    window.clearTimeout(armed);
    disarm();
    S.log = [];
    await eraseAllLocalData();
    S.budget = await loadBudget();
    refreshAll();
    toast('All local data deleted from this device.');
  });
  $('#demoBtn').addEventListener('click', () => { addEntries(seedDemo()); toast('Demo week loaded. It is labeled "demo" and can be cleared.'); });

  const dlg = $<HTMLDialogElement>('#connect');
  const selectTab = (which: 'A' | 'B') => {
    $('#tabA').setAttribute('aria-selected', String(which === 'A'));
    $('#tabB').setAttribute('aria-selected', String(which === 'B'));
    $('#panelA').classList.toggle('hidden', which !== 'A');
    $('#panelB').classList.toggle('hidden', which !== 'B');
  };
  const open = (tab: 'A' | 'B') => { selectTab(tab); dlg.showModal(); };
  $('#openConnect').addEventListener('click', () => open('A'));
  $('#whereMore').addEventListener('click', () => open('A'));
  $('#closeConnect').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $('#tabA').addEventListener('click', () => selectTab('A'));
  $('#tabB').addEventListener('click', () => selectTab('B'));
  $('#usageExample').addEventListener('click', () => {
    $<HTMLTextAreaElement>('#usageJson').value = JSON.stringify({ model: 'claude-3-5-sonnet-20241022', usage: { input_tokens: 1840, output_tokens: 512 } }, null, 2);
  });
  $('#usageImport').addEventListener('click', importUsage);

  $$('[data-inapp-site]').forEach((b) => b.addEventListener('click', async () => {
    const site = b.dataset.inappSite as InAppSite;
    void tapFeedback();
    // Shown inside the dialog: a toast would sit behind the modal's top layer.
    const err = $('#inappError');
    err.hidden = true;
    if (await openInAppBrowser(site)) { dlg.close(); return; }
    err.textContent = "Couldn't open the in-app browser. It needs the latest iOS build (npm run ios:setup).";
    err.hidden = false;
  }));
  $('#openSafariSettings').addEventListener('click', async () => {
    const hint = $('#safariSettingsHint');
    const target = await openSafariExtensionSettings();
    hint.hidden = target === 'safari';
    hint.textContent = target === 'app'
      ? 'Settings opened on Prompt Fitness. Go back to Apps, then Safari, then Extensions, and turn on Prompt Fitness.'
      : 'Open the Settings app, then follow the path above.';
  });
}

async function syncExtensionEntries(): Promise<void> {
  const incoming = await drainExtensionEntries();
  if (!incoming.length) return;
  addEntries(incoming);
  const n = incoming.length;
  const where = incoming.every((e) => e.src === 'inapp') ? 'in the in-app browser'
    : incoming.every((e) => e.src === 'extension') ? 'in Safari' : 'in Safari and the in-app browser';
  toast(`Added ${n} prompt${n === 1 ? '' : 's'} tracked ${where}.`);
}

async function init(): Promise<void> {
  buildSelects();
  renderSamples();
  configurePlatformCopy();
  wire();
  initCharts();
  renderIcons();

  const [log, budget] = await Promise.all([loadLog(), loadBudget()]);
  S.log = log ?? [];
  S.budget = budget;

  renderLive();
  refreshAll();

  await syncExtensionEntries();
  onAppResume(() => { void syncExtensionEntries(); refreshAll(); });
  // In-app browser: entries arrive one by one while it's open, and are saved right away.
  onInAppEntry((e) => addEntries([e]));
  onInAppBrowserClosed((counted) => {
    void syncExtensionEntries();
    if (counted > 0) {
      toast(`Added ${counted} prompt${counted === 1 ? '' : 's'} from the in-app browser.`);
      showToday();
    }
  });
  onAppPause(() => { void flushLog(); });

  await initShareTarget((text) => {
    const ta = $<HTMLTextAreaElement>('#prompt');
    ta.value = text;
    S.pendingSource = 'share';
    setMode('playground');
    renderLive();
    $('#playground').scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
    toast('Shared prompt loaded. Tap Log prompt to keep its numbers.');
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { void init(); });
else void init();
