// Runs on the leaderboard site only. Isolated world: has chrome.*, no page JS.
const SRC_IN = "cdl-site";       // page -> extension
const SRC_OUT = "cdl-companion"; // extension -> page

function post(msg) {
  window.postMessage({ ...msg, source: SRC_OUT }, "*");
}

// Announce on load, and again whenever the page asks.
post({
  type: "hello",
  version: chrome.runtime.getManifest().version
});

window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  const d = event.data;
  if (!d || d.source !== SRC_IN) return;

  if (d.type === "ping") {
    post({
      type: "hello",
      version: chrome.runtime.getManifest().version
    });
    return;
  }

  if (d.type === "analyse") {
  // d: { gameId, replayUrl, pace? }
  const sim = {
    at: Date.now(),
    requested: true,
    gameId: d.gameId,
    url: d.replayUrl,
    text: null
  };
  if (typeof d.pace === "number") sim.pace = d.pace;

  chrome.storage.local.set({ sim }, () => {
    chrome.runtime.sendMessage(
      {
        type: "open-game-tab",
        url: "https://game.chronodivide.com/#/replay/" +
          encodeURIComponent(d.replayUrl)
      },
      (answer) => {
        void chrome.runtime.lastErroralance;

        if (!answer || !answer.ok) {
          post({
            type: "error",
            gameId: d.gameId,
            error: "could not open the game tab"
          });
        }
      }
    );
  });
}

});

// Watch the extension's own storage and relay progress + results to the page.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;

  if (changes.sim && changes.sim.newValue) {
    const s = changes.sim.newValue;

    post({
      type: "progress",
      gameId: s.gameId,
      tick: s.tick,
      endTick: s.endTick,
      error: s.error || ""
    });
  }

  if (changes.sims && changes.sims.newValue) {
    const sims = changes.sims.newValue;
    const prev = changes.sims.oldValue || {};

    for (const [gameId, result] of Object.entries(sims)) {
      if (prev[gameId] === result) continue;
      if (result && result.checkpoint) continue; // mid-run snapshot, not the final answer

      post({
        type: "result",
        gameId,
        result
      });
    }
  }
});