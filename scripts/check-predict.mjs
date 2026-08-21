/**
 * The prediction ledger answers the lag the way the client eventually will.
 *
 *   node scripts/check-predict.mjs
 *
 * `src/queue-predict.js` is the one part of the overlay whose defect is
 * *invisible while it is happening*: a wrong prediction looks exactly like the
 * lag it was written to hide, right up until the client catches up and the
 * screen jumps. There is no match to watch it in and no assertion a running
 * game could make, so the algebra is exercised here on snapshots written by
 * hand — the same reason `check-chords.mjs` exists for the decision tables.
 *
 * The case that named the feature is `PAIR`: two presses of a cancel key inside
 * one lag window used to read an unchanged queue twice and send Pause twice, so
 * the cancel was never reached. That is the first thing here, and it is written
 * as the sequence a player performs rather than as a call to the reconciler.
 *
 * What this cannot check is the lag itself. `LOST_AFTER_MS` is a backstop
 * chosen without a measurement — `__cdc.build().prediction` reports what
 * confirmations actually took in a match, and that is where a measured number
 * would come from.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src");

const window = {};
new Function("window", readFileSync(join(src, "queue-predict.js"), "utf8"))(window);
new Function("window", readFileSync(join(src, "build-chords.js"), "utf8"))(window);

const predict = window.__cdcQueuePredict;
const chords = window.__cdcBuildChords;
if (!predict) fail("src/queue-predict.js did not define window.__cdcQueuePredict");
if (!chords) fail("src/build-chords.js did not define window.__cdcBuildChords");

let failed = 0;

function check(name, ok, got) {
  if (ok) {
    console.log(`  ok   ${name}`);
    return;
  }
  failed++;
  console.log(`  FAIL ${name}${got === undefined ? "" : ` — got ${JSON.stringify(got)}`}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** A queue as the client would read it, in the shape `readQueue` produces. */
function queue(status, items, extra) {
  return {
    type: "Vehicles",
    status,
    maxSize: 30,
    maxItemQuantity: 99,
    currentSize: items.reduce((n, item) => n + item.quantity, 0),
    items: items.map((item) => ({
      name: item.name,
      quantity: item.quantity,
      progress: item.progress || 0,
      rules: { name: item.name },
    })),
    ...extra,
  };
}

/** A clock the test drives, so a deadline can be crossed without waiting. */
function clock(start) {
  let at = start;
  return { now: () => at, tick: (ms) => (at += ms) };
}

/** What the overlay would decide about this object, given a predicted queue. */
function decide(at, name, want) {
  return chords.chordCancelAction(
    {
      status: at.status,
      queued: predict.quantityOf(at, name),
      isFirst: predict.isFirst(at, name),
    },
    want
  );
}

console.log("the algebra");

{
  const at = predict.applyOp(queue("idle", []), { op: "add", name: "GRIZZLY", quantity: 3 });
  check(
    "an add into an empty queue puts it there and starts the queue",
    at.status === "active" && at.items.length === 1 && at.items[0].quantity === 3 && at.currentSize === 3,
    at
  );
}

{
  const at = predict.applyOp(queue("active", [{ name: "GRIZZLY", quantity: 2 }]), {
    op: "add",
    name: "GRIZZLY",
    quantity: 4,
  });
  check(
    "a second add joins the entry that already holds it rather than opening another",
    at.items.length === 1 && at.items[0].quantity === 6,
    at.items
  );
}

{
  const at = predict.applyOp(queue("onhold", [{ name: "GRIZZLY", quantity: 1 }]), {
    op: "add",
    name: "IFV",
    quantity: 1,
  });
  check("an add does not resume a held queue — that is the left click's job", at.status === "onhold", at.status);
}

// `AddNext` — the Ctrl on a cameo the overlay reaches with a key since 0.70.0.
// Written as the shapes `insertAfterFirst` produces rather than as "it went
// second", because the head split is the part a naive algebra drops and the
// part `signature` would then read as the client contradicting us.

{
  const at = predict.applyOp(queue("idle", []), { op: "addnext", name: "GRIZZLY", quantity: 2 });
  check(
    "next into an empty queue is just an add — the client falls through to push",
    at.status === "active" && at.items.length === 1 && at.items[0].quantity === 2 && at.currentSize === 2,
    at
  );
}

