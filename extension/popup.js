document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get({ prompts: [] }, (result) => {
    const prompts = result.prompts;

    const totalPrompts = prompts.length;
    const totalWater = prompts.reduce((acc, curr) => acc + (curr.estimatedWaterMl || 0), 0);
    const totalEnergy = prompts.reduce((acc, curr) => acc + (curr.estimatedEnergyWh || 0), 0);

    document.getElementById('total-prompts').textContent = totalPrompts;
    document.getElementById('total-water').textContent = totalWater.toFixed(1) + ' ml';
    document.getElementById('total-energy').textContent = totalEnergy.toFixed(2) + ' Wh';

    // Ortalama Skor Hesaplama
    if (prompts.length > 0) {
      const grades = prompts.map(p => p.fitnessScore || 'A');
      const mostCommonGrade = grades.sort((a,b) =>
        grades.filter(v => v===a).length - grades.filter(v => v===b).length
      ).pop();
      document.getElementById('avg-grade').textContent = mostCommonGrade;
    }

    // Chart.js Çizimi
    initChart(prompts);
  });

  // Veri İndirme (JSON Export)
  document.getElementById('btn-export').addEventListener('click', () => {
    chrome.storage.local.get({ prompts: [] }, (result) => {
      const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(result.prompts, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute("href", dataStr);
      downloadAnchor.setAttribute("download", `prompt_fitness_data_${new Date().toISOString().slice(0,10)}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    });
  });

  // Veri Sıfırlama
  document.getElementById('btn-reset').addEventListener('click', () => {
    if (confirm("Tüm prompt geçmişinizi sıfırlamak istediğinize emin misiniz?")) {
      chrome.storage.local.set({ prompts: [] }, () => {
        location.reload();
      });
    }
  });
});

function initChart(prompts) {
  const ctx = document.getElementById('usageChart').getContext('2d');
  
  // Son 7 girdiyi veya mevcut tüm veriyi al
  const recentPrompts = prompts.slice(-7);
  const labels = recentPrompts.map((_, index) => `#${index + 1}`);
  const waterData = recentPrompts.map(p => p.estimatedWaterMl || 0);

  new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels.length > 0 ? labels : ['0'],
      datasets: [{
        label: 'Su (ml)',
        data: waterData.length > 0 ? waterData : [0],
        borderColor: '#38bdf8',
        backgroundColor: 'rgba(56, 189, 248, 0.1)',
        fill: true,
        tension: 0.4
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#64748b' } },
        y: { grid: { color: '#334155' }, ticks: { color: '#64748b' } }
      }
    }
  });
}