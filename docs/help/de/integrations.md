# Native Integrationen

CodeNomad stellt OpenCodes native MCP-Verbindungen, Plugin-Aktivierung, Skills und benutzerdefinierte Befehle bereit. Sie laufen auf dem Ausführungshost. Sie sind getrennt von [Panel-Erweiterungen](extensions.md) in der Sandbox und [SideCars](browser-sidecars.md).

## Passende Steuerung wählen {#integration-scopes}

| Integration | Wo handeln | Was die Steuerung ändert |
| --- | --- | --- |
| MCP-Server | **Status → MCP-Server** | Native Verbindung an der angezeigten Location; installiert keinen Server. |
| Natives Plugin | **Status → Plugins** | Dauerhafte Aktivierungsregel **Global** oder **Projekt**; installiert/aktualisiert/entfernt das Paket nicht. |
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

1. Installieren/deklarieren Sie das native Plugin mit OpenCode; öffnen Sie dann **Status → Plugins**.
2. Zeigen Sie auf den Namen oder fokussieren Sie ihn, um Quelle, Laufzeitfehler und Konfigurationszieldetails zu prüfen.
3. Schalten Sie **Global** oder **Projekt** bewusst um. Warten Sie den Schreibvorgang ab und verwenden Sie bei unklarem Zustand **Plugin-Steuerung aktualisieren**.

Global zielt auf die gefundene globale Konfiguration des verbundenen Daemons. Projekt zielt auf die Konfiguration innerhalb der aktiven Location, nicht auf eine geerbte übergeordnete Datei. Eine spätere Projektregel kann Global übersteuern; der globale Schalter zeigt weiterhin die globale Regel, statt den endgültigen Projektzustand vorzutäuschen. Ohne Projektregel erbt Projekt den aufgelösten globalen Zustand.

Diese Schalter ergänzen exakte Aktivierungsregeln und bewahren Quelldeklarationen sowie unabhängige Konfiguration. Sie bearbeiten keine Plugin-Optionen, installieren keine Pakete und entfernen keine Dateien. Integrierte OpenCode-Plugins werden nicht als Benutzeraktivierungsschalter angeboten. Projekt ist deaktiviert, wenn sein Ziel nicht sicher von Global getrennt werden kann oder die aktive Location verlassen würde.

Die Oberfläche behält im verborgenen Zustand ihren letzten Schnappschuss und prüft beim Anzeigen, nach nativen Änderungen/Wiederverbindung und expliziter Aktualisierung erneut. Gespeicherte Regel und aktuelle Laufzeitverfügbarkeit können kurzzeitig abweichen. Bleibt ein Plugin nicht verfügbar, prüfen Sie Tooltip und native Konfiguration vor **OpenCode-Konfiguration neu laden**; dies betrifft alle geladenen Locations, nicht nur dieses Plugin. Fehlerhafte Konfiguration oder gleichzeitige Bearbeitung wird nicht stillschweigend überschrieben: Beheben Sie das Problem, aktualisieren Sie und wiederholen Sie ausdrücklich.

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
