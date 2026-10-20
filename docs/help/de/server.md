# Eigenständiger Server

Betreiben Sie CodeNomad dort, wo Ihre Projekte und Werkzeuge liegen, und verwenden Sie dessen Browseroberfläche lokal oder entfernt. Das Backend bietet Dateisystemzugriff, Git-Vorgänge, Authentifizierung und Ereigniszustellung. OpenCodes gemeinsamer Dienst verwaltet Unterhaltungen und Ausführung; er ist kein untergeordneter Server, der bei Browsertrennung gestoppt werden soll.

Dieselbe Oberfläche unterstützt [mehrere Projekt-Tabs und Worktrees](projects.md), [Unterhaltungsfamilien und Hintergrundaktivität](conversations.md), [begrenztes Verlaufsladen, Suche und Timeline-Navigation](history.md) sowie [Befehlspalette und Tastenkürzel](shortcuts.md). Browser- und Tablet-Zugriff verlagern die Ausführung nicht vom Host.

## Host vorbereiten {#prerequisites}

1. Installieren Sie Node.js 24 LTS und npm; die festgelegte Build-Laufzeit des Repositorys ist 24.20.0. Desktop-Pakete enthalten Node/npm.
2. Stellen Sie Git im **PATH des Backend-Prozesses** bereit. Git allein in WSL genügt für ein Windows-Backend nicht.
3. Installieren oder wählen Sie OpenCode: Erforderliches Minimum ist **2.1.0**, empfohlenes Qualifizierungsziel **2.1.0**. Neuere/angepasste Builds durchlaufen Kompatibilitätsprüfungen, keine Positivliste getesteter Versionen. Siehe [OpenCode-Einrichtung](opencode.md).
4. Wählen Sie den Startordner des Servers oder übergeben Sie `--workspace-root` ausdrücklich.

Ohne Git bleiben Unterhaltungen nur im ausdrücklich geöffneten physischen Ordner verfügbar; Git- und Worktree-Vorgänge schlagen fehl. Installieren Sie Git und starten Sie das Backend nach einer PATH-Änderung neu. Das Arbeitsbereichs-Stammverzeichnis begrenzt Öffnen/Durchsuchen, nicht Agentenausführung: siehe [Sicherheit](security.md).

## Ausführen oder installieren {#run}

Wählen Sie eine Installationsmethode. Diese Erststartbeispiele verwenden lokale Ersteinrichtung statt eines Passworts im Shell-Verlauf:

### Mit npx ausführen {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Global installieren {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### In einem Projekt installieren {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad` verwendet die im Projekt installierte Programmdatei, falls vorhanden. Dies installiert das Paket im Projekt; Konfiguration oder OpenCode-Speicher werden dadurch **nicht** projektlokal.

1. Öffnen Sie die ausgegebene **Local Connection URL** auf dem Host. Schließen Sie die [lokale Ersteinrichtung](security.md) ab und speichern Sie dann ein dauerhaftes Serverpasswort. Dieses Verfahren enthält eine reine Loopback-HTTP-Einrichtungsoption, falls noch kein HTTPS-Vertrauen eingerichtet ist.
2. Lassen Sie bei späteren Starts `--generate-token` weg; alternativ übergeben Sie bei jedem Start `CODENOMAD_SERVER_PASSWORD`.
3. Prüfen Sie mit `codenomad --help` die Optionen der installierten CLI.

Die Befehle laufen im Vordergrund. Terminal-Schließen oder Ctrl+C stoppt dieses Backend und dessen Fernsteuerungsverbindung. `--launch` öffnet nur einen Browser; es macht den Server nicht zum Daemon. Für unbeaufsichtigte Verfügbarkeit führen Sie denselben Befehl über Ihre OS-Prozess-/Dienstverwaltung mit expliziter Konfiguration, Arbeitsverzeichnis, Umgebung und Neustartrichtlinie aus. Schreiben Sie keine Geheimnisse in Dienstlogs oder öffentliche Unit-Dateien.

