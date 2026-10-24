import * as vscode from "vscode";
import { Profile, defaultPort, baseName, parentOf } from "./backend";
import { Connections, profiles, uriFor } from "./backends";
import { RemoteFileSystem } from "./provider";
import { Decision, Result, download, upload } from "./transfer";
import { expandHome, toLocal, toRemote } from "./mapping";
import { readdirSync } from "node:fs";
import { dirname, join as joinLocal, resolve } from "node:path";

export type Node = ProfileNode | EntryNode;

export class ProfileNode extends vscode.TreeItem {
  constructor(readonly profile: Profile, readonly connected: boolean) {
    super(profile.name, connected ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    const user = profile.username ? profile.username + "@" : "";
    this.id = `profile:${profile.name}`;
    this.description = `${profile.protocol}://${user}${profile.host}:${profile.port ?? defaultPort(profile)}`;
    this.tooltip = connected ? "Verbunden" : "Nicht verbunden (Klick verbindet)";
    this.contextValue = connected ? "profile.connected" : "profile.disconnected";
    this.iconPath = connected
      ? new vscode.ThemeIcon("vm-active", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("vm-outline");
    if (!connected) this.command = { command: "craftRemote.connect", title: "Verbinden", arguments: [this] };
  }
}

export class EntryNode extends vscode.TreeItem {
  constructor(readonly profile: Profile, readonly path: string, readonly isDir: boolean) {
    super(baseName(path) || "/", isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.uri = uriFor(profile, path);
    this.resourceUri = this.uri;
    this.id = this.uri.toString();
    this.contextValue = isDir ? "remote.dir" : "remote.file";
    if (!isDir) this.command = { command: "vscode.open", title: "Öffnen", arguments: [this.uri] };
  }
  readonly uri: vscode.Uri;
}

/** The "Craft Remote" side bar: profiles, and below a connected one its files and folders. */
export class RemoteTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private subs: vscode.Disposable[];

  constructor(private conns: Connections, private fs: RemoteFileSystem) {
    this.subs = [
      this.changed,
      conns.onDidChange(() => {
        for (const name of [...this.starts.keys()]) if (!conns.isOpen(name)) this.starts.delete(name);
        this.refresh();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("craftRemote") && this.refresh()),
    ];
  }

  refresh(node?: Node) {
    this.changed.fire(node);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  getParent(): undefined {
    // Only profiles are ever revealed, and they sit at the top.
    return undefined;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) return profiles().map((p) => new ProfileNode(p, this.conns.isOpen(p.name)));
    if (node instanceof ProfileNode) return this.list(node.profile, await this.startPath(node.profile));
    return node.isDir ? this.list(node.profile, node.path) : [];
  }

  /** Where a profile's tree starts; asked once per connection. */
  private starts = new Map<string, string>();

  async startPath(p: Profile): Promise<string> {
    if (p.remotePath) return p.remotePath;
    const known = this.starts.get(p.name);
    if (known) return known;
    const home = await (await this.conns.get(encodeURIComponent(p.name))).home();
    this.starts.set(p.name, home);
    return home;
  }

  private async list(p: Profile, path: string): Promise<Node[]> {
    try {
      const entries = await this.fs.readDirectory(uriFor(p, path));
      const dirs = (t: vscode.FileType) => t === vscode.FileType.Directory;
      return entries
        .sort((a, b) => Number(dirs(b[1])) - Number(dirs(a[1])) || a[0].localeCompare(b[0], undefined, { numeric: true }))
        .map(([name, type]) => new EntryNode(p, (path.endsWith("/") ? path : path + "/") + name, dirs(type)));
    } catch (e) {
      vscode.window.showErrorMessage(`Ordner ${path} konnte nicht gelesen werden: ${e instanceof Error ? e.message : e}`);
      return [];
    }
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
  }
}

const uriOf = (n: EntryNode) => n.uri;
const resolveLocal = (p: string) => resolve(expandHome(p));

/** New file, new folder, rename and delete on a node of the tree. */
export function registerFileCommands(tree: RemoteTree, conns: Connections, selection: () => readonly Node[]): vscode.Disposable[] {
  const dirOf = (n: EntryNode) => (n.isDir ? n.path : parentOf(n.path));
  const join = (dir: string, name: string) => (dir.endsWith("/") ? dir : dir + "/") + name;
  const name = (prompt: string, value?: string) =>
    vscode.window.showInputBox({
      prompt,
      value,
      validateInput: (v) => (v.trim() === "" ? "Name fehlt" : /[\\/]/.test(v) ? "Kein / im Namen" : undefined),
    });
  const run = async (what: string, f: () => Thenable<unknown>) => {
    try {
      await f();
    } catch (e) {
      vscode.window.showErrorMessage(`${what} fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
    }
    tree.refresh();
  };
  /** Asks what to do with a file that is already there; "all" answers stick for the rest of the run. */
  const conflictPolicy = () => {
    let sticky: Decision | undefined;
    return async (path: string): Promise<Decision> => {
      if (sticky) return sticky;
      const pick = await vscode.window.showWarningMessage(
        `„${path}“ gibt es schon.`,
        { modal: true },
        "Überschreiben",
        "Überspringen",
        "Alle überschreiben",
        "Alle überspringen",
      );
      switch (pick) {
        case "Überschreiben": return "overwrite";
        case "Überspringen": return "skip";
        case "Alle überschreiben": return (sticky = "overwrite");
        case "Alle überspringen": return (sticky = "skip");
        default: return "cancel";
      }
    };
  };
  const transferred = (verb: string, r: { done: number; skipped: number; failed: { path: string; error: string }[]; cancelled: boolean }) => {
    const parts = [`${r.done} ${verb}`];
    if (r.skipped) parts.push(`${r.skipped} übersprungen`);
    if (r.failed.length) parts.push(`${r.failed.length} fehlgeschlagen`);
    const text = `${r.cancelled ? "Abgebrochen: " : ""}${parts.join(", ")}.`;
    if (r.failed.length) {
      const first = r.failed[0];
      void vscode.window.showErrorMessage(`${text} Erster Fehler: ${first?.path}: ${first?.error}`);
    } else {
      void vscode.window.showInformationMessage(text);
    }
  };
  const backendOf = (n: ProfileNode | EntryNode) => conns.get(encodeURIComponent(n.profile.name));
  /** The folder an upload to `n` lands in: the folder itself, a file's folder, a profile's start folder. */
  const targetDir = async (n: ProfileNode | EntryNode) =>
    n instanceof ProfileNode ? tree.startPath(n.profile) : n.isDir ? n.path : parentOf(n.path);

  /** Where downloads go: the workspace folder (asked, if there are several), else a folder dialog. */
  const downloadTarget = async (nodes: EntryNode[]): Promise<string | undefined> => {
    const folders = vscode.workspace.workspaceFolders?.filter((f) => f.uri.scheme === "file") ?? [];
    if (folders.length === 1) return folders[0]?.uri.fsPath;
    if (folders.length > 1) {
      const pick = await vscode.window.showQuickPick(
        folders.map((f) => ({ label: f.name, description: f.uri.fsPath, path: f.uri.fsPath })),
        { placeHolder: `${nodes.length === 1 ? `„${baseName(nodes[0]?.path ?? "")}“` : `${nodes.length} Einträge`} herunterladen nach …` },
      );
      return pick?.path;
    }
    const dest = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, openLabel: "Hierher laden" });
    return dest?.[0]?.fsPath;
  };

  interface UploadJob {
    paths: string[];
    dir: string;
  }

  const merge = (into: Result, r: Result) => {
    into.done += r.done;
    into.skipped += r.skipped;
    into.failed.push(...r.failed);
    into.cancelled ||= r.cancelled;
  };

  const runUpload = async (profile: Profile, jobs: UploadJob[]) => {
    const policy = conflictPolicy();
    const where = jobs.length === 1 ? `${profile.name}:${jobs[0]?.dir}` : profile.name;
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Hochladen nach ${where}`, cancellable: true },
      async (progress, token) => {
        const b = await conns.get(encodeURIComponent(profile.name));
        const all: Result = { done: 0, skipped: 0, failed: [], cancelled: false };
        for (const job of jobs) {
          merge(all, await upload(b, job.paths, job.dir, {
            exists: policy,
            cancelled: () => token.isCancellationRequested,
            progress: (done, total, name) => name && progress.report({ message: `${done} von ${total}: ${name}` }),
          }));
          if (all.cancelled) break;
        }
        return all;
      },
    );
    transferred("hochgeladen", result);
    tree.refresh();
  };

  /** Upload jobs from the profile's folder mapping; `undefined` when something lies outside it. */
  const mappedUploads = async (p: Profile, local: string[]): Promise<UploadJob[] | undefined> => {
    if (!p.localPath) return undefined;
    const remoteRoot = await tree.startPath(p);
    const byDir = new Map<string, string[]>();
    const add = (dir: string, path: string) => byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
    for (const l of local) {
      const remote = toRemote(p.localPath, remoteRoot, l);
      if (remote === undefined) return undefined;
      if (remote === remoteRoot) {
        // The mapped folder itself: its contents go into the remote folder, not a copy of its name.
        for (const child of readdirSync(l)) add(remoteRoot, joinLocal(l, child));
      } else {
        add(parentOf(remote), l);
      }
    }
    return [...byDir].map(([dir, paths]) => ({ dir, paths }));
  };

  const commands = [
    vscode.commands.registerCommand("craftRemote.uploadFromExplorer", async (clicked?: vscode.Uri, all?: vscode.Uri[]) => {
      const local = (all?.length ? all : clicked ? [clicked] : []).filter((u) => u.scheme === "file").map((u) => u.fsPath);
      if (!local.length) return;
      const open = profiles().filter((p) => conns.isOpen(p.name));
      if (!open.length) {
        void vscode.window.showWarningMessage("Keine Verbindung offen. Erst in der Seitenleiste „Craft Remote“ verbinden.");
        return;
      }
      // A profile whose local folder contains everything chosen decides by itself where the files go.
      const mapped: { p: Profile; jobs: UploadJob[] }[] = [];
      for (const p of open) {
        const jobs = await mappedUploads(p, local);
        if (jobs) mapped.push({ p, jobs });
      }
      if (mapped.length) {
        const pick =
          mapped.length === 1
            ? mapped[0]
            : (await vscode.window.showQuickPick(mapped.map((m) => ({ label: m.p.name, m })), { placeHolder: "Auf welchen Server hochladen?" }))?.m;
        if (pick) await runUpload(pick.p, pick.jobs);
        return;
      }
      const profile =
        open.length === 1
          ? open[0]
          : (await vscode.window.showQuickPick(open.map((p) => ({ label: p.name, p })), { placeHolder: "Auf welchen Server hochladen?" }))?.p;
      if (!profile) return;
      // No mapping applies: the folder marked in the tree, if it is on this server, else the start folder.
      const marked = selection().find((n): n is EntryNode => n instanceof EntryNode && n.profile.name === profile.name);
      const target = marked ? (marked.isDir ? marked.path : parentOf(marked.path)) : await tree.startPath(profile);
      await runUpload(profile, [{ paths: local, dir: target }]);
    }),
    vscode.commands.registerCommand("craftRemote.upload", async (n: ProfileNode | EntryNode) => {
      const target = await targetDir(n);
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: "Hochladen",
        title: `Hochladen nach ${target}`,
      });
      if (picked?.length) await runUpload(n.profile, [{ paths: picked.map((u) => u.fsPath), dir: target }]);
    }),
    vscode.commands.registerCommand("craftRemote.download", async (n: EntryNode, all?: EntryNode[]) => {
      const nodes = (all?.length ? all : [n]).filter((x): x is EntryNode => x instanceof EntryNode);
      // Entries inside the mapped folder go to the matching place; the rest to the workspace folder.
      const remoteRoot = n.profile.localPath ? await tree.startPath(n.profile) : undefined;
      const localRoot = n.profile.localPath ? resolveLocal(n.profile.localPath) : undefined;
      const mapped: { node: EntryNode; dir: string }[] = [];
      const rest: EntryNode[] = [];
      for (const x of nodes) {
        const local = remoteRoot && n.profile.localPath ? toLocal(n.profile.localPath, remoteRoot, x.path) : undefined;
        if (local && local !== localRoot) mapped.push({ node: x, dir: dirname(local) });
        else rest.push(x);
      }
      let folder: string | undefined;
      if (rest.length) {
        folder = await downloadTarget(rest);
        if (!folder) return;
      }
      const policy = conflictPolicy();
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Herunterladen von ${n.profile.name}`, cancellable: true },
        async (progress, token) => {
          const b = await backendOf(n);
          const all: Result = { done: 0, skipped: 0, failed: [], cancelled: false };
          const hooks = {
            exists: policy,
            cancelled: () => token.isCancellationRequested,
            progress: (done: number, _t: number | undefined, name: string) => progress.report({ message: `${done} Dateien fertig, jetzt ${name}` }),
          };
          for (const m of mapped) {
            merge(all, await download(b, [{ path: m.node.path, isDir: m.node.isDir }], m.dir, hooks));
            if (all.cancelled) return all;
          }
          if (folder) merge(all, await download(b, rest.map((x) => ({ path: x.path, isDir: x.isDir })), folder, hooks));
          return all;
        },
      );
      transferred("heruntergeladen", result);
    }),
    vscode.commands.registerCommand("craftRemote.newFile", async (n: EntryNode) => {
      const f = await name("Name der neuen Datei");
      if (!f) return;
      const uri = uriFor(n.profile, join(dirOf(n), f.trim()));
      await run("Anlegen", async () => {
        await vscode.workspace.fs.writeFile(uri, new Uint8Array());
        await vscode.commands.executeCommand("vscode.open", uri);
      });
    }),
    vscode.commands.registerCommand("craftRemote.newFolder", async (n: EntryNode) => {
      const f = await name("Name des neuen Ordners");
      if (f) await run("Anlegen", () => vscode.workspace.fs.createDirectory(uriFor(n.profile, join(dirOf(n), f.trim()))));
    }),
    vscode.commands.registerCommand("craftRemote.rename", async (n: EntryNode) => {
      const f = await name("Neuer Name", baseName(n.path));
      if (f && f.trim() !== baseName(n.path)) {
        await run("Umbenennen", () => vscode.workspace.fs.rename(uriOf(n), uriFor(n.profile, join(parentOf(n.path), f.trim()))));
      }
    }),
    vscode.commands.registerCommand("craftRemote.delete", async (n: EntryNode) => {
      const ok = await vscode.window.showWarningMessage(
        `„${baseName(n.path)}“ auf dem Server löschen?`,
        { modal: true, detail: n.isDir ? "Der Ordner wird mit allem Inhalt gelöscht. Das lässt sich nicht rückgängig machen." : "Das lässt sich nicht rückgängig machen." },
        "Löschen",
      );
      if (ok === "Löschen") await run("Löschen", () => vscode.workspace.fs.delete(uriOf(n), { recursive: true }));
    }),
    vscode.commands.registerCommand("craftRemote.copyPath", (n: EntryNode) => vscode.env.clipboard.writeText(n.path)),
    vscode.commands.registerCommand("craftRemote.refresh", () => tree.refresh()),
  ];
  return commands;
}
