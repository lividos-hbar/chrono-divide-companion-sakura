/**
 * What the overlay believes a production queue holds, while the client is still
 * being told.
 *
 * Chrono Divide is lockstep: `CombatantUi#pushAction` puts an action on the same
 * `actionQueue` the mouse feeds, the turn manager sends it, and
 * `UpdateQueueAction#process` runs it some network turns later — on every
 * client, at the same tick. Until then the local `ProductionQueue` has not
 * moved.
 *
 * That is invisible for a mouse, because a cameo click is decided by the player
 * looking at the sidebar. It is not invisible for us: every overlay decision —
 * pause or cancel, order or place, how many fit — is taken by *reading* the
 * queue, so inside that window the overlay decides against a state it has
 * already changed. The reported shape of it is a cancel key pressed twice
 * quickly: both presses read `active, at the head`, so both send Pause, the
 * cancel row is never reached, and the second press looks swallowed.
 *
 * So the overlay keeps a ledger of what it has pushed and not yet seen applied,
 * and lays it over the client's own reading. Everything downstream — the
 * decisions, the chord tiles, the production panel — reads the result.
 *
 * Nothing in here touches the client, the DOM or storage: it is a state algebra
 * over plain snapshots, which is what lets `scripts/check-predict.mjs` exercise
 * the reconciliation on hand-written ones. The one concession is `rules`, which
 * an item carries opaquely so the panel can still draw a cameo for an item that
 * exists only in the prediction; this file never looks inside it.
 *
 * A snapshot is one queue:
 *
 *   { type, status: "idle"|"active"|"onhold"|"ready",
 *     maxSize, maxItemQuantity, currentSize,
 *     items: [ { name, quantity, progress, rules } ] }
 *
 * `status` is `QueueStatus`'s own name lowered, the same idiom `queueStateFor`
 * already used, so the algebra can be tested without the client's enum.
 */
