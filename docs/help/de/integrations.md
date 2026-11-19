# Native Integrationen

CodeNomad stellt OpenCodes native MCP-Verbindungen, Plugin-Aktivierung, Skills und benutzerdefinierte Befehle bereit. Sie laufen auf dem Ausführungshost. Sie sind getrennt von [Panel-Erweiterungen](extensions.md) in der Sandbox und [SideCars](browser-sidecars.md).

## Passende Steuerung wählen {#integration-scopes}

| Integration | Wo handeln | Was die Steuerung ändert |
| --- | --- | --- |
| MCP-Server | **Status → MCP-Server** | Native Verbindung an der angezeigten Location; installiert keinen Server. |
| Natives Plugin | **Status → Plugins** | Fügt eine Paketdeklaration hinzu oder entfernt sie und setzt eine dauerhafte Aktivierungsregel **Global** oder **Projekt**; bei einem Paket-Plugin eine ausdrückliche Prüfung oder Aktualisierung dieses Pakets. |
| Skill | `@`-Menü im Eingabefeld | Expliziter Anhang an den nächsten Prompt in der Location der Unterhaltung. |
| Benutzerdefinierter Befehl | `/`-Menü im Eingabefeld | Führt einen von OpenCode für diese Location angebotenen Befehl aus. |

Native Integrationen haben die Rechte ihres Hostprozesses unter OpenCodes Berechtigungen; sie sind keine HTML-Panels in einer Sandbox.

## MCP verbinden oder trennen {#mcp}

