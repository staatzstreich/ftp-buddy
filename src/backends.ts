import * as vscode from "vscode";
import { Backend, HostKeys, Profile, once, timed } from "./backend";
import { FtpBackend } from "./ftp";
import { SftpBackend } from "./sftp";

export const SCHEME = "craftremote";

export function profiles(): Profile[] {
  return vscode.workspace.getConfiguration("craftRemote").get<Profile[]>("profiles", []);
}

export function uriFor(profile: Profile, path: string): vscode.Uri {
  return vscode.Uri.from({ scheme: SCHEME, authority: encodeURIComponent(profile.name), path });
}

const secretKey = (name: string) => `craftRemote.password.${name}`;

/** Trust on first use: the first fingerprint is confirmed by the user, later ones must match. */
export class StoredHostKeys implements HostKeys {
  constructor(private state: vscode.Memento, private output: vscode.OutputChannel) {}

  async verify(server: string, fingerprint: string): Promise<boolean> {
    const known = this.state.get<Record<string, string>>("craftRemote.hostKeys", {});
    const have = known[server];
    this.output.appendLine(`${server}: Fingerabdruck ${fingerprint} (${have ? (have === fingerprint ? "bekannt" : "GEÄNDERT") : "neu, warte auf Bestätigung im Dialog"})`);
    if (have === fingerprint) return true;
    if (have) {
      vscode.window.showErrorMessage(
        `Der Schlüssel von ${server} hat sich geändert (jetzt ${fingerprint}). Das kann ein Angriff sein. ` +
          `Wenn der Server neu aufgesetzt wurde: „Craft Remote: Bekannte Server vergessen“.`,
        { modal: true },
      );
      return false;
    }
    const ok = await vscode.window.showWarningMessage(
      `Unbekannter Server ${server}`,
      { modal: true, detail: `Fingerabdruck: ${fingerprint}\n\nNur vertrauen, wenn du ihn kennst.` },
      "Vertrauen",
    );
    if (ok !== "Vertrauen") return false;
    await this.state.update("craftRemote.hostKeys", { ...known, [server]: fingerprint });
    return true;
  }

  async forgetAll(): Promise<void> {
    await this.state.update("craftRemote.hostKeys", {});
  }
}

/** One live connection per profile, created on first use. */
export class Connections {
  private open = new Map<string, Promise<Backend>>();
  private changed = new vscode.EventEmitter<void>();
  /** Fires when a connection is opened or closed. */
  readonly onDidChange = this.changed.event;

  /** Whether a connection for the profile exists (it may still be starting). */
  isOpen(name: string): boolean {
    return this.open.has(name);
  }

  constructor(private secrets: vscode.SecretStorage, private hostKeys: HostKeys, private output: vscode.OutputChannel) {}

  profileOf(authority: string): Profile {
    const name = decodeURIComponent(authority);
    const p = profiles().find((x) => x.name === name);
    if (!p) throw vscode.FileSystemError.Unavailable(`Kein Profil „${name}“ in craftRemote.profiles`);
    return p;
  }

  /** A password is asked for only when the profile needs one and none is saved. */
  private async password(p: Profile): Promise<string | undefined> {
    const needs = p.protocol === "sftp" ? !p.privateKeyPath : !!p.username;
    if (!needs) {
      this.output.appendLine(`[${p.name}] Anmeldung ohne Passwort (${p.protocol === "sftp" ? "Schlüssel " + p.privateKeyPath : "anonym"})`);
      return undefined;
    }
    const saved = await this.secrets.get(secretKey(p.name));
    if (saved !== undefined) {
      this.output.appendLine(`[${p.name}] Passwort aus dem Schlüsselbund`);
      return saved;
    }
    const typed = await vscode.window.showInputBox({
      prompt: `Passwort für ${p.username ?? ""}@${p.host}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (typed === undefined) throw vscode.FileSystemError.NoPermissions("Abgebrochen");
    await this.secrets.store(secretKey(p.name), typed);
    return typed;
  }

  get(authority: string): Promise<Backend> {
    const p = this.profileOf(authority);
    return once(this.open, p.name, async () => {
      const password = await this.password(p);
      const raw = p.protocol === "sftp" ? new SftpBackend(p, password, this.hostKeys) : new FtpBackend(p, password);
      return timed(raw, (line) => this.output.appendLine(`[${p.name}] ${line}`));
    }).then((b) => {
      this.changed.fire();
      return b;
    });
  }

  async forgetPassword(name: string): Promise<void> {
    await this.secrets.delete(secretKey(name));
    await this.drop(name);
  }

  async drop(name?: string): Promise<void> {
    const names = name ? [name] : [...this.open.keys()];
    for (const n of names) {
      const b = await this.open.get(n)?.catch(() => undefined);
      this.open.delete(n);
      await b?.close();
    }
    this.changed.fire();
  }
}
