import { test } from "node:test";
import assert from "node:assert/strict";
import { formatOctal, formatSymbolic, parseSymbolic } from "../src/backend";

test("symbolic permissions round-trip with octal", () => {
  assert.equal(parseSymbolic("-rw-r--r--"), 0o644);
  assert.equal(parseSymbolic("drwxr-xr-x"), 0o755);
  assert.equal(parseSymbolic("-rwsr-xr-x"), 0o4755);
  assert.equal(parseSymbolic("drwxrwxrwt"), 0o1777);
  assert.equal(parseSymbolic("nonsense"), undefined);
  for (const m of [0o644, 0o755, 0o600, 0o4755, 0o2775, 0o1777, 0o000]) assert.equal(parseSymbolic(formatSymbolic(m)), m);
  assert.equal(formatOctal(0o644), "644");
  assert.equal(formatOctal(0o4755), "4755");
  assert.equal(formatOctal(0o7), "007");
});
