# Verlauf, Suche und Bereinigung

Gespeicherter Verlauf, aktuell angezeigter Gesprächsverlauf und komprimierter Modellkontext sind getrennte Dinge. Wählen Sie Navigation oder Filter, bevor Sie etwas löschen.

## Gesamten Verlauf durchsuchen {#full-history-search}

1. Öffnen Sie **Chat-Verlauf durchsuchen** im Unterhaltungskopf oder verwenden Sie das zugewiesene Tastenkürzel (standardmäßig **Ctrl/Cmd+F**).
2. Wählen Sie **Gesamte Sitzung** oder **Gesamter Arbeitsbereich** und geben Sie einen Suchbegriff ein.
3. Aktivieren Sie **Werkzeuge und Denkblöcke einbeziehen**, wenn Sie neben lesbarem Text auch technische Inhalte benötigen.
4. Wählen Sie einen Auszug. Unter **Gesamte Sitzung** blättern Sie mit **Weitere Ergebnisse** durch chronologische Seiten.

**Gesamte Sitzung** sucht eine wörtliche Phrase ohne Beachtung der Groß-/Kleinschreibung im gespeicherten Verlauf. **Gesamter Arbeitsbereich** durchsucht den autorisierten Verzeichnisbaum und die Worktrees des geöffneten Projekts mit bis zu sechs Suchbegriffen und zeigt höchstens 40 beste Treffer in einer Liste. Der beste Treffer jeder Unterhaltung kommt zuerst; Titel und aktuelle Worktree-Namen bleiben in Rangfolge. Begriffe werden in Auszügen und nach **In Sitzung öffnen** im Zieltranskript hervorgehoben. Durchsucht werden lesbarer Text und optional Werkzeuge und Denkblöcke.

Unterhaltungsseiten zeigen beim Eintreffen der Stapel **Diese Seite: … Ergebnisse · … Nachrichten durchsucht**. Die Projektsuche zeigt **Beste Ergebnisse: …** sowie kompakte Hinweise auf Teilsuchen oder ausgeschlossene Verzeichnisse. Ist die sortierte Suche in der Laufzeit nicht verfügbar, verwenden Sie **Gesamte Sitzung**. Übersprungene Nachrichten werden gemeldet; starten Sie für neue Nachrichten eine neue Suche.

Projektsuchen beginnen bei höchstens 16.384 neuesten gespeicherten Nachrichten je Ort. **Weiter zurück suchen** ersetzt die Liste durch die besten Treffer des nächsten älteren Fensters. Der Hinweis nennt den geprüften Bereich, je Projektort von neu nach alt. Die Rangfolge gilt nur innerhalb dieses Fensters. Änderungen an Suchtext, Bereich oder technischen Inhalten, Schließen der Suche oder Verlassen der Sitzung setzen das Fenster zurück. Eine neue Suche berücksichtigt neue Nachrichten.

Läuft ein Suchfenster ab oder ändert sich sein Verlauf, beginnt **Neue Suche starten** mit denselben Suchbegriffen und Optionen bei den neuesten Nachrichten.

## Ergebnisse öffnen und Timeline nutzen {#timeline-navigation}

1. Wählen Sie ein Suchergebnis der aktuellen Sitzung, um zur umgebenden Passage zu springen.
2. Wählen Sie ein Ergebnis einer anderen Sitzung, um eine separate Vorschau dieser Nachricht zu öffnen; verwenden Sie **In Sitzung öffnen**, um an der Trefferstelle zu dieser Unterhaltung zu wechseln.
3. Zeigen Sie in **Nachrichten-Timeline** auf eine Markierung oder fokussieren Sie sie für einen Auszug und wählen Sie sie dann zur Navigation: Ihr Block rückt nach oben, und die Markierung bleibt hervorgehoben, bis Sie scrollen; danach folgt die Hervorhebung dem Block oben im Gespräch. Über die Pfeile für erste/neueste Nachricht gelangen Sie zu den Enden des gespeicherten Verlaufs. Sie schweben über dem Gespräch; ist unter **Allgemein** die Option **Pfeile für erste/neueste Nachricht unter der Zeitleiste anzeigen** aktiviert, sitzen sie stattdessen in der Ecke unter der Zeitleiste rechts von **Nachricht senden**, und der Pfeil des Endes, an dem Sie sich befinden, ist abgeblendet.