{
  const at = predict.applyOp(queue("active", [{ name: "RHINO", quantity: 5, progress: 0.4 }]), {
    op: "addnext",
    name: "GRIZZLY",
    quantity: 1,
  });
  check(
    "next splits the head: the one being paid for keeps its place and its progress",
    at.items.length === 3 &&
      at.items[0].name === "RHINO" &&
      at.items[0].quantity === 1 &&
      at.items[0].progress === 0.4 &&
      at.items[1].name === "GRIZZLY" &&
      at.items[2].name === "RHINO" &&
      at.items[2].quantity === 4 &&
      at.items[2].progress === 0 &&
      at.currentSize === 6,
    at.items
  );
}

{
  const at = predict.applyOp(queue("active", [{ name: "RHINO", quantity: 5 }]), {
    op: "addnext",
    name: "RHINO",
    quantity: 1,
  });
  check(
    "next does not merge by name the way an add does — one object, three entries",
    at.items.length === 3 && at.items.every((item) => item.name === "RHINO") && at.currentSize === 6,
    at.items
  );
}

{
  const at = predict.applyOp(
    queue("active", [
      { name: "RHINO", quantity: 1 },
      { name: "IFV", quantity: 2 },
    ]),
    { op: "addnext", name: "GRIZZLY", quantity: 1 }
  );
  check(
    "a head of one leaves no remainder behind, and what was queued after it stays after it",
    at.items.length === 3 && at.items[1].name === "GRIZZLY" && at.items[2].name === "IFV",
    at.items
  );
}

{
  // The round trip that matters: what we predicted has to be what the client
  // then reads, or the ledger never retires the op and reports it lost.
  const time = clock(1000);
  const lost = [];
  const ledger = predict.createLedger({ now: time.now, onLost: (l) => lost.push(l) });
  const raw = queue("active", [{ name: "RHINO", quantity: 5, progress: 0.4 }]);
  const before = ledger.predict(raw);
  ledger.record(raw.type, { op: "addnext", name: "GRIZZLY", quantity: 1, rules: { name: "GRIZZLY" } }, before);
  const applied = queue("active", [
    { name: "RHINO", quantity: 1, progress: 0.4 },
    { name: "GRIZZLY", quantity: 1 },
    { name: "RHINO", quantity: 4 },
  ]);
  ledger.predict(applied);
  check(
    "and the client applying it retires the op rather than losing it",
    !ledger.waiting().length && !lost.length,
    { waiting: ledger.waiting(), lost: lost.length }
  );
}

{
  const at = predict.applyOp(queue("active", [{ name: "GRIZZLY", quantity: 3 }]), {
    op: "pause",
  });
  check(
    "pause is a property of the queue, so it moves the status and not the items",
    at.status === "onhold" && at.items[0].quantity === 3,
    at
  );
}

{
  const at = predict.applyOp(queue("onhold", [{ name: "GRIZZLY", quantity: 1 }]), {
    op: "cancel",
    name: "GRIZZLY",
    quantity: 1,
  });
  check(
    "the last of a held object leaving takes the hold with it — there is nothing left to hold",
    at.status === "idle" && !at.items.length && at.currentSize === 0,
    at
  );
}

{
  const at = predict.applyOp(
    queue("active", [
      { name: "GRIZZLY", quantity: 2 },
      { name: "IFV", quantity: 1 },
      { name: "GRIZZLY", quantity: 3 },
    ]),
    { op: "cancel", name: "GRIZZLY", quantity: 4 }
  );
  check(
    "a cancel takes the newest first, which is the order a queue gives things up in",
    at.items.length === 2 && at.items[0].quantity === 1 && at.items[1].name === "IFV",
    at.items
  );
}

{
  const before = queue("active", [{ name: "GRIZZLY", quantity: 2 }]);
  predict.applyOp(before, { op: "cancel", name: "GRIZZLY", quantity: 2 });
  check(
    "applying an op never writes through into the reading it was given",
    before.items.length === 1 && before.items[0].quantity === 2,
    before.items
  );
}

{
  const a = queue("active", [{ name: "GRIZZLY", quantity: 2 }], {});
  const b = queue("active", [{ name: "GRIZZLY", quantity: 2 }], {});
  b.items[0].progress = 0.93;
  check(
    "progress is not part of the signature — the trait dispatches one per tick that spends credits",
    predict.signature(a) === predict.signature(b),
    predict.signature(b)
  );
}

console.log("the pair that named the feature");

