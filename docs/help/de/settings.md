# Einstellungen und Layout

## Einstellungen öffnen und Geltungsbereich erkennen {#open-settings}

1. Öffnen Sie **Einstellungen** über das Zahnrad **Einstellungen öffnen** in der Tab-Leiste oder auf der Startseite. Direktzugänge wie **Anbieter verwalten** in der Modellauswahl, das Zahnrad des Missionspanels oder **Einstellungen** im Benachrichtigungsverlauf öffnen direkt den passenden Abschnitt.
2. Wählen Sie einen Abschnitt. Lokale Electron-/Tauri-Fenster öffnen oder fokussieren ein natives Einstellungsfenster; Browser-/Remote-Ansichten verwenden die eingebettete Einstellungsseite.
3. Prüfen Sie vor dem Verlassen den Geltungsbereich und mögliche **Speichern**-Aktionen.

Die meisten Auswahlen wirken sofort, auch die Missionsvorgaben, die jede Änderung sofort speichern. Sprache, eigene Palettenfarben und Konfigurationsdateien behalten ein explizites **Speichern**. Ein fehlgeschlagenes Speichern bestätigt nicht die Wirksamkeit; öffnen/aktualisieren Sie den betreffenden Abschnitt vor Wiederholung. Erläuterungen liegen hinter dem **i** neben dem Titel einer Einstellung: Zeigen Sie darauf oder fokussieren Sie es, oder tippen Sie auf einem Touchscreen darauf.

| Zustand | Was er steuert |
| --- | --- |
| CodeNomad-Konfiguration | UI-Einstellungen, Sprache, SideCars und Servereinstellungen für Clients dieser Konfiguration. Einstellungen ohne Abzeichen werden ebenfalls nicht pro Gerät gespeichert; **Server-Einstellung** kennzeichnet serverseitige Konfiguration wie Sprache, SideCars, Fernsteuerung und Umgebungsvariablen. |
| Fenster-/Projekt-Tab-Layout | Offene Panels, ausgewählte Tabs, Lesezustand und wiederherstellbare Entwürfe/Layout. Dies ist keine OpenCode-Konfiguration. |
| Globale/projektbezogene OpenCode-Einstellungen | Native Plugin-/Konfigurationsänderungen im angezeigten Umfang. Projektsteuerung benötigt ein aktives Projekt/eine Location. |
| Desktop-Datenprofil | Native Fenster, Wiederherstellungszustand und Browserspeicher, unabhängig von Konfigurationsdatei und gemeinsamem OpenCode-Dienst. Siehe [Desktop-Fenster und Daten](desktop.md). |

**Statistik** umfasst den gesamten verbundenen OpenCode-Dienst (alle Projekte, unabhängige Klone und Untersitzungen), nicht nur den geöffneten Ordner, für die letzten 7, 30, 90 oder 365 Tage. Sie benötigt ein geöffnetes Projekt und zeigt die von OpenCode erfassten Tokens und Kosten, keine Anbieterrechnungen oder Abonnementkontingente; während der Aktualisierung können zuvor gespeicherte Summen erscheinen. Plankontingente gehören in den Statusabschnitt **Nutzung**.

Anzeigeeinstellungen neu zu setzen startet OpenCode nicht neu und wiederholt keinen Prompt. Native Konfiguration, Dienstwartung und Zugangsdaten haben separate Folgen: siehe [OpenCode-Einrichtung](opencode.md), [Anbieter](providers.md) und [Integrationen](integrations.md).

## Sprache und Darstellung {#language-appearance}

1. Wählen Sie unter **Allgemein** die **Sprache**: Englisch, Spanisch, Französisch, Russisch, Japanisch, vereinfachtes Chinesisch, Hebräisch, Deutsch, Nepali oder Türkisch.
2. Wählen Sie unter **Farbschema** den **Modus**: **Auto**, **Dunkel** oder **Hell**. Auto folgt dem Betriebssystem.
3. Wählen Sie eine Palette für die angezeigte Darstellung. Helle und dunkle Auswahl werden getrennt gespeichert; Auto verwendet die passende.
4. Verwenden Sie für eigene Farben die Farbfelder und **Speichern**; **Zurücksetzen** stellt die Farben einer integrierten Palette wieder her. Mit **Neu** benennen Sie eine separate Palette, mit **Löschen** entfernen Sie eine selbst erstellte.

Die Oberfläche aktualisiert sich ohne Unterhaltungsneustart. Hebräisch verwendet Rechts-nach-links-Layout; Code und technische Werte bleiben in ihrer eigenen Richtung lesbar. Die Sprachauswahl ändert Oberflächentexte, nicht die Sprache vorhandener Nachrichten oder Agentenanweisungen. Native Desktop-Menüs wechseln in die Oberflächensprache, sobald ein CodeNomad-Fenster geladen ist.

Werden Farben schwer lesbar, wählen Sie eine integrierte Palette oder setzen die bearbeitete zurück. Ein Palettenwechsel kann zum Verwerfen ungespeicherter Farbänderungen auffordern; er verwirft keinen Unterhaltungsentwurf.

## Panels und Statusabschnitte {#panels-status}

1. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den äußeren Kopfecken oder deren Menüpunkte unter **Ansicht** zum Ein-/Ausblenden.
2. Öffnen Sie **Rechtes Panel anpassen** im rechten Panel. Wählen Sie integrierte Tabs und Statusabschnitte per Kontrollkästchen; mindestens ein Statusabschnitt bleibt sichtbar.
3. Ziehen Sie rechte Panel-Tabs zum Umordnen. **Zurücksetzen** stellt integrierte Layoutauswahlen wieder her.

