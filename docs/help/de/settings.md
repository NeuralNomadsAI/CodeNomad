# Einstellungen und Layout

## Einstellungen öffnen und Geltungsbereich erkennen {#open-settings}

1. Öffnen Sie **Einstellungen** über das Zahnrad **Einstellungen öffnen** in der Tab-Leiste (in der macOS-Desktop-App in der Titelleiste) oder auf der Startseite. Direktzugänge wie **Anbieter verwalten** in der Modellauswahl, das Zahnrad des Missionspanels oder das Zahnrad **Einstellungen** im Benachrichtigungsverlauf öffnen direkt den passenden Abschnitt.
2. Wählen Sie einen Abschnitt. Lokale Electron-/Tauri-Fenster öffnen oder fokussieren ein natives Einstellungsfenster; Browser-/Remote-Ansichten verwenden die eingebettete Einstellungsseite.
3. Prüfen Sie vor dem Verlassen den Geltungsbereich und mögliche **Speichern**-Aktionen.

Die meisten Auswahlen wirken sofort, auch die Missionsvorgaben, die jede Änderung sofort speichern. Sprache, eigene Palettenfarben und Konfigurationsdateien behalten ein explizites **Speichern**. Ein fehlgeschlagenes Speichern bestätigt nicht die Wirksamkeit; öffnen/aktualisieren Sie den betreffenden Abschnitt vor Wiederholung. Zeigen Sie auf das **i** neben dem Einstellungstitel oder fokussieren Sie es für eine kurze Erklärung. Bei einem Hilfelink öffnen Klicken, Eingabe oder Antippen den passenden Abschnitt in der Oberflächensprache im Systembrowser oder in einem separaten Tab. Reine Tooltip-Symbole zeigen ihre Erklärung beim Antippen. **Einstellungen → Info** enthält außerdem die Karte **CodeNomad unterstützen**: **Sponsern oder mitwirken** öffnet die Seite [CodeNomad unterstützen](sponsor.md).

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

## Computer wach halten {#keep-computer-awake}

Unter **Einstellungen → Allgemein** ist **Computer wach halten, solange CodeNomad läuft** standardmäßig deaktiviert. Aktivieren Sie die Option, um den Ruhezustand zu verhindern, solange ein lokales CodeNomad-Fenster geöffnet ist (auch minimiert), auch wenn keine Sitzung arbeitet; der Bildschirm kann sich weiterhin ausschalten. Wenn deaktiviert, hält CodeNomad den Computer nur wach, während eine Sitzung arbeitet. Das **i** neben dem Titel erklärt dieses Verhalten. Die Option erscheint nur in lokalen Desktop-App-Fenstern und im nativen Einstellungsfenster; in Browser-/Remote-Ansichten ist sie ausgeblendet.

## Dauerhaftes Agentengedächtnis {#agent-memory}

Bei einem Speicherausfall werden Nachrichten weiter gesendet. CodeNomad versucht, veraltete Speicheranweisungen der Sitzung zu entfernen; schlägt auch dies fehl, können die bisherigen Anweisungen bis zur nächsten erfolgreichen Aktualisierung erhalten bleiben. Prüfen Sie Angaben weiterhin anhand aktueller Dateien und Befehle.

Öffnen Sie **Einstellungen → Allgemein → Gedächtnis** (im Browser ebenfalls unter **Einstellungen → Allgemein**). Das Gedächtnis ist standardmäßig ausgeschaltet. Aktivieren Sie es, damit der Agent nützliche Fakten und Vorlieben über Unterhaltungen hinweg behält. Der Schalter gilt für die verbundene CodeNomad-Konfiguration; Ausschalten erhält Einträge und Verlauf.

- **Über Sie**: bis zu 60 Einträge, gemeinsam für Projekte dieser Konfiguration.
- **Projekt**: bis zu 200 Einträge. Diese Oberfläche verwendet das in den Einstellungen ausgewählte Projekt; eingebettete Einstellungen verwenden das aktive Projekt des Hauptfensters. Das Agentenwerkzeug `codenomad_memory` und die Sitzungsanweisungen verwenden den Ordner der jeweiligen Sitzung. Der Server erkennt das Repository an seiner normalisierten Git-Remote-Adresse, ersatzweise am lokalen Repository-Pfad; Worktrees teilen dieses Gedächtnis. Öffnen Sie ein Projekt, um diesen Bereich auszuwählen.

Jede Sitzung einschließlich Untersitzungen erhält Speicherregeln und eine begrenzte Liste von Titeln und Typen (Anweisungsblock mit höchstens etwa 8.000 Zeichen). Der Agent soll relevante Einträge vor dem Handeln mit `codenomad_memory` lesen, Angaben anhand aktueller Dateien und Befehle prüfen und Speichervorgänge erwähnen. Auch ein leeres Gedächtnis erhält die Regeln. Unlesbare Bereiche werden als nicht verfügbar ausgelassen. Fehlt OpenCodes optionale Funktion für Sitzungsanweisungen, bleibt die Integration still inaktiv und behält Ihre Auswahl.

