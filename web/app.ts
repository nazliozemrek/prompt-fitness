/**
 * Prompt Fitness dashboard (web + Capacitor iOS/Android).
 * All processing is local. Only numeric LogEntry records are persisted.
 */
import Chart from 'chart.js/auto';
import {
  createIcons, BookOpen, Braces, CalendarCheck, ChartNoAxesCombined, ChevronDown, Copy, Download, Droplet, Feather, Globe,
  MessageSquare, MessageSquareShare, Plus, Share, TextSelect, WandSparkles,
  KeyRound, Leaf, Lightbulb, List, Lock, MessageSquarePlus, PenLine, PlugZap, Puzzle, Repeat, Ruler, Scissors,
  Send, Settings2, Share2, ShieldCheck, Shuffle, Sparkles, SquareTerminal, Sprout, Target, Trash2, X, Zap,
} from 'lucide';
import {
  C, CLASS_META, MODELS, analyze, buildTips, compute, dayStart, ecoFitness, fmtAuto, fmtMl, fmtN, fmtWater,
  explainScores, getModel, guessModel, isModelId, parseUsageJson, pruneLog, suggestRewrite, summarize,
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
  MessageSquare, MessageSquareShare, Plus, Share, TextSelect, WandSparkles,
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
  ['conciseness', 'Conciseness'], ['focus', 'Focus'], ['clarity', 'Clarity'], ['control', 'Reply control'],
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
  const r = a ? suggestRewrite($<HTMLTextAreaElement>('#prompt').value, a, S.pref) : null;
  const b = r ? analyze(r.text, model, S.pref, S.history) : null;
  if (!a || !r || !b || b.score < a.score) { card.hidden = true; rewriteText = ''; return; }
  rewriteText = r.text;
  const before = compute(model, a.inputTok, a.outputTok).waterL * 1000;
  const after = compute(model, b.inputTok, b.outputTok).waterL * 1000;
  const less = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  $('#rewriteImpact').textContent = `Score ${a.score} → ${b.score} · ${fmtMl(before)} mL → ${fmtMl(after)} mL per prompt`
    + (less > 0 ? ` (${less}% less water)` : '');
  $('#rewriteText').textContent = r.text;
  $('#rewriteChanges').replaceChildren(...r.changes.map((c) => { const li = document.createElement('li'); li.textContent = c; return li; }));
  card.hidden = false;
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

  if (!a) {
    for (const k of ['pWater', 'pEnergy', 'pCo2']) animateValue(k, 0, (v) => { $(`#${k}`).textContent = fmtAuto(v); });
    anims.set('effScore', { cur: 0, raf: 0 });
    $('#pBottleText').textContent = '0% of a 500 ml bottle';
    $('#tPrompt').textContent = '0';
    $('#tOut').textContent = '0';
    $('#effScore').textContent = '–';
    setRing($<SVGCircleElement & HTMLElement>('#effRing'), 0);
    $('#effVerdict').textContent = 'Paste a prompt to see how clear and lean it is.';
    $('#outWhy').textContent = 'Reply size is estimated from what your prompt asks for.';
    $('#badgeWater').textContent = '0 mL';
    $('#badgeScore').textContent = '–';
    renderSubScores(null);
    renderRewrite(null, model);
    renderTips(null, model);
    updateModelChart();
    return;
  }

  const f = compute(model, a.inputTok, a.outputTok);
  const ml = f.waterL * 1000;
  animateValue('pWater', ml, (v) => { $('#pWater').textContent = fmtMl(v); });
  animateValue('pEnergy', f.kWh * 1000, (v) => { $('#pEnergy').textContent = fmtAuto(v); });
  animateValue('pCo2', f.co2g, (v) => { $('#pCo2').textContent = fmtAuto(v); });
  animateValue('effScore', a.score, (v) => { $('#effScore').textContent = fmtN(v); });

  const bottles = f.waterL / C.BOTTLE_L;
  $('#pBottleText').textContent = bottles < 1
    ? `${fmtN(bottles * 100, bottles < 0.1 ? 1 : 0)}% of a 500 ml bottle`
    : `${fmtAuto(bottles)} bottles of 500 ml`;
  $('#tPrompt').textContent = fmtN(a.promptTok);
  $('#tOut').textContent = fmtN(a.outputTok);
  $('#outWhy').textContent = `Reply estimate: ~${fmtN(a.out.visible)} tokens (${a.out.why})`
    + (a.hiddenTok ? `, plus ~${fmtN(a.hiddenTok)} hidden reasoning tokens (assumed).` : '.')
    + (a.historyTok ? ` Input includes ${fmtN(a.historyTok)} tokens of chat history.` : '');

  setRing($<SVGCircleElement & HTMLElement>('#effRing'), a.score, scoreColor(a.score));
  $('#effVerdict').textContent = verdict(a.score);
  $('#badgeWater').textContent = `${fmtMl(ml)} mL`;
  $('#badgeScore').textContent = `${a.score}%`;
  renderSubScores(a);
  renderRewrite(a, model);
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
  head.textContent = `Today: ${sum.count} prompt${sum.count === 1 ? '' : 's'} · ${fmtWater(sum.waterL)} of water →`;
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

  animateValue('eqBottles', sum.waterL / C.BOTTLE_L, (v) => { $('#eqBottles').textContent = fmtAuto(v); });
  animateValue('eqPhones', sum.kWh / C.PHONE_KWH, (v) => { $('#eqPhones').textContent = fmtAuto(v); });
  animateValue('eqFlush', sum.waterL / C.FLUSH_L, (v) => { $('#eqFlush').textContent = fmtAuto(v); });

  const fitness = ecoFitness(sum, S.budget);
  const ring = $<SVGCircleElement & HTMLElement>('#fitRing');
  if (fitness === null) {
    $('#fitScore').textContent = '–';
    setRing(ring, 0);
    $('#fitEff').textContent = '–';
    $('#fitRight').textContent = '–';
    $('#fitBudget').textContent = sum.count ? (pct > 100 ? 'over' : 'on track') : '–';
  } else {
    animateValue('fitScore', fitness, (v) => { $('#fitScore').textContent = fmtN(v); });
    setRing(ring, fitness);
    $('#fitEff').textContent = `${fmtN(sum.avgScore ?? 0)}%`;
    $('#fitRight').textContent = sum.rightSized === null ? '–' : `${fmtN(sum.rightSized)}%`;
    $('#fitBudget').textContent = pct > 100 ? 'over' : 'on track';
  }
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
        <p class="text-xs muted font-mono">${when}, ${fmtN(e.i)} in / ${fmtN(e.o)} out</p>
      </div>
      <span class="font-mono text-sm text-aqua whitespace-nowrap">${fmtMl(f.waterL * 1000)} mL</span>
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
        { type: 'bar', label: 'Water (L)', data: [], yAxisID: 'y', backgroundColor: [], borderRadius: 8, maxBarThickness: 44, order: 2 },
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
        y: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.08)' }, border: { display: false }, title: { display: true, text: 'Water (L)' } },
        y1: { position: 'right', min: 0, max: 100, grid: { display: false }, border: { display: false }, title: { display: true, text: 'Efficiency %' } },
      },
    },
  });

  modelChart = new Chart<'bar', number[], string>($<HTMLCanvasElement>('#modelChart'), {
    type: 'bar',
    data: { labels: MODELS.map((m) => m.name), datasets: [{ data: [], backgroundColor: [], borderColor: [], borderWidth: 1, borderRadius: 6, maxBarThickness: 26 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation,
      plugins: { legend: { display: false }, tooltip: { ...tooltip, callbacks: { label: (c) => ` ${fmtMl(c.parsed.x ?? 0)} mL per prompt` } } },
      scales: {
        x: { beginAtZero: true, grid: { color: 'rgba(148,163,184,.08)' }, border: { display: false }, title: { display: true, text: 'Water per prompt (mL)' } },
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
  if (!a) { toast('Paste a prompt first.'); $('#prompt').focus(); return; }
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
  toast(`Added to your stats: ${fmtMl(f.waterL * 1000)} mL. Today: ${fmtN(todayL, 2)} of ${fmtN(S.budget, 1)} L.`);
}

const SAMPLES = [
  "Hi there! I hope you're doing well. I was wondering if you could please possibly help me out with something. Could you please explain to me what a REST API is? Could you please explain what a REST API is and how it works? Thank you so much in advance!",
  'Explain REST APIs to a junior developer in 5 bullet points, with one real-world example.',
  'code?',
  'Write a detailed, comprehensive guide on migrating a React app from JavaScript to TypeScript, step by step.',
  'Summarize the attached meeting notes in 3 bullets: decisions, owners, deadlines.',
];

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
        'Install the Prompt Fitness extension for Chrome or Safari.',
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
    heading: 'Use it where you chat',
    steps: [
      ['puzzle', 'Add the Prompt Fitness extension to Chrome, Firefox or Safari.'],
      ['message-square', 'Chat as usual on ChatGPT, Claude or Gemini.'],
      ['sparkles', 'Paste any prompt here to get a tighter version.'],
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
  $('#copyRewrite').addEventListener('click', async () => {
    if (!rewriteText) return;
    toast(await copyText(rewriteText) ? 'Copied. Paste it into your chat.' : "Couldn't copy. Select the text and copy it instead.");
  });
  $('#headerToday').addEventListener('click', () => showToday());
  $('#sampleBtn').addEventListener('click', () => { ta.value = SAMPLES[S.sample % SAMPLES.length] ?? ''; S.sample++; renderLive(); });
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