Die Timeline stellt die gesamte Sitzungsstruktur dar, auch wenn die Verlaufsanzeige nur eine begrenzte Passage enthält. Sprünge laden das Ziel, nicht jede dazwischenliegende Nachricht. Suchvorschauen anderer Sitzungen laden weder deren gesamten Verlauf noch wählen sie diese aus; nur **In Sitzung öffnen** wechselt die Unterhaltung.

Werkzeugmarkierungen folgen **Nachrichteninhalt**: Ein dort ausgeblendeter Werkzeugtyp hat keine Markierung (bei **Nichts** gar keine), außer einem Werkzeug, das auf eine Berechtigung wartet. Ein Schritt, der nur Werkzeuge ausgeführt hat, zeigt nur seine Werkzeugmarkierungen, ohne leere Agentenmarkierung.

Bei zu schmaler Unterhaltung (unter 420 CSS-Pixeln) ist die Timeline ausgeblendet; verwenden Sie dort Suche und Verlaufssteuerung. Die gespeicherte Sichtbarkeitseinstellung wird durch diese responsive Änderung nicht gelöscht.

## Richtigen Verlaufsvorgang wählen {#operation-reference}

| Vorgang | Wo | Umfang und Folgen |
| --- | --- | --- |
| Anzeigefilter | **Nachrichteninhalt** oder **Einstellungen → Chat** | Gemeinsame Anzeigeeinstellungen; Inhalte ausblenden/einklappen, ohne sie zu löschen |
| Komprimierung | Palette **Sitzung komprimieren** | Native Zusammenfassung/Kontextkomprimierung der ausgewählten Sitzung, keine Löschung technischer Ausgabe |
| Einzelantwort bereinigen | Nachricht **Weitere Aktionen → Tools und Denkprozesse aus dieser Antwort entfernen** | Entfernt geeignete abgeschlossene technische Teile dauerhaft; behält endgültigen Text |
| Technische Sitzungsbereinigung | Palette **Sitzungs-Tools und Denkprozesse entfernen** | Plant über den gesamten gespeicherten Sitzungsverlauf einschließlich Nachrichten vor der Komprimierung; behält endgültigen Text und Nachrichten-/Sitzungsmetadaten |
| Sitzung löschen | Sitzungszeile **Sitzung löschen** oder Löschung ausgewählter Sitzungen | Löscht die native Unterhaltung und ihre nachgeordneten Untersitzungen/Verläufe nach Bestätigung rekursiv; nicht rückgängig zu machen |
| Sitzungen bereinigen | Befehlspalette | Weiter gefasste Sitzungslöschung, keine Anzeige- oder Kontextgrößeneinstellung |

**Nachrichteninhalt** gilt unterhaltungsübergreifend. Wählen Sie oben darin oder in **Einstellungen → Chat** eine Voreinstellung (**Nichts**, **Minimal**, **Ausgewogen** oder **Alles**) und passen Sie dann einzelne Zeilen an; das Voreinstellungsmenü von **Nachrichteninhalt** zeigt dann **Benutzerdefiniert**. Eine andere Voreinstellung bewahrt diese Zeilen: Wählen Sie erneut **Benutzerdefiniert**, um zu ihnen zurückzukehren. Werkzeuge auszublenden deaktiviert sie nicht, ändert keine Berechtigungen und entfernt keine gespeicherten Ausgaben. Damit die Darstellung reaktionsfähig bleibt, zeigen sehr große Nachrichten an einer Auslassung **… weitere anzeigen**, und sehr langer Text oder sehr lange Werkzeugausgabe endet an einer Zeile **… weitere Zeichen ausgeblendet** mit **Alles anzeigen** oder, wenn noch viel übrig ist, **… weitere anzeigen**, was mehrere Schritte erfordern kann. Beides einzublenden betrifft nur die Anzeige und stellt keine gelöschten Inhalte wieder her. Ziehen Sie über die Augen- oder Pfeilschaltflächen, um mehrere Zeilen auf einmal einzustellen: Die erste Schaltfläche, die Sie verlassen, wird umgeschaltet, und jede überstrichene Schaltfläche derselben Spalte übernimmt ihren neuen Zustand. Die Unterhaltung wird aktualisiert, sobald Sie loslassen.

Unter **Werkzeuggruppen** schalten Sie das Auge aus, um jeden Aufruf einzeln anzuzeigen, oder verwenden den Pfeil, um Gruppen standardmäßig zu öffnen. Jeder Werkzeugtyp behält seine eigene Sichtbarkeitseinstellung. **Alles** öffnet Gruppen standardmäßig; bei den anderen Voreinstellungen bleiben sie eingeklappt.

