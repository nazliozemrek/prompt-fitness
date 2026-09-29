import { CLASS_META, MODELS, fmtMl, fmtN, getModel, isModelId, compute } from '../../shared/core';
import {
  DEFAULT_SITE_MODEL, api, hostFromUrl, isSafari, modelForHost,
  type AllowedHost, type Message, type Response, type Settings, type SummaryResponse,
} from './api';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
};

async function send(msg: Message): Promise<Response> {
  return (await api.runtime.sendMessage(msg)) as Response;
}

let settings: Settings | null = null;
let siteHost: AllowedHost | null = null;

async function activeHost(): Promise<AllowedHost | null> {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return hostFromUrl(tab?.url);
  } catch {
    return null;
  }
}

function render(s: SummaryResponse): void {
  settings = s.settings;
  const ml = s.waterL * 1000;
  $('water').textContent = ml < 1000 ? fmtMl(ml) : fmtN(s.waterL, 2);
  $('waterUnit').textContent = ml < 1000 ? 'mL' : 'L';
  const pct = s.settings.budget > 0 ? (s.waterL / s.settings.budget) * 100 : 0;
  const fill = $('barFill');
  fill.style.width = `${Math.min(100, pct)}%`;
  fill.style.background = pct > 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--accent)';
  $('bar').setAttribute('aria-valuenow', String(Math.round(Math.min(100, pct))));
  $('budgetText').textContent = `of ${fmtN(s.settings.budget, 1)} L daily budget`;
  $('count').textContent = fmtN(s.count);
  $('avg').textContent = s.avgScore === null ? '–' : `${fmtN(s.avgScore)}%`;
  $('fitness').textContent = s.fitness === null ? '–' : fmtN(s.fitness);
  $<HTMLInputElement>('pillToggle').checked = s.settings.showPill;
  $<HTMLSelectElement>('budget').value = String(s.settings.budget);

  if (s.last) {
    const m = getModel(s.last.m);
    const lml = compute(m, s.last.i, s.last.o).waterL * 1000;
    $('lastText').textContent = `${m.name}: ${fmtMl(lml)} mL` + (s.last.s !== null ? `, prompt score ${s.last.s}` : '');
    $('lastCard').hidden = false;
  }

  if (siteHost) {
    $('siteLabel').textContent = 'This site';
    $('siteHost').textContent = siteHost;
    $('siteControls').hidden = false;
    $('siteHint').hidden = true;
    $<HTMLInputElement>('pauseToggle').checked = !s.settings.paused.includes(siteHost);
    $<HTMLSelectElement>('siteModel').value = modelForHost(s.settings, siteHost);
  }
}

async function refresh(): Promise<void> {
  const res = await send({ type: 'summary' });
  if (res.ok && 'settings' in res) render(res);
}

async function patch(p: Partial<Settings>): Promise<void> {
  await send({ type: 'updateSettings', patch: p });
  await refresh();
}

function buildModelSelect(): void {
  const sel = $<HTMLSelectElement>('siteModel');
  for (const [cls, meta] of Object.entries(CLASS_META)) {
    const og = document.createElement('optgroup');
    og.label = meta.label;
    MODELS.filter((m) => m.cls === cls).forEach((m) => og.appendChild(new Option(m.name, m.id)));
    sel.appendChild(og);
  }
}

async function init(): Promise<void> {
  buildModelSelect();
  siteHost = await activeHost();
  if (isSafari()) {
    $('appHint').textContent = 'Estimates only. Message text is never stored or sent. Open the Prompt Fitness app for your full history and tips.';
  }

  $<HTMLInputElement>('pauseToggle').addEventListener('change', (e) => {
    if (!siteHost || !settings) return;
    const on = (e.target as HTMLInputElement).checked;
    const paused = new Set(settings.paused);
    if (on) paused.delete(siteHost); else paused.add(siteHost);
    void patch({ paused: [...paused] });
  });
  $<HTMLSelectElement>('siteModel').addEventListener('change', (e) => {
    if (!siteHost || !settings) return;
    const v = (e.target as HTMLSelectElement).value;
    if (!isModelId(v)) return;
    const siteModels = { ...settings.siteModels };
    if (v === DEFAULT_SITE_MODEL[siteHost]) delete siteModels[siteHost]; else siteModels[siteHost] = v;
    void patch({ siteModels });
  });
  $<HTMLInputElement>('pillToggle').addEventListener('change', (e) => {
    void patch({ showPill: (e.target as HTMLInputElement).checked });
  });
  $<HTMLSelectElement>('budget').addEventListener('change', (e) => {
    void patch({ budget: Number((e.target as HTMLSelectElement).value) });
  });

  const clearBtn = $<HTMLButtonElement>('clearBtn');
  let armed: number | undefined;
  clearBtn.addEventListener('click', async () => {
    if (armed === undefined) {
      clearBtn.textContent = 'Tap again to delete';
      clearBtn.classList.add('armed');
      armed = window.setTimeout(() => {
        armed = undefined; clearBtn.textContent = 'Clear tracked data'; clearBtn.classList.remove('armed');
      }, 3000);
      return;
    }
    window.clearTimeout(armed);
    armed = undefined;
    clearBtn.textContent = 'Clear tracked data';
    clearBtn.classList.remove('armed');
    await send({ type: 'clear' });
    $('lastCard').hidden = true;
    await refresh();
  });

  await refresh();
}

void init();
