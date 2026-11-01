# Native Integrationen

CodeNomad stellt OpenCodes native MCP-Verbindungen, Plugin-Aktivierung, Skills und benutzerdefinierte Befehle bereit. Sie laufen auf dem Ausführungshost. Sie sind getrennt von [Panel-Erweiterungen](extensions.md) in der Sandbox und [SideCars](browser-sidecars.md).

## Passende Steuerung wählen {#integration-scopes}

| Integration | Wo handeln | Was die Steuerung ändert |
| --- | --- | --- |
| MCP-Server | **Status → MCP-Server** | Native Verbindung an der angezeigten Location; installiert keinen Server. |
| Natives Plugin | **Status → Plugins** | Fügt eine Paketdeklaration hinzu oder entfernt sie und setzt eine dauerhafte Aktivierungsregel **Global** oder **Projekt**; bei einem Paket-Plugin eine ausdrückliche Prüfung oder Aktualisierung dieses Pakets. |
| Skill | `@`-Menü im Eingabefeld | Expliziter Anhang an den nächsten Prompt in der Location der Unterhaltung. |
| Benutzerdefinierter Befehl | `/`-Menü im Eingabefeld | Führt einen von OpenCode für diese Location angebotenen Befehl aus. |

Konfigurieren/installieren Sie die Integration zuerst mit OpenCodes unterstützter Konfiguration und CLI. Paketinstallation, Quelldeklaration, Regelaktivierung, Dienstverbindung und Werkzeugverfügbarkeit sind getrennte Schritte. Native Integrationen haben die Rechte ihres Hostprozesses unter OpenCodes Berechtigungen; sie sind keine HTML-Panels in einer Sandbox.

## MCP verbinden oder trennen {#mcp}