## Sitzung komprimieren {#compact-session}

1. Wählen Sie die beabsichtigte Unterhaltung.
2. Führen Sie **Sitzung komprimieren** in der Befehlspalette aus.
3. Warten Sie auf das native Komprimierungsergebnis oder prüfen Sie **Komprimierung fehlgeschlagen**, bevor Sie über eine Wiederholung entscheiden.

Komprimierung ändert den Kontext, mit dem OpenCode die Sitzung fortsetzt. Sie garantiert keine Löschung früherer gespeicherter Nachrichten: Vollverlaufssuche und technische Bereinigung erreichen weiterhin Inhalte vor der Komprimierung. Verwenden Sie Komprimierung nicht als Ersatz zum Löschen sensibler gespeicherter Verläufe.

## Werkzeuge und Denkprozesse entfernen {#technical-cleanup}

1. Wählen Sie die Einzelantwort-Aktion oder führen Sie **Sitzungs-Tools und Denkprozesse entfernen** für die ausgewählte Sitzung aus.
2. Prüfen Sie die geplanten Werkzeug-/Denkprozesszahlen und Warnungen zu übersprungenen Inhalten.
3. Bestätigen Sie **Entfernen**. Verfolgen Sie bei ganzen Sitzungen den Fortschritt über dem Verlauf und verwenden Sie bei Bedarf die Abbruchsteuerung.

Nur geeignete abgeschlossene Werkzeuge und Denkprozesse werden entfernt. Aktive/unvollständige Inhalte werden nicht bereinigt, ebenso wenig eine Nachricht, die in der von OpenCode gelesenen Form (einschließlich angehängter Dateien) größer als 16 MB ist und als übersprungener Inhalt zählt; geänderte Inhalte werden abgelehnt, statt den bestätigten Umfang stillschweigend auszuweiten. Endgültiger Text und Nachrichten-/Sitzungsmetadaten bleiben erhalten, entfernte technische Ausgaben lassen sich aber nicht wiederherstellen. Sichern Sie benötigte Inhalte vor der Bestätigung.

Sitzungsbereinigung ist nicht über die gesamte Sitzung atomar. Frühere erfolgreiche Entfernungen bleiben bestehen, wenn eine spätere Nachricht einen Konflikt oder Fehler verursacht. **Abbrechen stoppt künftige Stapel; ein bereits versandter Stapel wird nicht zurückgerollt** und kann weiterhin festgeschrieben werden.

## Sitzungen löschen und bereinigen {#delete-scrub}

Das Löschen einer übergeordneten Sitzung löscht auch deren nachgeordnete Untersitzungen und ihren Verlauf. Prüfen Sie die Unterhaltungsfamilie vor dem Bestätigen. Die Bereinigung von Missionsspezialisten ist anders: Sie behält Sitzungen mit Kindern.

1. Bevorzugen Sie **Sitzung löschen** in einer bestimmten Zeile, wenn Sie genau wissen, welche Unterhaltung entfernt werden soll.
2. Führen Sie für umfassendere Wartung **Sitzungen bereinigen** aus und lesen Sie die Bestätigung **Tiefenbereinigung der Sitzungen**.

Beide Bereinigungen löschen nur nachweislich leere, inaktive Sitzungen ohne Untersitzungen. Favoriten und ihre übergeordneten Sitzungen bleiben ordnerübergreifend erhalten.

Wenn eine Unterhaltung beim Bereinigen verschwindet, finden Sie ihren Entwurf und ihre Anhänge im Eingabefeld für eine neue Unterhaltung im Projekt. Mit **Entwurf wechseln** öffnen Sie einen gespeicherten Entwurf, ohne den aktuellen zu überschreiben. Das gilt auch beim erneuten Öffnen des Projekts.

Löschen entfernt Unterhaltungen, keine Git-Commits, und macht keine Dateisystem-/externen Auswirkungen rückgängig. Bei teilweise erfolgreicher Bereinigung bleiben bereits gelöschte Sitzungen gelöscht. Prüfen Sie vor dem Wiederholen die verbleibende Liste und Fehler. Siehe [Unterhaltungen](conversations.md) zu Forks/Rücknahme und [Projekte](projects.md) zum Löschen temporärer Ordner oder Worktrees.
