# OpenCode einrichten

CodeNomad verbindet sich mit einem gemeinsamen OpenCode-Dienst auf dem Ausführungshost. CLI-Auswahl, Aktualisierung ihrer Dateien, Dienstneustart und Konfigurationsneuladen sind unterschiedliche Vorgänge; keiner ersetzt die anderen.

## CLI auswählen oder installieren {#select-cli}

1. Öffnen Sie **Einstellungen → OpenCode** und wählen Sie auf der Karte **OpenCode-Binärdatei** unterhalb von **OpenCode-Version** die Programmdatei.
2. Lassen Sie den automatischen Eintrag ausgewählt, um den PATH des Servers zu bevorzugen, sofern er kein älteres OpenCode enthält, und danach dessen OpenCode-2-Installation im Benutzer-npm; oder verwenden Sie **Nach Binärdatei suchen...** beziehungsweise geben Sie einen Pfad ein und wählen **Hinzufügen**.
3. Verwenden Sie **Status und Updates prüfen**. Fehlt OpenCode, wählen Sie **OpenCode installieren und starten**; prüfen Sie vorher Host und Installationsumfang.
4. Falls die Einrichtung **Verbinden und fortfahren** anbietet, verwenden Sie dies nach Behebung des gemeldeten Problems.

Die Installation verwendet gebündeltes Node/npm für eine normale Benutzerinstallation, die mit anderen Clients geteilt wird. **Für den Benutzer installieren und PATH konfigurieren** ändert die Terminaleinrichtung dieses Benutzers; öffnen Sie danach ein neues Terminal. Ein Browser verbindet sich mit dem CodeNomad-Server: Dateiauswahl und Programmdateiauswahl betreffen diesen Server, nicht das Browsergerät.

Steht ein älteres OpenCode im PATH an erster Stelle, hängt die angebotene Aktion davon ab, wie es installiert wurde. Bei einem mit npm installierten OpenCode 1.x fragt **OpenCode {version} durch OpenCode 2 ersetzen** nach Bestätigung, entfernt dieses npm-Paket und installiert OpenCode 2 im selben npm-Ordner; der OpenCode-Datenordner bleibt erhalten, und OpenCode 2 importiert 1.x-Unterhaltungen selbst. Ein älteres oder unbrauchbares, auf anderem Weg installiertes OpenCode (winget, Homebrew, manuell) wird nie verändert: **OpenCode 2 für CodeNomad installieren** installiert OpenCode 2 daneben im Benutzer-npm-Ordner, und CodeNomad verwendet dann diese Kopie. Der Befehl `opencode` eines Terminals kann weiterhin die ältere Version starten. Eine ausdrücklich ausgewählte benutzerdefinierte Programmdatei wird nie ersetzt.

Installierte Programmdatei und laufender Dienst können unterschiedliche Versionen haben. Vergleichen Sie auf der Karte **OpenCode-Version** **Installierte Version** mit **Laufender Dienst**, statt anzunehmen, eine andere Programmdatei habe den laufenden Daemon ersetzt; **Versionsdetails** nennt Mindest- und empfohlene Version. Ist die Installation beschäftigt oder die Programmdatei gesperrt, warten Sie auf die Freigabe durch Installationsprogramm/Prozess und prüfen Sie vor dem Wiederholen den Status; starten Sie keine konkurrierenden Installationen.

## Erforderliche, empfohlene und ungeprüfte Versionen {#versions}

| Einstufung | Aktuelle Anforderung | Bedeutung |
| --- | --- | --- |
| Minimum | OpenCode **2.1.0** | Erforderliches natives Format für Verläufe, Wiedergabedaten und Komprimierungen; mit früheren Versionen gespeicherte Unterhaltungen bleiben nach dem Update lesbar. |
| Empfohlen | OpenCode **2.1.1** | Qualifiziertes Ziel, getrennt vom technischen Minimum. |
| Ungeprüft | Neuere oder angepasste, nicht vollständig validierte Version | Nicht allein wegen fehlender Tests abgelehnt; geprüft werden die tatsächlichen API-Verträge des verbundenen Dienstes. |

