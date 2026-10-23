import assert from "node:assert/strict";
import { Backend, RemoteError } from "../src/backend";

const text = (b: Uint8Array) => Buffer.from(b).toString("utf8");

/** What every protocol must do the same way. `dir` is a folder the backend can use. */
export async function contract(b: Backend, dir: string) {
  assert.ok((await b.home()).startsWith("/"));

  await b.write(`${dir}/hello.txt`, Buffer.from("hello remote\n"));
  assert.equal(text(await b.read(`${dir}/hello.txt`)), "hello remote\n");

  // Bytes must survive unchanged: umlauts, CRLF, and binary data with every byte value.
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  await b.write(`${dir}/all.bin`, binary);
  assert.deepEqual(Buffer.from(await b.read(`${dir}/all.bin`)), binary);
  await b.write(`${dir}/crlf.txt`, Buffer.from("Grüße\r\nzwei\r\n"));
  assert.equal(text(await b.read(`${dir}/crlf.txt`)), "Grüße\r\nzwei\r\n");

  // Overwrite with something shorter.
  await b.write(`${dir}/hello.txt`, Buffer.from("x"));
  assert.equal(text(await b.read(`${dir}/hello.txt`)), "x");

  await b.mkdir(`${dir}/sub`);
  const names = new Map((await b.list(dir)).map((e) => [e.name, e]));
  assert.equal(names.get("sub")?.kind, "dir");
  assert.equal(names.get("hello.txt")?.kind, "file");
  assert.equal(names.get("all.bin")?.size, 256);

  assert.equal((await b.stat(`${dir}/sub`))?.kind, "dir");
  assert.equal((await b.stat(`${dir}/hello.txt`))?.size, 1);
  assert.equal(await b.stat(`${dir}/missing`), undefined);

  await assert.rejects(b.read(`${dir}/missing`), (e) => e instanceof RemoteError && e.code === "NotFound");

  await b.rename(`${dir}/hello.txt`, `${dir}/sub/moved.txt`);
  assert.equal(await b.stat(`${dir}/hello.txt`), undefined);
  assert.equal(text(await b.read(`${dir}/sub/moved.txt`)), "x");

  await b.remove(`${dir}/sub/moved.txt`, false);
  await b.remove(`${dir}/sub`, true);
  assert.equal(await b.stat(`${dir}/sub`), undefined);
  await b.remove(`${dir}/all.bin`, false);
  await b.remove(`${dir}/crlf.txt`, false);
  assert.deepEqual((await b.list(dir)).map((e) => e.name), []);
}