{
  // Ctrl on a sidebar tab key, twice, faster than the client can answer.
  const time = clock(1000);
  const lost = [];
  const ledger = predict.createLedger({ now: time.now, onLost: (l) => lost.push(l) });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 3, progress: 0.4 }]);

  const first = ledger.predict(raw);
  const act1 = decide(first, "GRIZZLY", 1);
  check("press 1 on a running queue means pause", act1.act === "pause", act1);
  ledger.record(raw.type, { op: "pause", name: "GRIZZLY" }, first);

  // The client has not applied anything yet: same reading, 80ms later.
  time.tick(80);
  const second = ledger.predict(raw);
  const act2 = decide(second, "GRIZZLY", 1);
  check(
    "press 2 inside the lag means cancel, because the prediction already holds the queue",
    act2.act === "cancel" && act2.quantity === 1,
    act2
  );
  check("and the raw reading it was taken from has not moved at all", raw.status === "active", raw.status);
  ledger.record(raw.type, { op: "cancel", name: "GRIZZLY", quantity: 1 }, second);

  // Both actions rode the same turn and land together.
  time.tick(200);
  const landed = queue("onhold", [{ name: "GRIZZLY", quantity: 2, progress: 0.4 }]);
  const after = ledger.predict(landed);
  check(
    "when both land in the one turn both are retired, not one",
    ledger.waiting().length === 0 && after.items[0].quantity === 2 && after.status === "onhold",
    { waiting: ledger.waiting(), items: after.items }
  );
  check("and nothing was reported lost", lost.length === 0, lost);
  check("the wait is measured from the oldest of the batch", ledger.stats().lastMs === 280, ledger.stats());
}

console.log("reconciliation");

{
  const time = clock(0);
  const ledger = predict.createLedger({ now: time.now, onLost: () => {} });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 1 }]);
  const base = ledger.predict(raw);
  ledger.record(raw.type, { op: "add", name: "GRIZZLY", quantity: 1 }, base);

  time.tick(50);
  const still = ledger.predict(raw);
  check(
    "an unchanged reading leaves the prediction standing",
    still.items[0].quantity === 2 && ledger.waiting().length === 1,
    still.items
  );

  time.tick(50);
  const half = ledger.predict(queue("active", [{ name: "GRIZZLY", quantity: 1, progress: 0.7 }]));
  check(
    "a reading that only moved its progress is still the same state, not a contradiction",
    half.items[0].quantity === 2 && ledger.waiting().length === 1,
    half.items
  );
}

{
  // The case the first draft of the reconciler got wrong, and the reason the
  // contradiction branch is gone: a factory finishing a unit inside the few
  // hundred milliseconds an order is in flight is routine, not the client
  // refusing anything.
  const time = clock(0);
  const lost = [];
  const ledger = predict.createLedger({ now: time.now, lostAfterMs: 1000, onLost: (l) => lost.push(l) });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 3 }]);
  ledger.record(raw.type, { op: "add", name: "GRIZZLY", quantity: 1 }, ledger.predict(raw));

  time.tick(120);
  const drifted = ledger.predict(queue("active", [{ name: "GRIZZLY", quantity: 2 }]));
  check(
    "a unit leaving the factory mid-flight re-bases the prediction instead of dropping it",
    drifted.items[0].quantity === 3 && ledger.waiting().length === 1,
    { items: drifted.items, waiting: ledger.waiting() }
  );
  check("and nobody is accused of anything", lost.length === 0, lost);

  time.tick(120);
  const landed = ledger.predict(queue("active", [{ name: "GRIZZLY", quantity: 3 }]));
  check(
    "and the order is still recognised when it lands, on top of the drift",
    ledger.waiting().length === 0 && landed.items[0].quantity === 3,
    { items: landed.items, waiting: ledger.waiting() }
  );

  time.tick(2000);
  ledger.predict(queue("active", [{ name: "GRIZZLY", quantity: 3 }]));
  check("so the deadline never fires for it", lost.length === 0, lost);
}

{
  // Re-basing must not buy a pending action more time, or an order the client
  // refused would never expire on a queue that is doing anything at all.
  const time = clock(0);
  const lost = [];
  const ledger = predict.createLedger({ now: time.now, lostAfterMs: 1000, onLost: (l) => lost.push(l) });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 3 }]);
  ledger.record(raw.type, { op: "add", name: "IFV", quantity: 1, label: "IFV" }, ledger.predict(raw));
  for (let n = 2; n >= 0; n--) {
    time.tick(400);
    ledger.predict(queue("active", [{ name: "GRIZZLY", quantity: n }]));
  }
  check(
    "a refused order still expires while the queue drifts around it",
    ledger.waiting().length === 0 && lost.length === 1 && lost[0].reason === "expired",
    lost
  );
}