1. Konfigurieren Sie den MCP-Server auf dem OpenCode-Ausführungshost gemäß der [OpenCode-MCP-Dokumentation](https://opencode.ai/v2/docs/mcp-servers/).
2. Öffnen Sie **Status → MCP-Server** für das Projekt.
3. Verwenden Sie den Schalter neben dem Server zum Verbinden/Trennen. Warten Sie, bis sich die Verbindungsanzeige stabilisiert.

Der Schalter ruft die native Verbindungs-API für die gemeldete Location auf, kein gerätelokales Installationsprogramm und keine fensterbezogene Sichtbarkeitseinstellung. Andere Clients dieser Location können die Verbindungsänderung beobachten. Trennen entfernt weder die Serverdeklaration noch deinstalliert es dessen Programmdatei.

Erscheint kein Server, prüfen Sie aktive Location und native Konfiguration. Prüfen Sie bei Verbindungsfehlern Serverkonfiguration, erforderliche Umgebung und nativen Authentifizierungsablauf; nehmen Sie nicht an, dass der Schalter OAuth abschließt. Prüfen Sie nach dem Wiederverbinden den Status erneut. Verwenden Sie explizites Konfigurationsneuladen nur bei Bedarf und beachten Sie die Unterbrechungen unter [OpenCode-Einrichtung](opencode.md).

## Plugins global oder projektbezogen aktivieren {#plugins}

1. [Fügen Sie das Plugin hinzu](#plugin-sources) oder deklarieren Sie es in der OpenCode-Konfiguration; öffnen Sie dann **Status → Plugins**.
2. Zeigen Sie auf den Namen oder fokussieren Sie ihn, um Quelle, Laufzeitfehler und Konfigurationszieldetails zu prüfen.
3. Schalten Sie **Global** oder **Projekt** bewusst um. Warten Sie den Schreibvorgang ab und verwenden Sie bei unklarem Zustand **Plugin-Steuerung aktualisieren**.
4. Verwenden Sie bei einem aus einem Paket installierten Plugin das Symbol neben seinem Namen. Sein Menü nennt den genauen Vorgang: **Updates für … prüfen** für das Paket oder **… aktualisieren**, sobald eine neuere Version gefunden wurde.

Global zielt auf die gefundene globale Konfiguration des verbundenen Daemons. Projekt zielt auf die Konfiguration innerhalb der aktiven Location, nicht auf eine geerbte übergeordnete Datei. Eine spätere Projektregel kann Global übersteuern; der globale Schalter zeigt weiterhin die globale Regel, statt den endgültigen Projektzustand vorzutäuschen. Ohne Projektregel erbt Projekt den aufgelösten globalen Zustand.

Diese Schalter ergänzen exakte Aktivierungsregeln und bewahren Quelldeklarationen sowie unabhängige Konfiguration. Sie bearbeiten keine Plugin-Optionen, installieren keine Pakete und entfernen keine Dateien. Integrierte OpenCode-Plugins werden nicht als Benutzeraktivierungsschalter angeboten. Projekt ist deaktiviert, wenn sein Ziel nicht sicher von Global getrennt werden kann oder die aktive Location verlassen würde.

Eine Paketaktualisierung ändert dieses Paket im gemeinsamen Cache von OpenCode für jede Location, die es verwendet, wie sein Tooltip angibt; sie ändert keine Aktivierungsregeln, startet OpenCode nicht neu und lädt keine Konfiguration neu. Lokale, integrierte und vom SDK bereitgestellte Plugins haben keine Paketaktion. Ein Paket, das vor dem Melden seiner Plugin-ID scheitert, wird unter seinem Paketnamen aufgeführt, mit dem Fehler in seinem Tooltip und Prüf-/Aktualisierungsaktionen, aber ohne Aktivierungsschalter. Eine fehlgeschlagene Prüfung oder Aktualisierung wird gemeldet und nie automatisch wiederholt.

Die Oberfläche behält im verborgenen Zustand ihren letzten Schnappschuss und prüft beim Anzeigen, nach nativen Änderungen/Wiederverbindung und expliziter Aktualisierung erneut. Gespeicherte Regel und aktuelle Laufzeitverfügbarkeit können kurzzeitig abweichen. Bleibt ein Plugin nicht verfügbar, prüfen Sie Tooltip und native Konfiguration vor **OpenCode-Konfiguration neu laden**; dies betrifft alle geladenen Locations, nicht nur dieses Plugin. Fehlerhafte Konfiguration oder gleichzeitige Bearbeitung wird nicht stillschweigend überschrieben: Beheben Sie das Problem, aktualisieren Sie und wiederholen Sie ausdrücklich.

## Plugin hinzufügen oder entfernen {#plugin-sources}

1. Wählen Sie in **Status → Plugins** **Plugin hinzufügen** (das Plus-Symbol neben **Plugin-Steuerung aktualisieren**).
2. Geben Sie ein Paket aus der npm-Registry (`name`, `name@1.2.3`, `@scope/name@^1`) oder ein Git-Repository (`github:besitzer/repo`, `git+https://…`) ein.
3. Behalten Sie **Global** bei, außer das Plugin soll nur für dieses Projekt laufen, und wählen Sie **Hinzufügen**.
4. Die neue Zeile zeigt **Wird installiert**, bis OpenCode sie meldet. Danach wird sie eine normale Plugin-Zeile mit Schaltern oder eine fehlgeschlagene Zeile.

Zum Entfernen öffnen Sie das Menü neben dem Namen und wählen **Aus Global entfernen** oder **Aus Projekt entfernen**. Nur die Deklaration in der Konfigurationsdatei dieses Bereichs wird gelöscht; ihre Aktivierungsregeln für **Global**/**Projekt** bleiben als Regeln erhalten, und der Paket-Cache von OpenCode bleibt bestehen.

Der Code des Plugins läuft mit Ihren Rechten in OpenCode. Ein **Projekt**-Eintrag läuft jedes Mal, wenn dieser Ordner in OpenCode geöffnet wird, und Pakete mit Teilen für die OpenCode-Desktop-App laden diese nur aus **Global**; der Tooltip weist darauf hin, wenn ein solches Paket anderswo deklariert ist. Lokale Pfade, Konfigurationsvariablen und Plugin-IDs werden hier abgelehnt: Deklarieren Sie lokale Plugins in der Konfigurationsdatei. Ein Paket, das bereits in einer für diese Location geltenden Konfiguration deklariert ist, wird abgelehnt, unabhängig von Version, Bereich oder Form.

Eine OpenCode-Integration aus dem geprüften Katalog (zum Beispiel die Blender-Integration) wird schon vor der Installation erkannt. Eine Integration mit einem Teil in einer Anwendung wird nur unter **Global** hinzugefügt: **Projekt** wird für sie abgelehnt. Ihr Registry-Paket und ihre Git-Builds gelten als ein Paket; eine zweite Form einer bereits eingetragenen oder geladenen Integration wird abgelehnt.

Zeigen Sie auf den Namen eines Plugins oder fokussieren Sie ihn, um Version, **Update verfügbar** und bei einer fehlgeschlagenen Installation den Fehler mit seiner Referenz im OpenCode-Protokoll zu sehen. Eine Zeile, die OpenCode nach zwei Minuten nicht gemeldet hat, zeigt **Nicht bestätigt** mit der Aktion **Plugin-Steuerung aktualisieren**: Das Plugin ist vielleicht deaktiviert, oder seine Installation wurde nie abgeschlossen (siehe [Fehlerbehebung](troubleshooting.md#providers-and-addons)).

## Skills anhängen {#skills}

1. Geben Sie im Eingabefeld `@` ein, durchsuchen Sie die verfügbaren Skills der Location und wählen Sie einen.
2. Prüfen Sie dessen entfernbaren Anhang neben Dateien/Agenten; entfernen Sie ihn vor dem Senden, falls unbeabsichtigt.
3. Senden Sie den Prompt. Skill-Bezeichnungen bleiben an der gesendeten Nachricht.

Die Auswahl hängt die native Skill-ID an und entfernt das `@query`-Token; sie fügt die Anweisungen nicht in den sichtbaren Entwurf ein. Senden leert die Auswahl im Eingabefeld, nicht die bereits von OpenCode mit dieser Nachricht gespeicherten Anweisungen. Ein Anhang zu entfernen macht kein früheres Senden rückgängig.

Die Skill-Verfügbarkeit kommt aus der Location der Unterhaltung, nicht aus einem globalen CodeNomad-Skill-Katalog. Kann die Liste nicht laden, schließen und öffnen Sie die Auswahl erneut; ist sie leer, prüfen Sie native Suche/Konfiguration. Siehe [OpenCode-Skill-Dokumentation](https://opencode.ai/v2/docs/skills/) und [Unterhaltungen](conversations.md).

## Benutzerdefinierte Befehle ausführen {#commands}

1. Geben Sie `/` im Eingabefeld ein und wählen Sie einen verfügbaren nativen Befehl.
2. Geben Sie Argumente an und prüfen Sie vor dem Absenden je nach Befehl **Agent**, **Modell** und **Denken**.
3. Prüfen Sie bei unklarer Bestätigung die entstandene Unterhaltung, statt wiederholt abzusenden.

Befehle werden von OpenCode für die aktive Location ermittelt. Ihre eigene native Definition kann das Ausführungsverhalten bestimmen; das Menü ist weder Paketinstallation noch uneingeschränkter Konfigurationseditor. CodeNomad wendet vor nativen benutzerdefinierten Befehlen die Sitzungsumgebung des Profils an; ein fehlgeschlagenes Umgebungsupdate blockiert das Senden. `/btw` ist CodeNomads separater flüchtiger Frageablauf, kein normaler benutzerdefinierter Befehl.

Befehlsdefinitionen und native Konfigurationsvererbung erläutert die [OpenCode-Befehlsdokumentation](https://opencode.ai/v2/docs/commands/). Aktualisieren/öffnen Sie nach Konfigurationsänderungen zuerst die relevante Oberfläche erneut; verwenden Sie explizites Konfigurationsneuladen nur, wenn die Laufzeit es noch benötigt. Wiederholen Sie niemals einen möglicherweise angenommenen Befehl allein zum Aktualisieren seiner Anzeige.
## Geöffnete Anwendung verbinden {#application-attachment}

Geben Sie ein Dokument über die Integration der Anwendung frei. Wählen Sie dann **Geöffnete Anwendung verbinden…** im Unterhaltungskopf (oder dessen Überlaufmenü) oder im Menü der Plugins-Zeile. Die Aktion erscheint nur für aktive native Integrationen mit Angeboten. Wählen Sie Anwendung und Dokument, prüfen Sie Zielunterhaltung und Änderungshinweis und wählen Sie **Verbindung bestätigen**. Abbrechen erhält zunächst den Fokus. Die Anwendung läuft auf dem OpenCode-Rechner, auch bei Fernzugriff. Ein nicht unterstützter Host, einschließlich nicht unterstütztem WSL, zeigt stattdessen Hilfe.

Eine gestartete Aktion behält ihr Ergebnis oder ihren Fehler bei nativen Änderungen und Neuverbindungen, solange die Zielunterhaltung angezeigt bleibt. Die Erfolgsmeldung ist ein lokaler Aktionsbeleg mit **Diese Unterhaltung trennen**, auch bei bereits getrennter Verbindung sicher nutzbar. Auch die Trennung zeigt einen lokalen Beleg. Navigation schließt diese Belege. Dieser Vertrag erlaubt kein Lesen aktueller Verbindungen je Unterhaltung. Gespeicherte Metadaten dienen nur als Hinweis: Erneutes Verbinden erscheint nur bei einem Angebot mit gleicher Integration und Bezeichnung und erfordert eine Bestätigung. Andere Clients können Verbindungen ändern. Nach erneutem Öffnen trennen Sie bestehende Verbindungen in der Anwendung.

Plugins zeigt bei fehlendem Katalog einen Hinweis oder bei veraltetem Katalog den letzten gültigen Stand mit Abrufzeit. Aktualisieren Sie Plugins für einen neuen Versuch. Entfernen wird bei verbundenen Unterhaltungen oder ungeprüften Verbindungen abgelehnt. Trennen Sie sie in der Anwendung, aktivieren Sie bei Bedarf die Integration und aktualisieren Sie vor einem neuen Versuch.