Browser-Schließen stoppt kein separat laufendes eigenständiges Backend. Das Schließen eines Projekt-Tabs schließt das Projekt in CodeNomad und beendet dessen Verfolgung durch CodeNomad; Sitzungen laufen in OpenCode weiter und sind nach erneutem Öffnen des Projekts wieder verfügbar. Die native Location und der gemeinsame Daemon werden dabei nicht entfernt oder beendet. Auch Backend-Ende lässt den OpenCode-Dienst laufen. Backend-abhängige Funktionen fehlen bis zur Rückkehr von CodeNomad; die separate Lebensdauer nativer Planung erläutert [Missionen](missions.md).

## Adressen und Ports {#addresses}

Beim Start werden **Local Connection URL**, gegebenenfalls **Remote Connection URL** sowie bei Bedarf **Other Accessible URLs** ausgegeben. Verwenden Sie ausgegebenes Schema und Port, keine geratene Adresse. Eine Loopback-URL ist nur auf diesem Rechner erreichbar; eine ausgegebene LAN-Adresse benötigt weiterhin Routing und Firewallzugriff.

HTTPS bevorzugt Port **9898**, HTTP **9899**. Ohne Portüberschreibung wird bei belegtem bevorzugtem Port ein OS-zugewiesener Port verwendet. Ein expliziter Nichtnull-Port weicht nicht aus; `0` fordert einen OS-zugewiesenen Port. Ports akzeptieren Ganzzahlen von 0 bis 65535.

Listenerfreigabe, Zertifikate, VPN/SSH und Reverse-Proxys erläutert [Direkter Fernzugriff](remote-access.md). Für Zugriff ohne eingehenden Port verwenden Sie [Fernsteuerung](remote-control.md).

## Öffentliche CLI-Referenz {#cli-reference}

Flags übersteuern ihre Umgebungsentsprechungen. Flags mit Wert verwenden das gezeigte Argument; Schalter nicht. HTTPS-/HTTP-Werte erkennen `1`, `true`, `yes`, `y` und `on` unabhängig von Groß-/Kleinschreibung als aktiviert; verwenden Sie zur Klarheit explizites `true`/`false`. Automatische UI-Updates erkennen `1`, `true` und `yes`.

