const { test } = require("node:test");
const assert = require("node:assert/strict");

test("activity batches a burst without losing records or their order", async (t) => {
  const { createActivityStore } = await import("../src/activity-store.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createActivityStore();
  const updates = [];
  const unsubscribe = store.subscribe(() => updates.push(store.getSnapshot()));
  for (const event of ["started", "progress", "completed"]) {
    store.append({ at: "2026-09-14T00:00:00Z", level: "info", event, detail: {} });
  }
  assert.equal(updates.length, 0);
  t.mock.timers.tick(80);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].map(record => record.event), ["started", "progress", "completed"]);
  unsubscribe();
});

test("activity restores recent history and retains the latest 300 while offscreen", async () => {
  const { createActivityStore } = await import("../src/activity-store.ts");
  const store = createActivityStore();
  const record = event => ({ at: "2026-09-14T00:00:00Z", level: "info", event, detail: {} });
  store.initialize([record("history")]);
  const previous = store.getSnapshot();
  for (let index = 0; index < 301; index++) store.append(record(`event-${index}`));
  const current = store.getSnapshot();
  assert.equal(current.length, 300);
  assert.equal(current[0].event, "event-1");
  assert.equal(current.at(-1).event, "event-300");
  assert.equal(previous[0].event, "history");
  assert.strictEqual(store.getSnapshot(), current);
  const unsubscribe = store.subscribe(() => assert.fail("no pending offscreen notifications"));
  assert.strictEqual(store.getSnapshot(), current);
  unsubscribe();
});

test("leaving Activity cancels pending paints but preserves events for the next visit", async (t) => {
  const { createActivityStore } = await import("../src/activity-store.ts");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = createActivityStore();
  const unsubscribe = store.subscribe(() => assert.fail("a closed view must not update"));
  store.append({ at: "2026-09-14T00:00:00Z", level: "warning", event: "pending", detail: {} });
  unsubscribe();
  t.mock.timers.tick(1000);
  assert.equal(store.getSnapshot()[0].event, "pending");
  const updates = [];
  const stop = store.subscribe(() => updates.push(store.getSnapshot()));
  store.append({ at: "2026-09-14T00:00:01Z", level: "info", event: "resumed", detail: {} });
  t.mock.timers.tick(80);
  assert.deepEqual(updates[0].map(record => record.event), ["pending", "resumed"]);
  stop();
});
