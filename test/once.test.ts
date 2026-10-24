import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "../src/backend";

test("once: a burst of callers creates the value a single time", async () => {
  const cache = new Map<string, Promise<number>>();
  let made = 0;
  const create = async () => {
    made++;
    await new Promise((r) => setTimeout(r, 20));
    return 7;
  };
  const results = await Promise.all(Array.from({ length: 14 }, () => once(cache, "k", create)));
  assert.deepEqual(results, Array(14).fill(7));
  assert.equal(made, 1);
});

test("once: a failed creation is retried by the next caller", async () => {
  const cache = new Map<string, Promise<number>>();
  await assert.rejects(once(cache, "k", async () => Promise.reject(new Error("no"))));
  assert.equal(await once(cache, "k", async () => 1), 1);
});
