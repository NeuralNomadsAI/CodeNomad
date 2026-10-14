# CodeNomad installieren

Wählen Sie einen lokalen Desktop-Host oder betreiben Sie den [eigenständigen Server](server.md). In beiden Fällen verwaltet OpenCode den gemeinsamen nativen Dienst und den Verlauf.

## Desktop-Downloads {#desktop-downloads}

1. Öffnen Sie [das neueste Release](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest).
2. Wählen Sie den Build für Ihr Betriebssystem und Ihren Prozessor.
3. Entpacken Sie die ZIP-Datei oder installieren/starten Sie das Plattformpaket und starten Sie anschließend CodeNomad.

| Plattform | Electron-Release | Tauri-Release | Plattformhinweise |
| --- | --- | --- | --- |
| macOS | ZIP, Intel oder Apple Silicon | ZIP, Intel oder Apple Silicon | Die gebündelte Laufzeit erfordert macOS 13.5 oder neuer. |
| Windows | ZIP, x64 | Installationsprogramm, x64 | Windows 10 oder neuer; Tauri verwendet WebView2. |
| Linux | Debian-Paket, x64 | AppImage, x64 | Unter Ubuntu 24.04 gebaut und getestet; Kompatibilität mit älteren Distributionen ist nicht garantiert. |

Desktop-Releases enthalten die Laufzeitressourcen für Backend und OpenCode-Installation; dafür benötigen Sie keine separate Node.js/npm-Installation. Git wird nicht mitgeliefert. Native Browser-Automatisierung wird in Electron und Windows-Tauri unterstützt; andere Tauri-Plattformen verwenden iframe-Vorschauen.

Wird ein überprüfter Download beim Start blockiert, lesen Sie die [plattformbezogene Fehlerbehebung](troubleshooting.md#desktop-launch). Führen Sie niemals ein nicht vertrauenswürdiges Archiv aus, nur um eine Warnung zu umgehen.

## Unter Linux installieren {#linux-install}

Führen Sie im Ordner des heruntergeladenen Releases Folgendes mit dessen tatsächlicher Version und Dateinamen aus:

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

Für das Tauri-AppImage:

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Falls FUSE nicht verfügbar ist, verwenden Sie den Entpacken-und-Ausführen-Modus des AppImage:

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

Die Electron-Debian-Installation richtet die Chromium-Sandbox ein. Deaktivieren Sie die Sandbox nicht als Installationsbehelf. Für Grafikprobleme unter Linux-Tauri gibt es eine [gezielte WebKit-Abhilfe](troubleshooting.md#desktop-launch).

## Anforderungen {#requirements}

| Anforderung | Wo sie verfügbar sein muss | Aktuelle Anforderung |
| --- | --- | --- |
| OpenCode-CLI | Ausgewählter Ausführungshost, gegebenenfalls einschließlich der ausgewählten WSL-Distribution | Mindestens **2.0.27**; **2.0.29** ist das empfohlene/qualifizierte Ziel. Neuere oder angepasste Versionen werden anhand der Schnittstellenverträge geprüft, nicht wegen fehlender Tests ausgeschlossen. |
| Git | Im `PATH` des CodeNomad-Backend-Kontos | Erforderlich für Repository-Identität, Git-Vorgänge und Worktrees. |
| Node.js/npm | Host für eigenständigen Server und Quellcode-Builds | Node.js 24 LTS; reproduzierbare Quellcode-Builds verwenden `.node-version` (**24.20.0**). In den Desktop-Laufzeit-/Installationsressourcen enthalten. |
| Arbeitsbereichsordner | Für das Backend zugänglicher Datenträger | Ein ausdrücklich geöffneter physischer Ordner, kein von einem Remote-Browser angenommener gerätelokaler Ordner. |

Installieren Sie unter Windows [Git for Windows](https://gitforwindows.org/) mit aktiviertem Zugriff über Befehlszeile/Drittsoftware. Eine vom Benutzer beschreibbare benutzerbezogene Installation genügt. Unter macOS/Linux folgen Sie [Gits Plattformanleitung](https://git-scm.com/downloads).

Beenden Sie nach einer Änderung von `PATH` die Desktop-App vollständig und starten Sie sie neu, oder starten Sie das eigenständige Backend unter dem vorgesehenen Konto neu. Ein Browser-Neuladen aktualisiert die Backend-Umgebung nicht. Nur innerhalb von WSL verfügbares Git erfüllt die Git-Anforderung eines Windows-Backends nicht.

Ohne Git können Sie weiterhin einen physischen Ordner öffnen und verzeichnisgebundene Unterhaltungen führen, einschließlich einer Bitte an den Agenten um Installationshilfe. Repository-/Worktree-Vorgänge bleiben nicht verfügbar; der Sitzungszugriff bleibt auf genau diesen Ordner begrenzt. CodeNomad informiert den Agenten vor Prompts/benutzerdefinierten Befehlen über die Git-Verfügbarkeit im Backend und entfernt diesen Hinweis nach der Wiederherstellung. Der Ausführungshost des Agenten kann vom Backend-Host abweichen: Installieren Sie Git für das Backend, nicht nur für die Shell des Agenten.

## OpenCode beim ersten Start auswählen {#first-launch}

1. Wählen Sie bei der Einrichtung eine kompatible vorhandene Programmdatei oder nutzen Sie die angebotene OpenCode-Installation.
2. Prüfen Sie vor dem Öffnen eines Projekts den Laufzeitstatus.
3. Öffnen Sie später **Einstellungen → OpenCode**, um Programmdatei, Installation und gemeinsamen Dienst getrennt zu verwalten.

CodeNomad bevorzugt kompatible Programmdateien im `PATH` und unterstützt eine ausdrücklich ausgewählte Programmdatei. Das Installieren/Aktualisieren einer CLI startet einen bereits laufenden gemeinsamen Dienst nicht stillschweigend neu. Die [OpenCode-Einrichtung](opencode.md) erläutert Neustart-/Neuladefolgen, WSL und die Sitzungsumgebung.

## Stattdessen einen Browser verwenden {#browser-install}

Installieren Sie Node.js/npm, Git und OpenCode auf dem Server-Host und folgen Sie dann den [Server-Startanleitungen](server.md). Verbinden Sie sich über die ausgegebene Adresse mit konfigurierter Authentifizierung und einem vertrauenswürdigen Zertifikat. Ein Browser/eine PWA benötigt ein laufendes Backend; dies ist keine Offline-Kopie Ihrer Projekte.

Ports, Bindungen und TLS beschreibt der [Direktzugriff](remote-access.md). Zum Koppeln eines Geräts ohne eingehende Ports verwenden Sie die [Fernsteuerung](remote-control.md). Entwicklungs- und Paketierungsbefehle finden Sie unter [Quellcode-Builds](support.md#build-from-source).
