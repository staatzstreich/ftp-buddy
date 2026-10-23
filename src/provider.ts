import * as vscode from "vscode";
import { Backend, Entry, RemoteError, parentOf } from "./backend";
import { Connections } from "./backends";

function asVscodeError(e: unknown, uri: vscode.Uri): unknown {
  if (!(e instanceof RemoteError)) return e;
  switch (e.code) {
    case "NotFound": return vscode.FileSystemError.FileNotFound(uri);
    case "Exists": return vscode.FileSystemError.FileExists(uri);
    case "NoPermission": return vscode.FileSystemError.NoPermissions(uri);
    default: return vscode.FileSystemError.Unavailable(e.message);
  }
}

const typeOf = (e: Entry, isDir?: boolean): vscode.FileType => {
  if (e.kind === "link") return isDir ? vscode.FileType.Directory : vscode.FileType.File;
  return e.kind === "dir" ? vscode.FileType.Directory : vscode.FileType.File;
};

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;

export class RemoteFileSystem implements vscode.FileSystemProvider {
  private changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(private conns: Connections) {}

  watch(): vscode.Disposable {
    // Remote folders are not watched; refresh the Explorer to see changes made elsewhere.
    return new vscode.Disposable(() => undefined);
  }

  /** Runs `f` with the backend of `uri` and turns our errors into VS Code's. */
  private async with<T>(uri: vscode.Uri, f: (b: Backend, path: string) => Promise<T>): Promise<T> {
    try {
      return await f(await this.conns.get(uri.authority), uri.path || "/");
    } catch (e) {
      throw asVscodeError(e, uri);
    }
  }

  private fire(type: vscode.FileChangeType, uri: vscode.Uri) {
    this.changes.fire([{ type, uri }]);
  }

  /** Whether a symbolic link points to a folder: it is, when listing it works. */
  private async linkIsDir(b: Backend, path: string): Promise<boolean> {
    return b.list(path).then(() => true, () => false);
  }

  stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    return this.with(uri, async (b, path) => {
      const e = await b.stat(path);
      if (!e) throw new RemoteError("NotFound", path);
      const dir = e.kind === "link" ? await this.linkIsDir(b, path) : undefined;
      return { type: typeOf(e, dir), ctime: e.mtime, mtime: e.mtime, size: e.size };
    });
  }

  readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    return this.with(uri, async (b, path) => {
      const entries = await b.list(path);
      return Promise.all(
        entries
          .filter((e) => e.name !== "." && e.name !== "..")
          .map(async (e): Promise<[string, vscode.FileType]> => {
            const dir = e.kind === "link" ? await this.linkIsDir(b, join(path, e.name)) : undefined;
            return [e.name, typeOf(e, dir)];
          }),
      );
    });
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.with(uri, (b, path) => b.read(path));
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, opts: { create: boolean; overwrite: boolean }): Promise<void> {
    return this.with(uri, async (b, path) => {
      const existing = await b.stat(path);
      if (existing && !opts.overwrite) throw new RemoteError("Exists", path);
      if (!existing && !opts.create) throw new RemoteError("NotFound", path);
      await b.write(path, content);
      this.fire(existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri);
    });
  }

  createDirectory(uri: vscode.Uri): Promise<void> {
    return this.with(uri, async (b, path) => {
      await b.mkdir(path);
      this.fire(vscode.FileChangeType.Created, uri);
    });
  }

  delete(uri: vscode.Uri, opts: { recursive: boolean }): Promise<void> {
    return this.with(uri, async (b, path) => {
      const removeTree = async (p: string, isDir: boolean): Promise<void> => {
        if (isDir && opts.recursive) {
          for (const e of await b.list(p)) {
            if (e.name === "." || e.name === "..") continue;
            await removeTree(join(p, e.name), e.kind === "dir");
          }
        }
        await b.remove(p, isDir);
      };
      const e = await b.stat(path);
      if (!e) throw new RemoteError("NotFound", path);
      await removeTree(path, e.kind === "dir");
      this.fire(vscode.FileChangeType.Deleted, uri);
    });
  }

  rename(from: vscode.Uri, to: vscode.Uri, opts: { overwrite: boolean }): Promise<void> {
    return this.with(from, async (b, path) => {
      const target = to.path;
      const existing = await b.stat(target);
      if (existing && !opts.overwrite) throw new RemoteError("Exists", target);
      if (existing) await b.remove(target, existing.kind === "dir");
      await b.rename(path, target);
      this.changes.fire([
        { type: vscode.FileChangeType.Deleted, uri: from },
        { type: vscode.FileChangeType.Created, uri: to },
      ]);
    });
  }
}

export { parentOf };
