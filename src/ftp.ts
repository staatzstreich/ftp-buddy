import { Client, FileInfo, FileType } from "basic-ftp";
import { Readable, Writable } from "node:stream";
import { Backend, Entry, Profile, RemoteError, baseName, defaultPort, parentOf } from "./backend";

function translate(e: unknown, path: string): RemoteError {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: number }).code;
  if (code === 550 || /no such file|not found|550/i.test(msg)) return new RemoteError("NotFound", path);
  if (code === 553 || /permission/i.test(msg)) return new RemoteError("NoPermission", path);
  return new RemoteError("Unavailable", msg);
}

function toEntry(i: FileInfo): Entry {
  return {
    name: i.name,
    kind: i.type === FileType.Directory ? "dir" : i.type === FileType.SymbolicLink ? "link" : "file",
    size: i.size,
    mtime: i.modifiedAt?.getTime() ?? 0,
  };
}

/** How long a listing may be reused; VS Code asks for the same folder many times in a row. */
const LIST_TTL_MS = 2000;

export class FtpBackend implements Backend {
  private client: Client | undefined;
  /** FTP does one thing at a time per connection, so every operation waits for the one before. */
  private tail: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { at: number; entries: Entry[] }>();

  constructor(private profile: Profile, private password: string | undefined) {}

  private async connect(): Promise<Client> {
    const p = this.profile;
    const c = new Client(30000);
    await c.access({
      host: p.host,
      port: defaultPort(p),
      user: p.username || "anonymous",
      password: p.username ? this.password ?? "" : "anonymous@",
      secure: p.protocol === "ftps",
    });
    await c.useDefaultSettings();
    return c;
  }

  private enqueue<T>(path: string, f: (c: Client) => Promise<T>): Promise<T> {
    const job = this.tail.then(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          this.client ??= await this.connect();
          return await f(this.client);
        } catch (e) {
          const err = translate(e, path);
          if (err.code !== "Unavailable" || attempt > 0) throw err;
          // Probably a dead connection: start over once.
          this.client?.close();
          this.client = undefined;
        }
      }
    });
    this.tail = job.catch(() => undefined);
    return job;
  }

  home(): Promise<string> {
    return this.enqueue("~", (c) => c.pwd());
  }

  list(path: string): Promise<Entry[]> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < LIST_TTL_MS) return Promise.resolve(hit.entries);
    return this.enqueue(path, async (c) => {
      const entries = (await c.list(path)).map(toEntry);
      this.cache.set(path, { at: Date.now(), entries });
      return entries;
    });
  }

  async stat(path: string): Promise<Entry | undefined> {
    if (path === "/" || path === "") return { name: "", kind: "dir", size: 0, mtime: 0 };
    let entries: Entry[];
    try {
      entries = await this.list(parentOf(path));
    } catch (e) {
      if (e instanceof RemoteError && e.code === "NotFound") return undefined;
      throw e;
    }
    return entries.find((e) => e.name === baseName(path));
  }

  read(path: string): Promise<Uint8Array> {
    return this.enqueue(path, async (c) => {
      const chunks: Buffer[] = [];
      const sink = new Writable({
        write(chunk, _enc, cb) {
          chunks.push(Buffer.from(chunk));
          cb();
        },
      });
      await c.downloadTo(sink, path);
      return Buffer.concat(chunks);
    });
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.enqueue(path, (c) => c.uploadFrom(Readable.from([Buffer.from(data)]), path));
    this.cache.delete(parentOf(path));
  }

  async mkdir(path: string): Promise<void> {
    await this.enqueue(path, (c) => c.send(`MKD ${path}`).then(() => undefined));
    this.cache.delete(parentOf(path));
  }

  async remove(path: string, isDir: boolean): Promise<void> {
    await this.enqueue(path, (c) => (isDir ? c.removeEmptyDir(path) : c.remove(path)).then(() => undefined));
    this.cache.delete(parentOf(path));
    this.cache.delete(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.enqueue(from, (c) => c.rename(from, to).then(() => undefined));
    this.cache.delete(parentOf(from));
    this.cache.delete(parentOf(to));
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = undefined;
  }
}