Auch die erforderlichen Verträge für Sitzungen, Berechtigungen, Forms, Posteingang und Sitzungsumgebung müssen verfügbar sein. Eine Programmversion allein beweist nicht deren Unterstützung durch den verbundenen Dienst. Meldet die Einrichtung einen nicht unterstützten laufenden Dienst, wählen/installieren Sie eine unterstützte CLI und führen Sie bei Bereitschaft den expliziten Neustart des gemeinsamen Dienstes aus.

## Host, WSL und gemeinsamer Dienst {#execution-host}

Unter Windows läuft eine ausgewählte WSL-Programmdatei in der gewählten Distribution. Installieren/aktualisieren Sie sie dort und verwenden Sie dort gültige Pfade. WSL-Verbindungen hängen von der Windows-Localhost-Weiterleitung ab. Windows-CLI und WSL-CLI sind keine austauschbaren Ausführungsumgebungen.

OpenCode verwaltet seine globale Dienstregistrierung, Sitzungen, Nachrichten und Datenbank. CodeNomad erstellt keine private OpenCode-Datenbank pro Fenster oder Projekt. Das Schließen eines Projekt-Tabs schließt das Projekt in CodeNomad; Sitzungen laufen in OpenCode weiter und erscheinen wieder, wenn Sie das Projekt erneut öffnen. CodeNomad entlädt niemals native Locations. Das Schließen eines ganzen Fensters, Beenden oder Neuladen bewahrt Projektverbindungen für die Wiederherstellung; weder diese Aktionen noch das Herunterfahren des Backends beenden den gemeinsamen Daemon. Siehe [Projekte](projects.md).

## Aktualisieren, neu starten oder neu laden {#maintenance}

1. Wählen Sie unter **Einstellungen → OpenCode** die Aktion **Status und Updates prüfen**.
2. Um installierte CLI-Dateien zu ersetzen, wählen Sie gegebenenfalls **Auf OpenCode {version} aktualisieren**. Warten Sie den Abschluss ab.
3. Prüfen Sie den Status des laufenden Dienstes. Verwenden Sie **Gemeinsamen Dienst neu starten** nur, wenn Sie die ausgewählte Installation für jeden verbundenen Client aktivieren möchten.
4. Für einen Prozessneustart ohne Installation klappen Sie **Fehlerbehebung** auf, wählen **OpenCode-Dienst neu starten** und bestätigen.

| Aktion | Umfang und Wirkung | Sichere Wiederherstellung |
| --- | --- | --- |
| CLI aktualisieren | Ändert die unterstützte installierte Programmdatei; startet den laufenden Daemon nicht implizit neu. | Prüfen Sie nach Fehlern installierte und laufende Version; wiederholen Sie erst nach Fehlerbehebung ausdrücklich. |
| Dienst neu starten | Ersetzt den gemeinsamen Prozess und unterbricht aktive Arbeit in allen verbundenen OpenCode-Clients; Sitzungsverlauf bleibt erhalten. | Verbinden Sie neu und prüfen Sie Unterhaltungen und geplante Missionen; Neustart bedeutet keine automatische Fortsetzung. |
| OpenCode-Konfiguration neu laden | Behält den Prozess, erstellt aber **jede geladene Location** für alle Clients neu. Bricht offene Berechtigungen/Forms ab und schließt Terminals/Hintergrundbefehle; aktive Arbeit kann unterbrochen werden. | Prüfen Sie Ressourcen und offene Arbeit erneut. Wiederholen Sie keinen Prompt und keine Änderung nur wegen einer verlorenen Antwort. |

Verwenden Sie **OpenCode-Konfiguration neu laden** (unter **Fehlerbehebung**, wenn der laufende Dienst es unterstützt) ausdrücklich, wenn gespeicherte Konfiguration oder installierte Plugins weiter fehlen und die Unterbrechung akzeptabel ist. Dies ist keine harmlose Anzeigeaktualisierung. CodeNomad verwendet keine ältere ausgewählte CLI, um einen neueren laufenden Daemon herunterzustufen.

