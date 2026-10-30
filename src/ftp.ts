import { Client, FileInfo, FileType } from "basic-ftp";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { ConnectionOptions, TLSSocket } from "node:tls";
import { Backend, Entry, HostKeys, Profile, RemoteError, baseName, defaultPort, parentOf } from "./backend";

/** Errors Node gives when it does not trust the server's certificate (self-signed, unknown CA, wrong name, expired). */
const CERT_ERRORS = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

const isCertError = (e: unknown) => CERT_ERRORS.has(String((e as { code?: unknown }).code));

const fingerprintOf = (der: Buffer) => "SHA256:" + createHash("sha256").update(der).digest("base64").replace(/=+$/, "");

function translate(e: unknown, path: string): RemoteError {
  if (e instanceof RemoteError) return e;
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

/** How long a listing may be reused for a folder view; VS Code asks for the same folder many times in a row. */
const LIST_TTL_MS = 2000;
/** How long a listing may answer "does this file exist, how big is it": the questions come in bursts. */
const STAT_TTL_MS = 30000;

export class FtpBackend implements Backend {
  private client: Client | undefined;
  /** FTP does one thing at a time per connection, so every operation waits for the one before. */
  private tail: Promise<unknown> = Promise.resolve();
  private cache = new Map<string, { at: number; entries: Entry[] }>();
  /** Listings under way, so parallel requests for one folder share a single LIST. */
  private pending = new Map<string, Promise<Entry[]>>();

  /** `hostKeys` decides about certificates Node does not trust itself; without it only trusted ones are accepted. */
  constructor(
    private profile: Profile,
    private password: string | undefined,
    private hostKeys?: HostKeys,
    private log: (line: string) => void = () => undefined,
  ) {}

  /** A new client that reports what it says and hears (passwords are masked by basic-ftp). */
  private newClient(): Client {
    const c = new Client(30000);
    c.ftp.verbose = true;
    c.ftp.log = (line: string) => this.log(`ftp  ${line}`);
    return c;
  }

  /**
   * Connects and, for FTPS, switches to TLS before anything secret is sent. A certificate that Node
   * does not trust (a company CA that only the macOS keychain knows, a self-signed one) is not
   * refused outright: its fingerprint goes to the user once, like an SSH host key, and from then on
   * only that very certificate is accepted, on the control and on every data connection.
   */
  private async connect(): Promise<Client> {
    const p = this.profile;
    const host = p.host;
    const port = defaultPort(p);
    const login = async (c: Client) => {
      await c.sendIgnoringError("OPTS UTF8 ON");
      await c.login(p.username || "anonymous", p.username ? this.password ?? "" : "anonymous@");
      await c.useDefaultSettings();
      return c;
    };
    if (p.protocol !== "ftps") {
      const c = this.newClient();
      try {
        await c.connect(host, port);
        return await login(c);
      } catch (e) {
        c.close();
        throw this.explain(e);
      }
    }

    const strict = this.newClient();
    try {
      await strict.connect(host, port);
      await strict.useTLS({ host });
      return await login(strict);
    } catch (e) {
      strict.close();
      if (!isCertError(e) || !this.hostKeys) throw this.explain(e);
      this.log(`tls  Zertifikat nicht vertrauenswürdig (${(e as { code?: string }).code}); frage nach dem Fingerabdruck`);
    }

    const c = this.newClient();
    try {
      await c.connect(host, port);
      // Look at the certificate, but send nothing secret until it is confirmed.
      await c.useTLS({ host, rejectUnauthorized: false });
      const cert = (c.ftp.socket as TLSSocket).getPeerCertificate();
      const fingerprint = fingerprintOf(cert.raw);
      this.log(`tls  Zertifikat ${fingerprint}, ausgestellt für ${cert.subject?.CN ?? "?"} von ${cert.issuer?.CN ?? "?"}`);
      if (!(await this.hostKeys?.verify(`ftps:${host}:${port}`, fingerprint))) {
        throw new RemoteError("NoPermission", "Dem Zertifikat des Servers wurde nicht vertraut.");
      }
      // Data connections get the same check, so no other certificate slips in later.
      const pinned: ConnectionOptions = {
        host,
        rejectUnauthorized: false,
        checkServerIdentity: (_name, other) => (fingerprintOf(other.raw) === fingerprint ? undefined : new Error("Zertifikat der Datenverbindung weicht ab")),
      };
      c.ftp.tlsOptions = pinned;
      return await login(c);
    } catch (e) {
      c.close();
      throw this.explain(e);
    }
  }

  /** The reason in words; certificate problems say what to do. */
  private explain(e: unknown): unknown {
    if (e instanceof RemoteError) return e;
    const code = (e as { code?: string }).code;
    const msg = e instanceof Error ? e.message : String(e);
    this.log(`fehler  ${code ?? ""} ${msg}`);
    // 421 is the server closing the door: very often a limit of connections per address or user.
    // Trying again at once would only make it worse, so this is not the "Unavailable" that is retried.
    if ((e as { code?: number }).code === 421 || /^421\b/.test(msg)) {
      return new RemoteError("NoPermission", `Der Server hat die Verbindung abgelehnt: ${msg}. Oft ist das ein Limit gleichzeitiger Verbindungen: andere FTP-Programme (Cyberduck, FileZilla) schließen und noch einmal versuchen.`);
    }
    if (isCertError(e)) return new RemoteError("NoPermission", `Zertifikat nicht vertrauenswürdig (${code}). ${msg}`);
    return e;
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

  list(path: string, maxAge = LIST_TTL_MS): Promise<Entry[]> {
    const hit = this.cache.get(path);
    if (hit && Date.now() - hit.at < maxAge) return Promise.resolve(hit.entries);
    const running = this.pending.get(path);
    if (running) return running;
    const job = this.enqueue(path, async (c) => {
      const entries = (await c.list(path)).map(toEntry);
      this.cache.set(path, { at: Date.now(), entries });
      return entries;
    }).finally(() => this.pending.delete(path));
    this.pending.set(path, job);
    return job;
  }

  async stat(path: string, fresh = false): Promise<Entry | undefined> {
    if (path === "/" || path === "") return { name: "", kind: "dir", size: 0, mtime: 0 };
    let entries: Entry[];
    try {
      entries = await this.list(parentOf(path), fresh ? 0 : STAT_TTL_MS);
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
