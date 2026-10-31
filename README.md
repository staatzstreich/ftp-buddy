# FTP Buddy

VS Code-Erweiterung (Prototyp): SFTP-, FTP- und FTPS-Ordner erscheinen direkt im Explorer, ohne lokale Kopie.
Dateien werden beim Öffnen vom Server gelesen und beim Speichern direkt dorthin geschrieben.

## Benutzen

In der Seitenleiste gibt es ein Feld **FTP Buddy** (Server-Symbol) mit allen Profilen. Ein grüner Punkt zeigt eine bestehende
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
{ "name": "Lab", "protocol": "sftp", "host": "sftp.example.com", "port": 22,
  "remotePath": "/web/lab", "localPath": "~/Developer/lab" }
```

**Hochladen aus dem VS Code-Explorer:** Dateien oder Ordner im Explorer markieren (auch mehrere), Rechtsklick →
**Zu FTP Buddy hochladen**. Ziel ist der Ordner, den du im Baum **FTP Buddy** markiert hast; ist dort nichts markiert, der
Startordner des Servers. Sind mehrere Server verbunden, fragt VS Code, welcher. Der Fortschritt nennt das Ziel.

**Herunterladen:** im Baum Datei(en) oder Ordner markieren, Rechtsklick → **Herunterladen**. Sie landen im Ordner deines Workspaces
(bei mehreren Ordnern fragt VS Code; ohne geöffneten Ordner erscheint eine Ordnerauswahl). Danach kannst du sie im Explorer
an die richtige Stelle ziehen.

Zusätzlich gibt es im Baum bei Ordnern **Hochladen …** mit der Dateiauswahl des Mac, falls du etwas von außerhalb des Workspaces brauchst.
Beides zeigt einen Fortschritt mit „Abbrechen“. Gibt es eine Datei schon, fragt ein Dialog:
Überschreiben, Überspringen, Alle überschreiben, Alle überspringen. Ordner werden samt Inhalt übertragen, leere Ordner auch;
symbolische Links werden beim Hochladen übersprungen.

Oben im Feld: Aktualisieren, Profil anlegen, Einstellungen, Zeitmessung. Rechtsklick auf ein Profil: gespeichertes Passwort vergessen.

**Andere Ebene anzeigen:** Der Baum beginnt im Startordner des Profils. Am verbundenen Profil gibt es den Pfeil **Eine Ebene höher**
(Symbol in der Zeile) und im Rechtsklick-Menü **Wurzelverzeichnis / anzeigen** und **Zum Startordner**; auf einem Ordner
**Hier als oberste Ebene anzeigen**. Das Profil zeigt dann „· zeigt /pfad“ an. Das ändert nur die Ansicht: die Ordner-Zuordnung
(`localPath`) bleibt am Startordner. Darf der Server den Ordner nicht auflisten, bleibt die Ansicht, wie sie war.

Eine Verbindung endet beim Trennen, beim Schließen oder Neuladen des Fensters und wenn der Server sie beendet (sie wird beim
nächsten Zugriff neu aufgebaut). Geöffnete Dateien bleiben nach dem Trennen in ihren Tabs.

Die Einrichtung:

1. Befehlspalette (⇧⌘P) → **FTP Buddy: Profil anlegen …** (Name, Protokoll, Server, Port, Benutzer, Schlüssel, Startordner).
   Profile stehen danach in den Einstellungen unter `ftpBuddy.profiles`.
2. Im Feld **FTP Buddy** auf das Profil klicken.
3. Das Passwort wird beim ersten Verbinden gefragt und im Schlüsselbund (VS Code `SecretStorage`) gespeichert.

Beim ersten Kontakt mit einem SFTP-Server zeigt ein Dialog den Fingerabdruck (Trust on first use). Ändert er sich später,
wird die Verbindung abgelehnt. **Bekannte Server vergessen** setzt das zurück.

| Befehl | Wirkung |
|---|---|
| FTP Buddy: Mit Profil verbinden … | Profil wählen, Ordner im Explorer öffnen |
| FTP Buddy: Profil anlegen … | Eingabefolge, speichert in den Einstellungen |
| FTP Buddy: Profile bearbeiten | Öffnet die Einstellung `ftpBuddy.profiles` |
| FTP Buddy: Gespeichertes Passwort vergessen … | Passwort aus dem Schlüsselbund löschen |
| FTP Buddy: Bekannte Server vergessen | SFTP-Fingerabdrücke löschen |
| FTP Buddy: Verbindung neu aufbauen | Alle Verbindungen schließen, beim nächsten Zugriff neu öffnen |

Beispielprofil:

```json
"ftpBuddy.profiles": [
  { "name": "Kunde Müller", "protocol": "ftps", "host": "ftp.example.com", "username": "web123", "remotePath": "/htdocs" },
  { "name": "Server", "protocol": "sftp", "host": "example.org", "username": "benutzer", "privateKeyPath": "~/.ssh/id_ed25519" },
  { "name": "Per Agent", "protocol": "sftp", "host": "example.org", "username": "benutzer", "useAgent": true },
  { "name": "Per Config", "protocol": "sftp", "host": "shop" }
]
```

## SSH-Agent und `~/.ssh/config`

- **`"useAgent": true`** nimmt die Schlüssel des laufenden ssh-agent (`SSH_AUTH_SOCK`). Dort können auch Schlüssel mit Passphrase
  liegen (`ssh-add --apple-use-keychain`); FTP Buddy fragt dann nach nichts. Ohne Agent kommt eine klare Fehlermeldung.
- Bei SFTP darf `host` ein **Alias aus `~/.ssh/config`** sein. Daraus werden `HostName`, `Port`, `User` und `IdentityFile` übernommen;
  was im Profil selbst steht, hat Vorrang. Unterstützt: `Host` mit `*`, `?` und `!`-Mustern, wie bei ssh gilt der erste Treffer.
  Nicht unterstützt: `Match`, `Include`, `ProxyJump`.
- Schlüsseldateien (`privateKeyPath`/`IdentityFile`) werden nur ohne Passphrase gelesen; für Schlüssel mit Passphrase den Agenten nehmen.

## FTPS und Zertifikate

FTPS (explizit, Port 21, `ftps`) prüft das Zertifikat des Servers. Kennt dein Mac die ausstellende Stelle, geht es ohne Rückfrage. Ist das
Zertifikat selbst signiert oder stammt von einer Firmen-CA, die nur im macOS-Schlüsselbund steht (Node benutzt den Schlüsselbund
nicht), zeigt ein Dialog **einmal** den Fingerabdruck. Nach „Vertrauen“ wird genau dieses Zertifikat gemerkt, für die Anmeldung
und für jede Datenverbindung; ein anderes wird abgelehnt. Vor der Bestätigung wird kein Benutzername und kein Passwort gesendet.
**Bekannte Server vergessen** löscht die gemerkten Fingerabdrücke (SFTP und FTPS). Beides gilt auch für **implizites FTPS** (Protokoll `ftps-implicit`, meist Port 990, von der ersten Zeile an verschlüsselt).

Meldet der Server `421`, hat er die Verbindung abgelehnt, oft wegen eines Limits gleichzeitiger Verbindungen: andere FTP-Programme
schließen. Das Ausgabefenster „FTP Buddy“ zeigt bei FTP den ganzen Befehlsdialog (Passwörter sind maskiert), damit sich Probleme
nachvollziehen lassen.

## Grenzen des Prototyps

- Ordner werden nicht überwacht: Änderungen von außen siehst du erst nach „Aktualisieren“ (Pfeil oben im Feld).
- Hoch- und Herunterladen nur über die Befehle, nicht per Drag & Drop; jede Datei wird komplett im Speicher gehalten. Keine Suche über den Server.
- Kein Terminal, keine Language Server auf Remote-Dateien (viele Erweiterungen sind auf `file:` beschränkt).
- Große Dateien werden komplett in den Speicher gelesen; Ordner löschen geht Datei für Datei.
- FTP: keine Zeitstempel bei Servern ohne MLSD; Symlinks werden durch Auflisten als Ordner erkannt.
- SFTP: Passwort, Schlüsseldatei ohne Passphrase oder ssh-agent; `~/.ssh/config` nur mit `Host`/`HostName`/`Port`/`User`/`IdentityFile` (kein `Match`, `Include`, `ProxyJump`).
- Nicht im echten VS Code-Fenster geprüft, nur die Protokollschicht per Tests (siehe unten).

## Installieren

Aus einer fertigen Paketdatei (`ftp-buddy-<version>.vsix`, etwa von der Release-Seite des Repositorys):

```sh
code --install-extension ftp-buddy-0.10.0.vsix
```

Oder aus dem Quelltext (braucht Node.js 20 oder neuer):

```sh
git clone <Adresse des Repositorys> && cd ftp-buddy
npm install
npm run package
code --install-extension ftp-buddy-0.10.0.vsix
```

Danach das Fenster neu laden (⇧⌘P → „Developer: Reload Window“). Deine Profile stehen in den Einstellungen unter `ftpBuddy.profiles`.

## Entwickeln

```sh
npm install
npm test            # FTP (ftp-srv) und SFTP (lokaler sshd) gegen dieselben Vertragstests
npm run typecheck
npm run build       # out/extension.js
npm run package     # ftp-buddy-0.10.0.vsix
code --install-extension ftp-buddy-0.10.0.vsix
```

Zum Ausprobieren ohne Installation: Ordner in VS Code öffnen und F5 (Extension Development Host).
