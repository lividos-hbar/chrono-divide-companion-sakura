/**
 * Run src/frames.js — the file as shipped — in a fake tab.
 *
 *   node scripts/check-frames.mjs
 *
 * The rule worth a test of its own is **inert until asked**: the shim is
 * installed on every game page, including the one the user is playing in, and
 * there it must be the real `requestAnimationFrame` and nothing else. What it
 * does when a run holds it — keep firing callbacks while the tab is hidden, on a
 * clock the tab cannot clamp — is the other half, and the half a run depends on.
 *
 * The pumped frames are timed, so the checks below wait real milliseconds rather
 * than stepping a fake clock: the point of the file is that a real clock keeps
 * going, and a fake one would prove nothing about it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "src", "frames.js"), "utf8");

/**
 * The worker the clock asks for: a timer that is not the page's, which is the
 * whole of what a real one gives it. Its intervals are left holding the process
 * open on purpose — `sleep` waits on nothing else, and an unreferenced timer
 * under it would end the run instead of the wait. The last line exits.
 */
class FakeWorker {
  constructor() {
    this.timers = new Map();
    this.onmessage = null;
    this.onerror = null;
  }
  postMessage(job) {
    if (job.stop) {
      clearInterval(this.timers.get(job.stop));
      this.timers.delete(job.stop);
      return;
    }
    this.timers.set(job.id, setInterval(() => this.onmessage && this.onmessage({ data: job.id }), job.millis));
  }
}

/** A tab with the file loaded into it. */
function tab({ worker = true } = {}) {
  const listeners = [];
  const workers = [];
  const native = []; // frames the real requestAnimationFrame was asked for
  const cancelled = [];
  let nextNative = 1;

  const window = {
    requestAnimationFrame(fn) {
      const id = nextNative++;
      native.push({ id, fn });
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
    },
  };
  // `visibilityState` on a prototype, the way a browser puts it on
  // `Document.prototype`: src/frames.js reads it through that accessor on
  // purpose, so a run spoofing an own property on the document cannot fool the
  // pump into thinking the tab is visible.
  const proto = {};
  Object.defineProperty(proto, "visibilityState", {
    get() {
      return this.realState;
    },
    configurable: true,
  });
  const document = Object.create(proto);
  document.realState = "visible";
  document.addEventListener = (type, fn) => listeners.push([type, fn]);

  vm.runInNewContext(source, {
    window,
    document,
    console,
    performance,
    Date,
    MessageChannel,
    Blob: class Blob {},
    URL: { createObjectURL: () => "blob:fake" },
    Worker: worker
      ? class Recorded extends FakeWorker {
          constructor(...rest) {
            super(...rest);
            workers.push(this);
          }
        }
      : function Blocked() {
          throw new Error("refused by the page's policy");
        },
  });

  const tell = () => listeners.filter(([type]) => type === "visibilitychange").forEach(([, fn]) => fn());

  return {
    window,
    native,
    cancelled,
    /** The clock's own worker, so a check can deliver its ticks by hand. */
    beat(times = 1) {
      const worker = workers[0];
      const id = [...worker.timers.keys()][0];
      for (let i = 0; i < times; i++) worker.onmessage({ data: id });
    },
    api: window.__cdcFrames,
    ask: (fn) => window.requestAnimationFrame(fn),
    drop: (id) => window.cancelAnimationFrame(id),
    hide() {
      document.realState = "hidden";
      tell();
    },
    show() {
      document.realState = "visible";
      tell();
    },
    /** What a run does to the document so the client keeps rendering. */
    spoofVisible() {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      Object.defineProperty(document, "hidden", { value: false, configurable: true });
      tell();
    },
    /** Deliver the frames the real one was asked for, the way a visible tab would. */
    serve(now = 1) {
      for (const frame of native.splice(0)) frame.fn(now);
    },
  };
}

const settle = (millis = 120) => new Promise((r) => setTimeout(r, millis));
const results = [];
const check = (name, ok, detail) =>
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);

/** A callback that asks for the next frame, which is what an animation loop is. */
const loop = (counter) => {
  const step = (t) => {
    counter.frames++;
    counter.last = t;
    counter.ask(step);
  };
  return step;
};

// --- the tab the user is playing in -----------------------------------------

const playing = tab();
check("it takes the worker clock when the page allows one", playing.api.state().worker === true, JSON.stringify(playing.api.state()));

const seen = { frames: 0, last: 0, ask: playing.ask };
playing.ask(loop(seen));
check("a frame asked for in a visible tab goes to the real one", playing.native.length === 1, JSON.stringify(playing.native.length));
await settle(60);
check("and nothing fires it but the real one", seen.frames === 0, String(seen.frames));
playing.serve(11);
check("which delivers it", seen.frames === 1 && seen.last === 11, JSON.stringify(seen));