1. Wählen Sie einen Bereich und Eintrag. **Neu** und **Geändert** kennzeichnen Änderungen seit der letzten erfolgreichen Einsicht in diesen Bereich in dieser Browser- oder Desktop-Ansicht; sie bleiben während des aktuellen Besuchs sichtbar.
2. Bearbeiten Sie **Titel**, **Typ** (**Fakt**, **Vorliebe** oder **Referenz**) und **Text**, dann **Speichern**. Titel erlauben 60 Zeichen, Texte 2.000. **Abbrechen** stellt den gespeicherten Inhalt wieder her. Wurde der Eintrag anderswo geändert, wählen Sie **Neu laden** und prüfen ihn vor erneutem Speichern.
3. Öffnen Sie zum Entfernen das Aktionsmenü des Eintrags und bestätigen Sie **Vergessen**. Der Eintrag verlässt das aktive Gedächtnis; Git behält den lokalen Verlauf samt altem Text. Vergessen beendet die Agentennutzung und ist keine sichere Datenlöschung.
4. Ist das Gedächtnis voll, führen Sie Einträge zusammen oder vergessen Sie welche. Gleiche Titel oder stark überlappende Texte ersetzen einen vorhandenen Eintrag; Git erhält dessen vorherigen Text.

**Prüfung erforderlich** markiert verdächtige Anweisungen, die Schutzmaßnahmen umgehen oder Zugangsdaten offenlegen könnten. Diese Einträge bleiben hier bearbeitbar, zählen zum Limit und werden aus Agententiteln und -lesezugriffen ausgeschlossen. Die Prüfung läuft bei jedem Lesen; korrigieren und speichern Sie den Inhalt oder wählen Sie **Vergessen**. Fehlerhafte oder unlesbare Daten zeigen einen Fehler statt einer leeren Liste; beheben Sie die Ursache vor dem nächsten Versuch.

**Aufräumen** fragt nach Bestätigung und öffnet eine neue Unterhaltung im in den Einstellungen angezeigten Projekt, um den ausgewählten Bereich zu prüfen und zusammenzuführen. Unüberprüfbare Einträge und externe Referenzen bleiben erhalten; der Agent berichtet seine Änderungen. Erforderlich sind ein geöffnetes Projekt und aktiviertes, les- und schreibbares Gedächtnis mit mindestens einem unmarkierten Eintrag. Bei unbestätigtem Start prüfen Sie die Projektunterhaltungen vor einem neuen Versuch.

Das Gedächtnis wird vom Agenten gepflegt. Führt er bereits anderswo eines, etwa `.claude/…/MEMORY.md`, speichert er eine **Referenz** darauf; externe Gedächtnisdateien bleiben eigenständig verwaltet. CodeNomad speichert pro Eintrag eine Markdown-Datei unter `memory/global/` oder `memory/projects/<id>/` in seinem Konfigurationsordner, mit einem lokalen Git-Commit bei jedem Speichern oder Löschen. Die Speicherung bleibt lokal, ohne Remote-Synchronisierung. Konfigurations- und Profilgrenzen beschreibt [Desktop-Fenster und Daten](desktop.md).

## Panels und Statusabschnitte {#panels-status}

Ziehen Sie am inneren Rand eines angedockten Panels, um seine Größe zu ändern. Der Griff bleibt während des Ziehens hervorgehoben und behält die Zeigererfassung, auch wenn der Zeiger den Rand verlässt. Lassen Sie los, um abzuschließen.

1. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den äußeren Kopfecken oder deren Menüpunkte unter **Ansicht** zum Ein-/Ausblenden.
2. Öffnen Sie **Rechtes Panel anpassen** im rechten Panel. Wählen Sie integrierte Tabs und Statusabschnitte per Kontrollkästchen; mindestens ein Statusabschnitt bleibt sichtbar. Ziehen Sie über diese Kontrollkästchen, um mehrere auf einmal einzustellen.
3. Ziehen Sie rechte Panel-Tabs zum Umordnen. **Zurücksetzen** stellt integrierte Layoutauswahlen wieder her.