Status enthält Tokeninformationen, Yolo-Modus, Anbieternutzung, Hintergrund-Shells, MCP und Plugins. Ausblenden deaktiviert keinen Dienst und widerruft keine Rechte. Schmale Layouts lassen Panels über der Unterhaltung schweben, statt sie einzuengen; ein schwebendes Panel zu öffnen schließt das andere.

Integriertes Layout ist Fensterlayout, keine Projektänderung. Erweiterungskästchen sind anders: Sie aktivieren Code über alle Projekte dieser Konfiguration. **Zurücksetzen** ändert keine Erweiterungszustimmung. Siehe [Panel-Erweiterungen](extensions.md).

## Verlaufsdetails und Eingabegröße {#transcript-composer}

1. Öffnen Sie **Chat**, um Standarddetails des Verlaufs zu wählen. Vorgaben sind **Nichts**, **Minimal**, **Ausgewogen** und **Alles**; Einzeländerungen erzeugen **Benutzerdefiniert**.
2. Legen Sie für Denken, Diagnosen, Werkzeugeingaben, Tokens, Systemnachrichten und jeden Werkzeugtyp den **Standardzustand** jeder Zeile fest (**Ausgeblendet**, **Eingeklappt** oder **Erweitert**), oder verwenden Sie das Popup **Nachrichteninhalt** der Unterhaltung, das diese Auswahl teilt.
3. Aktivieren Sie unter **Allgemein** nach Bedarf **Nachrichten-Zeitleiste anzeigen**, **Diffs von Tool-Aufrufen geteilt anzeigen** und **Gesendete Prompts in die Warteschlange stellen** (Prompts, die während der Arbeit einer Sitzung gesendet werden, einreihen statt sie einzuschieben).
4. Ändern Sie die Größe des Eingabefelds über dessen Größensteuerung; lange Entwürfe scrollen im Feld.

Timeline-Werkzeugmarkierungen folgen **Nachrichteninhalt**: Ein dort ausgeblendeter Werkzeugtyp blendet auch seine Markierungen aus, außer einer mit offener Berechtigung, und **Nichts** blendet sie alle aus. Sichtbarkeits- und Aufklappeinstellungen ändern nur die Darstellung. Sie entfernen keine gespeicherten Werkzeuge/Denkprozesse und komprimieren keinen Modellkontext. Destruktive Vorgänge siehe [Verlauf und Bereinigung](history.md).

Die Eingabehöhe folgt der sichtbaren Unterhaltung einschließlich Bildschirmtastatur: mindestens 8 % mit 44-Pixel-Untergrenze, höchstens 60 %. Manuelle Höhe wird proportional gemerkt; schmale Breite und langer Text erhöhen diese Grenzen nicht. Eine aufgeklappte Berechtigung/Frage minimiert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Klappen/erledigen Sie die Anfrage, um Größenänderung fortzusetzen.

## Benachrichtigungen und Abzeichen {#notifications}

1. Öffnen Sie **Benachrichtigungen**. Markieren Sie für jede Art von Benachrichtigung, wo sie erscheint: **Auf dem Bildschirm** (eine vorübergehende Blase), **Verlauf** (im Benachrichtigungsverlauf der Glocke in der Tab-Leiste aufbewahrt) und **System** (eine Betriebssystembenachrichtigung).
2. Das Markieren eines **System**-Kästchens fragt bei Bedarf nach der Berechtigung. Unter **Systembenachrichtigungen** fragt **Anfordern** erneut, solange die Berechtigung fehlt.
3. Aktivieren Sie **Benachrichtigen, wenn die App im Fokus ist**, um Systembenachrichtigungen auch zu erhalten, während dieses Fenster sichtbar ist.

Standardmäßig gehen **Eine Sitzung wartet auf Ihre Antwort** und **Eine Sitzung ist beendet** nur an System, damit sich vorübergehende Sitzungszustände nicht im Verlauf stapeln; sie betreffen Hauptsitzungen, keine Subagenten, und eine Sitzung, die Sie selbst stoppen, wird nicht gemeldet. Fehler erscheinen unabhängig von der Tabelle immer auf dem Bildschirm und im Verlauf, und kurze Fortschrittsmeldungen bleiben nur auf dem Bildschirm.

Browser-/OS-Berechtigung gehört zum Gerät und zur Anwendungs-Origin; eine gespeicherte Einstellung kann Ablehnung nicht übersteuern. Aktivieren Sie bei Blockade Benachrichtigungen in Browser-/OS-Einstellungen und kehren Sie hierher zurück. Nicht unterstützte Umgebungen lassen die Spalte System deaktiviert.

Die ungelesene Glocken-/Verlaufszahl, die nur an den Verlauf geleitete Benachrichtigungen zählt, steuert Browser-Favicon-Punkt und natives App-Abzeichen. Native Abzeichen aggregieren aktive Hauptfenster; sie zählen keine laufenden Sitzungen und beweisen keine zugestellte OS-Benachrichtigung. PWA-Starter-Abzeichen bietet diese Funktion nicht.

## Erweiterte Optionen {#advanced}

1. Öffnen Sie **Erweitert**.
2. Aktivieren oder deaktivieren Sie nur die benötigten Optionen; jede Änderung wird über die CodeNomad-Einstellungen gespeichert. Um die Ausführungsumgebung der Sitzung zu ändern, klappen Sie die eingeklappte Gruppe **Umgebungsvariablen** am Ende auf.
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
