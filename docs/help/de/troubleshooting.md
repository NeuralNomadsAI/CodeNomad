# Fehlerbehebung

Prüfen Sie zur Wiederherstellung zuerst die zuständige Komponente des fehlgeschlagenen Vorgangs: Browser, CodeNomad-Backend, OpenCode-Dienst oder Anbieter. Eine verlorene Antwort beweist keine fehlgeschlagene Änderung; lesen Sie vor Wiederholung den aktuellen Zustand erneut.

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

Lässt sich ein zugehöriger Worktree oder Unterhaltungsort nicht überprüfen, öffnen Sie ausdrücklich dessen physischen Ordner, statt beliebige Pfade zu versuchen oder nativen Speicher zu bearbeiten. Aktualisieren Sie nach ungewisser Verschiebung/Entfernung, um den tatsächlich vorhandenen Ort zu sehen. Erzwungenes Worktree-Entfernen kann nicht committete Dateien zerstören; verwenden Sie es nicht zur Verbindungsreparatur.

## OpenCode-Laufzeit und WSL {#opencode-runtime}

1. Öffnen Sie **Einstellungen → OpenCode** und prüfen Sie die Karte **OpenCode-Version** (installierte Version und Status des laufenden Dienstes), dann die gewählte Programmdatei unter **OpenCode-Binärdatei**.
2. Verwenden Sie die unterstützte Installation/Aktualisierung, falls die erforderliche Laufzeit fehlt. Aktuelles Minimum: **2.1.2**; empfohlen/qualifiziert: **2.1.4**.
3. Weicht die installierte CLI vom laufenden Dienst ab, entscheiden Sie ausdrücklich über einen Neustart des gemeinsamen Dienstes.

**OpenCode-Dienst neu starten** ist unter **Fehlerbehebung** verfügbar und benötigt Bestätigung. Es unterbricht aktive Arbeit in jedem verbundenen Client, behält aber Sitzungsverlauf. Konfigurationsneuladen ist separat: Es behält den Prozess, erstellt aber geladene Locations neu und storniert offene Fragen/Berechtigungen. Beides ist keine harmlose Aktualisierung.

Prüfen Sie für WSL-Programmdateien vorgesehene Distribution und Windows-Localhost-Weiterleitung. Dienstlebenszyklus läuft in Linux; CodeNomad muss dessen Loopback-Endpunkt weiterhin von Windows erreichen. Bearbeiten Sie niemals Dienstregistrierung/Datenbank und senden Sie aus Windows keine Signale an geratene Linux-Prozess-IDs.

Eine angepasste/neuere Version kann ungeprüft sein, ohne inkompatibel zu sein. Lesen Sie vor Versionswechsel den tatsächlichen Vertragsfehler. Scheitert Sitzungsumgebungssynchronisierung, beheben Sie Umgebung/Verbindung des Ausführungshosts: CodeNomad sendet ohne Synchronisierung keinen Prompt. Siehe [OpenCode](opencode.md).

## Anmeldung, TLS und direkte Verbindung {#login-and-tls}

| Symptom | Sichere Prüfung und Wiederherstellung |
| --- | --- |
| **Erneut bei CodeNomad anmelden** | Seite offen lassen, Serverbenutzername/-passwort eingeben und **Anmelden** wählen. Wiederherstellung verbindet an Ort und Stelle neu, um Entwürfe zu bewahren; sie wiederholt keine fehlgeschlagene Aktion. |
| Server nicht erreichbar | Backend-Lauf prüfen und ausgegebene Adresse/tatsächlichen Port verwenden. Eine fehlgeschlagene Erreichbarkeitsprüfung allein beweist keinen Anmeldeablauf. |
| Anbieter verweigert Authentifizierung | Anbieteranmeldung über deren Eigentümer reparieren; nicht das CodeNomad-Serverpasswort zur OAuth-Reparatur ändern. |
| Zertifikatsnamen-/Vertrauensfehler | Tatsächlichen Hostnamen/IP mit SANs vergleichen und vorgesehenes CA-Vertrauen oder gültiges Serverzertifikat installieren. TLS-Prüfung nicht deaktivieren. |
| Direktverbindung verweigert | Effektive HTTP-/HTTPS-Bindung, Firewall und Routing prüfen. HTTP im Desktop-/Zwei-Listener-Modus bleibt Loopback; eigenständiges Nur-HTTP verhält sich anders. |

Prüfen Sie nach Authentifizierungswiederherstellung den Zustand vor manueller Wiederholung einer ungewissen Änderung. Laufzeitpasswörter müssen bei jedem Backend-Start angegeben werden; über Einstellungen gespeicherte Passwörter bleiben erhalten. Siehe [Sicherheit](security.md), [TLS-/Bindungsregeln](remote-access.md) und [Server-Referenz](server.md).

## Fernsteuerungskopplung {#pairing}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff** und prüfen Sie laufende Fernsteuerung.
2. Erzeugen Sie einen frischen Kopplungslink und öffnen Sie ihn vor Ablauf auf dem vorgesehenen Gerät.
3. Zeigt der Client **Dieses Gerät erneut koppeln**, koppeln Sie vom Host aus und wählen dann **Verbindung prüfen** im Client.

Kopplungslinks sind einmalig und kurzlebig; das Direktzugriffspasswort ersetzt sie nicht. Widerrufene oder wegen Inaktivität abgelaufene Gerätezugangsdaten benötigen erneute Kopplung. Das Schließen des letzten Desktop-Fensters stoppt dessen Backend und damit die Fernsteuerung; ein aktivierter Dienst setzt beim nächsten App-Start fort. Nur auf dem Host verfügbare Oberflächen und Widerruf erläutert [Fernsteuerung](remote-control.md).