**Strikt boolesche Umgebungsvariablen** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` und `CODENOMAD_SKIP_AUTH`) aktivieren ihre Schalter mit `1`, `true`, `yes` oder `on`; Groß-/Kleinschreibung und umgebende Leerzeichen werden ignoriert. `0`, `false`, `no`, `off`, leere oder nur aus Leerzeichen bestehende Werte sowie nicht gesetzte Variablen lassen die Schalter aus. Jeder andere Wert verhindert den Serverstart, auch mit dem entsprechenden CLI-Flag. Ein CLI-Flag aktiviert seinen Schalter trotz eines gültigen Aus-Werts; andernfalls gelten die folgenden `false`-Standards.

| Flag | Umgebung | Standard und Wirkung |
| --- | --- | --- |
| `-h, --help` | — | Hilfe ausgeben und beenden. |
| `-v, --version` | — | Installierte Paketversion ausgeben und beenden. |
| `--host <host>` | `CLI_HOST` | `127.0.0.1`; `localhost` wird auf IPv4-Loopback normalisiert. IPv6-Zonenkennungen werden abgelehnt. Siehe [Bindungsmatrix](remote-access.md). |
| `--https <enabled>` | `CLI_HTTPS` | `true`; HTTPS-Listener. |
| `--http <enabled>` | `CLI_HTTP` | `false`; HTTP-Listener. Mindestens ein Listener muss aktiviert sein. |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` bevorzugt; `0` automatisch. |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` bevorzugt; `0` automatisch. |
| `--tls-key <path>` | `CLI_TLS_KEY` | Nicht gesetzt; privater PEM-Schlüssel, benötigt `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | Nicht gesetzt; PEM-Zertifikat, benötigt `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Nicht gesetzt; optionale PEM-CA-Kette für bereitgestellte Zertifikate. |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Nicht gesetzt; zusätzliche kommaseparierte DNS-Namen/IPs für erzeugte Zertifikate. |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Prozessarbeitsverzeichnis; Wurzel zum Öffnen von Arbeitsbereichen. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false`; erlaubt das Durchsuchen des gesamten Dateisystems. Keine Agenten-Sandbox-Einstellung. |
| `--config <path>` | `CLI_CONFIG` | Aufgelöster aktiver Standard: `~/.config/codenomad/config.yaml`. Akzeptiert Verzeichnis oder YAML-Datei für expliziten Speicherort. |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info`; dokumentierte Stufen: `trace`, `debug`, `info`, `warn`, `error`. |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout`; sonst in die gewählte Datei schreiben. |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad`; Laufzeit-Authentifizierungsbenutzername. Eine gespeicherte Auth-Datei behält ihren Benutzernamen ohne Laufzeit-Passwortüberschreibung. |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Nicht gesetzt; reines Laufzeitpasswort mit Vorrang vor der verwalteten Auth-Datei. |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session`; Zeichen außer Buchstaben, Ziffern, `_` und `-` werden `_`. |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false`; einmaliges lokales Ersteinrichtungstoken mit 60 Sekunden Gültigkeit ausgeben. |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false`; deaktiviert Direkt-Listener-Authentifizierung. Gefährlich: siehe [Sicherheit](security.md). Fernsteuerung benötigt weiterhin Gerätekopplung. |
| `--ui-dir <path>` | `CLI_UI_DIR` | `public`-Verzeichnis des Pakets; explizite Überschreibung liefert diese Oberfläche statt entfernter UI-Auflösung. |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Nicht gesetzt; UI über den HTTP-Listener weiterleiten. Für Entwicklung `--https=false --http=true` verwenden; der HTTPS-Listener leitet die Entwicklungs-UI nicht weiter. |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false`; übersteuert automatische Updates und verwendet verfügbare zwischengespeicherte/gebündelte UI. |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true`; beim Start auf kompatible entfernte UI prüfen. |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json`; entferntes UI-Manifest. |
| `--launch` | `CLI_LAUNCH` | `false`; nach Start lokale UI im Browser öffnen. |
| `--upgrade [version]` | — | Standardmäßig kein Upgrade. Auf Anfrage `@neuralnomads/codenomad@latest` oder die angegebene Version global installieren und beenden. |

Die öffentliche Referenz listet benutzerseitige Optionen; Desktop-Hosts verwalten ihre eigene private Startkoordination.

### Zusätzliche Bereitstellungsumgebung {#deployment-environment}

| Variable | Standard und Geltungsbereich |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad`; Repository für Release-Angebote. |
| `CODENOMAD_REMOTE_CONTROL_API` | Nicht gesetzt: gehostete OpenTunnel-API. Für selbst gehostetes Relay eine API-Origin setzen. |
| `NODE_EXTRA_CA_CERTS` | Optionale zusätzliche CA-Datei von Node; wird mit zulässiger Startumgebung beim Start eines fehlenden OpenCode-Daemons übergeben. Ändert keinen bereits laufenden Daemon. |

Anbieterspezifische Nutzungszugangsdaten behandelt [Anbieter](providers.md). Desktop-Datenprofilauswahl beschreibt [Desktop](desktop.md); der Release-Kanal steuert sie nicht.

## Konfiguration und Speicherzuständigkeit {#storage}

Die folgenden Standardpfade verwenden das Home des Backend-Benutzers. Ein explizites `--config`-Verzeichnis ändert die Konfigurationsbasis; ein YAML-Dateiname wählt diese Datei mit benachbartem Zustand/Speicher. Verwenden Sie eine bewusste Konfigurationsidentität pro Bereitstellung und schützen Sie das ganze Verzeichnis mit OS-Rechten.

