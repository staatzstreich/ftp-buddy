/** What a protocol must offer. No `vscode` import here, so it can be tested on its own. */

export type Kind = "file" | "dir" | "link";

export interface Entry {
  name: string;
  kind: Kind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
  /** Unix permission bits (`0o755`, with setuid/setgid/sticky); `undefined` when the server does not tell. */
  mode?: number;
}

/** `rwxr-xr-x` (or `drwxr-xr-x`, as in a listing) to `0o755`; `undefined` when it is not such a string. */
export function parseSymbolic(s: string): number | undefined {
  const m = /^[-dlcbps]?([r-][w-][xsS-])([r-][w-][xsS-])([r-][w-][xtT-])$/.exec(s);
  if (!m) return undefined;
  let mode = 0;
  m.slice(1).forEach((triple, i) => {
    const bit = (c: string, on: string) => (c === on ? 1 : 0);
    const [r = "", w = "", x = ""] = triple;
    const digit = bit(r, "r") * 4 + bit(w, "w") * 2 + (x === "x" || x === "s" || x === "t" ? 1 : 0);
    mode |= digit << (6 - 3 * i);
    if (i === 0 && (x === "s" || x === "S")) mode |= 0o4000;
    if (i === 1 && (x === "s" || x === "S")) mode |= 0o2000;
    if (i === 2 && (x === "t" || x === "T")) mode |= 0o1000;
  });
  return mode;
}

/** `0o755` to `rwxr-xr-x`. */
export function formatSymbolic(mode: number): string {
  const triple = (d: number, special: boolean, on: string) => {
    const x = d & 1 ? (special ? on : "x") : special ? on.toUpperCase() : "-";
    return (d & 4 ? "r" : "-") + (d & 2 ? "w" : "-") + x;
  };
  return (
    triple((mode >> 6) & 7, !!(mode & 0o4000), "s") +
    triple((mode >> 3) & 7, !!(mode & 0o2000), "s") +
    triple(mode & 7, !!(mode & 0o1000), "t")
  );
}

/** `0o644` to `644`; `0o4755` to `4755`. */
export const formatOctal = (mode: number): string => (mode & 0o7777).toString(8).padStart(3, "0");

export type ErrorCode = "NotFound" | "Exists" | "NoPermission" | "Unavailable";

export class RemoteError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export interface Profile {
  name: string;
  protocol: "sftp" | "ftp" | "ftps" | "ftps-implicit";
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  /** SFTP only: log in with the keys of the running ssh-agent (`SSH_AUTH_SOCK`) instead of a password or key file. */
  useAgent?: boolean;
  remotePath?: string;
  /** Profiles with the same group are shown together in a folder of the side bar. */
  group?: string;
  /** The local folder that matches `remotePath` (or the login folder): uploads and downloads keep the structure. */
  localPath?: string;
}

export interface Backend {
  /** The directory a connection starts in. */
  home(): Promise<string>;
  list(path: string): Promise<Entry[]>;
  /** `undefined` when the path does not exist. */
  stat(path: string, fresh?: boolean): Promise<Entry | undefined>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Creates `path` with any parents that are missing. */
  ensureDir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Sets the permission bits (`0o644`). FTP servers may refuse: `SITE CHMOD` is not part of every server. */
  chmod(path: string, mode: number): Promise<void>;
  close(): Promise<void>;
}

export const defaultPort = (p: Profile): number => p.port ?? (p.protocol === "sftp" ? 22 : p.protocol === "ftps-implicit" ? 990 : 21);

export function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Remembers the host keys of SFTP servers (trust on first use). */
export interface HostKeys {
  /** `true` to go on. Called with the server's `SHA256:` fingerprint on every connection. */
  verify(server: string, fingerprint: string): Promise<boolean>;
}

/** Reports how long each operation took, to find out what feels slow. */
export function timed(inner: Backend, log: (line: string) => void): Backend {
  const t = async <T>(what: string, f: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      return await f();
    } finally {
      log(`${String(Date.now() - start).padStart(5)} ms  ${what}`);
    }
  };
  return {
    home: () => t("home", () => inner.home()),
    list: (p) => t(`list ${p}`, () => inner.list(p)),
    stat: (p, fresh) => t(`stat ${p}`, () => inner.stat(p, fresh)),
    read: (p) => t(`read ${p}`, () => inner.read(p)),
    write: (p, d) => t(`write ${p} (${d.length} B)`, () => inner.write(p, d)),
    mkdir: (p) => t(`mkdir ${p}`, () => inner.mkdir(p)),
    ensureDir: (p) => t(`ensureDir ${p}`, () => inner.ensureDir(p)),
    remove: (p, d) => t(`remove ${p}`, () => inner.remove(p, d)),
    rename: (a, b) => t(`rename ${a} -> ${b}`, () => inner.rename(a, b)),
    chmod: (p, m) => t(`chmod ${formatOctal(m)} ${p}`, () => inner.chmod(p, m)),
    close: () => inner.close(),
  };
}

/**
 * The value for `key`, created once even when many callers ask at the same time (VS Code sends a
 * dozen requests in a burst before the first connection exists). A failed creation is forgotten,
 * so the next call tries again.
 */
export function once<K, V>(cache: Map<K, Promise<V>>, key: K, create: () => Promise<V>, created?: () => void): Promise<V> {
  const have = cache.get(key);
  if (have) return have;
  const made = create().then((v) => {
    // Told once per creation, never to the callers that only got the cached value.
    created?.();
    return v;
  }).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, made);
  return made;
}
