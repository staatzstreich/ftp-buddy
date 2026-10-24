# Craft Remote

VS Code-Erweiterung (Prototyp): SFTP-, FTP- und FTPS-Ordner erscheinen direkt im Explorer, ohne lokale Kopie.
Dateien werden beim Öffnen vom Server gelesen und beim Speichern direkt dorthin geschrieben.

## Benutzen

In der Seitenleiste gibt es ein Feld **Craft Remote** (Server-Symbol) mit allen Profilen. Ein grüner Punkt zeigt eine bestehende
Verbindung. Pro Profil gibt es **Verbinden** (Stecker, auch per Klick auf die Zeile) und **Trennen**. Ein verbundenes Profil klappt
auf: darunter stehen Ordner und Dateien des Servers. Ein Klick auf eine Datei öffnet sie in einem normalen Tab, **Speichern**
schreibt direkt auf den Server. Es gibt keinen Explorer-Ordner, keinen Workspace und kein zusätzliches Fenster.

Rechtsklick auf Ordner und Dateien: Neue Datei, Neuer Ordner, Umbenennen, Löschen (Ordner mit Inhalt, nach Rückfrage), Pfad kopieren.
**Ordner-Zuordnung (`localPath`):** Trägst du im Profil zusätzlich zum Startordner (`remotePath`, sonst dem Login-Ordner) einen lokalen
Ordner ein, gelten beide als „dieselbe Stelle“. Hochladen aus dem Explorer legt eine Datei dann an der passenden Stelle auf dem Server ab
(`~/Developer/projekt/css/main.css` → `<remotePath>/css/main.css`), ohne dass du ein Ziel wählst. Herunterladen aus dem Baum
legt sie in den passenden lokalen Ordner, fehlende Unterordner werden angelegt. Alles außerhalb der Zuordnung läuft wie unten beschrieben.
Der Zuordnungs-Ordner selbst überträgt seinen Inhalt, nicht eine Kopie seines Namens.

```json
{ "name": "Lab", "protocol": "sftp", "host": "staatzstreich.de", "port": 23,
  "remotePath": "/web/lab.staatzstreich.de", "localPath": "~/Developer/staatzstreich-lab" }
```

**Hochladen aus dem VS Code-Explorer:** Dateien oder Ordner im Explorer markieren (auch mehrere), Rechtsklick →
**Zu Craft Remote hochladen**. Ziel ist der Ordner, den du im Baum **Craft Remote** markiert hast; ist dort nichts markiert, der
Startordner des Servers. Sind mehrere Server verbunden, fragt VS Code, welcher. Der Fortschritt nennt das Ziel.

**Herunterladen:** im Baum Datei(en) oder Ordner markieren, Rechtsklick → **Herunterladen**. Sie landen im Ordner deines Workspaces
(bei mehreren Ordnern fragt VS Code; ohne geöffneten Ordner erscheint eine Ordnerauswahl). Danach kannst du sie im Explorer
an die richtige Stelle ziehen.

Zusätzlich gibt es im Baum bei Ordnern **Hochladen …** mit der Dateiauswahl des Mac, falls du etwas von außerhalb des Workspaces brauchst.
Beides zeigt einen Fortschritt mit „Abbrechen“. Gibt es eine Datei schon, fragt ein Dialog:
Überschreiben, Überspringen, Alle überschreiben, Alle überspringen. Ordner werden samt Inhalt übertragen, leere Ordner auch;
symbolische Links werden beim Hochladen übersprungen.

Oben im Feld: Aktualisieren, Profil anlegen, Einstellungen, Zeitmessung. Rechtsklick auf ein Profil: gespeichertes Passwort vergessen.

Eine Verbindung endet beim Trennen, beim Schließen oder Neuladen des Fensters und wenn der Server sie beendet (sie wird beim
nächsten Zugriff neu aufgebaut). Geöffnete Dateien bleiben nach dem Trennen in ihren Tabs.

Die Einrichtung:

1. Befehlspalette (⇧⌘P) → **Craft Remote: Profil anlegen …** (Name, Protokoll, Server, Port, Benutzer, Schlüssel, Startordner).
   Profile stehen danach in den Einstellungen unter `craftRemote.profiles`.
2. Im Feld **Craft Remote** auf das Profil klicken.
3. Das Passwort wird beim ersten Verbinden gefragt und im Schlüsselbund (VS Code `SecretStorage`) gespeichert.

Beim ersten Kontakt mit einem SFTP-Server zeigt ein Dialog den Fingerabdruck (Trust on first use). Ändert er sich später,
wird die Verbindung abgelehnt. **Bekannte Server vergessen** setzt das zurück.

| Befehl | Wirkung |
|---|---|
| Craft Remote: Mit Profil verbinden … | Profil wählen, Ordner im Explorer öffnen |
| Craft Remote: Profil anlegen … | Eingabefolge, speichert in den Einstellungen |
| Craft Remote: Profile bearbeiten | Öffnet die Einstellung `craftRemote.profiles` |
| Craft Remote: Gespeichertes Passwort vergessen … | Passwort aus dem Schlüsselbund löschen |
| Craft Remote: Bekannte Server vergessen | SFTP-Fingerabdrücke löschen |
| Craft Remote: Verbindung neu aufbauen | Alle Verbindungen schließen, beim nächsten Zugriff neu öffnen |

Beispielprofil:

```json
"craftRemote.profiles": [
  { "name": "Kunde Müller", "protocol": "ftps", "host": "ftp.example.com", "username": "web123", "remotePath": "/htdocs" },
  { "name": "Server", "protocol": "sftp", "host": "example.org", "username": "michael", "privateKeyPath": "~/.ssh/id_ed25519" }
]
```

## Grenzen des Prototyps

- Ordner werden nicht überwacht: Änderungen von außen siehst du erst nach „Aktualisieren“ (Pfeil oben im Feld).
- Hoch- und Herunterladen nur über die Befehle, nicht per Drag & Drop; jede Datei wird komplett im Speicher gehalten. Keine Suche über den Server.
- Kein Terminal, keine Language Server auf Remote-Dateien (viele Erweiterungen sind auf `file:` beschränkt).
- Große Dateien werden komplett in den Speicher gelesen; Ordner löschen geht Datei für Datei.
- FTP: keine Zeitstempel bei Servern ohne MLSD; Symlinks werden durch Auflisten als Ordner erkannt.
- Nur Passwort oder Schlüssel (mit oder ohne Passphrase); kein ssh-agent, kein `~/.ssh/config`.
- Nicht im echten VS Code-Fenster geprüft, nur die Protokollschicht per Tests (siehe unten).

## Entwickeln

```sh
npm install
npm test            # FTP (ftp-srv) und SFTP (lokaler sshd) gegen dieselben Vertragstests
npm run typecheck
npm run build       # out/extension.js
npm run package     # craft-remote-0.6.0.vsix
code --install-extension craft-remote-0.6.0.vsix
```

Zum Ausprobieren ohne Installation: Ordner in VS Code öffnen und F5 (Extension Development Host).
