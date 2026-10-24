import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { toLocal, toRemote } from "../src/mapping";

const L = "/Users/m/proj";
const R = "/web/lab";

test("mapping: files below the local folder go to the same place below the remote folder", () => {
  assert.equal(toRemote(L, R, "/Users/m/proj/css/main.css"), "/web/lab/css/main.css");
  assert.equal(toRemote(L, R, "/Users/m/proj"), "/web/lab");
  assert.equal(toRemote(L, "/", "/Users/m/proj/a"), "/a");
  assert.equal(toRemote(L, R + "/", "/Users/m/proj/a"), "/web/lab/a");
});

test("mapping: paths outside the local folder are not mapped", () => {
  assert.equal(toRemote(L, R, "/Users/m/other/x"), undefined);
  assert.equal(toRemote(L, R, "/Users/m/proj-2/x"), undefined);
  assert.equal(toRemote(L, R, "/Users/m/proj/../secret"), undefined);
});

test("mapping: the way back mirrors the way there", () => {
  assert.equal(toLocal(L, R, "/web/lab/css/main.css"), "/Users/m/proj/css/main.css");
  assert.equal(toLocal(L, R, "/web/lab"), "/Users/m/proj");
  assert.equal(toLocal(L, "/", "/a/b"), "/Users/m/proj/a/b");
  assert.equal(toLocal(L, R, "/web/lab-2/x"), undefined);
  assert.equal(toLocal(L, R, "/other/x"), undefined);
});

test("mapping: ~ is the home folder", () => {
  assert.equal(toRemote("~/proj", R, `${homedir()}/proj/x`), "/web/lab/x");
  assert.equal(toLocal("~/proj", R, "/web/lab/x"), `${homedir()}/proj/x`);
});
