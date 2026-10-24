import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { AddressInfo, connect, createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import FtpSrv from "ftp-srv";
import bunyan from "bunyan";
import { Backend } from "../src/backend";
import { FtpBackend } from "../src/ftp";
import { SftpBackend } from "../src/sftp";
import { Decision, Hooks, download, upload } from "../src/transfer";

const SSHD = ["/usr/sbin/sshd", "/usr/bin/sshd"].find(existsSync);
const SFTP_SERVER = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"].find(existsSync);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
const reachable = (p: number) =>
  new Promise<boolean>((resolve) => {
    const c = connect(p, "127.0.0.1");
    c.once("connect", () => (c.destroy(), resolve(true)));
    c.once("error", () => resolve(false));
  });

let ftp: FtpSrv;
let ftpRoot: string;
let ftpPort: number;
let sshd: ChildProcess | undefined;
let sshDir: string;
let sshPort: number;
const cleanup: string[] = [];

before(async () => {
  ftpRoot = mkdtempSync(join(tmpdir(), "craft-tr-ftp-"));
  cleanup.push(ftpRoot);
  ftpPort = await freePort();
  ftp = new FtpSrv({
    url: `ftp://127.0.0.1:${ftpPort}`,
    pasv_url: "127.0.0.1",
    pasv_min: 42000 + (ftpPort % 1000),
    pasv_max: 43000 + (ftpPort % 1000),
    anonymous: false,
    log: bunyan.createLogger({ name: "ftp-test", level: 60 }),
  });
  ftp.on("login", (_d: unknown, ok: (r: { root: string }) => void) => ok({ root: ftpRoot }));
  await ftp.listen();
  if (SSHD && SFTP_SERVER) {
    sshDir = mkdtempSync(join(tmpdir(), "craft-tr-sshd-"));
    cleanup.push(sshDir);
    for (const n of ["host", "id"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(sshDir, n)]);
    sshPort = await freePort();
    writeFileSync(
      join(sshDir, "sshd_config"),
      `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${sshDir}/host\nPidFile ${sshDir}/pid\nAuthorizedKeysFile ${sshDir}/id.pub\n` +
        `PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nSubsystem sftp ${SFTP_SERVER}\n`,
    );
    sshd = spawn(SSHD, ["-D", "-e", "-f", join(sshDir, "sshd_config")], { stdio: "ignore" });
    for (let i = 0; i < 100 && !(await reachable(sshPort)); i++) await new Promise((r) => setTimeout(r, 50));
  }
});

after(async () => {
  await ftp.close();
  sshd?.kill();
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

const hooks = (decision: Decision = "overwrite", cancelAfter = Infinity): Hooks & { asked: string[]; seen: string[] } => {
  const h = {
    asked: [] as string[],
    seen: [] as string[],
    exists: async (p: string) => (h.asked.push(p), decision),
    progress: (_d: number, _t: number | undefined, name: string) => name && h.seen.push(name),
    cancelled: () => h.seen.length >= cancelAfter,
  };
  return h;
};

/** A local tree with nested folders, an empty folder, binary data and an umlaut name. */
function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), "craft-tr-local-"));
  cleanup.push(root);
  const proj = join(root, "projekt");
  mkdirSync(join(proj, "sub", "tief"), { recursive: true });
  mkdirSync(join(proj, "leer"));
  writeFileSync(join(proj, "a.txt"), "hallo\r\n");
  writeFileSync(join(proj, "sub", "größe.bin"), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  writeFileSync(join(proj, "sub", "tief", "c.txt"), "tief");
  return proj;
}

const dump = (dir: string, rel = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? [`${rel}${e.name}/`, ...dump(join(dir, e.name), `${rel}${e.name}/`)] : [`${rel}${e.name}`],
  ).sort();

async function roundTrip(b: Backend, remoteDir: string) {
  const proj = makeTree();
  const up = await upload(b, [proj], remoteDir, hooks());
  assert.deepEqual(up.failed, []);
  assert.equal(up.done, 3);

  const down = mkdtempSync(join(tmpdir(), "craft-tr-down-"));
  cleanup.push(down);
  const res = await download(b, [{ path: `${remoteDir}/projekt`, isDir: true }], down, hooks());
  assert.deepEqual(res.failed, []);
  assert.deepEqual(dump(join(down, "projekt")), dump(proj));
  assert.deepEqual(readFileSync(join(down, "projekt", "sub", "größe.bin")), readFileSync(join(proj, "sub", "größe.bin")));
  assert.equal(readFileSync(join(down, "projekt", "a.txt"), "utf8"), "hallo\r\n");

  // A second upload meets existing files: "skip" leaves them alone, "overwrite" replaces.
  writeFileSync(join(proj, "a.txt"), "neu");
  const h = hooks("skip");
  const again = await upload(b, [proj], remoteDir, h);
  assert.equal(again.skipped, 3);
  assert.equal(again.done, 0);
  assert.equal(h.asked.length, 3);
  assert.equal(Buffer.from(await b.read(`${remoteDir}/projekt/a.txt`)).toString(), "hallo\r\n");
  const over = await upload(b, [proj], remoteDir, hooks("overwrite"));
  assert.equal(over.done, 3);
  assert.equal(Buffer.from(await b.read(`${remoteDir}/projekt/a.txt`)).toString(), "neu");

  // A single file, and a cancel after the first file.
  const single = await download(b, [{ path: `${remoteDir}/projekt/a.txt`, isDir: false }], down, hooks());
  assert.equal(single.done, 1);
  assert.equal(readFileSync(join(down, "a.txt"), "utf8"), "neu");
  const stopped = await upload(b, [proj], remoteDir, hooks("overwrite", 1));
  assert.equal(stopped.cancelled, true);
}

test("transfer over ftp: folders and files go up and come back unchanged", async () => {
  const b = new FtpBackend({ name: "t", protocol: "ftp", host: "127.0.0.1", port: ftpPort, username: "u" }, "p");
  try {
    await roundTrip(b, "/");
  } finally {
    await b.close();
  }
});

test("transfer over sftp: folders and files go up and come back unchanged", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const b = new SftpBackend(
    { name: "t", protocol: "sftp", host: "127.0.0.1", port: sshPort, username: userInfo().username, privateKeyPath: join(sshDir, "id") },
    undefined,
    { verify: async () => true },
  );
  const remote = mkdtempSync(join(tmpdir(), "craft-tr-remote-"));
  cleanup.push(remote);
  try {
    await roundTrip(b, remote);
  } finally {
    await b.close();
  }
});

test("transfer: a download creates the missing folders of its target", async () => {
  const b = new FtpBackend({ name: "t", protocol: "ftp", host: "127.0.0.1", port: ftpPort, username: "u" }, "p");
  try {
    await b.write("/mapped.txt", Buffer.from("x"));
    const root = mkdtempSync(join(tmpdir(), "craft-tr-map-"));
    cleanup.push(root);
    const dir = join(root, "neu", "tief");
    const res = await download(b, [{ path: "/mapped.txt", isDir: false }], dir, hooks());
    assert.equal(res.done, 1);
    assert.equal(readFileSync(join(dir, "mapped.txt"), "utf8"), "x");
    await b.remove("/mapped.txt", false);
  } finally {
    await b.close();
  }
});
