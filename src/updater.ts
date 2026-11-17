import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { REPO, Release, Update, updateFrom } from "./update";

const DAY = 24 * 60 * 60 * 1000;
const LAST_CHECK = "update.lastCheck";
const SKIPPED = "update.skippedVersion";

/**
 * Looks for a newer release on GitHub and offers to install it. Nothing is installed without a click.
 * Automatic checks run at most once a day; the command checks right away and also says when there is nothing new.
 */
export class Updater {
  private busy = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  private get current(): string {
    return String(this.context.extension.packageJSON.version);
  }

  /** Called on start, a little later so it does not compete with connecting. */
  scheduleAutomatic(): vscode.Disposable {
    const timer = setTimeout(() => void this.check(false), 15_000);
    return { dispose: () => clearTimeout(timer) };
  }

  async check(manual: boolean): Promise<void> {
    if (this.busy) return;
    const state = this.context.globalState;
    if (!manual) {
      if (!vscode.workspace.getConfiguration("ftpBuddy").get<boolean>("checkForUpdates", true)) return;
      if (Date.now() - state.get<number>(LAST_CHECK, 0) < DAY) return;
    }
    this.busy = true;
    try {
      let update: Update | undefined;
      try {
        update = await this.latest();
        await state.update(LAST_CHECK, Date.now());
      } catch (e) {
        this.output.appendLine(`[Update] Prüfung fehlgeschlagen: ${message(e)}`);
        if (manual) vscode.window.showErrorMessage(`Suche nach Updates fehlgeschlagen: ${message(e)}`);
        return;
      }
      if (!update) {
        if (manual) vscode.window.showInformationMessage(`FTP Buddy ${this.current} ist die neueste Version.`);
        return;
      }
      if (!manual && state.get<string>(SKIPPED) === update.version) return;
      await this.offer(update);
    } finally {
      this.busy = false;
    }
  }

  private async latest(): Promise<Update | undefined> {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "ftp-buddy-updater" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`GitHub antwortet ${res.status} ${res.statusText}`);
    return updateFrom((await res.json()) as Release, this.current);
  }

  private async offer(update: Update): Promise<void> {
    const install = "Installieren";
    const notes = "Was ist neu?";
    const skip = "Diese Version überspringen";
    const choice = await vscode.window.showInformationMessage(
      `FTP Buddy ${update.version} ist verfügbar (installiert: ${this.current}).`,
      install,
      notes,
      skip,
    );
    if (choice === skip) await this.context.globalState.update(SKIPPED, update.version);
    if (choice === notes) {
      await vscode.env.openExternal(vscode.Uri.parse(update.page));
      return this.offer(update);
    }
    if (choice === install) await this.install(update);
  }

  private async install(update: Update): Promise<void> {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `FTP Buddy ${update.version} wird installiert …` },
        async () => {
          const res = await fetch(update.url, { headers: { "User-Agent": "ftp-buddy-updater" }, signal: AbortSignal.timeout(120_000) });
          if (!res.ok) throw new Error(`Download: ${res.status} ${res.statusText}`);
          const data = new Uint8Array(await res.arrayBuffer());
          if (data.length !== update.size) throw new Error(`Download unvollständig (${data.length} von ${update.size} Bytes)`);
          if (update.sha256) {
            const got = createHash("sha256").update(data).digest("hex");
            if (got !== update.sha256) throw new Error("Prüfsumme stimmt nicht, Datei wurde nicht installiert");
          }
          const dir = this.context.globalStorageUri;
          await vscode.workspace.fs.createDirectory(dir);
          const file = vscode.Uri.joinPath(dir, `ftp-buddy-${update.version}.vsix`);
          await vscode.workspace.fs.writeFile(file, data);
          try {
            await vscode.commands.executeCommand("workbench.extensions.installExtension", file);
          } finally {
            await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
          }
        },
      );
    } catch (e) {
      this.output.appendLine(`[Update] Installation fehlgeschlagen: ${message(e)}`);
      vscode.window.showErrorMessage(`Update auf FTP Buddy ${update.version} fehlgeschlagen: ${message(e)}`);
      return;
    }
    this.output.appendLine(`[Update] ${update.version} installiert`);
    const reload = "Fenster neu laden";
    const go = await vscode.window.showInformationMessage(
      `FTP Buddy ${update.version} ist installiert. Nach dem Neuladen des Fensters ist es aktiv.`,
      reload,
    );
    if (go === reload) await vscode.commands.executeCommand("workbench.action.reloadWindow");
  }
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
