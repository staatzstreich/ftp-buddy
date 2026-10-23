/** What a protocol must offer. No `vscode` import here, so it can be tested on its own. */

export type Kind = "file" | "dir" | "link";

export interface Entry {
  name: string;
  kind: Kind;
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

export type ErrorCode = "NotFound" | "Exists" | "NoPermission" | "Unavailable";

export class RemoteError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

export interface Profile {
  name: string;
  protocol: "sftp" | "ftp" | "ftps";
  host: string;
  port?: number;
  username?: string;
  privateKeyPath?: string;
  remotePath?: string;
}

export interface Backend {
  /** The directory a connection starts in. */
  home(): Promise<string>;
  list(path: string): Promise<Entry[]>;
  /** `undefined` when the path does not exist. */
  stat(path: string): Promise<Entry | undefined>;
  read(path: string): Promise<Uint8Array>;
  write(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  close(): Promise<void>;
}

export const defaultPort = (p: Profile): number => p.port ?? (p.protocol === "sftp" ? 22 : 21);

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
