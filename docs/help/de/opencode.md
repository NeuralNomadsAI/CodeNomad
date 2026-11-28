# OpenCode einrichten

## CLI auswählen oder installieren {#select-cli}

1. Öffnen Sie **Einstellungen → OpenCode** und wählen Sie auf der Karte **OpenCode-Binärdatei** unterhalb von **OpenCode-Version** die Programmdatei.
2. Lassen Sie den automatischen Eintrag ausgewählt oder öffnen Sie **Andere Binärdatei wählen…**, um **Nach Binärdatei suchen...** zu verwenden oder einen Pfad einzugeben und **Hinzufügen** zu wählen.
3. Verwenden Sie **Status und Updates prüfen**. Fehlt OpenCode, wählen Sie **OpenCode installieren und starten**; prüfen Sie vorher Host und Installationsumfang.
4. Falls die Einrichtung **Verbinden und fortfahren** anbietet, verwenden Sie dies nach Behebung des gemeldeten Problems.

**Für den Benutzer installieren und PATH konfigurieren** ändert die Terminaleinrichtung dieses Benutzers; öffnen Sie danach ein neues Terminal. Ein Browser verbindet sich mit dem CodeNomad-Server: Dateiauswahl und Programmdateiauswahl betreffen diesen Server, nicht das Browsergerät.

Steht ein älteres OpenCode im PATH an erster Stelle, hängt die angebotene Aktion davon ab, wie es installiert wurde. Bei einem mit npm installierten OpenCode 1.x fragt **OpenCode {version} durch OpenCode 2 ersetzen** nach Bestätigung, entfernt dieses npm-Paket und installiert OpenCode 2 im selben npm-Ordner; der OpenCode-Datenordner bleibt erhalten, und OpenCode 2 importiert 1.x-Unterhaltungen selbst. Ein älteres oder unbrauchbares, auf anderem Weg installiertes OpenCode (winget, Homebrew, manuell) wird nie verändert: **OpenCode 2 für CodeNomad installieren** installiert OpenCode 2 daneben im Benutzer-npm-Ordner, und CodeNomad verwendet dann diese Kopie. Liegt dieser ältere Befehl selbst im Benutzer-npm-Ordner (zum Beispiel ein Link in `~/.local/bin`) oder ist dieser Ordner nicht beschreibbar, nennt die Einrichtung den Grund, statt die Aktion anzubieten: Verschieben Sie den Befehl oder benennen Sie ihn um, oder korrigieren Sie die Ordnerrechte, und wählen Sie dann **Status und Updates prüfen**. Der Befehl `opencode` eines Terminals kann weiterhin die ältere Version starten. Eine ausdrücklich ausgewählte benutzerdefinierte Programmdatei wird nie ersetzt.

Die Karte **OpenCode-Version** zeigt **Laufender Dienst** separat an, wenn seine Version von **Installierte Version** abweicht oder unbekannt ist. **Versionsdetails** zeigt die Mindestversion und bei Abweichung die empfohlene Version.

## Erforderliche, empfohlene und ungeprüfte Versionen {#versions}

| Einstufung | Aktuelle Anforderung | Bedeutung |
| --- | --- | --- |
| Minimum | OpenCode **2.4.2** | Für diese CodeNomad-Version erforderlich. Mit früheren Versionen gespeicherte Unterhaltungen bleiben nach dem Update lesbar. |
| Empfohlen | OpenCode **2.4.2** | Für CodeNomad **1.2.0**. |
| Ungeprüft | Neuere oder angepasste, nicht vollständig validierte Version | Nicht allein wegen fehlender Tests abgelehnt; geprüft werden die tatsächlichen API-Verträge des verbundenen Dienstes. |

## Host, WSL und gemeinsamer Dienst {#execution-host}

