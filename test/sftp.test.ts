import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, AddressInfo } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { HostKeys } from "../src/backend";
import { SftpBackend } from "../src/sftp";
import { contract } from "./contract";

/** A throw-away sshd on localhost, as in codecraft's own tests. Skipped when sshd is missing. */
const SSHD = ["/usr/sbin/sshd", "/usr/bin/sshd"].find(existsSync);
const SFTP_SERVER = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"].find(existsSync);

let dir: string;
let work: string;
let child: ChildProcess | undefined;
let port = 0;

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

before(async () => {
  if (!SSHD || !SFTP_SERVER) return;
  dir = mkdtempSync(join(tmpdir(), "craft-sshd-"));
  work = mkdtempSync(join(tmpdir(), "craft-sftp-work-"));
  for (const name of ["host", "id"]) execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(dir, name)]);
  port = await freePort();
  writeFileSync(
    join(dir, "sshd_config"),
    `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${dir}/host\nPidFile ${dir}/pid\nAuthorizedKeysFile ${dir}/id.pub\n` +
      `PasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\nSubsystem sftp ${SFTP_SERVER}\n`,
  );
  child = spawn(SSHD, ["-D", "-e", "-f", join(dir, "sshd_config")], { stdio: "ignore" });
  for (let i = 0; i < 100 && !(await reachable(port)); i++) await new Promise((r) => setTimeout(r, 50));
});

after(() => {
  child?.kill();
  for (const d of [dir, work]) if (d) rmSync(d, { recursive: true, force: true });
});

/** Trust on first use, like the extension, without the dialog. */
class Memory implements HostKeys {
  seen = new Map<string, string>();
  async verify(server: string, fingerprint: string) {
    const have = this.seen.get(server);
    if (!have) this.seen.set(server, fingerprint);
    return !have || have === fingerprint;
  }
}

const backend = (key: string, keys: HostKeys = new Memory(), limit?: number) =>
  new SftpBackend({ name: "t", protocol: "sftp", host: "127.0.0.1", port, username: userInfo().username, privateKeyPath: key }, undefined, keys, limit);

test("sftp: read, write, list, rename, delete keep bytes exact", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const b = backend(join(dir, "id"));
  try {
    await contract(b, work);
  } finally {
    await b.close();
  }
});

test("sftp: a key the server does not know is refused", { skip: !SSHD || !SFTP_SERVER }, async () => {
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", join(work, "other")]);
  const b = backend(join(work, "other"));
  await assert.rejects(b.home());
  await b.close();
});

test("sftp: a server that is not trusted is not connected to", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const b = backend(join(dir, "id"), { verify: async () => false });
  await assert.rejects(b.home());
  await b.close();
});

test("sftp: the host key is remembered and a different one is refused", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const keys = new Memory();
  const first = backend(join(dir, "id"), keys);
  await first.home();
  await first.close();
  const [server] = [...keys.seen.keys()];
  assert.ok(server);
  keys.seen.set(server, "SHA256:something-else");
  const second = backend(join(dir, "id"), keys);
  await assert.rejects(second.home());
  await second.close();
});

test("sftp: time spent in the host key dialog does not count towards the handshake timeout", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const slow: HostKeys = { verify: () => new Promise((r) => setTimeout(() => r(true), 1500)) };
  const b = backend(join(dir, "id"), slow, 700);
  try {
    assert.ok((await b.home()).startsWith("/"));
  } finally {
    await b.close();
  }
});

test("sftp: a server that never answers times out", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const silent = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => silent.once("listening", r));
  const p = (silent.address() as AddressInfo).port;
  const b = new SftpBackend({ name: "t", protocol: "sftp", host: "127.0.0.1", port: p, username: "x", privateKeyPath: join(dir, "id") }, undefined, new Memory(), 700);
  try {
    await assert.rejects(b.home(), /handshake/);
  } finally {
    await b.close();
    silent.close();
  }
});

test("sftp: keys from the ssh-agent are used", { skip: !SSHD || !SFTP_SERVER }, async () => {
  const out = execFileSync("ssh-agent", ["-s"]).toString();
  const sock = /SSH_AUTH_SOCK=([^;]+);/.exec(out)?.[1];
  const pid = /SSH_AGENT_PID=(\d+);/.exec(out)?.[1];
  assert.ok(sock && pid);
  const before = process.env.SSH_AUTH_SOCK;
  try {
    execFileSync("ssh-add", [join(dir, "id")], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: "ignore" });
    process.env.SSH_AUTH_SOCK = sock;
    const b = new SftpBackend({ name: "t", protocol: "sftp", host: "127.0.0.1", port, username: userInfo().username, useAgent: true }, undefined, new Memory());
    try {
      assert.ok((await b.home()).startsWith("/"));
    } finally {
      await b.close();
    }
    delete process.env.SSH_AUTH_SOCK;
    const none = new SftpBackend({ name: "t", protocol: "sftp", host: "127.0.0.1", port, username: "x", useAgent: true }, undefined, new Memory());
    await assert.rejects(none.home(), /ssh-agent/);
  } finally {
    if (before === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = before;
    process.kill(Number(pid));
  }
});
