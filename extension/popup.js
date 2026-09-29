document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get({ prompts: [] }, (result) => {
    const prompts = result.prompts;
    
    const totalPrompts = prompts.length;
    const totalWater = prompts.reduce((acc, curr) => acc + curr.estimatedWaterMl, 0);
    const totalEnergy = prompts.reduce((acc, curr) => acc + curr.estimatedEnergyWh, 0);

    document.getElementById('total-prompts').textContent = totalPrompts;
    document.getElementById('total-water').textContent = totalWater.toFixed(1) + ' ml';
    document.getElementById('total-energy').textContent = totalEnergy.toFixed(2) + ' Wh';
  });
});