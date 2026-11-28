# Fehlerbehebung

## Desktop-Startprobleme {#desktop-launch}

### macOS-Quarantäne {#macos-quarantine}

Die macOS-Releases von CodeNomad sind nicht von Apple notarisiert. macOS kann daher den ersten Start einer heruntergeladenen Kopie blockieren, auch einer aus dem offiziellen Repository überprüften: Es kann **"CodeNomad" Not Opened** melden (Apple konnte nicht überprüfen, ob sie frei von Schadsoftware ist) oder dass die Anwendung beschädigt ist.

1. Prüfen Sie Download-Herkunft und installierten App-Pfad.
2. Ist die App im folgenden Pfad installiert, entfernen Sie ihr Quarantäneattribut:

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Starten Sie erneut. Bei der Meldung **Not Opened** können Sie nach dem blockierten Start stattdessen in **System Settings → Privacy & Security** für CodeNomad **Open Anyway** wählen und mit Ihrem Administratorpasswort bestätigen.

Dies ändert das macOS-Quarantäneattribut dieser Anwendung. Es repariert keinen beschädigten Download und macht keine unbekannte Programmdatei vertrauenswürdig.

### Linux-Grafik und FUSE {#linux-graphics}

Ein unter Wayland/NVIDIA sofort endendes Tauri-AppImage kann vom DMA-BUF-/GBM-Renderer von WebKitGTK betroffen sein. Starten Sie das heruntergeladene AppImage mit der gezielten Umgebungsüberschreibung:

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron verwendet Chromium und ist auf demselben Host eine Alternative. Kann das AppImage wegen fehlendem FUSE nicht eingebunden werden, verwenden Sie stattdessen `--appimage-extract-and-run`; siehe [Linux-Installation](install.md#linux-install). Diese Abhilfen benötigen keine deaktivierte Electron-Sandbox.

## Git und Arbeitsbereichsverfügbarkeit {#git-and-workspaces}

1. Prüfen Sie Git im `PATH` des Backend-Kontos, nicht nur in der Agenten-Shell.
2. Installieren Sie fehlendes Git für diesen Host/dieses Konto und starten Sie das CodeNomad-Backend neu, damit es die aktualisierte Umgebung erbt.
3. Öffnen/aktualisieren Sie den Arbeitsbereich erneut und prüfen Sie den Repository-Status.

Verzeichnisgebundene Unterhaltungen bleiben ohne Git verfügbar, Worktree-/Git-Steuerungen nicht. Unter Windows genügt nur in WSL installiertes Git nicht für das Windows-Backend. Ein bekannter Ordner ohne Repository kann **Git initialisieren** anbieten; eine fehlende Git-Programmdatei ist ein anderer Zustand und muss zuerst behoben werden. Siehe [Anforderungen](install.md#requirements) und [Dateien](files.md).

Lässt sich ein zugehöriger Worktree oder Unterhaltungsort nicht überprüfen, öffnen Sie ausdrücklich dessen physischen Ordner, statt beliebige Pfade zu versuchen oder nativen Speicher zu bearbeiten. Erzwungenes Worktree-Entfernen kann nicht committete Dateien zerstören; verwenden Sie es nicht zur Verbindungsreparatur.

## OpenCode-Laufzeit und WSL {#opencode-runtime}

Wählen Sie im Dialog für Startfehler **OpenCode-Einstellungen öffnen**, um Programmdatei und Version zu prüfen; wechseln Sie für eigene Umgebungswerte zu **Erweitert → Umgebungsvariablen**.

1. Öffnen Sie **Einstellungen → OpenCode** und prüfen Sie die Karte **OpenCode-Version** (installierte Version und Status des laufenden Dienstes), dann die gewählte Programmdatei unter **OpenCode-Binärdatei**.
2. Verwenden Sie die unterstützte Installation/Aktualisierung, falls die erforderliche Laufzeit fehlt. Aktuelles Minimum: **2.4.0**; empfohlene/qualifizierte Version: **2.4.1**.
3. Weicht die installierte CLI vom laufenden Dienst ab, entscheiden Sie ausdrücklich über einen Neustart des gemeinsamen Dienstes.

**OpenCode-Dienst neu starten** ist unter **Fehlerbehebung** verfügbar und benötigt Bestätigung. Es unterbricht aktive Arbeit in jedem verbundenen Client, behält aber Sitzungsverlauf. Konfigurationsneuladen ist separat: Es behält den Prozess, erstellt aber geladene Locations neu und storniert offene Fragen/Berechtigungen. Beides ist keine harmlose Aktualisierung.

Prüfen Sie für WSL-Programmdateien vorgesehene Distribution und Windows-Localhost-Weiterleitung. Dienstlebenszyklus läuft in Linux; CodeNomad muss dessen Loopback-Endpunkt weiterhin von Windows erreichen. Bearbeiten Sie niemals Dienstregistrierung/Datenbank und senden Sie aus Windows keine Signale an geratene Linux-Prozess-IDs.

## Anmeldung, TLS und direkte Verbindung {#login-and-tls}

| Symptom | Sichere Prüfung und Wiederherstellung |
| --- | --- |
| **Erneut bei CodeNomad anmelden** | Seite offen lassen, Serverbenutzername/-passwort eingeben und **Anmelden** wählen. Wiederherstellung verbindet an Ort und Stelle neu, um Entwürfe zu bewahren; sie wiederholt keine fehlgeschlagene Aktion. |
| Server nicht erreichbar | Backend-Lauf prüfen und ausgegebene Adresse/tatsächlichen Port verwenden. |
| Zertifikatsnamen-/Vertrauensfehler | Tatsächlichen Hostnamen/IP mit SANs vergleichen und vorgesehenes CA-Vertrauen oder gültiges Serverzertifikat installieren. TLS-Prüfung nicht deaktivieren. |
| Direktverbindung verweigert | Effektive HTTP-/HTTPS-Bindung, Firewall und Routing prüfen. |

Laufzeitpasswörter müssen bei jedem Backend-Start angegeben werden; über Einstellungen gespeicherte Passwörter bleiben erhalten. Siehe [Sicherheit](security.md), [TLS-/Bindungsregeln](remote-access.md) und [Server-Referenz](server.md).

## Fernsteuerungskopplung {#pairing}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff** und prüfen Sie laufende Fernsteuerung.
2. Erzeugen Sie einen frischen Kopplungslink und öffnen Sie ihn vor Ablauf auf dem vorgesehenen Gerät.
3. Zeigt der Client **Dieses Gerät erneut koppeln**, koppeln Sie vom Host aus und wählen dann **Verbindung prüfen** im Client.

Kopplungslinks sind einmalig und kurzlebig; das Direktzugriffspasswort ersetzt sie nicht. Widerrufene oder wegen Inaktivität abgelaufene Gerätezugangsdaten benötigen erneute Kopplung. Das Schließen des letzten Desktop-Fensters stoppt dessen Backend und damit die Fernsteuerung; ein aktivierter Dienst setzt beim nächsten App-Start fort. Nur auf dem Host verfügbare Oberflächen und Widerruf erläutert [Fernsteuerung](remote-control.md).

## Anbieter-, Plugin- und Erweiterungszustand {#providers-and-addons}

- Hinzugefügtes Plugin fehlgeschlagen oder **Nicht bestätigt** — Prüfen Sie Paketname, Version und Registry-Zugriff des OpenCode-Hosts. Suchen Sie im OpenCode-Protokoll nach der Fehlerreferenz aus dem Plugin-Tooltip. **Nicht bestätigt** erscheint auch für ein deaktiviertes Plugin.
- Installierte Erweiterung fehlt — Aktivieren Sie sie in der Panel-Anpassung. Installation/Ersatz lässt sie deaktiviert, bis Sie ausdrücklich aktivieren und erforderlicher Zustimmung zustimmen.
- **Vollständige Zeitleiste nicht verfügbar** — Lesen Sie den Ladefehler von `codenomad-session-pruning` im OpenCode-Protokoll.

Siehe [Anbieter](providers.md), [Integrationen](integrations.md) und [Erweiterungen](extensions.md).

## Verlauf, offene Anfragen und Bereinigung {#history-and-requests}

Vollverlaufssuche ist nicht auf aktuell geladene Verlaufszeilen begrenzt. Ein Anzeigefilter verbirgt Inhalte ohne Löschung; [Verlauf](history.md) unterscheidet Suche, Komprimierung, technische Bereinigung und Löschung.

Lesen Sie bei abgebrochener/teilweiser Bereinigung Fortschritt/Belege vor weiterer Löschung. Abbrechen macht bereits versandte Stapel nicht rückgängig. Reparieren Sie Verlauf nicht durch Bearbeitung der nativen Datenbank.

## Logs und sichere Diagnosen {#diagnostics}

1. Öffnen Sie **Einstellungen → OpenCode → OpenCode-Protokolle anzeigen**. Die globale Datei `opencode.log` des ausgewählten Ausführungshosts wird mit `opencode debug paths log` ermittelt. Es zeigt höchstens die letzten 128 KiB; **Aktualisieren** liest die Datei erneut.
2. Wählen Sie unter **Einstellungen → OpenCode** nur bei Bedarf an mehr Details den vorgesehenen **Standard-Log-Level**. Für eigenständiges CodeNomad-Logging verwenden Sie die [Logging-Optionen der Server-CLI](server.md). Der CodeNomad-Server führt außerdem ein eigenes Log in `logs/server.log` neben seiner Konfigurationsdatei (standardmäßig `~/.config/codenomad`); die vorherige volle Datei heißt `server.previous.log`.
3. Öffnen Sie **Einstellungen → Info → Diagnose** und verwenden Sie **Fehler melden**, **In Zwischenablage kopieren** oder **.txt herunterladen**.

Ausführliche Logs können Pfade, Ausgaben und Anwendungsdaten offenlegen. Schwärzen Sie Zugangsdaten, Kopplungslinks, Netzwerkadressen, private Pfade und Unterhaltungsinhalte vor Teilen von Logs/Aufnahmen. Der vollständige Diagnosebericht enthält Pfade/Adressen; das vorausgefüllte Fehlerformular schließt sie bewusst aus. Siehe [Fehler melden](support.md#report-a-bug).
