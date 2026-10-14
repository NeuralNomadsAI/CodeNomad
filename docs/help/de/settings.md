# Einstellungen und Layout

## Einstellungen öffnen und Geltungsbereich erkennen {#open-settings}

1. Öffnen Sie **Einstellungen** auf der Startseite oder in der Befehlspalette.
2. Wählen Sie einen Abschnitt. Lokale Electron-/Tauri-Fenster öffnen oder fokussieren ein natives Einstellungsfenster; Browser-/Remote-Ansichten verwenden die eingebettete Einstellungsseite.
3. Prüfen Sie vor dem Verlassen den Geltungsbereich und mögliche **Speichern**-Aktionen.

Die meisten Schalter wirken sofort. Editoren für Sprache, Paletten und Missionsvorgaben haben explizite Speichersteuerung. Ein fehlgeschlagenes Speichern bestätigt nicht die Wirksamkeit; öffnen/aktualisieren Sie den betreffenden Abschnitt vor Wiederholung.

| Zustand | Was er steuert |
| --- | --- |
| CodeNomad-Konfiguration | UI-Einstellungen, Sprache, SideCars und Servereinstellungen für Clients dieser Konfiguration. Ein UI-Abzeichen „Gerät“ verspricht keine Isolation gegenüber anderen Clients derselben Konfiguration. |
| Fenster-/Projekt-Tab-Layout | Offene Panels, ausgewählte Tabs, Lesezustand und wiederherstellbare Entwürfe/Layout. Dies ist keine OpenCode-Konfiguration. |
| Globale/projektbezogene OpenCode-Einstellungen | Native Plugin-/Konfigurationsänderungen im angezeigten Umfang. Projektsteuerung benötigt ein aktives Projekt/eine Location. |
| Desktop-Datenprofil | Native Fenster, Wiederherstellungszustand und Browserspeicher, unabhängig von Konfigurationsdatei und gemeinsamem OpenCode-Dienst. Siehe [Desktop-Fenster und Daten](desktop.md). |

Anzeigeeinstellungen neu zu setzen startet OpenCode nicht neu und wiederholt keinen Prompt. Native Konfiguration, Dienstwartung und Zugangsdaten haben separate Folgen: siehe [OpenCode-Einrichtung](opencode.md), [Anbieter](providers.md) und [Integrationen](integrations.md).

## Sprache und Darstellung {#language-appearance}

1. Wählen Sie unter **Allgemein** die **Sprache**: Englisch, Spanisch, Französisch, Russisch, Japanisch, vereinfachtes Chinesisch, Hebräisch, Deutsch, Nepali oder Türkisch.
2. Wählen Sie **Darstellungsmodus**: **Auto**, **Hell** oder **Dunkel**. Auto folgt dem Betriebssystem.
3. Wählen Sie eine Palette für die angezeigte Darstellung. Helle und dunkle Auswahl werden getrennt gespeichert; Auto verwendet die passende.
4. Verwenden Sie für eigene Farben die Farbfelder und **Speichern**; **Zurücksetzen** stellt die Farben dieser Palette wieder her. Mit **Neu** benennen Sie eine separate Palette.

Die Oberfläche aktualisiert sich ohne Unterhaltungsneustart. Hebräisch verwendet Rechts-nach-links-Layout; Code und technische Werte bleiben in ihrer eigenen Richtung lesbar. Die Sprachauswahl ändert Oberflächentexte, nicht die Sprache vorhandener Nachrichten oder Agentenanweisungen. Native Betriebssystemmenüs können Englisch bleiben.

Werden Farben schwer lesbar, wählen Sie eine integrierte Palette oder setzen die bearbeitete zurück. Ein Palettenwechsel kann zum Verwerfen ungespeicherter Farbänderungen auffordern; er verwirft keinen Unterhaltungsentwurf.

## Panels und Statusabschnitte {#panels-status}

1. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den äußeren Kopfecken oder deren Menüpunkte unter **View** zum Ein-/Ausblenden.
2. Öffnen Sie **Rechtes Panel anpassen** im rechten Panel. Wählen Sie integrierte Tabs und Statusabschnitte per Kontrollkästchen; mindestens ein Statusabschnitt bleibt sichtbar.
3. Ziehen Sie rechte Panel-Tabs zum Umordnen. **Zurücksetzen** stellt integrierte Layoutauswahlen wieder her.

Status enthält Tokeninformationen, Yolo-Modus, Anbieternutzung, Hintergrundprozesse, MCP und Plugins. Ausblenden deaktiviert keinen Dienst und widerruft keine Rechte. Schmale Layouts lassen Panels über der Unterhaltung schweben, statt sie einzuengen; ein schwebendes Panel zu öffnen schließt das andere.

Integriertes Layout ist Fensterlayout, keine Projektänderung. Erweiterungskästchen sind anders: Sie aktivieren Code über alle Projekte dieser Konfiguration. **Zurücksetzen** ändert keine Erweiterungszustimmung. Siehe [Panel-Erweiterungen](extensions.md).

