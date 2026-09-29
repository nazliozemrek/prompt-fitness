// AI Girdi Kutusu Etkileşimlerini Dinleme
document.addEventListener('keydown', (event) => {
  // Enter tuşuna basıldığında (Shift+Enter hariç)
  if (event.key === 'Enter' && !event.shiftKey) {
    const target = event.target;
    
    // ChatGPT, Claude ve Gemini girdi alanları tespiti
    if (
      target.matches('#prompt-textarea, [contenteditable="true"], textarea')
    ) {
      const promptText = target.value || target.innerText || "";
      if (promptText.trim().length > 0) {
        processPrompt(promptText.trim());
      }
    }
  }
});

function processPrompt(text) {
  const charCount = text.length;
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  
  // Ortalama Token ve Çevre Ayak İzi Tahmini (Simülasyon Metrikleri)
  // ~4 karakter = 1 token
  const estimatedTokens = Math.ceil(charCount / 4);
  
  // Yaklaşık Enerji (Wh) ve Su Ayak İzi (ml)
  // Basit ortalama: 100 token ~ 0.3 Wh enerji & 0.5 ml su soğutma etkisi
  const estimatedEnergyWh = (estimatedTokens / 100) * 0.3;
  const estimatedWaterMl = (estimatedTokens / 100) * 0.5;

  const promptData = {
    timestamp: new Date().toISOString(),
    charCount,
    wordCount,
    estimatedTokens,
    estimatedEnergyWh,
    estimatedWaterMl
  };

  // On-Device Privacy: Sadece yerel depolamaya kaydet
  chrome.storage.local.get({ prompts: [] }, (result) => {
    const updatedPrompts = [...result.prompts, promptData];
    chrome.storage.local.set({ prompts: updatedPrompts });
  });
}