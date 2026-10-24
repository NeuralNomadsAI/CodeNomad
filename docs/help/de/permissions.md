# Fragen und Berechtigungen

Native Fragen, Forms und Berechtigungsanfragen werden im Unterbrechungsdock direkt über dem Eingabefeld beantwortet, nicht in wartenden Werkzeugkarten im Verlauf.

## Anfrage finden und Quelle prüfen {#request-dock}

1. Wählen Sie eine Unterhaltung mit **Eingabe erforderlich** / **Berechtigung erforderlich** oder klicken Sie auf das Projekt-Anfrageabzeichen, um das Dock an Ort und Stelle zu öffnen.
2. Lesen Sie Anfrageart, Unterhaltungstitel und Herkunft vor dem Aufklappen oder Beantworten.
3. Verwenden Sie bei mehreren wartenden Anfragen **Vorherige Anfrage** / **Nächste Anfrage**. Verwenden Sie **Unterhaltung anzeigen** nur, wenn Sie zur Quelle navigieren möchten.

| Herkunft | Bedeutung und Verhalten |
| --- | --- |
| Geöffnete Unterhaltung | Ihre Anfrage kann normal aufgeklappt werden |
| Subagent mit **Aus …**-Elternangabe | Rekursive Nachfahren der geöffneten Unterhaltung gehören zum lokalen Kontext; die Elternherkunft bleibt sichtbar |
| Andere Unterhaltung | Beginnt als kompakte Vorschau; ausdrücklich aufklappen, um ohne Verlassen der aktuellen Unterhaltung zu antworten |
| Projektanfrage / Dienstanfrage | Ein Form kann ohne zugehörige Unterhaltung sein; es wird kein erfundener Unterhaltungslink angezeigt |

Neue Eingänge ersetzen weder die bearbeitete Anfrage noch navigieren sie weg. Die Auswahl bleibt bei Warteschlangenaktualisierungen auf derselben Anfrage; Pfeile springen an den Enden nicht um. Nach Erledigung bleibt die Anfrage einer anderen, unabhängigen Unterhaltung kompakt, bis Sie sie öffnen.

**Anfragen einklappen** verbirgt den Inhalt; es verweigert, storniert oder beantwortet nichts. Ein aufgeklappter Editor verkleinert das Eingabefeld vorübergehend auf seine Mindesthöhe, ohne gespeicherte Größe oder Entwurf zu ändern. Sein Inhalt scrollt unabhängig von den festen Antwortaktionen.

## Fragen und Forms beantworten {#answer-questions-forms}

1. Klappen Sie die gewünschte Anfrage auf und füllen Sie die Felder aus oder wählen Sie angebotene Antworten.
2. Wenn ein Auswahlfeld eigene Antworten erlaubt, erscheint ein zusätzliches Textfeld: Geben Sie dort Ihre eigene Antwort statt einer angebotenen Auswahl ein (oder ergänzen Sie eigene Werte bei einem Mehrfachauswahlfeld). Beantworten Sie jede Pflichtfrage.
3. Wählen Sie **Absenden**; verwenden Sie **Abbrechen** bei einer Frage oder einem Form nur, wenn Sie diesen nativen Abbruch beabsichtigen.

Teilantworten und Ablehnungsentwürfe überstehen Warteschlangenaktualisierungen und Unterhaltungsnavigation im laufenden Client. Sie sind keine übermittelte Entscheidung und garantieren keine Wiederherstellung nach dem Löschen von Client-Daten. Eine fehlgeschlagene Antwort bleibt bearbeitbar; prüfen Sie vor dem Wiederholen die wartende Anfrage. CodeNomad wiederholt Antworten nicht automatisch.

Einige Forms bieten **Externes Formular öffnen** für einen Browser-Ablauf. Folgen Sie den Anweisungen und kehren Sie zum Status zurück, statt eine geöffnete Seite als erfolgreiche Antwort zu betrachten. Beliebige Anbieter-/Authentifizierungs-Forms sind nicht zwangsläufig Unterhaltungsartefakte.

Abgeschlossene native Fragewerkzeuge zeigen Frage, ausgewählte Antwort, Optionsbeschreibungen und unveränderten eigenen Text im Verlauf. **Andere Optionen** hält nicht ausgewählte Alternativen verfügbar. Diese abgeschlossenen Ergebnisse sind vom aktiven Dock getrennt.

## Berechtigung erlauben oder ablehnen {#permission-decisions}

1. Lesen Sie den angeforderten Vorgang, die Ressourcen und gegebenenfalls **Angefordertes Diff**. Prüfen Sie, welche Unterhaltung die Entscheidung erhält.
2. Geben Sie optional eine Begründung für die Ablehnung oder eine sicherere Alternative ein.
3. Wählen Sie **Einmalig erlauben**, **Immer erlauben** oder **Ablehnen**.

| Auswahl | Native Wirkung | Sicherheitsgrenze |
| --- | --- | --- |
| Einmalig erlauben | Genehmigt diese Berechtigungsanfrage | Keine pauschale Genehmigung unabhängiger zukünftiger Vorgänge |
| Immer erlauben | Sendet die native dauerhafte Genehmigung für passende Anfragen im geltenden Sitzungskontext | Kein CodeNomad- oder betriebssystemweiter Vertrauensschalter; prüfen Sie die autorisierte Ressource/das Muster |
| Ablehnen | Verweigert die Anfrage mit optionalem Feedback | Macht vor dieser Anfrage ausgeführte Arbeit nicht rückgängig |

