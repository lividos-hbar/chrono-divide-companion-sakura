/**
 * Keep a run alive in a tab nobody is looking at.
 *
 * A hidden tab gets **no animation frames at all**, and its timers are clamped
 * to a second — to a minute once it has been hidden for five. The game client's
 * boot leans on both: it advances its loading screen from inside
 * `requestAnimationFrame`, so a tab opened in the background for a run sits on
 * that screen until whatever asked for the run gives up. That is the whole
 * reason a replay re-run used to have to be watched.
 *
 * So this replaces `requestAnimationFrame` with one that keeps its promise while
 * the tab is hidden: it hands callbacks to the real one whenever the tab is
 * visible, and drives them itself — off a clock a background tab does not slow
 * down — while it is not. It is **inert until a job asks for it**: nothing is
 * pumped, and no clock runs, unless something is holding it. A tab the user is
 * playing in never holds it, so nothing here touches a live match.
 *
 * It is a content script at `document_start` on purpose. The client captures
 * `requestAnimationFrame` while it boots, and a replacement installed after that
 * would be a replacement nothing calls.
 *
 * `window.__cdcFrames`:
 *
 *   hold()        → release()   frames keep coming while at least one hold is out
 *   sleep(millis) → Promise     a wait a hidden tab cannot stretch
 *
 * No chrome APIs and no client modules, so scripts/check-frames.mjs drives this
 * very file rather than a copy of it.
 */
