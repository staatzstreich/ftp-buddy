import * as vscode from "vscode";
import { Profile } from "./backend";
import { Connections, askDeleteGroup, askRenameGroup, profiles } from "./backends";

/** The form for `ftpBuddy.profiles`: VS Code's own settings page can only show a JSON link for a list of objects. */
export class ProfileEditor {
  private static current: ProfileEditor | undefined;
  private subs: vscode.Disposable[] = [];

  static show(conns: Connections, select?: string) {
    if (ProfileEditor.current) {
      ProfileEditor.current.panel.reveal();
      ProfileEditor.current.post(select);
      return;
    }
    ProfileEditor.current = new ProfileEditor(conns, select);
  }

  private panel: vscode.WebviewPanel;

  private constructor(private conns: Connections, select?: string) {
    this.panel = vscode.window.createWebviewPanel("ftpBuddy.profileEditor", "FTP Buddy: Profile", vscode.ViewColumn.Active, { enableScripts: true });
    this.panel.webview.html = html();
    this.subs.push(
      this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("ftpBuddy.profiles") && this.post()),
      this.panel.onDidDispose(() => {
        ProfileEditor.current = undefined;
        this.subs.forEach((s) => s.dispose());
      }),
    );
    this.initialSelect = select;
  }

  private initialSelect: string | undefined;

  private post(select?: string) {
    void this.panel.webview.postMessage({ type: "profiles", profiles: profiles(), select });
  }

  private reply(type: string, text: string) {
    void this.panel.webview.postMessage({ type, text });
  }

  private async onMessage(m: { type: string; original?: string; profile?: Profile; name?: string; group?: string }) {
    const all = profiles();
    if (m.type === "ready") {
      this.post(this.initialSelect);
      this.initialSelect = undefined;
    } else if (m.type === "save" && m.profile) {
      const p = clean(m.profile);
      const problem = check(p, all, m.original);
      if (problem) return this.reply("error", problem);
      const at = m.original === undefined ? -1 : all.findIndex((x) => x.name === m.original);
      // Fields the form does not know (from a hand-edited settings.json) stay as they are.
      const next = at < 0 ? [...all, p] : all.map((x, i) => (i === at ? { ...x, ...blank(x), ...p } : x));
      await vscode.workspace.getConfiguration("ftpBuddy").update("profiles", next, vscode.ConfigurationTarget.Global);
      if (m.original !== undefined && m.original !== p.name) await this.conns.renamePassword(m.original, p.name);
      else await this.conns.drop(p.name);
      this.reply("saved", `„${p.name}“ gespeichert.`);
      this.post(p.name);
    } else if (m.type === "renameGroup" && m.group) {
      const to = await askRenameGroup(m.group);
      if (to !== undefined) void this.panel.webview.postMessage({ type: "groupRenamed", from: m.group, to });
    } else if (m.type === "deleteGroup" && m.group) {
      if (await askDeleteGroup(m.group)) void this.panel.webview.postMessage({ type: "groupDeleted", group: m.group });
    } else if (m.type === "delete" && m.name !== undefined) {
      const ok = await vscode.window.showWarningMessage(`Profil „${m.name}“ löschen?`, { modal: true, detail: "Das gespeicherte Passwort wird ebenfalls vergessen." }, "Löschen");
      if (ok !== "Löschen") return;
      await vscode.workspace.getConfiguration("ftpBuddy").update("profiles", all.filter((x) => x.name !== m.name), vscode.ConfigurationTarget.Global);
      await this.conns.forgetPassword(m.name);
      this.post();
    }
  }
}

const FIELDS = ["name", "group", "protocol", "host", "port", "username", "privateKeyPath", "useAgent", "remotePath", "localPath"] as const;

