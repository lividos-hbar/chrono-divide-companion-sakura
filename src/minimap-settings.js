(() => {
  "use strict";

  const DEFAULTS = {
    minimapEnabled: true,
    minimapPreserveRadarColors: true,
    minimapTerrain: "#141414",
    minimapDarkened: "#080808",
    minimapUnexplored: "#000000",
    playerColoursEnabled: false,
    playerColoursMatchMode: "1v1",
    playerColoursEnemyMode: "same",
    playerColoursOrder: ["DarkRed", "DarkBlue"],
  };
  const PLAYER_COLOURS = ["Gold", "DarkRed", "DarkBlue", "DarkGreen", "Orange", "DarkSky", "Purple", "Magenta"];

  const $ = (id) => document.getElementById(id);
  const controls = {
    enabled: $("enabled"),
    preserve: $("preserve"),
    terrain: $("terrain"),
    darkened: $("darkened"),
    unexplored: $("unexplored"),
    playerColoursEnabled: $("playerColoursEnabled"),
    playerColoursMatchMode: $("playerColoursMatchMode"),
    playerColoursEnemyMode: $("playerColoursEnemyMode"),
    playerColoursFirst: $("playerColoursFirst"),
    playerColoursSecond: $("playerColoursSecond"),
  };

  function fillColourSelects() {
    for (const control of [controls.playerColoursFirst, controls.playerColoursSecond]) {
      control.replaceChildren(...PLAYER_COLOURS.map((name) => new Option(name, name)));
    }
  }

  function load() {
    chrome.storage.local.get({ prefs: {} }, ({ prefs }) => {
      const p = { ...DEFAULTS, ...prefs };
      controls.enabled.checked = !!p.minimapEnabled;
      controls.preserve.checked = !!p.minimapPreserveRadarColors;
      controls.terrain.value = p.minimapTerrain;
      controls.darkened.value = p.minimapDarkened;
      controls.unexplored.value = p.minimapUnexplored;
      controls.playerColoursEnabled.checked = !!p.playerColoursEnabled;
      controls.playerColoursMatchMode.value = p.playerColoursMatchMode;
      controls.playerColoursEnemyMode.value = p.playerColoursEnemyMode;
      controls.playerColoursFirst.value = p.playerColoursOrder[0];
      controls.playerColoursSecond.value = p.playerColoursOrder[1] || p.playerColoursOrder[0];
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
        playerColoursEnabled: controls.playerColoursEnabled.checked,
        playerColoursMatchMode: controls.playerColoursMatchMode.value,
        playerColoursEnemyMode: controls.playerColoursEnemyMode.value,
        playerColoursOrder: [controls.playerColoursFirst.value, controls.playerColoursSecond.value],
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
    controls.playerColoursEnabled.checked = DEFAULTS.playerColoursEnabled;
    controls.playerColoursMatchMode.value = DEFAULTS.playerColoursMatchMode;
    controls.playerColoursEnemyMode.value = DEFAULTS.playerColoursEnemyMode;
    controls.playerColoursFirst.value = DEFAULTS.playerColoursOrder[0];
    controls.playerColoursSecond.value = DEFAULTS.playerColoursOrder[1];
    save();
  });
  $("fullOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  fillColourSelects();
  load();
})();
