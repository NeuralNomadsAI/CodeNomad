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

**Anfragen einklappen** verbirgt den Inhalt; es verweigert, storniert oder beantwortet nichts. Ein aufgeklappter Editor verkleinert das Eingabefeld vorübergehend auf seine Mindesthöhe, ohne gespeicherte Größe oder Entwurf zu ändern. Sein Inhalt scrollt unabhängig von den festen Antwortaktionen.

## Fragen und Forms beantworten {#answer-questions-forms}

1. Klappen Sie die gewünschte Anfrage auf und füllen Sie die Felder aus oder wählen Sie angebotene Antworten.
2. Wenn ein Auswahlfeld eigene Antworten erlaubt, erscheint ein zusätzliches Textfeld: Geben Sie dort Ihre eigene Antwort statt einer angebotenen Auswahl ein (oder ergänzen Sie eigene Werte bei einem Mehrfachauswahlfeld). Beantworten Sie jede Pflichtfrage.
3. Wählen Sie **Absenden**; verwenden Sie **Abbrechen** bei einer Frage oder einem Form nur, wenn Sie diesen nativen Abbruch beabsichtigen.

Teilantworten und Ablehnungsentwürfe überstehen Warteschlangenaktualisierungen und Unterhaltungsnavigation im laufenden Client. Sie sind keine übermittelte Entscheidung und garantieren keine Wiederherstellung nach dem Löschen von Client-Daten.

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

Erledigt ein anderer Client eine Anfrage, kann sie hier verschwinden. Ein Timeout oder eine fehlgeschlagene Antwort beweist nicht, ob der native Dienst die Entscheidung angenommen hat: Lassen Sie den Abgleich offener Anfragen das Dock aktualisieren, bevor Sie erneut bewusst entscheiden.

## Berechtigungsbelege lesen {#permission-receipts}

1. Suchen Sie **Berechtigungsentscheidungen** neben dem zugehörigen Verlaufsinhalt, auch bei ausgeblendeten nativen Werkzeugkarten.
2. Öffnen Sie für Entscheidungen ohne Quellnachricht **Berechtigungsentscheidungen der Sitzung**.
3. Verwenden Sie **Weitere Entscheidungen laden** zum Fortfahren oder **Erneut versuchen** nach einem Lesefehler.

Belege erfassen bekannte Anfragen/Ressourcen, die bestätigte Entscheidung sowie verfügbare Begründung/Herkunft. **Entscheidung in CodeNomad**, **Automatische Entscheidung** und **Native Entscheidung** unterscheiden beobachtete Ursprünge; eine native Erledigung beweist keinen Benutzerklick in diesem Fenster.

Belege sind schreibgeschützte CodeNomad-Anmerkungen, keine nativen Nachrichten oder Berechtigungsregel-Editoren. Sie sind von nativer Vollverlaufssuche, Nachrichtenkopie und Export ausgeschlossen. Sie können während CodeNomads Offline-Zeit verpasste Entscheidungen nicht rekonstruieren; ein erfolgreiches Werkzeugergebnis ersetzt keinen fehlenden Beleg. Eine Sitzungslöschung entfernt deren Belege.

## Berechtigungsmodus für Unterhaltungen {#conversation-mode}

Wählen Sie eine Unterhaltung, öffnen Sie **Status → Berechtigungen** und klicken Sie auf einen Modus. Bei eingeklapptem Abschnitt zeigt ein Blitz (Autonom) oder ein Schild (Beaufsichtigt) den zuletzt bekannten Modus an.

- **Autonom** — Befolgt die Berechtigungsregeln von OpenCode.
- **Beaufsichtigt** — Fragt vor Dateiänderungen und Shell-Befehlen des Agenten nach. Globale Verbote sowie Verbote für das Projekt und die Unterhaltung bleiben für diese Aktionen wirksam; Erlaubnisregeln führen zu einer Anfrage. Passende, von OpenCode gespeicherte Genehmigungen über **Immer erlauben** gelten weiterhin.

Beide Modi nutzen die Sitzungsregeln von OpenCode, auch in dessen Terminaloberfläche, wenn Sie dort dieselbe Unterhaltung im selben Dienst öffnen. Der Wechsel zu **Autonom** entfernt nur die für die Beaufsichtigung hinzugefügten Regeln. Die OpenCode-Konfigurationsdateien bleiben unverändert. CodeNomad genehmigt in keinem Modus Anfragen automatisch.

Der beaufsichtigte Modus ist keine Sandbox. Lesezugriffe, Zugriffe außerhalb des Projekts und MCP-Werkzeuge behalten ihre eigenen Regeln. Offene Anfragen behalten ihre ursprünglichen Regeln.

Bei einem Subagenten zeigt und ändert **Berechtigungen** den Modus der Hauptunterhaltung. Bestehende Subagenten behalten bei einem Moduswechsel ihre Regeln. Startet ein Subagent einen weiteren, übernimmt dieser die Regeln seines unmittelbaren Elternagenten.

Eine verzweigte Unterhaltung übernimmt die Regeln ihrer Quelle und hat einen eigenen Modus. Kann CodeNomad nicht prüfen, welche Regeln zu entfernen sind, bleiben diese erhalten und Sie können weiterhin Nachrichten senden.

Ist der Modus nicht bestätigt, wählen Sie **Berechtigungen neu laden**. Zum Festlegen des Startmodus siehe [Berechtigungen für neue Unterhaltungen](settings.md#new-conversation-permissions).

## Fehlende oder veraltete Anfragen wiederherstellen {#request-recovery}

1. Prüfen Sie die Verbindungsanzeige und verbinden Sie sich erneut mit demselben Backend/Projekt.
2. Lassen Sie die Wiederherstellung offene native Anfragen abgleichen; bekannte Anfragen und Entwürfe bleiben bei unvollständiger Abdeckung erhalten.

Vorübergehende Wiederherstellungsfehler werden im Hintergrund ohne Benachrichtigung erneut versucht. Wenn das mitgelieferte OpenCode-Plugin wartende Anfragen nicht auflisten kann, erscheint pro Backend ein Hinweis im Browser-Tab, bis die Wiederherstellung gelingt.

Eine unvollständige Antwort ist keine maßgebliche leere Warteschlange, und ein Hinweis auf ein fehlendes Plugin erlaubt keine Wiederholung eines Prompts, einer Antwort oder Freigabe. Konfigurationsneuladen kann native Forms/Berechtigungen abbrechen; verwenden Sie es nicht als routinemäßige Anfrageaktualisierung. Siehe [Fehlerbehebung](troubleshooting.md) und [OpenCode-Einrichtung](opencode.md).
