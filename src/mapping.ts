/** Maps paths between a profile's local folder and its remote folder. No `vscode` import. */
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const expandHome = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? homedir() + p.slice(1) : p);

/** `path` relative to `root` with `/`, `""` for the root itself, `undefined` when `path` lies outside. */
function inside(root: string, path: string): string | undefined {
  const rel = relative(resolve(expandHome(root)), resolve(path));
  if (rel === "") return "";
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

const join = (dir: string, rel: string) => (rel === "" ? dir : (dir.endsWith("/") ? dir : dir + "/") + rel);

/** Where a local file or folder belongs on the server; `undefined` outside the mapped folder. */
export function toRemote(localRoot: string, remoteRoot: string, local: string): string | undefined {
  const rel = inside(localRoot, local);
  return rel === undefined ? undefined : join(remoteRoot, rel);
}

/** Where a remote file or folder belongs locally; `undefined` outside the mapped folder. */
export function toLocal(localRoot: string, remoteRoot: string, remote: string): string | undefined {
  const root = remoteRoot.endsWith("/") && remoteRoot.length > 1 ? remoteRoot.slice(0, -1) : remoteRoot;
  let rel: string;
  if (remote === root) rel = "";
  else if (remote.startsWith(root === "/" ? "/" : root + "/")) rel = remote.slice(root === "/" ? 1 : root.length + 1);
  else return undefined;
  return rel === "" ? resolve(expandHome(localRoot)) : resolve(expandHome(localRoot), ...rel.split("/"));
}