playing.hide();
await settle(60);
check("a hidden tab with no run in it is not pumped", seen.frames === 1 && playing.api.state().pumping === false, JSON.stringify(seen));

// --- a tab with a run in it --------------------------------------------------

const running = tab();
const run = { frames: 0, last: 0, ask: running.ask };
running.hide();
const release = running.api.hold();
running.ask(loop(run));
await settle();
check("a held hidden tab keeps the frames coming", run.frames > 2, String(run.frames));
check("without asking the real one for any", running.native.length === 0, JSON.stringify(running.native.length));
check("and it says so", running.api.state().pumping === true, JSON.stringify(running.api.state()));
// The count a run divides its ticks by to say how far apart two frames were.
check("it counts the frames it delivered", running.api.state().frames >= run.frames, JSON.stringify(running.api.state()));

const second = running.api.hold();
release();
release(); // a job that releases twice must not take the other one's hold down
await settle(40);
const held = run.frames;
await settle(60);
check("a second hold keeps it going after the first is given back", run.frames > held, `${held} -> ${run.frames}`);
second();
await settle(40);
const stopped = run.frames;
await settle(60);
check("the last release stops the pump", run.frames === stopped, `${stopped} -> ${run.frames}`);
check("and it says so", running.api.state().pumping === false, JSON.stringify(running.api.state()));

// --- the tab coming to the front mid-run -------------------------------------

const shown = tab();
const front = { frames: 0, last: 0, ask: shown.ask };
shown.hide();
const holding = shown.api.hold();
shown.ask(loop(front));
await settle(60);
check("frames while hidden", front.frames > 0, String(front.frames));
shown.show();
const pumpedTo = front.frames;
await settle(60);
check("a tab brought to the front stops being pumped", front.frames === pumpedTo, `${pumpedTo} -> ${front.frames}`);
check("and the waiting callback is handed to the real one", shown.native.length === 1, JSON.stringify(shown.native.length));
shown.serve(22);
check("which delivers it", front.frames === pumpedTo + 1, String(front.frames));
shown.hide();
check("hiding it again takes back the frame the real one was booked for", shown.cancelled.length === 1, JSON.stringify(shown.cancelled));
holding();

// --- the lie a run tells the client -----------------------------------------

const spoofed = tab();
spoofed.hide();
const spoofHold = spoofed.api.hold();
const lied = { frames: 0, last: 0, ask: spoofed.ask };
spoofed.ask(loop(lied));
await settle(60);
const before = lied.frames;
check("frames while hidden", before > 0, String(before));
// The run tells the page it is visible so the client's animation loop keeps
// rendering; the pump must go on pumping, because the browser still gives this
// tab nothing.
spoofed.spoofVisible();
await settle(60);
check("a run spoofing document.hidden does not stop the pump", lied.frames > before, `${before} -> ${lied.frames}`);
check("and the real frames were never asked for", spoofed.native.length === 0, JSON.stringify(spoofed.native.length));
spoofHold();

// --- a busy main thread, and the backlog it comes back to --------------------

const busy = tab();
busy.hide();
const busyHold = busy.api.hold();
const burst = { frames: 0, last: 0, ask: busy.ask };
busy.ask(loop(burst));
// Three ticks of the clock inside one frame's worth of time, which is what a job
// that held the main thread for 100 ms comes back to. The real one delivers one
// callback per frame it actually produced and drops the rest.
busy.beat(3);
check("a backlog of clock ticks is one frame, not three", burst.frames === 1, String(burst.frames));
await settle(40);
check("and the frames go on coming after it", burst.frames > 1, String(burst.frames));
busyHold();

// --- what a frame is allowed to do -------------------------------------------

const odd = tab();
odd.hide();
const oddHold = odd.api.hold();
let after = 0;
let cancelledRan = false;
const dropped = odd.ask(() => (cancelledRan = true));
odd.drop(dropped);
odd.ask(() => {
  throw new Error("this callback is broken");
});
odd.ask(() => after++);
await settle(60);
check("a cancelled frame never fires", cancelledRan === false, String(cancelledRan));
check("a throwing callback does not take the next one down with it", after > 0, String(after));
oddHold();

// --- the wait, and the clock under it ----------------------------------------

const waiting = tab();
waiting.hide();
const began = Date.now();
await waiting.api.sleep(40);
const slept = Date.now() - began;
check("sleep waits about as long as it was asked to", slept >= 35 && slept < 400, `${slept}ms`);

// --- a page that refuses the worker ------------------------------------------

const strict = tab({ worker: false });
check("a page that refuses a worker still has a clock", strict.api.state().worker === false, JSON.stringify(strict.api.state()));
const spun = { frames: 0, last: 0, ask: strict.ask };
strict.hide();
const spinHold = strict.api.hold();
strict.ask(loop(spun));
await settle(80);
spinHold();
check("and the frames still come", spun.frames > 2, String(spun.frames));

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
