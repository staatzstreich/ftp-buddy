import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AddressInfo, createServer } from "node:net";
import FtpSrv from "ftp-srv";
import bunyan from "bunyan";
import { FtpBackend } from "../src/ftp";
import { contract } from "./contract";

let server: FtpSrv;
let root: string;
let port: number;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

before(async () => {
  root = mkdtempSync(join(tmpdir(), "craft-ftp-"));
  port = await freePort();
  server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: "127.0.0.1",
    pasv_min: 40000 + (port % 1000),
    pasv_max: 41000 + (port % 1000),
    anonymous: false,
    log: bunyan.createLogger({ name: "ftp-test", level: 60 }),
  });
  server.on("login", ({ username, password }: { username: string; password: string }, resolve: Function, reject: Function) =>
    username === "tester" && password === "secret" ? resolve({ root }) : reject(new Error("bad login")),
  );
  await server.listen();
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

const backend = (password = "secret") =>
  new FtpBackend({ name: "t", protocol: "ftp", host: "127.0.0.1", port, username: "tester" }, password);

test("ftp: read, write, list, rename, delete keep bytes exact", async () => {
  const b = backend();
  try {
    await contract(b, "/");
  } finally {
    await b.close();
  }
});

test("ftp: a wrong password is reported, not retried forever", async () => {
  const b = backend("wrong");
  await assert.rejects(b.home());
  await b.close();
});

test("ftp: a burst of stat calls works and a write is visible to the next stat", async () => {
  const b = backend();
  try {
    await b.write("/burst-a.txt", Buffer.from("a"));
    const sizes = await Promise.all(Array.from({ length: 20 }, () => b.stat("/burst-a.txt")));
    assert.ok(sizes.every((e) => e?.size === 1));
    assert.equal(await b.stat("/burst-b.txt"), undefined);
    await b.write("/burst-b.txt", Buffer.from("bb"));
    assert.equal((await b.stat("/burst-b.txt"))?.size, 2);
    await b.remove("/burst-a.txt", false);
    await b.remove("/burst-b.txt", false);
    assert.equal(await b.stat("/burst-a.txt", true), undefined);
  } finally {
    await b.close();
  }
});