/** Empty fields are left out, so the settings stay as small as the ones made by hand. */
function clean(p: Profile): Profile {
  const out: Record<string, unknown> = {};
  for (const k of FIELDS) {
    const v = (p as unknown as Record<string, unknown>)[k];
    if (typeof v === "string") {
      if (v.trim() !== "") out[k] = v.trim();
    } else if (v === true) out[k] = true;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  // The agent and the key file only exist for SFTP.
  if (out.protocol !== "sftp") {
    delete out.useAgent;
    delete out.privateKeyPath;
  }
  return out as unknown as Profile;
}

/** The form's fields a saved profile had, set to `undefined`, so a field that was emptied is removed. */
function blank(old: Profile): Partial<Profile> {
  const out: Record<string, undefined> = {};
  for (const k of FIELDS) if (k in old) out[k] = undefined;
  return out as Partial<Profile>;
}

function check(p: Profile, all: Profile[], original: string | undefined): string | undefined {
  if (!p.name) return "Der Name fehlt.";
  if (!p.host) return "Der Server fehlt.";
  if (!["sftp", "ftp", "ftps", "ftps-implicit"].includes(p.protocol)) return "Das Protokoll fehlt.";
  if (p.port !== undefined && !(Number.isInteger(p.port) && p.port > 0 && p.port < 65536)) return "Der Port muss eine Zahl zwischen 1 und 65535 sein.";
  if (all.some((x) => x.name === p.name && x.name !== original)) return `Es gibt schon ein Profil „${p.name}“.`;
  return undefined;
}

function html(): string {
  const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2]).join("");
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style nonce="${nonce}">
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0; margin: 0; }
  .wrap { display: flex; min-height: 100vh; }
  aside { width: 240px; flex: none; border-right: 1px solid var(--vscode-panel-border); padding: 12px 0; }
  aside h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; margin: 0 16px 8px; color: var(--vscode-descriptionForeground); }
  .item { padding: 6px 16px; cursor: pointer; display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; }
  .item small { display: block; color: var(--vscode-descriptionForeground); }
  .grp { padding: 6px 16px; cursor: pointer; display: block; width: 100%; text-align: left; background: none; border: 0; color: inherit; font: inherit; font-weight: 600; }
  .grp:hover { background: var(--vscode-list-hoverBackground); }
  .grp span { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .in { padding-left: 28px; }
  a { color: var(--vscode-textLink-foreground); }
  .item:hover { background: var(--vscode-list-hoverBackground); }
  .item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .item.sel small { color: inherit; opacity: .8; }
  main { flex: 1; padding: 16px 28px; max-width: 640px; }
  h1 { font-size: 1.4em; font-weight: 600; margin: 0 0 16px; }
  .row { margin-bottom: 16px; }
  label { display: block; font-weight: 600; margin-bottom: 4px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 3px; }
  input[type=text], input[type=number], select { width: 100%; box-sizing: border-box; padding: 4px 6px; font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .check label { display: inline; font-weight: 600; margin-left: 6px; }
  .buttons { display: flex; gap: 8px; margin-top: 24px; align-items: center; }
  button.b { padding: 5px 14px; font: inherit; cursor: pointer; border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.b:hover { background: var(--vscode-button-hoverBackground); }
  button.b.second { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.b.second:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.b.danger { margin-left: auto; }
  #msg { font-size: 12px; }
  #msg.error { color: var(--vscode-errorForeground); }
  .empty { padding: 0 16px; color: var(--vscode-descriptionForeground); }
</style></head>
<body><div class="wrap">
<aside><h2>Profile</h2><div id="list"></div>
  <div style="padding:8px 16px"><button class="b second" id="new">+ Neues Profil</button></div></aside>
<main>
  <h1 id="title">Neues Profil</h1>
  <div class="row"><label for="name">Name</label><input type="text" id="name"><div class="hint">Erscheint in der Seitenleiste.</div></div>
  <div class="row"><label for="group">Gruppe</label><select id="groupSel"></select><input type="text" id="group" placeholder="Name der neuen Gruppe" style="margin-top:6px"><div class="hint">Optional. Profile mit gleicher Gruppe stehen in der Seitenleiste zusammen in einem aufklappbaren Ordner. <span id="groupLinks"><a href="#" id="renameGroup">Gruppe umbenennen …</a> · <a href="#" id="deleteGroup">Gruppe löschen …</a></span></div></div>
  <div class="row"><label for="protocol">Protokoll</label>
    <select id="protocol">
      <option value="sftp">SFTP (über SSH)</option>
      <option value="ftp">FTP (unverschlüsselt)</option>
      <option value="ftps">FTPS explizit (FTP mit TLS, Port 21)</option>
      <option value="ftps-implicit">FTPS implizit (meist Port 990)</option></select></div>
  <div class="row"><label for="host">Server</label><input type="text" id="host"><div class="hint" id="hostHint">Hostname, IP oder (bei SFTP) ein Alias aus ~/.ssh/config.</div></div>
  <div class="row"><label for="port">Port</label><input type="number" id="port" min="1" max="65535"><div class="hint">Leer = Standard.</div></div>
  <div class="row"><label for="username">Benutzer</label><input type="text" id="username"><div class="hint" id="userHint"></div></div>
  <div class="row sftp"><label for="privateKeyPath">Schlüsseldatei</label><input type="text" id="privateKeyPath" placeholder="~/.ssh/id_ed25519"><div class="hint">Nur SFTP. Leer = Passwort bzw. IdentityFile aus ~/.ssh/config.</div></div>
  <div class="row sftp check"><input type="checkbox" id="useAgent"><label for="useAgent">ssh-agent verwenden</label><div class="hint">Nur SFTP. Nimmt die Schlüssel des laufenden ssh-agent (SSH_AUTH_SOCK).</div></div>
  <div class="row"><label for="remotePath">Startordner auf dem Server</label><input type="text" id="remotePath"><div class="hint">Leer = Home-Ordner nach dem Login.</div></div>
  <div class="row"><label for="localPath">Passender lokaler Ordner</label><input type="text" id="localPath" placeholder="~/Developer/projekt"><div class="hint">Beim Hoch- und Herunterladen bleibt dann die Ordnerstruktur erhalten.</div></div>
  <div class="hint">Das Passwort wird nicht hier gespeichert: Es wird beim ersten Verbinden abgefragt und im Schlüsselbund abgelegt.</div>
  <div class="buttons"><button class="b" id="save">Speichern</button><span id="msg"></span><button class="b second danger" id="del">Löschen</button></div>
</main></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const text = ["name", "group", "host", "username", "privateKeyPath", "remotePath", "localPath"];
  let profiles = [];
  let original; // name of the profile in the form, undefined for a new one
  let dirty = false;
  const closed = new Set(); // groups folded in the list
  const NONE = "", NEW = "__new__";

  function msg(t, error) { $("msg").textContent = t; $("msg").className = error ? "error" : ""; }
  function protocolChanged() {
    const sftp = $("protocol").value === "sftp";
    document.querySelectorAll(".sftp").forEach((e) => (e.style.display = sftp ? "" : "none"));
    $("userHint").textContent = sftp ? "Leer = User aus ~/.ssh/config." : "Leer = anonym.";
    $("port").placeholder = { sftp: 22, ftp: 21, ftps: 21, "ftps-implicit": 990 }[$("protocol").value];
  }
  function fill(p) {
    original = p ? p.name : undefined;
    $("title").textContent = p ? p.name : "Neues Profil";
    for (const k of text) $(k).value = (p && p[k]) || "";
    $("protocol").value = (p && p.protocol) || "sftp";
    $("port").value = p && p.port ? p.port : "";
    $("useAgent").checked = !!(p && p.useAgent);
    $("del").style.display = p ? "" : "none";
    dirty = false; msg("");
    protocolChanged(); renderList();
  }
  function syncGroup() {
    const known = [...new Set(profiles.map((p) => p.group).filter(Boolean))].sort();
    const sel = $("groupSel"); sel.textContent = "";
    const add = (v, t) => { const o = document.createElement("option"); o.value = v; o.textContent = t; sel.append(o); };
    add(NONE, "(keine Gruppe)");
    for (const g of known) add(g, g);
    add(NEW, "Neue Gruppe \u2026");
    const v = $("group").value.trim();
    sel.value = v === "" ? NONE : known.includes(v) ? v : NEW;
    $("group").style.display = sel.value === NEW ? "" : "none";
    $("groupLinks").style.display = sel.value === NONE || sel.value === NEW ? "none" : "";
  }
  function renderList() {
    syncGroup();
    const list = $("list"); list.textContent = "";
    if (!profiles.length) { const e = document.createElement("div"); e.className = "empty"; e.textContent = "Noch keine Profile."; list.append(e); }
    const item = (p, nested) => {
      const b = document.createElement("button");
      b.className = "item" + (p.name === original ? " sel" : "") + (nested ? " in" : "");
      b.append(document.createTextNode(p.name));
      const s = document.createElement("small"); s.textContent = p.protocol + "://" + p.host; b.append(s);
      b.onclick = () => fill(p);
      return b;
    };
    const groups = [...new Set(profiles.map((p) => p.group).filter(Boolean))].sort();
    for (const g of groups) {
      const members = profiles.filter((p) => p.group === g);
      const h = document.createElement("button");
      h.className = "grp";
      h.append(document.createTextNode((closed.has(g) ? "\u25B8 " : "\u25BE ") + g + " "));
      const c = document.createElement("span"); c.textContent = members.length; h.append(c);
      h.onclick = () => { closed.has(g) ? closed.delete(g) : closed.add(g); renderList(); };
      list.append(h);
      if (!closed.has(g)) for (const p of members) list.append(item(p, true));
    }
    for (const p of profiles.filter((p) => !p.group)) list.append(item(p, false));
  }
  function read() {
    const p = { protocol: $("protocol").value, useAgent: $("useAgent").checked };
    for (const k of text) p[k] = $(k).value;
    p.port = $("port").value === "" ? undefined : Number($("port").value);
    return p;
  }
  $("save").onclick = () => vscode.postMessage({ type: "save", original, profile: read() });
  $("del").onclick = () => original !== undefined && vscode.postMessage({ type: "delete", name: original });
  $("new").onclick = () => fill(undefined);
  $("protocol").onchange = protocolChanged;
  $("renameGroup").onclick = (e) => {
    e.preventDefault();
    const g = $("groupSel").value;
    if (g !== NONE && g !== NEW) vscode.postMessage({ type: "renameGroup", group: g });
  };
  $("deleteGroup").onclick = (e) => {
    e.preventDefault();
    const g = $("groupSel").value;
    if (g !== NONE && g !== NEW) vscode.postMessage({ type: "deleteGroup", group: g });
  };
  $("groupSel").onchange = () => {
    const v = $("groupSel").value;
    $("group").value = v === NEW ? "" : v;
    $("group").style.display = v === NEW ? "" : "none";
    if (v === NEW) $("group").focus();
    dirty = true; msg("");
  };
  document.querySelectorAll("input,select").forEach((e) => e.addEventListener("input", () => { dirty = true; msg(""); }));
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "profiles") {
      profiles = m.profiles;
      const target = m.select !== undefined ? profiles.find((p) => p.name === m.select) : undefined;
      if (target) fill(target);
      else if (original !== undefined && !profiles.some((p) => p.name === original)) fill(profiles[0]);
      else if (original !== undefined && !dirty) fill(profiles.find((p) => p.name === original));
      else renderList();
    } else if (m.type === "groupRenamed") {
      // the form still shows the old name; the list arrives with the settings change
      if ($("group").value.trim() === m.from) $("group").value = m.to;
      if (closed.delete(m.from)) closed.add(m.to);
      renderList();
    } else if (m.type === "groupDeleted") {
      if ($("group").value.trim() === m.group) $("group").value = "";
      closed.delete(m.group);
      renderList();
    } else if (m.type === "error") msg(m.text, true);
    else if (m.type === "saved") msg(m.text);
  });
  fill(undefined);
  vscode.postMessage({ type: "ready" });
</script></body></html>`;
}
