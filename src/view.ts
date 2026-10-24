import * as vscode from "vscode";
import { Profile, defaultPort } from "./backend";
import { Connections, SCHEME, profiles } from "./backends";

/** The folder of `profile` in the Explorer, if it is open. */
export function folderOf(profile: Profile): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find(
    (f) => f.uri.scheme === SCHEME && decodeURIComponent(f.uri.authority) === profile.name,
  );
}

export class ProfileItem extends vscode.TreeItem {
  constructor(readonly profile: Profile, connected: boolean) {
    super(profile.name, vscode.TreeItemCollapsibleState.None);
    const user = profile.username ? profile.username + "@" : "";
    this.description = `${profile.protocol}://${user}${profile.host}:${profile.port ?? defaultPort(profile)}`;
    this.tooltip = connected ? "Verbunden" : "Nicht verbunden";
    this.contextValue = connected ? "profile.connected" : "profile.disconnected";
    this.iconPath = connected
      ? new vscode.ThemeIcon("vm-active", new vscode.ThemeColor("charts.green"))
      : new vscode.ThemeIcon("vm-outline");
    // A click on a disconnected profile connects it.
    if (!connected) this.command = { command: "craftRemote.connect", title: "Verbinden", arguments: [this] };
  }
}

/** The "Craft Remote" list in the side bar: every profile, with its state. */
export class ProfilesView implements vscode.TreeDataProvider<ProfileItem>, vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private subs: vscode.Disposable[];

  constructor(private conns: Connections) {
    this.subs = [
      this.changed,
      conns.onDidChange(() => this.changed.fire()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.changed.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("craftRemote") && this.changed.fire()),
    ];
  }

  getTreeItem(item: ProfileItem): vscode.TreeItem {
    return item;
  }

  getChildren(): ProfileItem[] {
    return profiles().map((p) => new ProfileItem(p, this.conns.isOpen(p.name) || !!folderOf(p)));
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
  }
}
