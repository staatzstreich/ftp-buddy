import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import FtpSrv from "ftp-srv";
import bunyan from "bunyan";
import { HostKeys } from "../src/backend";
import { FtpBackend } from "../src/ftp";

let server: FtpSrv;
let root: string;
let certDir: string;
let port: number;
let logins = 0;

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

before(async () => {
  root = mkdtempSync(join(tmpdir(), "ftpb-tls-root-"));
  certDir = mkdtempSync(join(tmpdir(), "ftpb-tls-cert-"));
  // A self-signed certificate: exactly what Node does not trust on its own.
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "k.pem"), "-out", join(certDir, "c.pem"), "-days", "2", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
  port = await freePort();
  server = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    pasv_url: "127.0.0.1",
    pasv_min: 44000 + (port % 1000),
    pasv_max: 45000 + (port % 1000),
    anonymous: false,
    tls: { key: readFileSync(join(certDir, "k.pem")), cert: readFileSync(join(certDir, "c.pem")) },
    log: bunyan.createLogger({ name: "ftps-test", level: 60 }),
  });
  server.on("login", (_d: unknown, ok: (r: { root: string }) => void) => {
    logins++;
    ok({ root });
  });
  await server.listen();
});

after(async () => {
  await server.close();
  for (const d of [root, certDir]) rmSync(d, { recursive: true, force: true });
});

const profile = () => ({ name: "t", protocol: "ftps" as const, host: "127.0.0.1", port, username: "u" });

/** Remembers what it was asked and answers as told. */
class Asked implements HostKeys {
  asked: [string, string][] = [];
  known = new Map<string, string>();
  constructor(private answer: boolean) {}
  async verify(server: string, fingerprint: string) {
    this.asked.push([server, fingerprint]);
    const have = this.known.get(server);
    if (have) return have === fingerprint;
    if (this.answer) this.known.set(server, fingerprint);
    return this.answer;
  }
}

test("ftps: an untrusted certificate is refused when nobody can be asked", async () => {
  const before = logins;
  const b = new FtpBackend(profile(), "p");
  await assert.rejects(b.home(), /Zertifikat nicht vertrauenswürdig/);
  await b.close();
  assert.equal(logins, before, "no login may happen over an untrusted channel");
});

test("ftps: a confirmed certificate works, for the control and the data connection", async () => {
  const keys = new Asked(true);
  const lines: string[] = [];
  const b = new FtpBackend(profile(), "p", keys, (l) => lines.push(l));
  try {
    assert.ok((await b.home()).startsWith("/"));
    await b.write("/tls.txt", Buffer.from("verschlüsselt"));
    assert.equal(Buffer.from(await b.read("/tls.txt")).toString(), "verschlüsselt");
    assert.equal((await b.list("/")).some((e) => e.name === "tls.txt"), true);
    await b.remove("/tls.txt", false);
  } finally {
    await b.close();
  }
  assert.equal(keys.asked.length, 1, "asked once, not for every data connection");
  assert.match(keys.asked[0]?.[0] ?? "", /^ftps:127\.0\.0\.1:/);
  assert.ok(lines.some((l) => l.includes("USER u")), "the dialogue is logged");
  assert.ok(!lines.some((l) => l.includes("PASS p")), "the password is not");
});

test("ftps: a refused certificate stops before any login", async () => {
  const before = logins;
  const b = new FtpBackend(profile(), "p", new Asked(false));
  await assert.rejects(b.home(), /nicht vertraut/);
  await b.close();
  assert.equal(logins, before);
});

test("ftps: a certificate that differs from the remembered one is refused", async () => {
  const keys = new Asked(true);
  keys.known.set(`ftps:127.0.0.1:${port}`, "SHA256:ein-anderes-zertifikat");
  const b = new FtpBackend(profile(), "p", keys);
  await assert.rejects(b.home(), /nicht vertraut/);
  await b.close();
});
