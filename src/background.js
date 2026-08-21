/**
 * Service worker. Two jobs, both of which need a context the other halves of the
 * extension do not have.
 *
 * 1. The toolbar icon opens the options page. `action.onClicked` fires only when
 *    the action has no default_popup, which is why manifest.json declares
 *    `action` without one.
 *
 * 2. A render run needs a game client, and neither the options page nor a
 *    content script can open a tab. So the options page asks here, and the tab
 *    that finishes the run asks here to be closed again.
 *
 * The ids of the tabs opened this way live in `chrome.storage.session`, not in a
 * variable: this worker is torn down whenever it is idle, and a run takes
 * minutes. A tab the *user* opened is never in that list and is never closed.
 *
 * 3. It owns the extension's log — see appendLog. That is here for the same
 *    reason as the tab list: it is the one context every other half can reach.
 */

const GAME_URL = "https://game.chronodivide.com/";

/**
 * How many log entries are kept. Small on purpose: the log is for the last
 * thing that happened, and every entry shares a storage budget with renders
 * that are megabytes each.
 */
const MAX_LOG = 400;

/** One line of the log, as short as it can be and still be read. */
const MAX_LINE = 300;

/**
 * The extension's log: what it did, in storage, so it can be read without
 * DevTools — by the options page's Log tab, and by
 * `scripts/read-storage.mjs` from a shell with no browser at all.
 *
 * It lives here rather than in each half because there is one storage key and
 * three writers (the game tab's bridge, the options page, this worker), and a
 * key with three independent read-modify-write cycles loses entries. Writers
 * send batches; this appends them.
 *
 * Written as each batch arrives rather than buffered, because a worker is torn
 * down whenever it is idle and a buffer here would be lost with it. The chain
 * below serialises the read-modify-write against itself; it does not survive a
 * teardown, but neither does anything it was waiting for.
 */
let appending = Promise.resolve();

function appendLog(lines) {
  if (!Array.isArray(lines) || !lines.length) return appending;
  appending = appending
    .then(async () => {
      const { log } = await chrome.storage.local.get({ log: [] });
      const clean = lines
        .filter((e) => e && e.msg)
        .map((e) => ({
          at: Number(e.at) || Date.now(),
          src: String(e.src || "?").slice(0, 12),
          level: e.level === "warn" || e.level === "error" ? e.level : "info",
          msg: String(e.msg).slice(0, MAX_LINE),
        }));
      await chrome.storage.local.set({ log: log.concat(clean).slice(-MAX_LOG) });
    })
    .catch((e) => {
      // Never logged back into the log: a failing log that logs its failures
      // is a loop, and this is the one place with nowhere else to report to.
      console.warn("[cd-companion/background] could not append to the log", e);
    });
  return appending;
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

async function ownedTabs() {
  const data = await chrome.storage.session.get({ ownedTabs: [] });
  return data.ownedTabs;
}

async function setOwnedTabs(ids) {
  await chrome.storage.session.set({ ownedTabs: ids });
}

/**
 * A tab for a run.
 *
 * `url` is for a replay run, which needs the client to open on a particular
 * match (`#/replay/<url>`) rather than on its menu. It is checked against the
 * game's own origin rather than trusted: this worker will open a tab for
 * anything that asks, and the only thing that should ever ask for is the client.
 */
async function openGameTab(url) {
  const target = typeof url === "string" && url.startsWith(GAME_URL) ? url : GAME_URL;
  // Inactive: a run started from the options page must not take the screen away
  // from whoever started it.
  const tab = await chrome.tabs.create({ url: target, active: false });
  await setOwnedTabs([...(await ownedTabs()), tab.id]);
  // Muted: the client's menu music has nothing to do with a render run, and the
  // nudge below can put this tab in front of whatever the user is listening to.
  // `create` takes no `muted`, so it is a second call — still long before the
  // client has booted far enough to play anything, and it needs no permission
  // beyond the ones already declared. Ownership is recorded first: a mute that
  // fails must not leave a tab open that nothing knows how to close.
  //
  // Muting a tab is not silencing the page — Chrome still counts it as audible,
  // so the tab keeps whatever throttling exemption the sound earns it.
  try {
    await chrome.tabs.update(tab.id, { muted: true });
  } catch (e) {
    console.warn("[cd-companion/background] could not mute the run's tab", e);
  }
  return tab.id;
}

/**
 * Bring a tab we opened to the front.
 *
 * A background tab is throttled: timers are clamped and `requestAnimationFrame`
 * does not run at all, and the client's own boot leans on both. That is a tab
 * that quietly never finishes starting, which is indistinguishable from a run
 * that is merely slow. Showing it is the cheapest way out — and it is only ever
 * a tab this worker opened, so nothing the user arranged moves.
 */
async function showIfOurs(tabId) {
  const ids = await ownedTabs();
  if (!ids.includes(tabId)) return false;
  const tab = await chrome.tabs.update(tabId, { active: true });
  // The window as well: an active tab in a window behind another one is still
  // hidden, and hidden is the whole problem.
  if (tab && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
  return true;
}

async function closeIfOurs(tabId) {
  const ids = await ownedTabs();
  if (!ids.includes(tabId)) return false; // the user's own tab: leave it alone
  await setOwnedTabs(ids.filter((id) => id !== tabId));
  await chrome.tabs.remove(tabId);
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return;

  if (message.type === "log") {
    // Answered, so a sender that must not lose its last lines — the bridge in a
    // tab about to be closed — can wait for the write instead of hoping.
    appendLog(message.lines).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "open-game-tab") {
    openGameTab(message.url).then(
      (tabId) => sendResponse({ ok: true, tabId }),
      (e) => {
        console.warn("[cd-companion/background] could not open a game tab", e);
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    );
    return true; // the answer comes later
  }

  if (message.type === "show-game-tab") {
    showIfOurs(message.tabId).then(
      (shown) => sendResponse({ ok: shown }),
      (e) => {
        console.warn("[cd-companion/background] could not show the run's tab", e);
        sendResponse({ ok: false, error: (e && e.message) || String(e) });
      }
    );
    return true;
  }

  if (message.type === "run-finished") {
    // Sent by the bridge in the tab that ran it, so the tab id comes from the
    // sender rather than being tracked from this side.
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) return;
    closeIfOurs(tabId).catch((e) =>
      console.warn("[cd-companion/background] could not close the run's tab", e)
    );
  }
});

// A tab we opened and the user closed by hand is no longer ours to close.
chrome.tabs.onRemoved.addListener((tabId) => {
  ownedTabs().then(
    (ids) => ids.includes(tabId) && setOwnedTabs(ids.filter((id) => id !== tabId)),
    (e) => console.warn("[cd-companion/background] could not update the tab list", e)
  );
});
