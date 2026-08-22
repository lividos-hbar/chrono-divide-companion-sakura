(() => {
  "use strict";

  const DEFAULTS = {
    minimapEnabled: true,
    minimapPreserveRadarColors: true,
    minimapTerrain: "#141414",
    minimapDarkened: "#080808",
    minimapUnexplored: "#000000",
  };

  const $ = (id) => document.getElementById(id);
  const controls = {
    enabled: $("enabled"),
    preserve: $("preserve"),
    terrain: $("terrain"),
    darkened: $("darkened"),
    unexplored: $("unexplored"),
  };

  function load() {
    chrome.storage.local.get({ prefs: {} }, ({ prefs }) => {
      const p = { ...DEFAULTS, ...prefs };
      controls.enabled.checked = !!p.minimapEnabled;
      controls.preserve.checked = !!p.minimapPreserveRadarColors;
      controls.terrain.value = p.minimapTerrain;
      controls.darkened.value = p.minimapDarkened;
      controls.unexplored.value = p.minimapUnexplored;
      renderPreview();
    });
  }

  function save() {
    chrome.storage.local.get({ prefs: {} }, ({ prefs }) => {
      const next = {
        ...prefs,
        minimapEnabled: controls.enabled.checked,
        minimapPreserveRadarColors: controls.preserve.checked,
        minimapTerrain: controls.terrain.value,
        minimapDarkened: controls.darkened.value,
        minimapUnexplored: controls.unexplored.value,
      };
      chrome.storage.local.set({ prefs: next }, () => {
        $("status").textContent = "Saved. Reload the game tab to test it.";
        renderPreview();
      });
    });
  }

  function renderPreview() {
    $("preview").innerHTML = `
      <div class="swatch" style="background:${controls.unexplored.value}">unexplored</div>
      <div class="swatch" style="background:${controls.darkened.value}">shroud</div>
      <div class="swatch" style="background:${controls.terrain.value}">terrain</div>`;
  }

  for (const el of Object.values(controls)) el.addEventListener("change", save);
  $("reset").addEventListener("click", () => {
    controls.enabled.checked = DEFAULTS.minimapEnabled;
    controls.preserve.checked = DEFAULTS.minimapPreserveRadarColors;
    controls.terrain.value = DEFAULTS.minimapTerrain;
    controls.darkened.value = DEFAULTS.minimapDarkened;
    controls.unexplored.value = DEFAULTS.minimapUnexplored;
    save();
  });
  $("fullOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  load();
})();