Erkannte [Integrationen](integrations.md#integration-sections) haben ebenfalls Statusabschnitte. Blenden Sie diese mit denselben Kontrollkästchen aus; ordnen Sie jeden Statusabschnitt per Ziehen oder mit den Tasten Auf/Ab um. Sichtbarkeit und Reihenfolge bleiben bei Neuladen und vorübergehend fehlenden Integrationen erhalten.

Status enthält Tokeninformationen, Yolo-Modus, Anbieternutzung, Hintergrund-Shells, MCP und Plugins. Solange die Unterhaltung ein [Ziel](conversations.md#goal) hat, zeigt eine Zielzeile über diesen Abschnitten es an; diese Zeile ist kein Abschnitt und lässt sich weder ausblenden noch verschieben. Ausblenden deaktiviert keinen Dienst und widerruft keine Rechte. Schmale Layouts schließen Panels, die nicht mehr passen, statt die Unterhaltung einzuengen; ein dort geöffnetes Panel schwebt über ihr, und ein schwebendes Panel zu öffnen schließt das andere.

Integriertes Layout ist Fensterlayout, keine Projektänderung. Erweiterungskästchen sind anders: Sie aktivieren Code über alle Projekte dieser Konfiguration. **Zurücksetzen** ändert keine Erweiterungszustimmung. Siehe [Panel-Erweiterungen](extensions.md).

## Verlaufsdetails und Eingabegröße {#transcript-composer}

1. Öffnen Sie **Chat**, um Standarddetails des Verlaufs zu wählen. Vorgaben sind **Nichts**, **Minimal**, **Ausgewogen** und **Alles**; Einzeländerungen erzeugen **Benutzerdefiniert**.
2. Legen Sie für Denken, Diagnosen, Werkzeugeingaben, Tokens, Systemnachrichten und jeden Werkzeugtyp den **Standardzustand** jeder Zeile fest (**Ausgeblendet**, **Eingeklappt** oder **Erweitert**), oder verwenden Sie das Popup **Nachrichteninhalt** der Unterhaltung, das diese Auswahl teilt.
3. Aktivieren Sie unter **Allgemein** nach Bedarf **Nachrichten-Zeitleiste anzeigen**, **Pfeile für erste/neueste Nachricht unter der Zeitleiste anzeigen**, **Diffs von Tool-Aufrufen geteilt anzeigen** und **Gesendete Prompts in die Warteschlange stellen** (Prompts, die während der Arbeit einer Sitzung gesendet werden, einreihen statt sie einzuschieben).
4. Ändern Sie die Größe des Eingabefelds über dessen Größensteuerung; lange Entwürfe scrollen im Feld.

Die Timeline hat eine Markierung für jede Antwort, jeden Denkprozess, jedes Werkzeug, jede Komprimierung und jeden Systemkontext, die das Gespräch zeigt, in derselben Reihenfolge. Ihre Markierungen folgen **Nachrichteninhalt**: Werden dort ein Werkzeugtyp, Denkprozesse oder Systemnachrichten ausgeblendet, verschwinden auch ihre Markierungen, außer bei einem Werkzeug mit offener Berechtigung, und **Nichts** blendet alle Werkzeugmarkierungen aus. Sichtbarkeits- und Aufklappeinstellungen ändern nur die Darstellung. Sie entfernen keine gespeicherten Werkzeuge/Denkprozesse und komprimieren keinen Modellkontext. Destruktive Vorgänge siehe [Verlauf und Bereinigung](history.md).

Die Eingabehöhe folgt der sichtbaren Unterhaltung einschließlich Bildschirmtastatur: mindestens 8 % mit 44-Pixel-Untergrenze, höchstens 60 %. Manuelle Höhe wird proportional gemerkt; schmale Breite und langer Text erhöhen diese Grenzen nicht. Eine aufgeklappte Berechtigung/Frage minimiert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Klappen/erledigen Sie die Anfrage, um Größenänderung fortzusetzen.

## Benachrichtigungen und Abzeichen {#notifications}

1. Öffnen Sie **Benachrichtigungen**. Markieren Sie für jede Art von Benachrichtigung, wo sie erscheint: **Auf dem Bildschirm** (eine vorübergehende Blase), **Verlauf** (im Benachrichtigungsverlauf der Glocke in der Tab-Leiste, in der macOS-Desktop-App in der Titelleiste, aufbewahrt) und **System** (eine Betriebssystembenachrichtigung). Ziehen Sie über eine Zeile oder Spalte von Kästchen, um mehrere auf einmal einzustellen.
2. Das Markieren eines **System**-Kästchens fragt bei Bedarf nach der Berechtigung. Unter **Systembenachrichtigungen** fragt **Anfordern** erneut, solange die Berechtigung fehlt.
3. Aktivieren Sie **Benachrichtigen, wenn die App im Fokus ist**, um Systembenachrichtigungen auch zu erhalten, während dieses Fenster im Fokus ist. Sonst erscheinen sie, sobald es nicht im Fokus ist, auch wenn es geöffnet auf dem Bildschirm bleibt.

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

Tastaturkonfiguration siehe [Tastenkürzel](shortcuts.md); Sprachsteuerung siehe [Spracheingabe und Wiedergabe](voice.md). Startwiederherstellung und Desktop-Datenprofile behandelt [Desktop-Fenster und Daten](desktop.md).