Unter Windows läuft eine ausgewählte WSL-Programmdatei in der gewählten Distribution. Installieren/aktualisieren Sie sie dort und verwenden Sie dort gültige Pfade. WSL-Verbindungen hängen von der Windows-Localhost-Weiterleitung ab. Windows-CLI und WSL-CLI sind keine austauschbaren Ausführungsumgebungen.

Das Schließen eines Projekt-Tabs schließt das Projekt in CodeNomad; Sitzungen laufen in OpenCode weiter und erscheinen wieder, wenn Sie das Projekt erneut öffnen. Das Schließen eines ganzen Fensters, Beenden oder Neuladen bewahrt Projektverbindungen für die Wiederherstellung; weder diese Aktionen noch das Herunterfahren des Backends beenden den gemeinsamen Daemon. Siehe [Projekte](projects.md).

## Beim Systemstart starten {#login-start}

Unter **Einstellungen → OpenCode** lässt **Beim Systemstart starten** das Betriebssystem den OpenCode-Dienst bei Ihrer Anmeldung im Hintergrund starten, auch wenn CodeNomad geschlossen ist. Die Einstellung bleibt aus, bis Sie sie einschalten, wirkt ab Ihrer nächsten Anmeldung und gilt für Ihr Konto auf dem Computer, auf dem der CodeNomad-Server läuft. Sie startet die auf der Karte **OpenCode-Binärdatei** gewählte Programmdatei; die Auswahl einer anderen nativen Programmdatei aktualisiert sie, sonst startet sie weiter die bisherige.

| System | Was OpenCode startet | Nach einem Absturz |
| --- | --- | --- |
| Windows | Eine verborgene geplante Aufgabe für Ihr Konto, ohne Kennwort oder Administratorrechte. Eine WSL-Programmdatei startet in ihrer Distribution. | Kein Neustart. |
| macOS | Ein LaunchAgent. | Neustart durch macOS. |
| Linux | Ein systemd-Benutzerdienst, der bei der Anmeldung startet, ohne Lingering zu aktivieren. | Neustart durch systemd. |

Ausschalten entfernt nur diese Aufgabe, diesen LaunchAgent oder Dienst; ein laufendes OpenCode läuft weiter. **Auf diesem System nicht verfügbar** erscheint, wenn der CodeNomad-Server in WSL oder auf einem anderen System ohne Anmeldestart läuft.

## Aktualisieren, neu starten oder neu laden {#maintenance}

1. Wählen Sie unter **Einstellungen → OpenCode** die Aktion **Status und Updates prüfen**.
2. Um installierte CLI-Dateien zu ersetzen, wählen Sie gegebenenfalls **Auf OpenCode {version} aktualisieren**. Warten Sie den Abschluss ab.
3. Prüfen Sie den Status des laufenden Dienstes. Verwenden Sie **Gemeinsamen Dienst neu starten** nur, wenn Sie die ausgewählte Installation für jeden verbundenen Client aktivieren möchten.
4. Für einen Prozessneustart ohne Installation klappen Sie **Fehlerbehebung** auf, wählen **OpenCode-Dienst neu starten** und bestätigen.

| Aktion | Umfang und Wirkung |
| --- | --- |
| CLI aktualisieren | Ändert die unterstützte installierte Programmdatei; startet den laufenden Daemon nicht implizit neu. |
| Dienst neu starten | Ersetzt den gemeinsamen Prozess und unterbricht aktive Arbeit in allen verbundenen OpenCode-Clients; Sitzungsverlauf bleibt erhalten. |
| OpenCode-Konfiguration neu laden | Behält den Prozess. Bricht für alle verbundenen Clients offene Berechtigungen/Forms ab, schließt Terminals/Hintergrundbefehle und kann aktive Arbeit unterbrechen. |

