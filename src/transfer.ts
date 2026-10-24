/** Upload and download of files and folders. No `vscode` import, so it can be tested on its own. */
import { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import { Backend } from "./backend";

export type Decision = "overwrite" | "skip" | "cancel";

export interface Hooks {
  /** A file of that name is already at the target: what now? */
  exists(path: string): Promise<Decision>;
  /** `total` is known for uploads only. */
  progress(done: number, total: number | undefined, name: string): void;
  cancelled(): boolean;
}

export interface Result {
  done: number;
  skipped: number;
  failed: { path: string; error: string }[];
  cancelled: boolean;
}

const remoteJoin = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface LocalFile {
  local: string;
  /** Path relative to the chosen item, with `/`. */
  rel: string;
}

/** Everything below `local` (a file or a folder) as files plus the folders to create. Links are skipped. */
async function walkLocal(local: string, rel: string, files: LocalFile[], dirs: string[]): Promise<void> {
  const st = await fsp.lstat(local);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    dirs.push(rel);
    for (const name of (await fsp.readdir(local)).sort()) await walkLocal(join(local, name), `${rel}/${name}`, files, dirs);
  } else if (st.isFile()) {
    files.push({ local, rel });
  }
}

export async function upload(b: Backend, locals: string[], remoteDir: string, hooks: Hooks): Promise<Result> {
  const result: Result = { done: 0, skipped: 0, failed: [], cancelled: false };
  const files: LocalFile[] = [];
  const dirs: string[] = [];
  for (const l of locals) await walkLocal(l, basename(l), files, dirs);
  const total = files.length;

  // Folders first, shortest first, so every parent exists.
  for (const d of dirs.sort((a, c) => a.length - c.length)) {
    if (hooks.cancelled()) return { ...result, cancelled: true };
    const path = remoteJoin(remoteDir, d);
    try {
      const have = await b.stat(path, true);
      if (!have) await b.mkdir(path);
      else if (have.kind === "file") throw new Error("auf dem Server ist das eine Datei");
    } catch (e) {
      result.failed.push({ path, error: message(e) });
    }
  }
  for (const f of files) {
    if (hooks.cancelled()) return { ...result, cancelled: true };
    const path = remoteJoin(remoteDir, f.rel);
    hooks.progress(result.done + result.skipped + result.failed.length, total, f.rel);
    try {
      if (await b.stat(path, true)) {
        const d = await hooks.exists(path);
        if (d === "cancel") return { ...result, cancelled: true };
        if (d === "skip") {
          result.skipped++;
          continue;
        }
      }
      await b.write(path, await fsp.readFile(f.local));
      result.done++;
    } catch (e) {
      result.failed.push({ path, error: message(e) });
    }
  }
  hooks.progress(total, total, "");
  return result;
}

export async function download(b: Backend, items: { path: string; isDir: boolean }[], localDir: string, hooks: Hooks): Promise<Result> {
  const result: Result = { done: 0, skipped: 0, failed: [], cancelled: false };
  const seen = () => result.done + result.skipped + result.failed.length;

  const one = async (path: string, local: string, name: string): Promise<boolean> => {
    if (hooks.cancelled()) return false;
    hooks.progress(seen(), undefined, name);
    try {
      const have = await fsp.lstat(local).then((s) => s, () => undefined);
      if (have) {
        const d = await hooks.exists(local);
        if (d === "cancel") return false;
        if (d === "skip") {
          result.skipped++;
          return true;
        }
      }
      await fsp.writeFile(local, await b.read(path));
      result.done++;
    } catch (e) {
      result.failed.push({ path, error: message(e) });
    }
    return true;
  };

  const tree = async (path: string, local: string, name: string): Promise<boolean> => {
    if (hooks.cancelled()) return false;
    try {
      await fsp.mkdir(local, { recursive: true });
      for (const e of await b.list(path)) {
        if (e.name === "." || e.name === "..") continue;
        const childPath = remoteJoin(path, e.name);
        const childLocal = join(local, e.name);
        const isDir = e.kind === "dir" || (e.kind === "link" && (await b.list(childPath).then(() => true, () => false)));
        const go = isDir ? await tree(childPath, childLocal, `${name}/${e.name}`) : await one(childPath, childLocal, `${name}/${e.name}`);
        if (!go) return false;
      }
    } catch (e) {
      result.failed.push({ path, error: message(e) });
    }
    return true;
  };

  for (const it of items) {
    const name = it.path.slice(it.path.lastIndexOf("/") + 1);
    const go = it.isDir ? await tree(it.path, join(localDir, name), name) : await one(it.path, join(localDir, name), name);
    if (!go) return { ...result, cancelled: true };
  }
  return result;
}
