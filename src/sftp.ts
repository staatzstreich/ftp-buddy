import SftpClient from "ssh2-sftp-client";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { Backend, Entry, HostKeys, Profile, RemoteError, defaultPort } from "./backend";

type Sftp = InstanceType<typeof SftpClient>;

const expand = (p: string) => (p.startsWith("~/") ? homedir() + p.slice(1) : p);

function translate(e: unknown, path: string): RemoteError {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: number | string }).code;
  if (code === 2 || /no such file/i.test(msg)) return new RemoteError("NotFound", path);
  if (code === 3 || /permission denied/i.test(msg)) return new RemoteError("NoPermission", path);
  if (code === 4 && /exist/i.test(msg)) return new RemoteError("Exists", path);
  return new RemoteError("Unavailable", msg);
}

export class SftpBackend implements Backend {
  private client: Sftp | undefined;
  private connecting: Promise<Sftp> | undefined;

  constructor(private profile: Profile, private password: string | undefined, private hostKeys: HostKeys) {}

  private async connect(): Promise<Sftp> {
    const c = new SftpClient();
    const p = this.profile;
    await c.connect({
      host: p.host,
      port: defaultPort(p),
      username: p.username,
      password: p.privateKeyPath ? undefined : this.password,
      privateKey: p.privateKeyPath ? readFileSync(expand(p.privateKeyPath)) : undefined,
      passphrase: p.privateKeyPath ? this.password : undefined,
      readyTimeout: 20000,
      keepaliveInterval: 20000,
      hostVerifier: (key: Buffer, done: (ok: boolean) => void) => {
        const fingerprint = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
        this.hostKeys.verify(`${p.host}:${defaultPort(p)}`, fingerprint).then(done, () => done(false));
      },
    });
    // A dropped connection must not stay cached.
    const forget = () => {
      if (this.client === c) this.client = undefined;
    };
    c.on("close", forget);
    c.on("error", forget);
    c.on("end", forget);
    return c;
  }

  private async conn(): Promise<Sftp> {
    if (this.client) return this.client;
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    this.client = await this.connecting;
    return this.client;
  }

  /** Runs `f`; after a lost connection it reconnects once. */
  private async run<T>(path: string, f: (c: Sftp) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await f(await this.conn());
      } catch (e) {
        const err = translate(e, path);
        if (err.code !== "Unavailable" || attempt > 0) throw err;
        this.client = undefined;
      }
    }
  }

  home(): Promise<string> {
    return this.run("~", (c) => c.realPath("."));
  }

  async list(path: string): Promise<Entry[]> {
    const items = await this.run(path, (c) => c.list(path));
    return items.map((i) => ({
      name: i.name,
      kind: i.type === "d" ? "dir" : i.type === "l" ? "link" : "file",
      size: i.size,
      mtime: i.modifyTime,
    }));
  }

  async stat(path: string): Promise<Entry | undefined> {
    try {
      const s = await this.run(path, (c) => c.stat(path));
      return {
        name: path.slice(path.lastIndexOf("/") + 1),
        kind: s.isDirectory ? "dir" : "file",
        size: s.size,
        mtime: s.modifyTime,
      };
    } catch (e) {
      if (e instanceof RemoteError && e.code === "NotFound") return undefined;
      throw e;
    }
  }

  async read(path: string): Promise<Uint8Array> {
    const data = await this.run(path, (c) => c.get(path));
    return data instanceof Buffer ? data : Buffer.from(String(data));
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.run(path, (c) => c.put(Buffer.from(data), path));
  }

  async mkdir(path: string): Promise<void> {
    await this.run(path, (c) => c.mkdir(path, false));
  }

  async remove(path: string, isDir: boolean): Promise<void> {
    await this.run(path, (c) => (isDir ? c.rmdir(path, false) : c.delete(path)));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.run(from, (c) => c.rename(from, to));
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    await c?.end().catch(() => undefined);
  }
}
