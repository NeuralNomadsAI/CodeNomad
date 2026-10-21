# Support und Quellcode-Builds

Verwenden Sie das Repository für Fehlerberichte, aktuelle Releases und Beiträge. Die [Fehlerbehebung](troubleshooting.md) beschreibt sichere Wiederherstellung vor einer Meldung.

## Fehler melden {#report-a-bug}

1. Öffnen Sie **Einstellungen → Info → Diagnose**.
2. Wählen Sie **Fehler melden**, um das GitHub-Issue-Formular zu öffnen.
3. Prüfen Sie vorausgefüllte Versions-/Clientinformationen. Ergänzen Sie eine minimale Reproduktion, erwartetes Verhalten und tatsächliches Ergebnis und senden Sie dann über GitHub ab.

Die Aktion füllt die Versionen von CodeNomad und OpenCode (einschließlich des laufenden OpenCode-Dienstes, wenn er von der installierten Version abweicht), Ihr Betriebssystem, den Clienttyp (in einem Webbrowser mit dessen User-Agent) und das Betriebssystem des Servers vorab aus. Listeneradressen, Arbeitsbereichspfade, Zugangsdaten und Unterhaltungstext werden nicht vorausgefüllt. Formularöffnen ist noch keine Meldung.

Benötigen Sie mehr Diagnosen, erzeugen **In Zwischenablage kopieren** oder **.txt herunterladen** einen separaten Bericht. Dieser ausführlichere Bericht kann lokale Pfade und Netzwerkadressen enthalten: Prüfen und schwärzen Sie ihn vor dem Anhängen. Screenshots oder Log-Auszüge können weiterhin Geheimnisse enthalten, selbst wenn der automatische Diagnosebericht Authentifizierungsgeheimnisse ausschließt.

Hat das GitHub-Formular inkompatible Felder, öffnet CodeNomad ein einfaches Issue mit denselben Berichtsinformationen. Ein vorübergehender Lesefehler des Formulars verhindert das Öffnen nicht. Sie können jederzeit manuell die [Issue-Liste](https://github.com/NeuralNomadsAI/CodeNomad/issues) verwenden.

## Community und Releases {#community}

| Ressource | Verwendung |
| --- | --- |
| [CodeNomad-Repository](https://github.com/NeuralNomadsAI/CodeNomad) | Quelltext, Projektaktivität und Dokumentation. |
| [Issues](https://github.com/NeuralNomadsAI/CodeNomad/issues) | Vor reproduzierbarer Fehlermeldung oder Funktionswunsch vorhandene Meldungen durchsuchen. |
| [Pull Requests](https://github.com/NeuralNomadsAI/CodeNomad/pulls) | Vorgeschlagene Änderungen prüfen oder Beitrag koordinieren. |
| [Neuestes Release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest) | Stabile Download-Artefakte. |
| [Alle Releases](https://github.com/NeuralNomadsAI/CodeNomad/releases) | Veröffentlichte Vorschauen und Release-Hinweise. |
| [Neural Nomads](https://github.com/NeuralNomadsAI) | Projektorganisation. |
| [MIT-Lizenz](../../../LICENSE) | Lizenzbedingungen. |

Bei Problemen mit nativer OpenCode-Konfiguration statt CodeNomad-Steuerung beachten Sie [OpenCodes Dokumentation](https://opencode.ai/v2/docs/) und [Upstream-Releases](https://github.com/anomalyco/opencode/releases).

## Aus Quellcode bauen {#build-from-source}

Verwenden Sie Node.js **24.20.0** gemäß `.node-version`, npm, Git und eine kompatible OpenCode-CLI. Führen Sie die Befehle aus einem Entwicklungs-Checkout aus:

```sh
git clone --branch dev https://github.com/NeuralNomadsAI/CodeNomad.git
cd CodeNomad
npm ci --workspaces --include=optional
npm run dev
```

`npm run dev` startet den Electron-Entwicklungshost. Installieren Sie für Tauri zuerst dessen [Plattform-Build-Voraussetzungen](https://v2.tauri.app/start/prerequisites/) einschließlich Rust-Toolchain und führen Sie dann aus:

```sh
npm run dev:tauri
```

Entwicklungsänderungen betreffen den Entwicklungshost, nicht die installierte Version eines unabhängig laufenden OpenCode-Daemons. Native Paketierung benötigt passende Zielwerkzeuge; bevorzugen Sie Builds auf dem Ziel-OS.

### Bauen und validieren {#build-and-validate}

| Befehl vom Repository-Stamm aus | Zweck |
| --- | --- |
| `npm run build` | Electron-Anwendungsressourcen bauen. |
| `npm run build:tauri` | Tauri-Anwendung mit nativen Voraussetzungen bauen. |
| `npm run build:ui` | Browseroberfläche bauen. |
| `npm run build --workspace @neuralnomads/codenomad` | Eigenständigen Server und gebündelte Dateien bauen. |
| `npm run build:linux --workspace @neuralnomads/codenomad-electron-app` | Electron-Debian-Release paketieren. |
| `npm exec --workspace @codenomad/tauri-app -- tauri build --bundles appimage` | Linux-Tauri-AppImage paketieren. |
| `npm run typecheck` | Konfigurierte TypeScript-Workspaces des Stammprojekts prüfen. |
| `npm run test:help` | Alle öffentlichen Hilfesprachen und Links validieren. |
| `npm run build:help` | Eigenständige öffentliche Hilfe nach `dist/help` bauen. |

Der Hilfe-Build benötigt keinen laufenden CodeNomad- oder OpenCode-Dienst. Paketierungsdetails siehe [BUILD.md](../../../BUILD.md), gezielte Validierung und PR-Konventionen [CONTRIBUTING.md](../../../CONTRIBUTING.md); verwenden Sie tatsächlich im Zielpaket vorhandene Skripte.

## Paketübersicht und Beiträge {#contribute}

| Paket | Zuständigkeit |
| --- | --- |
| `packages/server` | Arbeitsbereichs-/API-/Git-Steuerung, OpenCode-Verbindung, Authentifizierung, Ereignisse und Sprache. |
| `packages/ui` | SolidJS-Arbeitsbereich, Bedienelemente, Lokalisierung und Browser-Hilfeeinstieg. |
| `packages/electron-app` | Electron-Fenster, native Integration und Paketierung. |
| `packages/tauri-app` | Tauri-Fenster, Plattformintegration und Paketierung. |
| `packages/remote-tunnel` | Backendseitige OpenTunnel-Transportlaufzeit. |

1. Besprechen Sie den Umfang im passenden Issue vor sich überschneidender Implementierung.
2. Erstellen Sie einen Branch von `dev` und halten Sie die Änderung fokussiert.
3. Führen Sie Prüfungen des betroffenen Bereichs aus, aktualisieren Sie die Benutzerhilfe zusammen mit dem Verhalten und richten Sie den PR an `dev`.

Quellen öffentlicher Hilfe liegen in `docs/help/<locale>/`. Bewahren Sie explizite ID, Ebene und Reihenfolge jeder englischen Überschrift über Übersetzungen hinweg; übersetzte Überschriften dürfen Deep Links nicht brechen. Der [Hilfe-Wartungsvertrag](../../../dev-docs/USER_HELP.md) beschreibt strenge Vollständigkeitsprüfungen und die statische Veröffentlichungspipeline.
