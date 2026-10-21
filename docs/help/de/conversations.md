# Unterhaltungen

CodeNomad stellt native OpenCode-Sitzungen als Unterhaltungen dar, mit einer Hierarchie für delegierte Arbeit und separaten Bedienelementen für Ihre nächste Eingabe.

Nachrichten stellen Markdown, Code, Diffs und unterstützte Bilder aus Werkzeugergebnissen dar. Textkopie, Vollverlaufssuche und Sprachausgabe verwenden Textprojektionen, keine eingebetteten Bildbytes. **Nachrichteninhalt** ändert die Sichtbarkeit, ohne gespeicherte Teile zu löschen; [Verlauf](history.md#operation-reference) unterscheidet Anzeigeeinstellungen und Bereinigung.

Kopfzeilen von Denkprozessen und Werkzeugen zeigen, wie lange jeder Schritt gedauert hat, und zählen live mit, solange er läuft; Dauern unter einer Sekunde werden nicht angezeigt. Wenn **Tokens** in **Nachrichteninhalt** angezeigt wird (die Voreinstellung **Alles** zeigt sie), endet jede Agentennachricht nach ihrem letzten Text mit einer Token- und Kostenzeile. Diese Zeile summiert die Nachricht und die Nachrichten mit den Werkzeugen und Denkprozessen, die ihre Aktion **Tools und Denkprozesse aus dieser Antwort entfernen** abdeckt, innerhalb des geladenen Verlaufs; klappen Sie sie für Denk- und Cache-Zähler auf. Schritte, die nur Werkzeuge ausgeführt haben, haben keine eigene Zeile.

## Unterhaltungen finden und navigieren {#navigate-conversations}

1. Wählen Sie eine Zeile unter **Sitzungen** oder verwenden Sie **Neue Sitzung**, um eine übergeordnete Unterhaltung zu beginnen.
2. Klappen Sie den Pfeil einer übergeordneten Sitzung auf, um deren Untersitzungen zu sehen. Ein eingeklappter Pfeil zeigt den dringendsten Zustand seiner Nachfahren: wartet auf Eingabe, arbeitet oder kürzlich beendet (untätig); sein Tooltip zählt sie.
3. Grenzen Sie die Liste mit **Sitzungen suchen...**, **Hauptsitzungen** / **Untersitzungen**, dem Worktree-Filter und der Sortierung nach **Aktivität**, **Name** oder **Worktree** ein.
4. Verwenden Sie **Zurück** und **Vorwärts** in der Seitenleiste, um zuvor angezeigte Unterhaltungen erneut aufzurufen.

Normales Durchsuchen ist hierarchisch; Such-/Filterergebnisse sind flache Einträge mit eigener Identität und eigenem Worktree jeder Unterhaltung. Eine neu arbeitende Untersitzung wird nur unter der Familie der aktiven Unterhaltung automatisch eingeblendet. Das Einklappen dieses Zweigs beendet diese automatische Einblendung für die derzeit laufenden Nachfahren.

Zurück/Vorwärts ist ein Besuchsverlauf pro Projekt-Tab und Fenster, nicht die Reihenfolge der Liste. Er bleibt im Arbeitsspeicher, überspringt nicht verfügbare/gelöschte Unterhaltungen und wird nach einem Neustart nicht wiederhergestellt. Die Auswahl einer neuen Unterhaltung nach dem Zurückgehen ersetzt den Vorwärtspfad. **Vorherige Sitzung** / **Nächste Sitzung** in der Palette durchlaufen stattdessen die sichtbare Liste.

## Agent, Modell und Denkaufwand wählen {#agent-model-thinking}

1. Verwenden Sie vor dem Senden die Agenten- und Modellauswahl in der Fußzeile des Eingabefelds.
2. Falls das Modell Varianten anbietet, wählen Sie den Aufwand unter **Denken**; **Standard** verwendet weiterhin den nativen Standard.
3. Senden Sie den nächsten Prompt und prüfen Sie zur Diagnose eines Ergebnisses die Agenten-/Modellmetadaten der Antwort.

Eine neue Unterhaltung beginnt mit dem Agenten, den OpenCode als Standard auflöst und den ein Plugin festlegen kann, sofern Sie keinen anderen wählen. Die Tooltips der Auswahlfelder zeigen ihre Tastenkürzel.

Dies sind Ausführungsentscheidungen für spätere Eingaben, keine Änderungen an früheren Antworten. Das Lesen einer alten Timeline-Passage ersetzt die aktuelle Auswahl im Eingabefeld nicht durch historische Metadaten. Modellsichtbarkeit, Favoriten und Anbieterverbindungen werden unter [Anbieter](providers.md) verwaltet.

## Entwürfe und Anhänge {#drafts-attachments}

1. Schreiben Sie in der ausgewählten Unterhaltung. Ein Unterhaltungswechsel behält deren Entwurf, statt ihn zu senden.
2. Wählen Sie für Dateien dieses Geräts **Datei anhängen…** im Menü **Weitere Aktionen** des Eingabefelds oder legen Sie sie ab bzw. fügen Sie sie ein; oder geben Sie `@` ein, um Projektdateien, Agenten oder Skills auszuwählen.
3. Prüfen Sie die Anhang-Chips und entfernen Sie alles, was nicht zur nächsten Eingabe gehören soll.

| Eingabe | Quelle und Wirkung |
| --- | --- |
| Geräteanhang | Auswahl, Ablegen oder Zwischenablage liest Bytes vom Gerät mit der Oberfläche; dies ist kein Serverpfad |
| Projekt-`@`-Referenz | Wird im Projekt/der Location der Unterhaltung auf dem Backend aufgelöst, einschließlich ihres Worktrees |
| Agentenerwähnung | Hängt die ausgewählte Agentenreferenz an, statt vergangene Nachrichten zu ändern |
| Skill | Durchsucht die Skills der Location nach Name/Beschreibung und hängt eine entfernbare Skill-Auswahl an |

Gerätedateien müssen lesbar sein und ins Anhangsbudget passen: höchstens je 5 MiB, 10 Dateien und insgesamt 20 MiB. Eine abgelehnte Datei wird nicht angehängt; prüfen Sie den Hinweis, statt den Erfolg der gesamten Auswahl anzunehmen.

Die Auswahl eines Skills entfernt das `@query`-Token und fügt einen Chip hinzu. Senden leert diese Auswahl im Eingabefeld, nicht die von OpenCode bereits mit der gesendeten Nachricht gespeicherten Anweisungen. Historische Nachrichten behalten Skill-Bezeichnungen. Ein beim Bearbeiten eines wartenden Prompts entfernter Skill bleibt auch beim ersetzenden Senden entfernt.

Auf dem Desktop verschiebt Senden den Tastaturfokus in die Unterhaltung, sodass Pfeiltasten, Bildlauftasten und Leertaste sie scrollen; das Tippen eines Zeichens kehrt mit diesem Zeichen zum Eingabefeld zurück. **Prompt-Text löschen** in **Weitere Aktionen** (Standard **Ctrl/Cmd+K**) leert den Entwurf des Eingabefelds.

Entwürfe sind clientseitiger Arbeitszustand, keine gemeinsamen nativen Nachrichten. Die Startwiederherstellung kann unterstützten Eingabezustand behalten; behandeln Sie einen ungesendeten Entwurf oder Anhang aber nicht als Sicherung und nehmen Sie nicht an, dass er auf einem anderen Gerät erscheint. Sichern Sie wichtigen Text vor dem Löschen von Startdaten oder dem Schließen eines Clients mit deaktivierter Wiederherstellung; siehe [Desktop](desktop.md).

## Befehle und Shell-Modus {#commands-shell}

1. Geben Sie `/` ein, wählen Sie einen gefundenen benutzerdefinierten Befehl und geben Sie dessen Argumente an.
2. Für einen direkten Shell-Befehl geben Sie am Anfang eines leeren Eingabefelds `!` ein, um den **Shell-Modus** zu aktivieren.
3. Senden Sie den Befehl. Verlassen Sie den Shell-Modus ohne Ausführung mit Escape oder mit Backspace im leeren Feld.

Nur bekannte Slash-Befehlsnamen nehmen den Weg für benutzerdefinierte Befehle; unbekanntes `/text` ist ein normaler Prompt. Benutzerdefinierte Befehle verwenden ihre native Definition. Datei-/Bildanhänge werden auf diesem Weg nicht gesendet und bleiben für einen späteren Prompt erhalten; eingefügter Text in Argumenten wird in diese aufgelöst.

Der Shell-Modus führt eine native Sitzungs-Shell-Anfrage aus, statt das Modell um einen Befehlsvorschlag zu bitten. Er kann Dateien ändern und Prozesse auf dem Ausführungshost starten. Profil-Umgebungseinstellungen gelten vor dem nächsten Prompt, benutzerdefinierten Befehl oder Shell-Aufruf; sie starten keinen vorhandenen Dienst neu. Siehe [Integrationen](integrations.md) und [OpenCode-Einrichtung](opencode.md).

## Folgeprompts steuern, einreihen und bearbeiten {#follow-ups}

1. Aktivieren Sie unter **Einstellungen → Allgemein** die Option **Gesendete Prompts in die Warteschlange stellen**, um während einer beschäftigten Sitzung gesendete Folgeprompts einzureihen; lassen Sie sie deaktiviert (Standard), um die laufende Aufgabe zu steuern.
2. Senden Sie während einer beschäftigten Sitzung einen Folgeprompt mit diesem Verhalten. Für das andere Verhalten wählen Sie **Nachricht einreihen** oder **Jetzt einschieben** im Menü **Weitere Aktionen** des Eingabefelds oder verwenden das alternative Sendetastenkürzel (Standard **Alt+Enter** unter Windows und Linux, **Cmd+Shift+Return** unter macOS; siehe [Tastenkürzel](shortcuts.md)).
3. Verwenden Sie in der Prompt-Warteschlange **Jetzt einschieben**, **In Warteschlange verschieben**, **Prompt bearbeiten** oder **Prompt entfernen**, solange der Eintrag noch wartet.

| Zustellung | Wirkung |
| --- | --- |
| Steuern | Native steuernde Eingabe für die laufende Ausführung |
| Warteschlange | Nativer Folgeprompt in der Warteschlange, zurückgehalten für spätere Verarbeitung |

Im Ruhezustand verwendet normales Senden unabhängig von diesem Schalter den unmittelbaren Standardweg, und die Alternative in **Weitere Aktionen** ist nicht verfügbar. Bearbeiten stellt einen wartenden Prompt samt entfernbaren Anhängen im Eingabefeld wieder her; **Bearbeitung abbrechen** verlässt die Bearbeitung. Ein bereits von OpenCode verarbeiteter Prompt ist kein bearbeitbarer wartender Eintrag mehr. Das Entfernen eines Eintrags macht bereits ausgeführte Arbeit nicht rückgängig.

Schlägt eine Warteschlangenänderung fehl, prüfen Sie vor dem Wiederholen die aktuelle Warteschlange. Die Annahme beweist nicht, dass das Modell einen Folgeprompt bereits verarbeitet hat, und eine Wiederverbindung berechtigt nicht zum erneuten Senden.

## Nebenfrage mit /btw stellen {#side-question}

1. Senden Sie `/btw your question` in einer vorhandenen Unterhaltung oder `/btw`, um das Nebenfragefenster zu öffnen.
2. Lesen Sie die Antwort, verwenden Sie **Antwort kopieren** oder wählen Sie während der Wartezeit **Frage abbrechen**.
3. Schließen Sie das Fenster anschließend.

Dies ist eine separate Modellanfrage mit dem Sitzungskontext. Sie führt keine Werkzeugschleife und keine Aktionen aus und hängt Frage/Antwort nicht an die Unterhaltung an. Datei-/Bildanhänge bleiben im Eingabefeld; eingefügter Text in der Frage wird als Text einbezogen. Dies ist weder eine neue dauerhafte Unterhaltung noch ein alternativer Weg zur Arbeitsvergabe.

Schließen bricht die wartende Nebenanfrage ab, ohne die Hauptsitzung zu unterbrechen. Das Verlassen der aktiven Unterhaltung leert dieses flüchtige Fenster; kopieren Sie benötigte Inhalte vorher. Leere Antworten/Fehler erscheinen hier, nicht als Verlaufsnachrichten.

## Abzweigen, rückgängig machen und Fehler beheben {#fork-errors}

1. Wählen Sie an einer Nachricht **Nach dieser Nachricht abzweigen (Fork)**, um nach diesem Punkt eine Unterhaltung anzulegen, ohne das Original zu ersetzen.
2. Prüfen Sie zum Rückgängigmachen **Änderungen bis hierhin rückgängig machen (löscht Nachrichten)** sorgfältig. Die Palette bietet **Letzte Nachricht rückgängig machen** und **Letzte Nachricht wiederherstellen** für die vorgemerkte Rücknahme.
3. Prüfen Sie bei fehlgeschlagener Ausführung vor erneutem Senden **Sitzungsfehler**, den Antwortfehler und gegebenenfalls Details unter **Senden fehlgeschlagen**.

Abzweigen kopiert den Unterhaltungskontext bis zum ausgewählten Punkt; es erzeugt keinen Git-Worktree und isoliert keine Dateien. Zurücksetzen ist nicht bloß Navigation. Prüfen Sie vor dem Fortfahren Dateiauswirkungen und Rücknahmegrenze; nutzen Sie einen Fork für eine alternative Diskussion ohne Umschreiben des ursprünglichen Verlaufs.

Ein Status **Wiederholung** mit Countdown bedeutet, dass OpenCode einen Anbieterfehler selbstständig erneut versucht; warten Sie darauf oder stoppen Sie die Sitzung, statt erneut zu senden. Ein fehlgeschlagenes Senden stellt den versuchten Entwurf und die Anhänge wieder her, sofern dadurch keine neueren Eingaben überschrieben werden. Ein fehlgeschlagener Lauf kann bereits Werkzeuge ausgeführt haben: Prüfen Sie vor dem Wiederholen [Dateien](files.md), offene [Anfragen](permissions.md) und native Aktivität. **Nachrichten neu laden** oder **Sitzung neu laden** liest den Zustand; beides ist keine Anweisung, eine Änderung zu wiederholen. **Sitzung stoppen** unterbricht die Ausführung, macht aber keine Datei- oder externen Dienständerungen rückgängig.