1. Konfigurieren Sie den MCP-Server auf dem OpenCode-Ausführungshost gemäß der [OpenCode-MCP-Dokumentation](https://opencode.ai/v2/docs/mcp-servers/).
2. Öffnen Sie **Status → MCP-Server** für das Projekt.
3. Verwenden Sie den Schalter neben dem Server zum Verbinden/Trennen. Warten Sie, bis sich die Verbindungsanzeige stabilisiert.

Andere Clients dieser Location können die Verbindungsänderung beobachten. Trennen entfernt weder die Serverdeklaration noch deinstalliert es dessen Programmdatei.

Prüfen Sie bei Verbindungsfehlern Serverkonfiguration, erforderliche Umgebung und Authentifizierung; der Schalter schließt OAuth nicht ab.

## Plugins global oder projektbezogen aktivieren {#plugins}

Von CodeNomad verwaltete Plugins erscheinen außerhalb der gewöhnlichen Plugin-Liste und ihrer Aktivierungs-, Aktualisierungs- und Entfernungsaktionen.

Bei **CodeNomad-Plugins erfordern Aufmerksamkeit** öffnen Sie **i** für Details. Ein deaktiviertes Plugin bietet **Erneut aktivieren**; prüfen Sie vorher den angezeigten Konfigurationsbereich.

1. [Fügen Sie das Plugin hinzu](#plugin-sources) oder deklarieren Sie es in der OpenCode-Konfiguration; öffnen Sie dann **Status → Plugins**.
2. Zeigen Sie auf den Namen oder fokussieren Sie ihn, um Quelle, Laufzeitfehler und Konfigurationszieldetails zu prüfen.
3. Schalten Sie **Global** oder **Projekt** bewusst um. Warten Sie den Schreibvorgang ab und verwenden Sie bei unklarem Zustand **Plugin-Steuerung aktualisieren**.
4. Verwenden Sie bei einem aus einem Paket installierten Plugin das Symbol neben seinem Namen. Sein Menü nennt den genauen Vorgang: **Updates für … prüfen** für das Paket oder **… aktualisieren**, sobald eine neuere Version gefunden wurde.

Global zielt auf die gefundene globale Konfiguration des verbundenen Daemons. Projekt zielt auf die Konfiguration innerhalb der aktiven Location, nicht auf eine geerbte übergeordnete Datei. Eine spätere Projektregel kann Global übersteuern; der globale Schalter zeigt weiterhin die globale Regel, statt den endgültigen Projektzustand vorzutäuschen. Ohne Projektregel erbt Projekt den aufgelösten globalen Zustand.

Integrierte OpenCode-Plugins werden nicht als Benutzeraktivierungsschalter angeboten. Projekt ist deaktiviert, wenn sein Ziel nicht sicher von Global getrennt werden kann oder die aktive Location verlassen würde.

Eine Paketaktualisierung ändert dieses Paket im gemeinsamen Cache von OpenCode für jede Location, die es verwendet, wie sein Tooltip angibt; sie ändert keine Aktivierungsregeln, startet OpenCode nicht neu und lädt keine Konfiguration neu. Lokale, integrierte und vom SDK bereitgestellte Plugins haben keine Paketaktion.

## Plugin hinzufügen oder entfernen {#plugin-sources}

1. Öffnen Sie in **Status → Plugins** **+** und wählen Sie **Plugin hinzufügen…**.
2. Geben Sie ein Paket aus der npm-Registry (`name`, `name@1.2.3`, `@scope/name@^1`) oder ein Git-Repository (`github:besitzer/repo`, `git+https://…`) ein.
3. Behalten Sie **Global** bei, außer das Plugin soll nur für dieses Projekt laufen, und wählen Sie **Hinzufügen**.
4. Die neue Zeile zeigt **Wird installiert**, bis OpenCode sie meldet.

Zum Entfernen öffnen Sie das Menü neben dem Namen und wählen **Aus Global entfernen** oder **Aus Projekt entfernen**. Die Deklaration und ihre Aktivierungsregeln in der Konfigurationsdatei dieses Bereichs werden gelöscht, außer einer Deaktivierungsregel, solange eine andere Deklaration des Plugins besteht, und einer Aktivierungsregel, die eine frühere Deklaration noch definiert. Eine Aktivierungsregel, die ihre Definition verlieren würde, wird auch aus der Konfiguration dieses Projekts gelöscht, da OpenCode sonst ein gleichnamiges Registry-Paket herunterladen würde; steht sie in einer Datei, die CodeNomad nicht bearbeitet, wird das Entfernen abgelehnt. Der Paket-Cache von OpenCode bleibt bestehen. Regeln eines Plugins, das OpenCode nicht identifizieren konnte (deaktiviert oder vor dem Laden fehlgeschlagen), bleiben in einer eigenen Zeile, deren Menü dasselbe Entfernen anbietet.

Der Code des Plugins läuft mit Ihren Rechten in OpenCode. Ein **Projekt**-Eintrag läuft jedes Mal, wenn dieser Ordner in OpenCode geöffnet wird, und Pakete mit Teilen für die OpenCode-Desktop-App laden diese nur aus **Global**; der Tooltip weist darauf hin, wenn ein solches Paket anderswo deklariert ist. Lokale Pfade, Konfigurationsvariablen und Plugin-IDs werden hier abgelehnt: Deklarieren Sie lokale Plugins in der Konfigurationsdatei. Ein Paket, das bereits in einer für diese Location geltenden Konfiguration deklariert ist, wird abgelehnt, unabhängig von Version, Bereich oder Form.

Die installierte Paketversion erscheint neben dem Plugin-Namen. Bei Git-Plugins enthalten die Details den Commit; ist die Version nicht verfügbar, erscheint der siebenstellige Commit neben dem Namen. Zeigen Sie auf den Namen oder fokussieren Sie ihn, um Details, **Update verfügbar** und bei einer fehlgeschlagenen Installation den Fehler mit seiner Referenz im OpenCode-Protokoll zu sehen.

## Skills anhängen {#skills}

1. Geben Sie im Eingabefeld `@` ein, durchsuchen Sie die verfügbaren Skills der Location und wählen Sie einen.
2. Prüfen Sie dessen entfernbaren Anhang neben Dateien/Agenten; entfernen Sie ihn vor dem Senden, falls unbeabsichtigt.
3. Senden Sie den Prompt. Skill-Bezeichnungen bleiben an der gesendeten Nachricht.

Ein Anhang zu entfernen macht kein früheres Senden rückgängig.

Die Skill-Verfügbarkeit kommt aus der Location der Unterhaltung, nicht aus einem globalen CodeNomad-Skill-Katalog. Siehe [OpenCode-Skill-Dokumentation](https://opencode.ai/v2/docs/skills/) und [Unterhaltungen](conversations.md).

## Benutzerdefinierte Befehle ausführen {#commands}

1. Geben Sie `/` im Eingabefeld ein und wählen Sie einen verfügbaren nativen Befehl.
2. Geben Sie Argumente an und prüfen Sie vor dem Absenden je nach Befehl **Agent**, **Modell** und **Denken**.
3. Prüfen Sie bei unklarer Bestätigung die entstandene Unterhaltung, statt wiederholt abzusenden.

Befehle werden von OpenCode für die aktive Location ermittelt. `/btw` ist CodeNomads separater flüchtiger Frageablauf, kein normaler benutzerdefinierter Befehl.

Befehlsdefinitionen und native Konfigurationsvererbung erläutert die [OpenCode-Befehlsdokumentation](https://opencode.ai/v2/docs/commands/). Aktualisieren/öffnen Sie nach Konfigurationsänderungen zuerst die relevante Oberfläche erneut; verwenden Sie explizites Konfigurationsneuladen nur, wenn die Laufzeit es noch benötigt. Wiederholen Sie niemals einen möglicherweise angenommenen Befehl allein zum Aktualisieren seiner Anzeige.
## Integrationen in Plugins {#integration-rows}

Unter **Status → Plugins** öffnet **+** die Auswahl **Integration hinzufügen…** oder **Plugin hinzufügen…**. Die Integrationsauswahl enthält nicht installierte Einträge des geprüften Katalogs. Wählen Sie den Bereich und **Installieren**: CodeNomad installiert die gewählte Katalog-ID. Native Integrationen verwenden **Nur global**. **Katalog nicht verfügbar** bietet **Aktualisieren**; **Katalog vom {date}** kennzeichnet den letzten gültigen, veralteten Katalog.

Die Statuszeile in Akzentfarbe bietet **In Blender installieren**, **Blender aktualisieren** oder **verbinden**, um die angezeigte Unterhaltung mit einem geöffneten Dokument zu verbinden (**Verbinden…** zur Auswahl zwischen mehreren). Ein Kettensymbol und das Dokument zeigen eine Verbindung; wählen Sie sie zum Trennen. Eine Unterhaltung verbindet sich außerdem selbst, sobald ihr Agent die Integration zum ersten Mal verwendet.

Das Menü **…** der Zeile beginnt mit dem Verbindungsstatus, zum Beispiel **Blender: 1 geöffnetes Dokument** oder **Blender geschlossen**. Danach bietet es **Dokumentation**, **In Anwendung installieren…**, **Anwendung aktualisieren…** oder **In Anwendung neu installieren…** ([siehe unten](#application-installation)), die Update-Prüfung des Pakets, **Aus Global entfernen** oder **Aus Projekt entfernen** und **Plugin-Steuerung aktualisieren**. Trennen erfordert einen Klick ohne Bestätigung und betrifft nur diese Unterhaltung: Die Anwendung bleibt offen, ihr Teil installiert, und andere Unterhaltungen behalten ihre Verbindung.

Kataloginstallation, Installation/Aktualisierung des Anwendungsteils und Entfernen erfordern eine Bestätigung. **Abbrechen** erhält zuerst den Fokus; die Bestätigungsaktion wird nach 600 ms verfügbar. Aktivierung, Plugin-Updates, Verbinden und Trennen werden direkt ausgeführt.

Beim Entfernen zeigt eine Warnung Plugin und genauen Bereich. **Abbrechen** erhält den Fokus; **Aus Global/Projekt entfernen** wird nach 600 ms verfügbar und erfordert eine ausdrückliche Aktion. Das Entfernen kann Verfügbarkeit und Verbindungen verwendender Unterhaltungen unterbrechen; Global kann weitere Projekte betreffen. Nur die bestätigte Deklaration und die oben beschriebenen Aktivierungsregeln werden entfernt; Cache, Anwendungsdateien und gespeicherte Verbindungshinweise bleiben erhalten. Änderungen der Konfiguration erfordern eine neue Auswahl und Bestätigung.

## Anwendungsintegration installieren oder aktualisieren {#application-installation}

Wählen Sie unter **Status → Plugins** in der Statuszeile der Integration **In Blender installieren** oder **Blender aktualisieren**, wenn der aktuelle Status die Aktion anbietet, oder im Menü **…** **In Anwendung installieren…**, **Anwendung aktualisieren…** oder **In Anwendung neu installieren…**. Eine Neuinstallation schreibt den Anwendungsteil neu, ob die Anwendung offen oder geschlossen ist. Die Aktion ist auch ohne Unterhaltung oder geöffnetes Dokument verfügbar.

Die Bestätigung nennt die Anwendung und die **Version des Integrationspakets**, das die Installation bereitstellt. Prüfen Sie beides und den Rechnerhinweis: Die Installation erfolgt auf dem Rechner, auf dem OpenCode läuft. Das kann ein entfernter Rechner sein. **Abbrechen** erhält zunächst den Fokus. Bestätigen Sie ausdrücklich, um fortzufahren.

WSL lehnt die Installation in der Anwendung immer ab, selbst wenn eine geöffnete Anwendung kompatibel erscheint. Öffnen Sie die Anwendung auf einem unterstützten Rechner.

Öffnen Sie nach Installation oder Aktualisierung die Anwendung und prüfen Sie deren Integration.

Bleibt das Ergebnis nach einem Fehler ungewiss, wiederholen Sie diese Anfrage niemals: Prüfen Sie zuerst die Anwendung und starten Sie bei Bedarf eine neue Aktion mit erneuter Bestätigung.