{
  // A pause that the player also sent from the sidebar, arriving first.
  const time = clock(0);
  const ledger = predict.createLedger({
    now: time.now,
    lostAfterMs: 1000,
    onLost: () => fail("an op the reading already satisfies is not a loss"),
  });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 2 }]);
  ledger.record(raw.type, { op: "pause", name: "GRIZZLY" }, ledger.predict(raw));

  time.tick(100);
  ledger.predict(queue("onhold", [{ name: "GRIZZLY", quantity: 1 }]));
  check(
    "a pause whose queue is held already has nothing left to predict and goes in silence",
    ledger.waiting().length === 0 && ledger.stats().moot + ledger.stats().confirmed === 1,
    ledger.stats()
  );
  time.tick(2000);
  ledger.predict(queue("onhold", [{ name: "GRIZZLY", quantity: 1 }]));
}

{
  const time = clock(0);
  const lost = [];
  const ledger = predict.createLedger({ now: time.now, lostAfterMs: 1000, onLost: (l) => lost.push(l) });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 1 }]);
  ledger.record(raw.type, { op: "add", name: "GRIZZLY", quantity: 1, label: "Grizzly Tank" }, ledger.predict(raw));

  time.tick(999);
  ledger.predict(raw);
  check("a prediction is not expired one tick early", ledger.waiting().length === 1 && !lost.length, lost);

  time.tick(1);
  const at = ledger.predict(raw);
  check(
    "an order the client dropped in silence expires, since nothing will ever confirm it",
    ledger.waiting().length === 0 && at.items[0].quantity === 1,
    at.items
  );
  check("and is reported as not having stood", lost.length === 1 && lost[0].reason === "expired", lost);
}

{
  const time = clock(0);
  const ledger = predict.createLedger({ now: time.now, lostAfterMs: 1000, onLost: () => {} });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 1 }]);
  ledger.record(raw.type, { op: "add", name: "GRIZZLY", quantity: 1 }, ledger.predict(raw));

  time.tick(900);
  const one = queue("active", [{ name: "GRIZZLY", quantity: 2 }]);
  ledger.predict(one);
  ledger.record(one.type, { op: "add", name: "GRIZZLY", quantity: 1 }, ledger.predict(one));
  time.tick(900);
  const at = ledger.predict(one);
  check(
    "a confirmation restarts the deadline, so a long chain never expires under its own age",
    ledger.waiting().length === 1 && at.items[0].quantity === 3,
    { waiting: ledger.waiting(), items: at.items }
  );
}

{
  const ledger = predict.createLedger({ onLost: () => fail("a reset must not report anything") });
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 1 }]);
  ledger.record(raw.type, { op: "add", name: "GRIZZLY", quantity: 1 }, ledger.predict(raw));
  check("a queue with something in flight is named by waiting()", ledger.waiting().length === 1, ledger.waiting());
  check("and due() says when to come back for it", typeof ledger.due() === "number", ledger.due());
  ledger.reset();
  check("a match that ended forgets its predictions in silence", ledger.due() === null, ledger.due());
}

{
  const ledger = predict.createLedger({});
  const raw = queue("active", [{ name: "GRIZZLY", quantity: 1 }]);
  const at = ledger.predict(raw);
  check("a ledger with nothing in it hands the reading straight back", predict.signature(at) === predict.signature(raw));
  check("and never hands back the client's own object", at !== raw && at.items[0] !== raw.items[0]);
}

console.log("the queue a section's cancel key lands on");

{
  // The Units tab feeds three queues, and two of them are running.
  const candidates = [
    { type: "Vehicles", status: "onhold", queued: 3 },
    { type: "Ships", status: "active", queued: 2 },
  ];
  check(
    "without a preference the pause and the cancel land on different queues, which is the defect",
    chords.chordCancelQueue(candidates).type === "Ships",
    chords.chordCancelQueue(candidates)
  );
  check(
    "the queue the last press acted on wins, so the pair stays a pair",
    chords.chordCancelQueue(candidates, "Vehicles").type === "Vehicles",
    chords.chordCancelQueue(candidates, "Vehicles")
  );
  check(
    "a preference for a queue that has since emptied is ignored rather than obeyed",
    chords.chordCancelQueue(
      [
        { type: "Vehicles", status: "idle", queued: 0 },
        { type: "Ships", status: "active", queued: 2 },
      ],
      "Vehicles"
    ).type === "Ships"
  );
}

console.log(failed ? `\n${failed} failed` : "\nall good");
process.exit(failed ? 1 : 0);
