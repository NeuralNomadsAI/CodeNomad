# Einstellungen und Layout

Das Einstellungsfenster verwendet den Server des ausgewählten Projekts für Projekteinstellungen, Anbieter, Statistiken und Gedächtnis, einschließlich der Bereinigung. Bei einem nicht erreichbaren Server bleiben die Projektaktionen inaktiv. Geräteeinstellungen und SideCars bleiben lokal. Die Einstellungen für Bilder und Websuche gelten für den Server des Projekts, einschließlich seiner globalen Vorgaben.

## Einstellungen öffnen und Geltungsbereich erkennen {#open-settings}

1. Öffnen Sie **Einstellungen** über das Zahnrad **Einstellungen öffnen** in der Tab-Leiste. Direktzugänge wie **Anbieter verwalten** in der Modellauswahl, das Zahnrad des Missionspanels oder das Zahnrad **Einstellungen** im Benachrichtigungsverlauf öffnen direkt den passenden Abschnitt.
2. Wählen Sie einen Abschnitt. Lokale Electron-/Tauri-Fenster öffnen oder fokussieren ein natives Einstellungsfenster; Browser-/Remote-Ansichten verwenden die eingebettete Einstellungsseite.
3. Prüfen Sie vor dem Verlassen den Geltungsbereich und mögliche **Speichern**-Aktionen.

Die meisten Auswahlen wirken sofort, auch die Missionsvorgaben, die jede Änderung sofort speichern. Einstellungen für Sprach-APIs, eigene Palettenfarben und Konfigurationsdateien erfordern **Speichern**. Zeigen Sie auf das **i** neben dem Einstellungstitel oder fokussieren Sie es für eine kurze Erklärung. Bei einem Hilfelink öffnen Klicken, Eingabe oder Antippen den passenden Abschnitt in der Oberflächensprache im Systembrowser oder in einem separaten Tab. Reine Tooltip-Symbole zeigen ihre Erklärung beim Antippen. **Einstellungen → Info** enthält außerdem die Karte **CodeNomad unterstützen**: **Sponsern oder mitwirken** öffnet die Seite [CodeNomad unterstützen](sponsor.md).