## Sitzungsumgebung {#session-environment}

1. Öffnen Sie **Einstellungen → Erweitert** und klappen Sie **Umgebungsvariablen** auf.
2. Ergänzen, ändern oder entfernen Sie die Überschreibungen des Profils; jede Änderung wird sofort gespeichert.
3. Senden Sie den nächsten Prompt, benutzerdefinierten Befehl oder Sitzungs-Shell-Aufruf über CodeNomad, um die aktuelle Umgebung auf diese Unterhaltung anzuwenden.

Dies ist eine Konfigurationsprofileinstellung, die serverseitig vor jedem Senden angewandt wird. Bloßes Öffnen/Lesen einer Unterhaltung oder Speichern von Einstellungen verändert keine native Sitzung. Das Entfernen einer Überschreibung stellt den geerbten Wert des Ausführungshosts wieder her oder entfernt ihn, wenn er dort fehlt. Fehler beim Anwenden blockieren das Senden, statt veraltete Werte zu verwenden.

Die Umgebung steuert spätere lokale Shell-Starts in dieser nativen Sitzung. Bereits laufende Prozesse behalten ihre Umgebung. Sie konfiguriert Anbieter, MCP-/LSP-Server, unabhängige Terminals oder reine Location-Hintergrund-Shells **nicht** neu. Prompts in Warteschlangen erfassen nicht jeweils eine eigene Umgebung; ein anderer OpenCode-Client kann dieselbe Sitzungsumgebung ersetzen. Nehmen Sie nicht an, dass vollständig innerhalb von OpenCode erstellte Kind-Sitzungen eine CodeNomad-Aktualisierung zum Sendezeitpunkt erhalten.

Zulässige Variablen werden auch beim Start eines gestoppten Dienstes übergeben; die Verbindung zu einem vorhandenen Daemon ändert dessen Prozessumgebung nicht. Unter WSL werden Werte mit der Linux-Ausführungsumgebung kombiniert, nicht mit Windows-PATH/HOME. Änderungen an Überschreibungen verlagern weder OpenCodes Datenbank noch Dienstregistrierung.

## Native Konfigurationsdateien bearbeiten {#configuration-files}

1. Öffnen Sie **Einstellungen → Konfigurationsdateien** und wählen Sie **Datei**.
2. Prüfen Sie den angezeigten Pfad, bearbeiten Sie und wählen Sie **Speichern**.
3. Verwenden Sie **Neu laden**, um die Datei erneut zu lesen; dies ist nicht **OpenCode-Konfiguration neu laden**.

Dieser Editor bietet nur die aufgelisteten globalen Dateien `opencode.json` und `opencode.jsonc` unter `.config/opencode` des **CodeNomad-Serverbenutzers**. Er ist weder ein beliebiger Dateieditor noch eine Projektkonfigurationsauswahl und garantiert nicht, dass ein WSL-Daemon oder ein Daemon mit angepassten Suchpfaden diese Datei liest. Prüfen Sie das Ziel anhand des angezeigten Pfads; für andere Wurzeln nutzen Sie die eigenen Werkzeuge des Daemons.

Speichern schreibt die Datei als Text; es validiert weder die gesamte native Konfiguration noch startet/lädt es OpenCode neu. Stimmen Sie Änderungen mit anderen Clients ab: Diese Oberfläche bietet keine Zusammenführung externer Änderungen. Sichern Sie vor umfangreichem Ersetzen eine Kopie. Dateiwechsel oder Neuladen eines geänderten Entwurfs fragt nach dessen Verwerfen.

Konfigurationsbezogene Abläufe finden Sie unter [Integrationen](integrations.md), [Anbieter](providers.md), [Missionen](missions.md) und [OpenCode-Dokumentation](https://opencode.ai/v2/docs/).
