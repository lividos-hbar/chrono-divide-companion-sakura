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
    minimapRadar: { on: true, litLo: 0.10, litHi: 0.34, shLo: 0.03, shHi: 0.09, sat: 0.25, oreLift: 0.06, unit: 1, halo: 0 },
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
    radarOn: $("radarOn"), radarLitLo: $("radarLitLo"), radarLitHi: $("radarLitHi"),
    radarShLo: $("radarShLo"), radarShHi: $("radarShHi"), radarSat: $("radarSat"),
    radarOreLift: $("radarOreLift"), radarUnit: $("radarUnit"), radarHalo: $("radarHalo"),
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
      const radar = { ...DEFAULTS.minimapRadar, ...(p.minimapRadar || {}) };
      controls.radarOn.checked = radar.on;
      for (const [key, control] of Object.entries({ litLo: controls.radarLitLo, litHi: controls.radarLitHi, shLo: controls.radarShLo, shHi: controls.radarShHi, sat: controls.radarSat, oreLift: controls.radarOreLift, unit: controls.radarUnit, halo: controls.radarHalo })) control.value = radar[key];
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
        minimapRadar: {
          on: controls.radarOn.checked,
          litLo: Number(controls.radarLitLo.value), litHi: Number(controls.radarLitHi.value),
          shLo: Number(controls.radarShLo.value), shHi: Number(controls.radarShHi.value),
          sat: Number(controls.radarSat.value), oreLift: Number(controls.radarOreLift.value),
          unit: Number(controls.radarUnit.value), halo: Number(controls.radarHalo.value),
        },
      };
      chrome.storage.local.set({ prefs: next }, () => {
        $("status").textContent = "Saved. It will apply to every match; an open tab repaints on its next radar update.";
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
    controls.radarOn.checked = DEFAULTS.minimapRadar.on;
    for (const [key, control] of Object.entries({ litLo: controls.radarLitLo, litHi: controls.radarLitHi, shLo: controls.radarShLo, shHi: controls.radarShHi, sat: controls.radarSat, oreLift: controls.radarOreLift, unit: controls.radarUnit, halo: controls.radarHalo })) control.value = DEFAULTS.minimapRadar[key];
    save();
  });
  $("fullOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());
  fillColourSelects();
  load();
})();