## Anbieter-, Plugin- und Erweiterungszustand {#providers-and-addons}

| Problem | Wiederherstellung |
| --- | --- |
| Falsches Anbieterkonto/Kontingent | Ausgewähltes natives Konto und **Nutzung** prüfen. Eine Kontingentanzeige ist keine Token-/Kostensumme. Nach ungewissem Kontowechsel aktualisieren; Auswahl kann andere Dienstclients betreffen. |
| Abgelaufenes extern verwaltetes OAuth | Über OpenCode, Claude Code oder zuständigen Zugangsdatenverwalter neu anmelden. CodeNomad tauscht deren Refresh-Tokens nicht aus. |
| Automatische Rotation wechselt nicht | Opt-in-Eignung und tatsächliche Ausschöpfung des aktuellen Kontos prüfen. Es ist eine Richtlinie vor Annahme, kein Failover während der Ausführung oder Prompt-Wiederholen. |
| Plugin-Zustand veraltet | **Plugin-Steuerung aktualisieren** verwenden und Umfang/Ziel im Plugin-Tooltip prüfen; Laufzeitaktivierung kann native Aktualisierung abwarten. Ungewisse Schreibvorgänge nicht wiederholt umschalten. |
| **Missionszentrale ist nicht verfügbar** | Der genannten Ursache folgen. Hat OpenCode das Missions-Plugin nicht geladen, aktualisieren und, falls es so bleibt, **OpenCode-Konfiguration neu laden** verwenden; ist das Laden des Plugins fehlgeschlagen, dessen Fehler in der Plugin-Liste lesen; konnte der Server seine lokale Verbindung für Missionen nicht öffnen, das Serverprotokoll prüfen, denn OpenCode neu zu laden hilft dann nicht. Missionen laufen auch auf dem eigenständigen Server. |
| Installierte Erweiterung fehlt | Einzelnes Aktivierungskästchen in der Panel-Anpassung prüfen. Installation/Ersatz lässt sie deaktiviert, bis Sie ausdrücklich aktivieren und erforderlicher Zustimmung zustimmen. |
| Erweiterungs-Assets verweigert | API-2-Asset-Lesezustimmung für die aktuell eingebundene Sitzung prüfen. Installation erlaubt kein Lesen beliebiger Dateien/Verläufe. |

Siehe [Anbieter](providers.md), [Integrationen](integrations.md) und [Erweiterungen](extensions.md).

## Verlauf, offene Anfragen und Bereinigung {#history-and-requests}

Vollverlaufssuche ist nicht auf aktuell geladene Verlaufszeilen begrenzt. Ein Anzeigefilter verbirgt Inhalte ohne Löschung; [Verlauf](history.md) unterscheidet Suche, Komprimierung, technische Bereinigung und Löschung.

Bei unvollständiger Anfragewiederherstellung behält CodeNomad bekannte Warteschlangen und Antwortentwürfe, statt fehlende Abdeckung als leere Warteschlange zu behandeln. Nach zwei aufeinanderfolgenden unvollständigen Wiederherstellungen warnt es einmal und nennt Projekt, Ursache, Ordner und betroffene Sitzungen; die Warnung gehört zur Benachrichtigungskategorie **Projekte und Tabs** (standardmäßig auf dem Bildschirm und im Verlauf, siehe **Einstellungen → Benachrichtigungen**). Die Lebendigkeitsprüfung wiederholt vorübergehende Fehler. Komprimierungsbedingter Aufschub bedeutet keinen Anfrageabbruch. Lassen Sie den Entwurf unverändert, prüfen Sie die Dienstverbindung und verwenden Sie vor erneuter Antwort den aktuellen Anfragezustand.

Lesen Sie bei abgebrochener/teilweiser Bereinigung Fortschritt/Belege vor weiterer Löschung. Abbrechen macht bereits versandte Stapel nicht rückgängig. Reparieren Sie Verlauf nicht durch Bearbeitung der nativen Datenbank. Verwenden Sie bei Missionsungewissheit **Status prüfen**/Aktualisierung statt eines weiteren Laufs oder automatischer Arbeitswiederholung; [Missionen](missions.md) erklärt Neustart- und Lebensdauergrenzen.

## Logs und sichere Diagnosen {#diagnostics}

1. Öffnen Sie **Instanz-Info** zur Statusprüfung; **Server-Protokolle anzeigen** zeigt verfügbare Ausgabe.
2. Wählen Sie unter **Einstellungen → OpenCode** nur bei Bedarf an mehr Details den vorgesehenen **Standard-Log-Level**. Für eigenständiges CodeNomad-Logging verwenden Sie die [Logging-Optionen der Server-CLI](server.md).
3. Öffnen Sie **Einstellungen → Info → Diagnose** und verwenden Sie **Fehler melden**, **In Zwischenablage kopieren** oder **.txt herunterladen**.

Ausführliche Logs können Pfade, Ausgaben und Anwendungsdaten offenlegen. Schwärzen Sie Zugangsdaten, Kopplungslinks, Netzwerkadressen, private Pfade und Unterhaltungsinhalte vor Teilen von Logs/Aufnahmen. Der vollständige Diagnosebericht enthält Pfade/Adressen; das vorausgefüllte Fehlerformular schließt sie bewusst aus. Siehe [Support](support.md#report-a-bug).