| Eigentümer/Daten | Standardort oder Regel |
| --- | --- |
| Stabile CodeNomad-Einstellungen | `~/.config/codenomad/config.yaml` |
| Veränderlicher CodeNomad-Zustand | `~/.config/codenomad/state.yaml` |
| CodeNomad-Instanzmetadaten | `~/.config/codenomad/instances/` |
| Passwort-Hash | `auth.json` neben der aktiven YAML-Konfiguration; appverwaltet. |
| Erzeugte TLS-Zertifikate und private Schlüssel | `tls/` unter der Konfigurationsbasis. |
| Fernsteuerungsroute, Aktivierungsauswahl und Geräte-Hashes | `remote-control-devices.json` unter der Konfigurationsbasis. |
| Register und Ordner temporärer Arbeitsbereiche | `temporary-workspaces.json` und `temporary-workspaces/` unter dieser Basis. |
| Installierte Panel-Erweiterungen und Berechtigungsbelege | `panel-extensions/` und `permission-receipts/` unter dieser Basis. |
| Heruntergeladener UI-Cache | `~/.config/codenomad/ui/`; der UI-Resolver der CLI verwendet diesen Home-basierten Cache auch bei angepasstem `--config`. |
| OpenCode-Unterhaltungen, Nachrichten, Dienstregistrierung und Anbieterverbindungen | OpenCodes eigener globaler Speicher auf dem Ausführungshost, nicht das CodeNomad-Instanzverzeichnis. |
| Desktop-Wiederherstellungszustand | Standard `~/.codenomad/client-state/v2/`; Profil-/Fensterumfang siehe [Desktop](desktop.md). |

CodeNomad verbindet sich mit dem vorhandenen gemeinsamen Daemon oder startet ihn, falls er fehlt. Die Startumgebung betrifft nur einen neu gestarteten Daemon. Separat wird die konfigurierte vollständige Sitzungsumgebung vor jedem Prompt, benutzerdefinierten Befehl oder Sitzungs-Shell-Aufruf angewandt, nicht beim bloßen Ansehen/Bearbeiten von Einstellungen. Siehe [OpenCode-Einrichtung](opencode.md).

## Ereignisse und Wiederverbindungen {#events}

Das Backend konsumiert einen gemeinsamen nativen OpenCode-Ereignisstrom und verteilt Arbeitsbereichs-/CodeNomad-Ereignisse per Server-Sent Events an Browser-Clients. Zustellung ist live und flüchtig: Es gibt **keine garantierte Ereigniswiederholung**.

Nach Wiederverbindung liest die Oberfläche maßgeblichen Sitzungs- und Anfragezustand erneut; Datei-/Konfigurationsinvalidierungen lösen ebenfalls frische Lesevorgänge aus. Wiederverbindung erlaubt kein erneutes Senden, Löschen, Antworten oder andere Änderungen mit verlorener Antwort. Prüfen Sie zuerst den Ergebniszustand. Bekannte offene Anfragen und Entwürfe bleiben bei unvollständiger Wiederherstellung erhalten; siehe [Berechtigungen](permissions.md) und [Fehlerbehebung](troubleshooting.md).

## Vorschaupakete und Wartung {#maintenance}

Um das CLI-Vorschaupaket explizit auszuprobieren:

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

Verwenden Sie für isolierte CodeNomad-Einstellungen bewusst eine separate Konfiguration; Paketauswahl isoliert keinen gemeinsamen OpenCode-Speicher. **Einstellungen → Info → Updates → Update-Kanal** steuert angebotene Releases, nicht Backend-Datenidentität oder installiertes Paket.

`codenomad --upgrade` aktualisiert das globale stabile CLI-Paket mit dem erkannten npm-/pnpm-/bun-Manager (npm, falls keiner erkannt wird). Es startet weder einen laufenden Server neu noch aktualisiert es OpenCode. Aktualisieren Sie bei projektlokaler oder Vorschauinstallation ausdrücklich genau dieses npm-Paket. Starten Sie den verwalteten CodeNomad-Prozess nach dem Update bewusst neu und prüfen Sie seine ausgegebenen Adressen erneut.

Desktop-Wartung siehe [Updates](updates.md), Quellcode-Build-Befehle [Support](support.md) und Anbieterplannutzung [Anbieter](providers.md).
