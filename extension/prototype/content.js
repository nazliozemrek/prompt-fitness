// Sayfaya canlı rozet (UI Widget) ekleme
function injectFloatingWidget() {
  if (document.getElementById('prompt-fitness-badge')) return;

  const badge = document.createElement('div');
  badge.id = 'prompt-fitness-badge';
  badge.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #0f172a;
    color: #ffffff;
    padding: 12px 16px;
    border-radius: 14px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 12px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    opacity: 0.95;
    border: 1px solid #1e293b;
  `;
  
  badge.innerHTML = `
    <div id="pf-score-badge" style="
      background: #22c55e;
      color: #000;
      font-weight: 800;
      font-size: 14px;
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
    ">A</div>
    <div>
      <div style="font-weight: 600; font-size: 12px; color: #38bdf8;">Prompt Fitness</div>
      <div id="pf-toast-text" style="font-size: 11px; color: #cbd5e1;">Hazır</div>
    </div>
  `;
  document.body.appendChild(badge);
}

// Prompt Verimlilik Skorlama Algoritması
function calculatePromptFitness(text) {
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  
  // Yaygın dolgu / gereksiz kelimeler
  const fluffWords = ["lütfen", "bana", "detaylı", "bir şekilde", "açıklar mısın", "yardımcı ol", "rica etsem"];
  let fluffCount = 0;
  
  fluffWords.forEach(word => {
    if (text.toLowerCase().includes(word)) fluffCount++;
  });

  let score = 'A';
  let badgeColor = '#22c55e'; // Yeşil

  if (wordCount > 150 || fluffCount >= 3) {
    score = 'D';
    badgeColor = '#ef4444'; // Kırmızı
  } else if (wordCount > 80 || fluffCount >= 2) {
    score = 'C';
    badgeColor = '#f97316'; // Turuncu
  } else if (wordCount > 40 || fluffCount >= 1) {
    score = 'B';
    badgeColor = '#eab308'; // Sarı
  }

  return { score, badgeColor };
}

function showPromptToast(waterMl, energyWh, scoreData) {
  injectFloatingWidget();
  
  const scoreBadge = document.getElementById('pf-score-badge');
  const textEl = document.getElementById('pf-toast-text');
  
  if (scoreBadge) {
    scoreBadge.textContent = scoreData.score;
    scoreBadge.style.backgroundColor = scoreData.badgeColor;
  }

  if (textEl) {
    textEl.innerHTML = `💧 <b>${waterMl.toFixed(1)} ml</b> | ⚡ <b>${energyWh.toFixed(2)} Wh</b>`;
  }
}

// Enter tuşunu dinleme
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    const activeEl = document.activeElement;
    if (activeEl) {
      const text = activeEl.value || activeEl.innerText || activeEl.textContent || "";
      const cleanText = text.trim();

      if (cleanText.length > 0) {
        const charCount = cleanText.length;
        const wordCount = cleanText.split(/\s+/).filter(Boolean).length;
        const estimatedTokens = Math.ceil(charCount / 4);
        const estimatedEnergyWh = (estimatedTokens / 100) * 0.3;
        const estimatedWaterMl = (estimatedTokens / 100) * 0.5;

        const scoreData = calculatePromptFitness(cleanText);

        const promptData = {
          timestamp: new Date().toISOString(),
          charCount,
          wordCount,
          estimatedTokens,
          estimatedEnergyWh,
          estimatedWaterMl,
          fitnessScore: scoreData.score
        };

        // Anlık rozeti güncelle
        showPromptToast(estimatedWaterMl, estimatedEnergyWh, scoreData);

        // Arka plana kaydet
        chrome.runtime.sendMessage({
          action: "SAVE_PROMPT",
          data: promptData
        });
      }
    }
  }
}, true);

// Sayfa yüklendiğinde başlat
injectFloatingWidget(); 