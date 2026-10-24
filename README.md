# Craft Remote

VS Code-Erweiterung (Prototyp): SFTP-, FTP- und FTPS-Ordner erscheinen direkt im Explorer, ohne lokale Kopie.
Dateien werden beim Öffnen vom Server gelesen und beim Speichern direkt dorthin geschrieben.

## Benutzen

In der Seitenleiste gibt es ein Feld **Craft Remote** (Server-Symbol) mit allen Profilen. Ein grüner Punkt zeigt eine bestehende
Verbindung. Pro Zeile gibt es **Verbinden** (Stecker, auch per Klick) und **Trennen** (nimmt den Ordner aus dem Explorer und
schließt die Verbindung). Oben im Feld: Profil anlegen, Einstellungen, Zeitmessung. Rechtsklick: gespeichertes Passwort vergessen.
Eine Verbindung endet beim Trennen, beim Schließen oder Neuladen des Fensters und wenn der Server sie beendet (sie wird beim
nächsten Zugriff neu aufgebaut).

1. Befehlspalette (⇧⌘P) → **Craft Remote: Profil anlegen …** (Name, Protokoll, Server, Port, Benutzer, Schlüssel, Startordner).
   Profile stehen danach in den Einstellungen unter `craftRemote.profiles`.
2. **Craft Remote: Mit Profil verbinden …** → der Ordner wird als Workspace-Ordner hinzugefügt.
3. Das Passwort wird beim ersten Verbinden gefragt und im Schlüsselbund (VS Code `SecretStorage`) gespeichert.
   **Gespeichertes Passwort vergessen …** löscht es wieder.

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

- Ordner werden nicht überwacht: Änderungen von außen siehst du erst nach „Explorer aktualisieren“.
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
npm run package     # craft-remote-0.2.0.vsix
code --install-extension craft-remote-0.2.0.vsix
```

Zum Ausprobieren ohne Installation: Ordner in VS Code öffnen und F5 (Extension Development Host).