(() => {
  "use strict";

  const TAG = "[cd-companion/frames]";

  /**
   * Deliver a local page through the client's existing XWOL message path.
   *
   * The lobby has no public "append chat row" API.  Its pages are ordinary
   * server messages, parsed from the WebSocket before React ever sees them.
   * Keep the first channel-join packet as a protocol-correct template, then
   * replay that packet with only its displayed text changed.  This lets the
   * client create, format, scroll and retire the page exactly as it does an
   * `(xwol-*) You are away` message — without guessing its private React DOM.
   *
   * This must be installed at document_start, before the client creates its
   * XWOL socket.  It is intentionally limited to text frames that contain the
   * server's own channel-join line; binary game sockets are never retained or
   * touched.
   */
  const NativeWebSocket = window.WebSocket;
  let pageTemplate = null;
  const JOIN_LINE = /You joined channel [^\r\n"\\]+/;

  function rememberPageTemplate(socket, event) {
    if (pageTemplate || typeof event.data !== "string" || !JOIN_LINE.test(event.data)) return;
    pageTemplate = { socket, data: event.data };
  }

  window.__cdcPage = (text) => {
    if (!NativeWebSocket || !pageTemplate || pageTemplate.socket.readyState !== NativeWebSocket.OPEN) return false;
    const data = pageTemplate.data.replace(JOIN_LINE, String(text));
    pageTemplate.socket.dispatchEvent(new MessageEvent("message", { data }));
    return true;
  };

  if (NativeWebSocket) {
    function CompanionWebSocket(...args) {
      const socket = Reflect.construct(NativeWebSocket, args, NativeWebSocket);
      socket.addEventListener("message", (event) => rememberPageTemplate(socket, event));
      return socket;
    }
    CompanionWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"]) {
      Object.defineProperty(CompanionWebSocket, key, { value: NativeWebSocket[key] });
    }
    window.WebSocket = CompanionWebSocket;
  }

  /** The interval the pumped frames aim at — 60 a second, what the real one gives. */
  const FRAME_MILLIS = 16;

  const native = {
    request: window.requestAnimationFrame.bind(window),
    cancel: window.cancelAnimationFrame.bind(window),
  };

  /**
   * A clock a hidden tab cannot slow down.
   *
   * `setTimeout` is the one thing this cannot be built on: it is exactly what
   * the tab clamps. A dedicated worker keeps its own scheduler and is not
   * clamped with the page, which is what makes it the clock here — and the
   * client's own origin sets no `script-src`/`worker-src` (measured 2026-08-17:
   * `frame-ancestors 'self'; base-uri 'self'; object-src 'none'`), so a blob
   * worker is allowed to exist there.
   *
   * The fallback is a `MessageChannel` task loop, because a page that refuses
   * the worker still has to boot: task messages are not throttled either, but
   * they also cannot wait, so that path spins a core for the length of the hold.
   * It is loud about it — a run burning a core is a fact worth seeing in the log
   * rather than a mystery in a fan.
   */
  const clock = (() => {
    const timers = new Map(); // id -> { millis, fn, due }
    let nextTimer = 1;
    let worker = null;
    let spinning = false;

    const spin = () => {
      if (spinning || !timers.size) return;
      spinning = true;
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        if (!timers.size) {
          spinning = false;
          return;
        }
        const now = Date.now();
        for (const timer of [...timers.values()]) {
          if (now < timer.due) continue;
          timer.due = now + timer.millis;
          timer.fn();
        }
        channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
    };

    try {
      const source =
        "const timers = new Map();" +
        "onmessage = (e) => {" +
        "  const job = e.data;" +
        "  if (job.stop) { clearInterval(timers.get(job.stop)); timers.delete(job.stop); return; }" +
        "  timers.set(job.id, setInterval(() => postMessage(job.id), job.millis));" +
        "};";
      worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      worker.onmessage = (event) => {
        const timer = timers.get(event.data);
        if (timer) timer.fn();
      };
      worker.onerror = (event) => {
        console.warn(TAG, "the worker clock failed — spinning through a task loop instead", event);
        worker = null;
        // Whatever was running on it is still wanted; the spin loop reads the
        // same list, so re-arming is one call.
        spin();
      };
    } catch (e) {
      console.warn(TAG, "no worker clock — spinning through a task loop instead", e);
      worker = null;
    }

    /** Run `fn` every `millis`, until the returned function is called. */
    const every = (millis, fn) => {
      const id = nextTimer++;
      timers.set(id, { millis, fn, due: Date.now() + millis });
      if (worker) worker.postMessage({ id, millis });
      else spin();
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        timers.delete(id);
        if (worker) worker.postMessage({ stop: id });
      };
    };

    return { every, worker: () => !!worker };
  })();

  /** A wait of `millis` that a hidden tab cannot stretch into a minute. */
  const sleep = (millis) =>
    new Promise((resolve) => {
      const stop = clock.every(millis, () => {
        stop();
        resolve();
      });
    });

  // --- the frames themselves ----------------------------------------------

  /** Callbacks waiting for the next frame, by the id this handed out for them. */
  const pending = new Map();
  let nextFrame = 1;
  /** The real frame we are waiting on, when the tab is visible. */
  let nativeHandle = 0;
  /** The pump's clock, when it is running. */
  let stopPump = null;
  let holds = 0;
  /** When the pump last delivered a frame — see `beat`. */
  let lastPumped = 0;

  /**
   * The tab's **real** visibility.
   *
   * Read through the accessor the platform defines rather than off `document`,
   * because a run spoofs `document.hidden` (src/replay-sim.js) to keep the
   * client's `GameAnimationLoop` on its `requestAnimationFrame` path — that loop
   * branches on `document.hidden` alone, and when it believes the tab is hidden
   * it renders nothing at all and disposes nothing with it. The pump is what
   * makes that lie true, so it must not be told it.
   */
  const trueVisibility = (() => {
    for (let proto = Object.getPrototypeOf(document); proto; proto = Object.getPrototypeOf(proto)) {
      const found = Object.getOwnPropertyDescriptor(proto, "visibilityState");
      if (found && found.get) return () => found.get.call(document);
    }
    // A document with no accessor to read is not a browser's; a check drives one.
    return () => document.visibilityState;
  })();

  const pumped = () => holds > 0 && trueVisibility() === "hidden";

  /**
   * Frames actually delivered, whoever drove them.
   *
   * Counted because the one number that separates watching a replay from
   * re-running it is how many game ticks pass between two frames — one when the
   * client plays it, forty-five when a run drives it — and nothing could read it
   * before this counter existed (2026-08-17).
   */
  let delivered = 0;

  const fire = (now) => {
    nativeHandle = 0;
    // Counted only when something was waiting: a beat with an empty queue is not
    // a frame anybody consumed, and counting it made the run's ticks-per-frame
    // read 9-30 where the truth was that the client had asked for no frames at
    // all (2026-08-17).
    if (pending.size) delivered++;
    // Taken and cleared before any of them run: a callback asking for the next
    // frame — which is what an animation loop is — must land in the next batch
    // rather than in this one, or the loop never returns.
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) {
      try {
        callback(now);
      } catch (e) {
        // The real `requestAnimationFrame` reports a throwing callback and goes
        // on to the next one; a shim that let the first one kill the loop would
        // be a shim that breaks the client it exists to keep running.
        console.warn(TAG, "an animation frame callback threw", e);
      }
    }
  };

  /**
   * One pumped frame, and **no catching up**.
   *
   * The clock goes on ticking while the main thread is busy, so a job that holds
   * the thread for 100 ms comes back to six ticks waiting for it. Delivering all
   * six would draw six frames back to back of a scene nobody is looking at,
   * which is the opposite of what the real `requestAnimationFrame` does: it
   * delivers one callback per frame the browser actually produces and drops the
   * rest. A backlog is dropped here for the same reason, and because the frames
   * a hidden tab draws are never consumed by anything — they are pure cost, and
   * enough of them took a tab down (2026-08-17).
   */
  const beat = () => {
    const now = performance.now();
    if (now - lastPumped < FRAME_MILLIS) return;
    lastPumped = now;
    fire(now);
  };

  /**
   * Put the frames on whichever source is right for the tab as it is now.
   *
   * Called whenever either half of `pumped()` can have changed — a hold arriving
   * or leaving, the tab being shown or hidden.
   */
  const sync = () => {
    if (pumped()) {
      if (nativeHandle) {
        native.cancel(nativeHandle);
        nativeHandle = 0;
      }
      if (!stopPump) stopPump = clock.every(FRAME_MILLIS, beat);
      return;
    }
    if (stopPump) {
      stopPump();
      stopPump = null;
    }
    if (pending.size && !nativeHandle) nativeHandle = native.request(fire);
  };

  window.requestAnimationFrame = (callback) => {
    const id = nextFrame++;
    pending.set(id, callback);
    if (!pumped() && !nativeHandle) nativeHandle = native.request(fire);
    return id;
  };

  window.cancelAnimationFrame = (id) => {
    pending.delete(id);
    // The real frame we asked for is left booked: it costs a call with nothing
    // to do, and cancelling it would strand any callback registered since.
  };

  document.addEventListener("visibilitychange", sync);

  /**
   * Ask for frames to keep coming. The returned function gives them back, and
   * gives them back once however many times it is called — a job that releases
   * in a `finally` and again on its way out must not take somebody else's hold
   * down with it.
   */
  const hold = () => {
    holds++;
    sync();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      holds--;
      sync();
    };
  };

  window.__cdcFrames = {
    hold,
    sleep,
    /** For a check, and for a log line that has to say which clock this got. */
    state: () => ({ holds, pumping: !!stopPump, worker: clock.worker(), pending: pending.size, frames: delivered }),
  };
})();