Eine Genehmigung kann die Werkzeugausführung sofort freigeben. Dies ist kein Probelauf. Diff-/Lesegrenzen und Quellenidentitätsprüfungen können Genehmigungen verhindern, wenn der angeforderte Inhalt nicht validiert werden kann; aktualisieren und prüfen Sie die tatsächliche Anfrage, statt aufgrund einer Annahme einen anderen Vorgang zu erlauben.

Erledigt ein anderer Client eine Anfrage, kann sie hier verschwinden. Ein Timeout oder eine fehlgeschlagene Antwort beweist nicht, ob der native Dienst die Entscheidung angenommen hat: Lassen Sie den Abgleich offener Anfragen das Dock aktualisieren, bevor Sie erneut bewusst entscheiden. Eine mehrdeutige Antwort wird niemals als erfundene bestätigte Entscheidung dargestellt.

## Berechtigungsbelege lesen {#permission-receipts}

1. Suchen Sie **Berechtigungsentscheidungen** neben dem zugehörigen Verlaufsinhalt, auch bei ausgeblendeten nativen Werkzeugkarten.
2. Öffnen Sie für Entscheidungen ohne Quellnachricht **Berechtigungsentscheidungen der Sitzung**.
3. Verwenden Sie **Weitere Entscheidungen laden** zum Fortfahren oder **Erneut versuchen** nach einem Lesefehler.

Belege erfassen bekannte Anfragen/Ressourcen, die bestätigte Entscheidung sowie verfügbare Begründung/Herkunft. **Entscheidung in CodeNomad**, **Automatisch · Yolo** und **Native Entscheidung** unterscheiden beobachtete Ursprünge; eine native Erledigung beweist keinen Benutzerklick in diesem Fenster.

Belege sind schreibgeschützte CodeNomad-Anmerkungen, keine nativen Nachrichten oder Berechtigungsregel-Editoren. Sie sind von nativer Vollverlaufssuche, Nachrichtenkopie und Export ausgeschlossen. Sie können während CodeNomads Offline-Zeit verpasste Entscheidungen nicht rekonstruieren; ein erfolgreiches Werkzeugergebnis ersetzt keinen fehlenden Beleg. Eine Sitzungslöschung entfernt deren Belege.

## Yolo-Modus und Familienumfang {#yolo-mode}

1. Wählen Sie eine Unterhaltung und öffnen Sie **Status → Yolo-Modus**.
2. Aktivieren Sie ihn nur, wenn automatische Berechtigungsfreigaben für die gesamte Familie akzeptabel sind.
3. Deaktivieren Sie ihn vor weiterer nicht vertrauenswürdiger Arbeit; prüfen Sie offene Anfragen und bereits laufende Werkzeuge.

Obwohl die Steuerung eine Sitzung nennt, gilt sie effektiv für die ermittelte Familienwurzel und Nachfahren: Aktivieren/Deaktivieren von einem Kind aus betrifft diese Familie. Ein nativer Fork gilt als eigene Wurzel. Dies ist keine globale Genehmigung für alle Projekte oder unabhängigen Unterhaltungen.

Yolo genehmigt **nur Berechtigungen**. Es beantwortet keine Fragen oder Forms, ergänzt keine fehlenden Angaben, garantiert keinen Ausführungserfolg und umgeht keine Backend-Zugehörigkeitsprüfungen. Das CodeNomad-Backend führt die automatische Genehmigung durch: Ein einzelnes Fenster zu schließen deaktiviert sie nicht, solange das Backend aktiv bleibt; ein gestopptes Backend kann keine Anfragen weiter genehmigen. Die Familieneinstellung wird gespeichert und beim erneuten Laden des Arbeitsbereichs wieder eingelesen.

Yolo auszuschalten widerruft keine bereits angenommene Entscheidung und macht keine Datei-/Netzwerkauswirkungen rückgängig. Prüfen Sie **Automatisch · Yolo**-Belege und stoppen Sie die Ausführung bei Bedarf ausdrücklich. Für Automatisierung mit menschlichen Freigaben siehe [Missionen](missions.md).

## Fehlende oder veraltete Anfragen wiederherstellen {#request-recovery}

1. Prüfen Sie die Verbindungsanzeige und verbinden Sie sich erneut mit demselben Backend/Projekt.
2. Lassen Sie die Wiederherstellung offene native Anfragen abgleichen; bekannte Anfragen und Entwürfe bleiben bei unvollständiger Abdeckung erhalten.
3. Erscheint die Warnung **Fragen und Berechtigungen nicht vollständig wiederhergestellt**, nennt sie das Projekt, die Ursache, die Ordner und die betroffenen Sitzungen. Beheben Sie diese Ursache (zum Beispiel ein gelöschter Worktree oder eine Sitzung, die außerhalb dieses Projekts arbeitet); der nächste Wiederherstellungsdurchlauf versucht es automatisch erneut.

Die Wiederherstellung lädt nicht jeden inaktiven Worktree, nur um Anfragen aufzulisten. Eine unvollständige Antwort ist keine maßgebliche leere Warteschlange, und die Warnung erlaubt keine Wiederholung eines Prompts, einer Antwort oder Freigabe. Konfigurationsneuladen kann native Forms/Berechtigungen abbrechen; verwenden Sie es nicht als routinemäßige Anfrageaktualisierung. Siehe [Fehlerbehebung](troubleshooting.md) und [OpenCode-Einrichtung](opencode.md).
