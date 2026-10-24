import * as vscode from "vscode";
import { Profile, defaultPort, baseName, parentOf } from "./backend";
import { Connections, profiles, uriFor } from "./backends";
import { RemoteFileSystem } from "./provider";

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
      conns.onDidChange(() => this.refresh()),
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

  private async startPath(p: Profile): Promise<string> {
    if (p.remotePath) return p.remotePath;
    return (await this.conns.get(encodeURIComponent(p.name))).home();
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

/** New file, new folder, rename and delete on a node of the tree. */
export function registerFileCommands(tree: RemoteTree): vscode.Disposable[] {
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
  return [
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
}