Verwenden Sie **OpenCode-Konfiguration neu laden** (unter **Fehlerbehebung**, wenn der laufende Dienst es unterstützt), wenn gespeicherte Konfiguration oder installierte Plugins weiter fehlen. Lesen und bestätigen Sie die Warnung: Das Neuladen kann aktive Arbeit in allen verbundenen Clients unterbrechen. CodeNomad verwendet keine ältere ausgewählte CLI, um einen neueren laufenden Daemon herunterzustufen.

## Sitzungsumgebung {#session-environment}

1. Öffnen Sie **Einstellungen → Erweitert** und klappen Sie **Umgebungsvariablen** auf.
2. Fügen Sie Werte hinzu, ändern oder entfernen Sie sie. Gespeicherte Namen sind schreibgeschützt. Wählen Sie in Rune eine Variable aus, ändern Sie ihren Wert und wählen Sie **Speichern**.
3. Senden Sie den nächsten Prompt, benutzerdefinierten Befehl oder Sitzungs-Shell-Aufruf über CodeNomad, um die aktuelle Umgebung auf diese Unterhaltung anzuwenden.

Dies ist eine Konfigurationsprofileinstellung. Bloßes Öffnen/Lesen einer Unterhaltung oder Speichern von Einstellungen verändert keine native Sitzung. Das Entfernen einer Überschreibung stellt den geerbten Wert des Ausführungshosts wieder her oder entfernt ihn, wenn er dort fehlt.

Die Umgebung steuert spätere lokale Shell-Starts in dieser nativen Sitzung. Bereits laufende Prozesse behalten ihre Umgebung. Sie konfiguriert Anbieter, MCP-/LSP-Server, unabhängige Terminals oder reine Location-Hintergrund-Shells **nicht** neu. Prompts in Warteschlangen erfassen nicht jeweils eine eigene Umgebung; ein anderer OpenCode-Client kann dieselbe Sitzungsumgebung ersetzen. Nehmen Sie nicht an, dass vollständig innerhalb von OpenCode erstellte Kind-Sitzungen eine CodeNomad-Aktualisierung zum Sendezeitpunkt erhalten.

Zulässige Variablen werden auch beim Start eines gestoppten Dienstes übergeben; die Verbindung zu einem vorhandenen Daemon ändert dessen Prozessumgebung nicht. Unter WSL werden Werte mit der Linux-Ausführungsumgebung kombiniert, nicht mit Windows-PATH/HOME.

## Native Konfigurationsdateien bearbeiten {#configuration-files}

1. Öffnen Sie **Einstellungen → Konfigurationsdateien** und wählen Sie **Datei**.
2. Prüfen Sie den angezeigten Pfad, bearbeiten Sie und wählen Sie **Speichern**.
3. Verwenden Sie **Neu laden**, um die Datei erneut zu lesen; dies ist nicht **OpenCode-Konfiguration neu laden**.

Dieser Editor bietet nur die aufgelisteten globalen Dateien `opencode.json` und `opencode.jsonc` unter `.config/opencode` des **CodeNomad-Serverbenutzers**. Er ist weder ein beliebiger Dateieditor noch eine Projektkonfigurationsauswahl und garantiert nicht, dass ein WSL-Daemon oder ein Daemon mit angepassten Suchpfaden diese Datei liest. Prüfen Sie das Ziel anhand des angezeigten Pfads; für andere Wurzeln nutzen Sie die eigenen Werkzeuge des Daemons.

Speichern schreibt die Datei als Text; es validiert weder die gesamte native Konfiguration noch startet/lädt es OpenCode neu. Stimmen Sie Änderungen mit anderen Clients ab: Diese Oberfläche bietet keine Zusammenführung externer Änderungen. Sichern Sie vor umfangreichem Ersetzen eine Kopie. Dateiwechsel oder Neuladen eines geänderten Entwurfs fragt nach dessen Verwerfen.

Konfigurationsbezogene Abläufe finden Sie unter [Integrationen](integrations.md), [Anbieter](providers.md), [Missionen](missions.md) und [OpenCode-Dokumentation](https://opencode.ai/v2/docs/).