| Zustand | Was er steuert |
| --- | --- |
| CodeNomad-Konfiguration | Gemeinsame UI-Einstellungen und als **Server-Einstellung** gekennzeichnete Optionen, darunter die Sprach-API, SideCars, Fernsteuerung und Umgebungsvariablen. |
| Sprach-Engines | Die [Diktier-Engine der Desktop-App](voice.md#desktop-dictation) gilt für alle Projekte auf diesem Gerät. Die [Gesprächs-Engine](voice.md#conversation) gilt für das Desktop-Profil bzw. das Browserprofil und den verbundenen Server. |
| Fenster-/Projekt-Tab-Layout | Offene Panels, ausgewählte Tabs, Lesezustand und wiederherstellbare Entwürfe/Layout. Dies ist keine OpenCode-Konfiguration. |
| Globale/projektbezogene OpenCode-Einstellungen | Native Plugin-/Konfigurationsänderungen im angezeigten Umfang. Projektsteuerung benötigt ein aktives Projekt/eine Location. |
| Desktop-Datenprofil | Native Fenster, Wiederherstellungszustand und Browserspeicher, unabhängig von Konfigurationsdatei und gemeinsamem OpenCode-Dienst. Siehe [Desktop-Fenster und Daten](desktop.md). |

Der ausgewählte Tab im rechten Panel und der Dateien-Modus werden für jeden Projekt-Tab getrennt gespeichert. Ihre letzten ausdrücklichen Auswahlen liefern die Vorgaben für neue Tabs; Panel-Größen, Tab-Reihenfolge, Anpassung und Erscheinungsbild bleiben gemeinsame Layout- und Einstellungsvorgaben.

**Statistik** umfasst den gesamten verbundenen OpenCode-Dienst (alle Projekte, unabhängige Klone und Untersitzungen), nicht nur den geöffneten Ordner, für die letzten 7, 30, 90 oder 365 Tage. Sie benötigt ein geöffnetes Projekt und zeigt die von OpenCode erfassten Tokens und Kosten, keine Anbieterrechnungen oder Abonnementkontingente; während der Aktualisierung können zuvor gespeicherte Summen erscheinen. Plankontingente gehören in den Statusabschnitt **Nutzung**.

## Sprache und Darstellung {#language-appearance}

1. Wählen Sie unter **Allgemein** die **Sprache**: Englisch, Spanisch, Französisch, Russisch, Japanisch, vereinfachtes Chinesisch, Hebräisch, Deutsch, Nepali oder Türkisch.
2. Wählen Sie unter **Farbschema** den **Modus**: **Auto**, **Dunkel** oder **Hell**. Auto folgt dem Betriebssystem.
3. Wählen Sie neben **Modus** den **Kontrast**: **Auto** (Standard) folgt der Kontrasteinstellung des Systems; **Ein** erhöht den Kontrast jeder Palette; **Aus** verwendet normalen Kontrast.
4. Wählen Sie eine Palette für die angezeigte Darstellung. Helle und dunkle Auswahl werden getrennt gespeichert; Auto verwendet die passende.
5. Verwenden Sie für eigene Farben die Farbfelder und **Speichern**; **Zurücksetzen** stellt die Farben einer integrierten Palette wieder her. Mit **Neu** benennen Sie eine separate Palette, mit **Löschen** entfernen Sie eine selbst erstellte.

Kontrast wird sofort angewendet und gespeichert, unabhängig vom **Speichern** der Farben. Die Darstellung wird angepasst; ausgewählte Palette, bearbeitbare Farben und Unterhaltungsentwurf bleiben erhalten. Das **i** zeigt bei Auto den aktuellen Kontrastzustand.

Die Oberfläche aktualisiert sich ohne Unterhaltungsneustart. Hebräisch verwendet Rechts-nach-links-Layout; Code und technische Werte bleiben in ihrer eigenen Richtung lesbar. Die Sprachauswahl ändert Oberflächentexte, nicht die Sprache vorhandener Nachrichten oder Agentenanweisungen. Native Desktop-Menüs wechseln in die Oberflächensprache, sobald ein CodeNomad-Fenster geladen ist.

Werden Farben schwer lesbar, wählen Sie **Kontrast → Ein**. Sie können auch eine integrierte Palette wählen oder die bearbeitete zurücksetzen. Ein Palettenwechsel kann zum Verwerfen ungespeicherter Farbänderungen auffordern; Ihr Unterhaltungsentwurf bleibt erhalten.

## Computer wach halten {#keep-computer-awake}

Unter **Einstellungen → Allgemein** ist **Computer wach halten, solange CodeNomad läuft** standardmäßig deaktiviert. Aktivieren Sie die Option, um den Ruhezustand zu verhindern, solange ein lokales CodeNomad-Fenster geöffnet ist (auch minimiert), auch wenn keine Sitzung arbeitet; der Bildschirm kann sich weiterhin ausschalten. Wenn deaktiviert, hält CodeNomad den Computer nur wach, während eine Sitzung arbeitet. Die Option erscheint nur in lokalen Desktop-App-Fenstern und im nativen Einstellungsfenster; in Browser-/Remote-Ansichten ist sie ausgeblendet.

## Berechtigungen für neue Unterhaltungen {#new-conversation-permissions}

Wählen Sie unter **Einstellungen → Allgemein → Berechtigungen für neue Unterhaltungen** den Modus **Autonom** (Standard) oder **Beaufsichtigt** für neue Hauptunterhaltungen, die Sie in CodeNomad erstellen. Bestehende Unterhaltungen bleiben unverändert. Zum Ändern öffnen Sie in der jeweiligen Unterhaltung [Status → Berechtigungen](permissions.md#conversation-mode).

## Dauerhaftes Agentengedächtnis {#agent-memory}

Authentifizierte Nutzer können über Fernsteuerung, verifiziertes HTTPS, LAN oder eine installierte PWA das Gedächtnis des ausgewählten lokalen oder entfernten Projekts prüfen, bearbeiten und **Aufräumen** verwenden.

CodeNomad versucht, veraltete Speicheranweisungen der Sitzung zu entfernen; schlägt auch dies fehl, können die bisherigen Anweisungen bis zur nächsten erfolgreichen Aktualisierung erhalten bleiben.

Öffnen Sie **Einstellungen → Allgemein → Gedächtnis** (im Browser ebenfalls unter **Einstellungen → Allgemein**). Das Gedächtnis ist standardmäßig ausgeschaltet. Aktivieren Sie es, damit der Agent nützliche Fakten und Vorlieben über Unterhaltungen hinweg behält. Der Schalter gilt für die verbundene CodeNomad-Konfiguration; Ausschalten erhält Einträge und Verlauf. Solange es ausgeschaltet ist, erhalten Agenten kein Gedächtniswerkzeug; das Umschalten gilt innerhalb weniger Sekunden auch für laufende Unterhaltungen, ohne Neustart.

- **Über Sie**: bis zu 60 Einträge, gemeinsam für Projekte dieser Konfiguration.
- **Projekt**: bis zu 200 Einträge. Diese Oberfläche verwendet das in den Einstellungen ausgewählte Projekt; eingebettete Einstellungen verwenden das aktive Projekt des Hauptfensters. Der Server erkennt das Repository an seiner normalisierten Git-Remote-Adresse, ersatzweise am lokalen Repository-Pfad; Worktrees teilen dieses Gedächtnis. Öffnen Sie ein Projekt, um diesen Bereich auszuwählen.

1. Wählen Sie einen Bereich, klappen Sie seine Eintragsanzahl auf (zum Beispiel **7/200**) und wählen Sie einen Eintrag. **Neu** und **Geändert** kennzeichnen Änderungen seit der letzten Anzeige der Einträge dieses Bereichs in dieser Browser- oder Desktop-Ansicht; die eingeklappte Zählerzeile zeigt sie ebenfalls, und sie bleiben während des aktuellen Besuchs sichtbar.
2. Bearbeiten Sie **Titel**, **Typ** (**Fakt**, **Vorliebe** oder **Referenz**) und **Text**, dann **Speichern**. Titel erlauben 60 Zeichen, Texte 2.000. **Abbrechen** stellt den gespeicherten Inhalt wieder her. Wurde der Eintrag anderswo geändert, wählen Sie **Neu laden** und prüfen ihn vor erneutem Speichern.
3. Öffnen Sie zum Entfernen das Aktionsmenü des Eintrags und bestätigen Sie **Vergessen**. Der Eintrag verlässt das aktive Gedächtnis; Git behält den lokalen Verlauf samt altem Text. Vergessen beendet die Agentennutzung und ist keine sichere Datenlöschung.
4. Ist das Gedächtnis voll, führen Sie Einträge zusammen oder vergessen Sie welche. Gleiche Titel oder stark überlappende Texte ersetzen einen vorhandenen Eintrag; Git erhält dessen vorherigen Text.

**Prüfung erforderlich** markiert verdächtige Anweisungen, die Schutzmaßnahmen umgehen oder Zugangsdaten offenlegen könnten. Diese Einträge bleiben hier bearbeitbar, zählen zum Limit und werden aus Agententiteln und -lesezugriffen ausgeschlossen. Die Prüfung läuft bei jedem Lesen; korrigieren und speichern Sie den Inhalt oder wählen Sie **Vergessen**.

**Aufräumen** fragt nach Bestätigung und öffnet eine neue Unterhaltung im in den Einstellungen angezeigten Projekt, um den ausgewählten Bereich zu prüfen und zusammenzuführen. Unüberprüfbare Einträge und externe Referenzen bleiben erhalten; der Agent berichtet seine Änderungen. Erforderlich sind ein geöffnetes Projekt und aktiviertes, les- und schreibbares Gedächtnis mit mindestens einem unmarkierten Eintrag.

Das Gedächtnis wird vom Agenten gepflegt. Führt er bereits anderswo eines, etwa `.claude/…/MEMORY.md`, speichert er eine **Referenz** darauf; externe Gedächtnisdateien bleiben eigenständig verwaltet. Die Speicherung bleibt lokal, ohne Remote-Synchronisierung. Konfigurations- und Profilgrenzen beschreibt [Desktop-Fenster und Daten](desktop.md).

## Panels und Statusabschnitte {#panels-status}

**Status** steht standardmäßig an erster Stelle; eine gespeicherte Tab-Reihenfolge hat Vorrang. Der Tab bleibt verfügbar. Unter **Rechtes Panel anpassen** klappt sein Pfeil die Liste der Abschnitts-Checkboxen ein oder aus, ohne die Abschnitte selbst auszublenden.

Ziehen Sie am inneren Rand eines angedockten Panels, um seine Größe zu ändern.

1. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den äußeren Kopfecken oder deren Menüpunkte unter **Ansicht** zum Ein-/Ausblenden.
2. Öffnen Sie **Rechtes Panel anpassen** im rechten Panel. Wählen Sie integrierte Tabs und Statusabschnitte per Kontrollkästchen; mindestens ein Statusabschnitt bleibt sichtbar. Ziehen Sie über diese Kontrollkästchen, um mehrere auf einmal einzustellen.
3. Ziehen Sie rechte Panel-Tabs zum Umordnen. **Zurücksetzen** stellt integrierte Layoutauswahlen wieder her.

Ordnen Sie jeden Statusabschnitt per Ziehen an seinem Griff oder mit den Tasten Auf/Ab um. Sichtbarkeit und Reihenfolge bleiben beim Neuladen erhalten.

Status enthält Tokeninformationen, Berechtigungen, Anbieternutzung, Hintergrund-Shells, MCP und Plugins. Solange die Unterhaltung ein [Ziel](conversations.md#goal) hat, zeigt eine Zielzeile über diesen Abschnitten es an; diese Zeile ist kein Abschnitt und lässt sich weder ausblenden noch verschieben. Ausblenden deaktiviert keinen Dienst und widerruft keine Rechte. Schmale Layouts schließen Panels, die nicht mehr passen, statt die Unterhaltung einzuengen; ein dort geöffnetes Panel schwebt über ihr, und ein schwebendes Panel zu öffnen schließt das andere.

Das integrierte Layout gilt für das Fenster. Das [Kästchen Missionen](missions.md#activation) ändert auch die globale Plugin-Aktivierung und wird beim Ziehen über Kästchen übersprungen. Erweiterungskästchen aktivieren Code in allen Projekten dieser Konfiguration. **Zurücksetzen** ändert keine Erweiterungszustimmung. Siehe [Panel-Erweiterungen](extensions.md).

## Verlaufsdetails und Eingabegröße {#transcript-composer}

1. Öffnen Sie **Chat**, um Standarddetails des Verlaufs zu wählen. Vorgaben sind **Nichts**, **Minimal**, **Ausgewogen** und **Alles**; Einzeländerungen erzeugen **Benutzerdefiniert**.
2. Legen Sie den **Standardzustand** jeder Zeile fest (**Ausgeblendet**, **Eingeklappt** oder **Erweitert**), oder verwenden Sie das Popup **Nachrichteninhalt** der Unterhaltung mit denselben Einstellungen. Bei **Werkzeuggruppen** zeigt **Deaktiviert** jeden Aufruf auf einer eigenen Karte; **Eingeklappt** und **Erweitert** legen den Anfangszustand der Gruppen fest.
3. Aktivieren Sie unter **Allgemein** nach Bedarf **Nachrichten-Zeitleiste anzeigen**, **Pfeile für erste/neueste Nachricht unter der Zeitleiste anzeigen**, **Diffs von Tool-Aufrufen geteilt anzeigen** und **Gesendete Prompts in die Warteschlange stellen** (Prompts, die während der Arbeit einer Sitzung gesendet werden, einreihen statt sie einzuschieben).
4. Ändern Sie die Größe des Eingabefelds über dessen Größensteuerung; lange Entwürfe scrollen im Feld.

Die Timeline hat eine Markierung für jede Antwort, jeden Denkprozess, jedes Werkzeug, jede Komprimierung und jeden Systemkontext, die das Gespräch zeigt, in derselben Reihenfolge. Ihre Markierungen folgen **Nachrichteninhalt**: Werden dort ein Werkzeugtyp, Denkprozesse oder Systemnachrichten ausgeblendet, verschwinden auch ihre Markierungen, außer bei einem Werkzeug mit offener Berechtigung, und **Nichts** blendet alle Werkzeugmarkierungen aus. Sichtbarkeits- und Aufklappeinstellungen ändern nur die Darstellung. Sie entfernen keine gespeicherten Werkzeuge/Denkprozesse und komprimieren keinen Modellkontext. Destruktive Vorgänge siehe [Verlauf und Bereinigung](history.md).

Beim manuellen Ändern der Eingabehöhe zählt die Höhe der Unterhaltung ohne Bildschirmtastatur: mindestens 8 % mit einer Untergrenze von 44 Pixeln, höchstens 60 %. Ein schmales Layout oder langer Text erhöhen diese Grenzen nicht. Bei geöffneter Tastatur kann das Feld vorübergehend kleiner werden, damit Bedienelemente und Nachrichten erreichbar bleiben. Das gespeicherte Höhenverhältnis bleibt dabei unverändert. Eine aufgeklappte Berechtigung/Frage minimiert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Klappen/erledigen Sie die Anfrage, um Größenänderung fortzusetzen.

## Benachrichtigungen und Abzeichen {#notifications}

Bei einem Projekt-Tab auf einem anderen CodeNomad-Server enthalten Benachrichtigungen den Servernamen. **Unterhaltung anzeigen** öffnet genau dieses Projekt und diese Unterhaltung; beim Trennen des Servers werden seine Hinweise entfernt.

Die Komprimierung technischer Missionssitzungen bleibt stumm.

1. Öffnen Sie **Benachrichtigungen**. Markieren Sie für jede Art von Benachrichtigung, wo sie erscheint: **Auf dem Bildschirm** (eine vorübergehende Blase), **Verlauf** (im Benachrichtigungsverlauf der Glocke in der Tab-Leiste aufbewahrt) und **System** (eine Betriebssystembenachrichtigung). Ziehen Sie über eine Zeile oder Spalte von Kästchen, um mehrere auf einmal einzustellen.
2. Das Markieren eines **System**-Kästchens fragt bei Bedarf nach der Berechtigung. Unter **Systembenachrichtigungen** fragt **Berechtigung anfordern** erneut, solange die Berechtigung fehlt.
3. Aktivieren Sie **Benachrichtigen, wenn die App im Fokus ist**, um Systembenachrichtigungen auch zu erhalten, während dieses Fenster im Fokus ist. Sonst erscheinen sie, sobald es nicht im Fokus ist, auch wenn es geöffnet auf dem Bildschirm bleibt.

Standardmäßig gehen **Eine Sitzung wartet auf Ihre Antwort** und **Eine Sitzung ist beendet** nur an System, damit sich vorübergehende Sitzungszustände nicht im Verlauf stapeln; sie betreffen Hauptsitzungen, keine Subagenten, und eine Sitzung, die Sie selbst stoppen, wird nicht gemeldet. Fehler erscheinen unabhängig von der Tabelle immer auf dem Bildschirm und im Verlauf, und kurze Fortschrittsmeldungen bleiben nur auf dem Bildschirm.

Browser-/OS-Berechtigung gehört zum Gerät und zur Anwendungs-Origin; eine gespeicherte Einstellung kann Ablehnung nicht übersteuern. Aktivieren Sie bei Blockade Benachrichtigungen in Browser-/OS-Einstellungen und kehren Sie hierher zurück. Nicht unterstützte Umgebungen lassen die Spalte System deaktiviert.

Die ungelesene Glocken-/Verlaufszahl, die nur an den Verlauf geleitete Benachrichtigungen zählt, steuert Browser-Favicon-Punkt und natives App-Abzeichen.

Wenn das System Benachrichtigungsaktionen unterstützt, zeigt ein Klick auf die Benachrichtigung die Unterhaltung an, sofern sie noch geöffnet ist. Ob das Fenster in den Vordergrund kommt, hängt von der Desktop-Umgebung ab.

## Erweiterte Optionen {#advanced}

In Rune zeigt das **i** neben einem deaktivierten Schalter den Grund an, wenn Sie es fokussieren. Der Konfigurationseditor nennt bei JSON-/JSONC-Syntaxfehlern die Zeile; Speichern bleibt möglich.

1. Öffnen Sie **Erweitert**.
2. Aktivieren oder deaktivieren Sie nur die benötigten Optionen; jede Änderung wird über die CodeNomad-Einstellungen gespeichert. Um die Ausführungsumgebung der Sitzung zu ändern, klappen Sie die eingeklappte Gruppe **Umgebungsvariablen** am Ende auf.

| Option | Wirkung und Vorsicht |
| --- | --- |
| Automatische Bereinigung leerer Sitzungen | Bereinigt leere Sitzungen beim Erstellen neuer; zum Behalten deaktiviert lassen. |
| Statusanzeigen von Unteragenten beibehalten | Behält ungesehene Inaktivitätsmarkierungen bis zur Ansicht, statt sie nach fünf Sekunden auszublenden. |
| Vorhandenes Fenster beim zweiten Start fokussieren | Nur nativer Desktop; ändert Zweitstartverhalten, nicht Tab-Erstellung. |
| Anbieterguthaben | Zeigt zusätzliche Guthaben unter Nutzung; kauft keine Guthaben und wechselt keine Konten. |
| Reine Leerraumänderungen ausblenden | Lässt nicht gestagte reine Leerraum-/Zeilenende-Dateien in Änderungen und Sammelaktionen weg; gestagte bleiben sichtbar. Siehe [Dateien](files.md). |
| Lange Assistentenantworten anhalten | Stoppt automatisches Folgen, wenn eine gestreamte Antwort über die Ansicht hinauswächst. |
| Umgebungsvariablen | Serverseitig vor jedem Prompt/Sitzungsbefehl angewandt; Lesen aktualisiert keine bereits laufende Ausführung. Siehe [OpenCode-Einrichtung](opencode.md). |

Tastaturkonfiguration siehe [Tastenkürzel](shortcuts.md). Unter **Sprache** finden Sie [Diktat, Wiedergabe und Gespräch](voice.md). Startwiederherstellung und Desktop-Datenprofile behandelt [Desktop-Fenster und Daten](desktop.md).