## Verlaufsdetails und Eingabegröße {#transcript-composer}

1. Öffnen Sie **Chat**, um Standarddetails des Verlaufs zu wählen. Vorgaben sind **Minimal**, **Balanced**, **Detailed** und **Everything**; Einzeländerungen erzeugen **Custom**.
2. Passen Sie Denken, Werkzeugeingaben/-ausgaben, Diagnosen und Tokendetails an oder verwenden Sie das Popup **Nachrichteninhalt** der Unterhaltung für dieselben Sichtbarkeitsoptionen.
3. Passen Sie unter **Allgemein** nach Bedarf **Nachrichten-Timeline**, **Timeline-Tool-Aufrufe**, **Diff-Ansicht** und **Folgeprompt-Verhalten** an.
4. Ändern Sie die Größe des Eingabefelds über dessen Größensteuerung; lange Entwürfe scrollen im Feld.

Sichtbarkeits- und Aufklappeinstellungen ändern nur die Darstellung. Sie entfernen keine gespeicherten Werkzeuge/Denkprozesse und komprimieren keinen Modellkontext. Destruktive Vorgänge siehe [Verlauf und Bereinigung](history.md).

Die Eingabehöhe folgt der sichtbaren Unterhaltung einschließlich Bildschirmtastatur: mindestens 8 % mit 44-Pixel-Untergrenze, höchstens 60 %. Manuelle Höhe wird proportional gemerkt; schmale Breite und langer Text erhöhen diese Grenzen nicht. Eine aufgeklappte Berechtigung/Frage minimiert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Klappen/erledigen Sie die Anfrage, um Größenänderung fortzusetzen.

## Benachrichtigungen und Abzeichen {#notifications}

1. Öffnen Sie **Benachrichtigungen** und wählen Sie **Anfordern**, falls noch keine Berechtigung erteilt wurde.
2. Aktivieren Sie **Benachrichtigungen aktivieren**.
3. Wählen Sie **Sitzung benötigt Eingabe**, **Sitzung wird inaktiv** sowie **Benachrichtigen, wenn die App im Fokus ist** nach Bedarf.

Browser-/OS-Berechtigung gehört zum Gerät und zur Anwendungs-Origin; eine gespeicherte Einstellung kann Ablehnung nicht übersteuern. Aktivieren Sie bei Blockade Benachrichtigungen in Browser-/OS-Einstellungen und kehren Sie hierher zurück. Nicht unterstützte Umgebungen lassen die Steuerung deaktiviert.

Die ungelesene Glocken-/Verlaufszahl steuert Browser-Favicon-Punkt und natives App-Abzeichen. Native Abzeichen aggregieren aktive Hauptfenster; sie zählen keine laufenden Sitzungen und beweisen keine zugestellte OS-Benachrichtigung. PWA-Starter-Abzeichen bietet diese Funktion nicht.

## Erweiterte Optionen {#advanced}

1. Öffnen Sie **Erweitert**.
2. Ändern Sie nur benötigtes Verhalten; Schalter speichern über CodeNomad-Einstellungen. Bearbeiten Sie **Umgebungsvariablen** separat für die Sitzungsausführungsumgebung.
3. Prüfen Sie die resultierende Ansicht oder nächste Eingabe, statt spekulativ den gemeinsamen Dienst neu zu starten.

| Option | Wirkung und Vorsicht |
| --- | --- |
| Automatische Bereinigung leerer Sitzungen | Bereinigt leere Sitzungen beim Erstellen neuer; zum Behalten deaktiviert lassen. |
| Statusanzeigen von Unteragenten beibehalten | Behält ungesehene Inaktivitätsmarkierungen bis zur Ansicht, statt sie nach fünf Sekunden auszublenden. |
| Vorhandenes Fenster beim zweiten Start fokussieren | Nur nativer Desktop; ändert Zweitstartverhalten, nicht Tab-Erstellung. |
| Anbieterguthaben | Zeigt zusätzliche Guthaben unter Nutzung; kauft keine Guthaben und wechselt keine Konten. |
| Reine Leerraumänderungen ausblenden | Lässt nicht gestagte reine Leerraum-/Zeilenende-Dateien in Änderungen und Sammelaktionen weg; gestagte bleiben sichtbar. Siehe [Dateien](files.md). |
| Lange Assistentenantworten anhalten | Stoppt automatisches Folgen, wenn eine gestreamte Antwort über die Ansicht hinauswächst. |
| Umgebungsvariablen | Serverseitig vor jedem Prompt/Sitzungsbefehl angewandt; Lesen aktualisiert keine bereits laufende Ausführung. Siehe [OpenCode-Einrichtung](opencode.md). |

Tastaturkonfiguration siehe [Tastenkürzel](shortcuts.md); Sprachsteuerung siehe [Spracheingabe und Wiedergabe](voice.md). Startwiederherstellung und Löschen gespeicherter Desktop-Profile behandelt [Desktop-Fenster und Daten](desktop.md).
