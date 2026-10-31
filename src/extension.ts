import * as vscode from "vscode";
import { Profile, defaultPort } from "./backend";
import { applySshConfig, readSshConfig } from "./sshconfig";
import { Connections, SCHEME, StoredHostKeys, profiles, uriFor } from "./backends";
import { RemoteFileSystem } from "./provider";
import { ProfileNode, RemoteTree, registerFileCommands } from "./view";

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("FTP Buddy");
  const hostKeys = new StoredHostKeys(context.globalState, output);
  const conns = new Connections(context.secrets, hostKeys, output);
  const fs = new RemoteFileSystem(conns);
  const tree = new RemoteTree(conns, fs);
  const treeView = vscode.window.createTreeView("ftpBuddy.profiles", { treeDataProvider: tree, canSelectMany: true });
  context.subscriptions.push(
    output,
    vscode.workspace.registerFileSystemProvider(SCHEME, fs, { isCaseSensitive: true }),
    { dispose: () => void conns.drop() },
    treeView,
    tree,
    ...registerFileCommands(tree, conns, () => treeView.selection),
    vscode.commands.registerCommand("ftpBuddy.connect", async (item?: ProfileNode) => {
      const node = await connect(conns, output, item?.profile);
      if (node) await treeView.reveal(node, { expand: true, focus: false, select: false }).then(undefined, () => undefined);
    }),
    vscode.commands.registerCommand("ftpBuddy.disconnect", (item?: ProfileNode) => disconnect(conns, item?.profile)),
    vscode.commands.registerCommand("ftpBuddy.addProfile", addProfile),
    vscode.commands.registerCommand("ftpBuddy.editProfiles", () =>
      vscode.commands.executeCommand("workbench.action.openSettings", "ftpBuddy.profiles"),
    ),
    vscode.commands.registerCommand("ftpBuddy.forgetPassword", async (item?: ProfileNode) => {
      const p = item?.profile ?? (await pickProfile("Passwort vergessen für …"));
      if (p) await conns.forgetPassword(p.name);
    }),
    vscode.commands.registerCommand("ftpBuddy.forgetHostKeys", async () => {
      await hostKeys.forgetAll();
      vscode.window.showInformationMessage("Alle bekannten Server wurden vergessen.");
    }),
    vscode.commands.registerCommand("ftpBuddy.showLog", () => output.show()),
    vscode.commands.registerCommand("ftpBuddy.reconnect", () => conns.drop()),
  );
}

export function deactivate() {}

async function pickProfile(placeHolder: string): Promise<Profile | undefined> {
  const all = profiles();
  if (all.length === 0) {
    const go = await vscode.window.showInformationMessage("Noch kein Profil angelegt.", "Profil anlegen");
    if (go) await addProfile();
    return undefined;
  }
  const item = await vscode.window.showQuickPick(
    all.map((p) => {
      const shown = applySshConfig(p, readSshConfig());
      return { label: p.name, description: `${shown.protocol}://${shown.username ? shown.username + "@" : ""}${shown.host}`, p };
    }),
    { placeHolder },
  );
  return item?.p;
}

/** Logs in (asking for the password if needed) and returns the node to open in the tree. */
async function connect(conns: Connections, output: vscode.OutputChannel, chosen?: Profile): Promise<ProfileNode | undefined> {
  const p = chosen ?? (await pickProfile("Mit welchem Profil verbinden?"));
  if (!p) return undefined;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Verbinde mit ${p.host} …` },
    async () => {
      try {
        const backend = await conns.get(encodeURIComponent(p.name));
        await backend.home();
        return new ProfileNode(p, true);
      } catch (e) {
        // Wrong password or host: forget the cached connection so the next try asks again.
        await conns.drop(p.name);
        output.appendLine(`[${p.name}] Fehler: ${e instanceof Error ? e.message : e}`);
        vscode.window.showErrorMessage(`Verbindung zu ${p.host} fehlgeschlagen: ${e instanceof Error ? e.message : e}`);
        return undefined;
      }
    },
  );
}

/** Closes the connection; files that are still open stay in their editors. */
async function disconnect(conns: Connections, chosen?: Profile) {
  const p = chosen ?? (await pickProfile("Welche Verbindung trennen?"));
  if (p) await conns.drop(p.name);
}

async function addProfile() {
  const ask = (prompt: string, value?: string) => vscode.window.showInputBox({ prompt, value, ignoreFocusOut: true });
  const name = await ask("Name des Profils (erscheint im Explorer)");
  if (!name) return;
  const proto = await vscode.window.showQuickPick(
    [
      { label: "SFTP", description: "über SSH", v: "sftp" },
      { label: "FTP", description: "unverschlüsselt", v: "ftp" },
      { label: "FTPS (explizit)", description: "FTP mit TLS, Port 21 (AUTH TLS)", v: "ftps" },
      { label: "FTPS (implizit)", description: "von Anfang an verschlüsselt, meist Port 990", v: "ftps-implicit" },
    ],
    { placeHolder: "Protokoll" },
  );
  if (!proto) return;
  const protocol = proto.v as Profile["protocol"];
  const host = await ask("Server");
  if (!host) return;
  const port = await ask("Port", String(defaultPort({ name, host, protocol })));
  if (port === undefined) return;
  const username = await ask(protocol === "sftp" ? "Benutzer" : "Benutzer (leer = anonym)");
  if (username === undefined) return;
  const profile: Profile = { name, protocol, host, port: Number(port) || undefined, username: username || undefined };
  if (protocol === "sftp") {
    const key = await ask("Schlüsseldatei (leer = Passwort), z. B. ~/.ssh/id_ed25519");
    if (key) profile.privateKeyPath = key;
  }
  const remotePath = await ask("Startordner auf dem Server (leer = Home)");
  if (remotePath) profile.remotePath = remotePath;
  const localPath = await ask("Passender lokaler Ordner für Hoch- und Herunterladen (leer = keiner), z. B. ~/Developer/projekt");
  if (localPath) profile.localPath = localPath;
  const cfg = vscode.workspace.getConfiguration("ftpBuddy");
  await cfg.update("profiles", [...profiles(), profile], vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Profil „${name}“ gespeichert. Befehl „FTP Buddy: Mit Profil verbinden“ öffnet es.`);
}