(() => {
  "use strict";

  /**
   * How long a pushed action may go unseen before we call it lost.
   *
   * This is a **backstop, not the expected lag.** An action that lands is
   * retired by positive confirmation — the client's own state moving to what we
   * predicted — which happens as soon as the turn carrying it executes. The
   * deadline is only for the other case: `UpdateQueueAction#process` re-checks
   * `isAvailableForProduction` as it runs, so an order that stopped being legal
   * between the press and the turn is dropped **silently**, leaving no state
   * change to confirm against and nothing else to tell us it is never coming.
   *
   * Which is why this is generous. Expiring early is the worse error of the two:
   * it retracts a prediction that was still in flight and tells the player an
   * order did not stand when it was about to. Expiring late only means the note
   * about a genuinely dropped order arrives a beat after the tile has snapped
   * back, and a snapped-back tile is already the honest answer.
   *
   * The real comms lag is `GameTurnManager`'s and readable only in a running
   * match, so this is not derived from it. `stats()` records what confirmations
   * actually took, so the number can be replaced with a measured one rather than
   * a second guess.
   */
  const LOST_AFTER_MS = 1200;

  /** The statuses a queue can be in, as `QueueStatus`'s names lowered. */
  const IDLE = "idle";
  const ACTIVE = "active";
  const ONHOLD = "onhold";
  const READY = "ready";

  /**
   * A snapshot of our own, so that applying an op cannot write through into the
   * client's objects. `rules` is carried by reference on purpose: it is the
   * client's rules object, opaque here, and copying it would be both pointless
   * and wrong.
   */
  function copy(snapshot) {
    return {
      type: snapshot.type,
      status: snapshot.status || IDLE,
      maxSize: snapshot.maxSize || 0,
      maxItemQuantity: snapshot.maxItemQuantity || 0,
      currentSize: snapshot.currentSize || 0,
      items: (snapshot.items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity || 0,
        progress: item.progress || 0,
        rules: item.rules,
      })),
    };
  }

  /**
   * What two readings have to agree on for one to be the other.
   *
   * `progress` is deliberately absent: the production trait dispatches an update
   * on **every tick that spends credits**, so a signature carrying progress
   * would differ from itself between one read and the next and every prediction
   * would read as contradicted within a frame. What an `UpdateQueue` action can
   * change is the item list and the status, and those are exactly what is here.
   */
  function signature(snapshot) {
    return (
      snapshot.status +
      "|" +
      snapshot.items.map((item) => `${item.name}:${item.quantity}`).join(",")
    );
  }

  /** Every entry for an object, in queue order — the client allows more than one. */
  function itemsNamed(snapshot, name) {
    return snapshot.items.filter((item) => item.name === name);
  }

  /** How many of an object the queue holds, across however many entries hold it. */
  function quantityOf(snapshot, name) {
    return itemsNamed(snapshot, name).reduce((n, item) => n + item.quantity, 0);
  }

  /** Whether an object is the one at the head, which is the one being paid for. */
  function isFirst(snapshot, name) {
    return !!snapshot.items.length && snapshot.items[0].name === name;
  }

  /**
   * One `UpdateQueue` action, carried out on a snapshot — the client's own
   * `ProductionQueue` semantics, as far as they are observable from outside.
   *
   * Five ops, matching `UpdateType`'s `Add`, `AddNext`, `Cancel`, `Pause` and
   * `Resume`. **Placement is not an op at all**: a ready structure leaves its
   * queue when the player clicks the ground, which is the client's own placement
   * mode rather than an action we pushed, so there is nothing of ours to be
   * waiting on.
   *
   * Three behaviours worth stating, because they are the ones a naive algebra
   * gets wrong:
   *
   * - **Pause is a property of the queue**, not of the item, so it moves
   *   `status` and never touches `items`. `queueCancel`'s doc says the same
   *   thing about the client.
   * - **An Add does not resume a held queue.** A paused head is resumed by the
   *   left click, which is `queueBuild`'s own branch and sends `Resume`; an Add
   *   arriving at a held queue joins the queue and leaves it held.
   * - **`AddNext` is not "to the front".** `ProductionQueue#insertAfterFirst`
   *   cuts the head entry to one, puts the new entry behind it, and re-pushes
   *   the rest of the head entry behind that — so the item being paid for keeps
   *   its progress and its place, and the split is visible: `Rhino ×5` plus a
   *   next Grizzly is `Rhino ×1, Grizzly ×1, Rhino ×4`. Entries are **not**
   *   merged by name here, unlike `Add`, so a next order for the head object
   *   itself really does give three entries of it. Both facts matter because
   *   `signature` is per entry: an algebra that merged, or that inserted at
   *   index 0, would read every one of these as the client contradicting it.
   */
  function applyOp(snapshot, op) {
    const out = copy(snapshot);
    if (op.op === "pause") {
      if (out.status === ACTIVE) out.status = ONHOLD;
      return out;
    }
    if (op.op === "resume") {
      if (out.status === ONHOLD) out.status = ACTIVE;
      return out;
    }
    if (op.op === "add") {
      const quantity = op.quantity || 0;
      if (quantity <= 0) return out;
      // Into the first entry that already holds it, because `maxItemQuantity`
      // caps an object per queue rather than per entry — a second entry for the
      // same object would let the prediction exceed a cap the client enforces.
      const mine = out.items.find((item) => item.name === op.name);
      if (mine) mine.quantity += quantity;
      else out.items.push({ name: op.name, quantity, progress: 0, rules: op.rules });
      out.currentSize += quantity;
      if (out.status === IDLE) out.status = ACTIVE;
      return out;
    }
    if (op.op === "addnext") {
      const quantity = op.quantity || 0;
      if (quantity <= 0) return out;
      const entry = { name: op.name, quantity, progress: 0, rules: op.rules };
      // An empty queue has no head to go behind, and the client says the same:
      // `insertAfterFirst` falls through to `push` when `items` is empty.
      if (!out.items.length) {
        out.items.push(entry);
      } else {
        const head = out.items[0];
        // `Math.max(0, n - 1)` in the client — the one being paid for stays, at
        // its own progress, and only the rest of its stack is moved down.
        const rest = Math.max(0, head.quantity - 1);
        const tail = out.items.slice(1);
        head.quantity = 1;
        out.items = [head, entry];
        if (rest > 0) {
          out.items.push({ name: head.name, quantity: rest, progress: 0, rules: head.rules });
        }
        out.items.push(...tail);
      }
      out.currentSize += quantity;
      if (out.status === IDLE) out.status = ACTIVE;
      return out;
    }
    if (op.op === "cancel") {
      let left = op.quantity || 0;
      if (left <= 0) return out;
      // From the back, which is the order a queue gives things up in: the head
      // is the one being paid for and the client takes the newest first.
      for (let i = out.items.length - 1; i >= 0 && left > 0; i--) {
        const item = out.items[i];
        if (item.name !== op.name) continue;
        const off = Math.min(item.quantity, left);
        item.quantity -= off;
        out.currentSize -= off;
        left -= off;
        if (item.quantity <= 0) out.items.splice(i, 1);
      }
      if (out.currentSize < 0) out.currentSize = 0;
      // A queue with nothing left in it is idle, whatever it was before — and
      // that includes a held one, since there is no longer anything to hold.
      if (!out.items.length) out.status = IDLE;
      return out;
    }
    return out;
  }

  /** Every op in order, over one snapshot. */
  function applyAll(snapshot, ops) {
    return ops.reduce((at, entry) => applyOp(at, entry.op ? entry.op : entry), snapshot);
  }

  /**
   * The ledger: what we have pushed at each queue and not yet seen applied.
   *
   * One FIFO per queue, and the FIFO is the whole reason the reconciliation can
   * be exact rather than heuristic. Actions on one queue reach
   * `UpdateQueueAction#process` in the order they were pushed, so the pending
   * list can only ever be consumed from the front — which means the client's
   * current reading, if it moved at all, is `base` with some prefix of the
   * pending list applied to it. Finding that prefix is the whole algorithm.
   *
   * @param {{now?: () => number, lostAfterMs?: number,
   *          onLost?: (loss: {type: any, ops: object[], reason: "expired"}) => void}} opts
   */
  function createLedger(opts) {
    const options = opts || {};
    const now = options.now || (() => Date.now());
    const lostAfterMs = options.lostAfterMs || LOST_AFTER_MS;
    const onLost = options.onLost || (() => {});

    /** queue type -> { base: snapshot|null, due: number, pending: [{op, at}] } */
    const entries = new Map();

    /**
     * What confirmations have actually taken, so `LOST_AFTER_MS` can be replaced
     * by a measurement instead of a second guess. Reported by `__cdc.build()`.
     */
    const stats = { confirmed: 0, moot: 0, lost: 0, lastMs: 0, worstMs: 0 };

    function entryFor(type) {
      let entry = entries.get(type);
      if (!entry) {
        entry = { base: null, due: 0, pending: [] };
        entries.set(type, entry);
      }
      return entry;
    }

    /**
     * Record an action we have just pushed.
     *
     * `raw` — the client's reading as it stands *before* the action lands — is
     * taken here rather than at the next read, and that is not tidiness. The
     * next read may be a keypress a second later, by which time the action has
     * landed and the client's reading is the post-action one; a base stamped
     * then would have the action already in it and the prediction would apply it
     * a second time.
     *
     * Only the first op of a batch stamps the base. The pause-then-cancel a
     * shifted key sends in one press is two records against one reading, and the
     * second must not move the base out from under the first.
     */
    function record(type, op, raw) {
      const entry = entryFor(type);
      if (!entry.pending.length) {
        entry.base = copy(raw);
        entry.due = now() + lostAfterMs;
      }
      entry.pending.push({ op, at: now() });
    }

    /**
     * Bring the ledger in line with what the client now says. Four steps, in
     * this order.
     *
     * **1 — retire what landed.** The reading equals `base` with the first `k`
     * ops applied. `k` is taken as the *largest* prefix that matches, not the
     * first: two presses inside one lag window are sent in the same turn and
     * land together, and retiring one at a time would leave the second still
     * predicted on top of a reading that already contains it. Where two
     * prefixes share a signature — an add and its own cancel — the longer one
     * is still safe, because the two states are identical and nothing is drawn
     * differently.
     *
     * **2 — retire what has become moot.** An op the current reading already
     * satisfies has nothing left to predict: a Pause whose queue is held
     * already, a Cancel of something no longer there. That is neither a landing
     * nor a failure, so it goes in silence. It matters because the alternative
     * is accusing the client of dropping an order whose effect is plainly
     * there.
     *
     * **3 — re-base when the queue moved on its own.** A reading that is
     * neither the base nor anything we predicted is the ordinary business of a
     * match: a unit left the factory, a building finished, the player clicked a
     * cameo themselves. The pending ops are still in flight and still apply, so
     * the new reading becomes the base and the prediction goes on top of it.
     *
     * This step is the correction to the first draft of this file, which read
     * exactly that case as the client contradicting us and dropped the
     * prediction with a note. It is wrong often rather than rarely — a factory
     * finishing a unit inside the few hundred milliseconds an order is in
     * flight is routine — and it would have spent the whole credibility of the
     * feature on a lie: a tile snapping back, and a note blaming the client for
     * an order that was about to arrive.
     *
     * **4 — the deadline.** Nothing else will ever tell us about an order the
     * client refused: `UpdateQueueAction#process` re-checks
     * `isAvailableForProduction` as it runs and drops a stale one in silence.
     * So an op that has neither landed nor gone moot within `lostAfterMs` is
     * called lost, and said aloud. A refusal is therefore always reported late
     * rather than at once, which is the price of never reporting one wrongly.
     */
    function reconcile(entry, raw) {
      if (!entry.pending.length) {
        entry.base = null;
        return;
      }
      const at = now();
      const rawSig = signature(raw);

      let landed = 0;
      let step = entry.base;
      for (let k = 0; k < entry.pending.length; k++) {
        step = applyOp(step, entry.pending[k].op);
        if (signature(step) === rawSig) landed = k + 1;
      }
      if (landed) {
        const done = entry.pending.splice(0, landed);
        stats.confirmed += done.length;
        // The oldest of the batch is the one whose wait says what the lag is:
        // the rest were pushed after it and rode the same turn.
        stats.lastMs = at - done[0].at;
        if (stats.lastMs > stats.worstMs) stats.worstMs = stats.lastMs;
        entry.base = copy(raw);
        entry.due = at + lostAfterMs;
      }

      let over = raw;
      while (entry.pending.length) {
        const next = applyOp(over, entry.pending[0].op);
        if (signature(next) !== signature(over)) break;
        over = next;
        entry.pending.shift();
        stats.moot++;
      }

      if (!entry.pending.length) {
        entry.base = null;
        return;
      }

      // The queue moved for reasons of its own; what we pushed is still coming.
      // The deadline is deliberately left where it was — re-basing is not news
      // about our own action and must not buy it more time.
      if (rawSig !== signature(entry.base)) entry.base = copy(raw);

      if (at >= entry.due) {
        const ops = entry.pending.splice(0).map((p) => p.op);
        entry.base = null;
        stats.lost += ops.length;
        onLost({ type: raw.type, ops, reason: "expired" });
      }
    }

    /**
     * What the queue holds as far as the overlay is concerned: the client's own
     * reading, reconciled, with whatever is still in flight laid over it.
     *
     * Called on every read — a decision, a tile repaint, a panel row — so the
     * reconciliation is driven by use rather than by a clock. With nothing
     * pending it is a copy and nothing else.
     */
    function predict(raw) {
      const entry = entries.get(raw.type);
      if (!entry) return copy(raw);
      reconcile(entry, raw);
      if (!entry.pending.length) return copy(raw);
      return applyAll(copy(raw), entry.pending);
    }

    /** The queue types with something in flight — what a sweep has to read. */
    function waiting() {
      const out = [];
      for (const [type, entry] of entries) if (entry.pending.length) out.push(type);
      return out;
    }

    /**
     * When the earliest pending batch stops being worth waiting for, so a caller
     * with nothing on screen can still arm one timer and let a silently dropped
     * order be noticed. Null when nothing is pending.
     */
    function due() {
      let soonest = null;
      for (const entry of entries.values()) {
        if (!entry.pending.length) continue;
        if (soonest === null || entry.due < soonest) soonest = entry.due;
      }
      return soonest;
    }

    /**
     * Forget everything, without a word.
     *
     * For the end of a match: the queues these predictions were about have gone
     * with the `CombatantUi` that owned them, so they were neither confirmed nor
     * dropped by the client and saying either would be a lie.
     */
    function reset() {
      entries.clear();
    }

    return { record, predict, waiting, due, reset, stats: () => ({ ...stats }) };
  }

  window.__cdcQueuePredict = {
    createLedger,
    applyOp,
    applyAll,
    signature,
    copy,
    itemsNamed,
    quantityOf,
    isFirst,
    LOST_AFTER_MS,
    IDLE,
    ACTIVE,
    ONHOLD,
    READY,
  };
})();
