# Missionen

Eine Mission verbindet ein Ziel, eine Koordinator-Unterhaltung, Aufgaben und Ergebnisse. Öffnen Sie **Missionen** im rechten Panel.

## Eine Mission erstellen {#create}

**Mission erstellen** öffnet das Formular anstelle des Baums. Die Gruppen folgen dieser Reihenfolge.

### Konfiguration {#saved-briefs}

**Konfiguration** lädt gespeichertes Ziel, Notizen, Playbook, Profile und Aufgabensitzungen. Der Name wird zum bearbeitbaren Titel. Prüfen Sie die Felder.

**Konfiguration speichern** unten neben Abbrechen und Erstellen speichert eine wiederverwendbare Konfiguration, ohne eine Mission zu erstellen oder zu starten. Zeitplanung und automatischer Start werden separat gewählt. Das Zahnrad öffnet die Einstellungen und die Bibliothek; das Entfernen einer Konfiguration erhält Missionen und Unterhaltungen.

### Ziel, Titel und Notizen {#mission-instructions}

**Ziel** beschreibt das gewünschte Ergebnis und seine Prüfung. **Titel** benennt den Baumeintrag; bei einer leeren Mission folgt er dem ersten Satz des Ziels, bis 60 Zeichen, und bleibt bearbeitbar. **Notizen** enthalten optional Kontext, Einschränkungen oder zusätzliche Anweisungen für die Agenten.

### Optionen und Playbook {#playbooks}

**Playbook** wählt die Arbeitsweise; [Playbooks](playbooks.md) beschreibt Rollen und Schritte. Native Berechtigungen gelten weiterhin. Commits, Pushes, Pull Requests und Änderungen an Tickets benötigen einen ausdrücklichen Auftrag für diese Handlung im Ziel oder in den Notizen.

### Delegation und Tiefe {#profiles}

**Aufgabensitzungen** wählt native Unteragenten des Koordinators oder unabhängige Sitzungen. Beide unterliegen OpenCodes Berechtigungen und Verschachtelungsgrenzen.

**Tiefe der Unteragenten** gilt für alle OpenCode-Unterhaltungen des Projekts. **Erben** oder 1–10 wird sofort gespeichert. Das **ⓘ** zeigt beobachtete effektive Tiefe, Berechtigungen und Konfigurationspfade. Bei einem fehlgeschlagenen oder unbestätigten Speichern bleibt die Warnung mit expliziter Aktualisierung erhalten.

Eine Projekttiefe erlaubt außerdem Unteragenten, innerhalb dieser Tiefe selbst zu delegieren, und überschreibt dabei unterstützte General-Beschränkungen anderer Konfigurationsdateien. Bei inkompatiblen Projektregeln bleibt eine Warnung. **Erben** entfernt die hinzugefügte Regel. Speichern lädt OpenCode nicht neu und ändert keine laufenden Unterhaltungen.

### Agenten und Modelle {#agents-models}

Öffnen Sie **Agenten und Modelle** für eine Zeile Agent / Modell / Denken pro Rolle. Zugeklappt bleiben die angeforderten Werte in der Zusammenfassung sichtbar. Die Vorgaben kommen aus den Einstellungen; Änderungen im Formular gelten für diese Mission.

Das Zahnrad öffnet Vorgaben für alle Missionen oder ein Playbook. Dort wird jede Änderung sofort gespeichert. Modelllisten folgen Sichtbarkeit und Favoriten der Unterhaltungsauswahl; gespeicherte Werte außerhalb der Liste bleiben erhalten.

**Zwei Modelle vergleichen** benötigt unterschiedliche Modelle für A und B. Eine andere Denken-Stufe reicht nicht. Der Gutachter verwendet ohne eigene Auswahl das Koordinatormodell; A oder B als Gutachter kann verzerren.

Kalenderbasierte Zeitplanung benötigt einen expliziten Agenten und ein Modell für den Koordinator und jede Playbook-Rolle.

### Automatisch starten {#automatic-start}

**Automatisch starten** steht außerhalb der Zeitplanung und ist standardmäßig aus. Ausgeschaltet erstellt es eine pausierte Mission für späteres ▶ Starten. Eingeschaltet fordert es den Start nach bestätigter Erstellung unter den üblichen Prüfungen und gegebenenfalls mit Zustimmung zu nativen Einstellungen an.

Bei verlorener Bestätigung bleibt der Start nach Lesen der Quittung manuell. Behalten Sie die ursprüngliche unbestätigte Anfrage und prüfen Sie Liste und Unterhaltung vor einer erneuten Erstellung.

## Zeitplanung {#daily-schedules}

### Kriterien {#native-scheduling}

Die Informationen zur Unteragententiefe nennen die wirksame Quelle unter **OpenCode-Konfigurationsdatei:**.

Erstes Kriterium ist **Einmal, jetzt**. **Kriterium hinzufügen** ergänzt ein weiteres. Wählen Sie den Typ, entfernen Sie eine Karte mit × oder verschieben Sie sie am Griff; Alt+Auf/Ab bewegt den fokussierten Griff.

Verfügbar sind einmal jetzt, alle N Stunden, täglich, ausgewählte Wochentage, Monatstag und Cron. Es gilt die gespeicherte Zeitzone; das Zonenfeld erscheint bei Abweichung vom System. Monate ohne den gewählten Tag werden übersprungen.

Einmal jetzt erhält seinen Zeitpunkt beim Start und bietet nur eine Gelegenheit; eine nicht erfüllte Bedingung kann diese verbrauchen. Zeitplanung benötigt den verfügbaren OpenCode-Dienst und Ausführungshost.

### Ereignisse und Kombinationen {#scheduling-conditions}

Wählen Sie **Repository-Aktivität → Ereignis**, danach optionale Filter in derselben Karte. Git-Commits teilen dieses Menü mit Ereignissen des automatisch erkannten GitHub-, GitLab- oder Gitea-Repositorys, wie in Contribute (`upstream`, dann `origin`). Alle drei unterstützen neue und zusammengeführte PRs/MRs sowie neue Issues mit optionalem **Autor**, einschließlich `dependabot[bot]`. Die Ereignisauswahl legt das Repository fest; gespeicherte Kriterien behalten ihr Ziel.

Forge-Prüfungen verwenden `gh`, `glab` oder `tea` auf dem OpenCode-Host, auch bei geschlossenem CodeNomad; öffentliche Repositorys erlauben anonymen Zugriff. Selbst gehostete Forges erfordern eine dort angemeldete CLI. **github.com** bietet außerdem Kontobenachrichtigungen und Dependabot-Warnungen über angemeldetes `gh` mit [Benachrichtigungszugriff](https://docs.github.com/en/rest/activity/notifications) oder [Lesezugriff auf Warnungen](https://docs.github.com/en/rest/dependabot/alerts). Benachrichtigungen behalten ihren Lesestatus; Warnungen umfassen behobene oder verworfene Einträge. Gespeicherte Benachrichtigungen mit leerem **GitHub-Repository** umfassen das Konto. Der erste Start setzt die Referenz. Jede Prüfung liest höchstens vier Seiten mit je 50 Einträgen in zehn Sekunden; fehlende Rechte, API-Limits oder unvollständige Fenster machen die Quelle unverfügbar. Zusammenfassungen gehen in die Eingabe ein und werden nach Erfolg verbraucht.

Ereignisse beziehen sich auf erfolgreiche andere Missionen/Zeitpläne, lokale Commits, neue Nachrichten oder explizite Dateien des Projekts. Wählen Sie die Quelle im jeweiligen Kriterium. Ohne Suche lädt die Auswahl beim Scrollen weitere Quellen; bei Lesefehlern erscheint dort **Erneut versuchen**. Die Suche ignoriert Groß- und Kleinschreibung, auch bei Buchstaben mit Akzenten. Während einer Suche setzen Sie mit **Weitere Quellen laden** fort, auch wenn die Seite bereits Treffer enthält. Die für neue Nachrichten gewählte Unterhaltung liefert auch Kontext für den Durchlauf. Ein anderer Kriteriumstyp leert die Quelle. Gespeicherter Unterhaltungskontext bleibt beim Bearbeiten erhalten.

**oder** verbindet benachbarte Zeitpläne oder Ereignisse. **wenn** macht Ereignisse nach Zeitplänen zu Bedingungen: seit dem letzten erfolgreichen Durchlauf muss eines eingetreten sein. **sonst** macht nachfolgende Zeitpläne zum Rückfall: seit ihrem vorherigen Termin beziehungsweise ihrer Aktivierung darf oben kein Durchlauf gestartet sein. Ereignisse danach bedingen diesen Rückfall.

Führende Ereignisse werden alle 15 Minuten geprüft. Der erste Start setzt die Referenz, Erfolg schreibt sie fort, Fehlschlag erhält sie. Unlesbare Quellen blockieren mit Erklärung. Durchläufe überlappen nicht.

### Zähler und Verlauf {#scheduling-limits}

**Koordinator-Sitzung** verwendet standardmäßig für jeden Durchlauf eine **Neue Sitzung**. Mit einem Zeitplan oder Ereignis können Sie unter **Vorhandene Sitzung** eine Stamm-Unterhaltung dieses Projekts und derselben Ausführungs-Location wählen. Jeder Durchlauf setzt sie mit dem konfigurierten Agenten und Modell fort; Verlauf, Titel und Berechtigungen bleiben erhalten. Missionssteuerungen betreffen auch vorhandene Arbeit darin. Jeder Durchlauf behält sein eigenes Ergebnis und Journal im Verlauf; eine verschwundene ausgewählte Unterhaltung erfordert Ihren Eingriff.

Der ausgewählte Zeitplan zeigt Zustand, nächsten Termin beziehungsweise Prüfung, gestartete/erfolgreiche Durchläufe und frühere Ergebnisse. Der Verlauf hält 30 Ergebnisse; Gesamtzähler bleiben. Ein zugelassenes **Jetzt ausführen** zählt mit. Nicht darstellbare gespeicherte Regeln bleiben bis zum ausdrücklichen Ersetzen erhalten; prüfen Sie gespeicherte Enden und Grenzen vor Änderungen.

### Bestehende tägliche Zeitpläne {#existing-daily-schedules}

Diese Einträge behalten ihre Kontrollen und Zeitzone. Nach Dienstneustart benötigen unterbrochene tägliche Zeitpläne **Fortsetzen**. Sie holen den letzten zulässigen Tag nach, nicht alle versäumten Tage. Ergebnisse stehen beim ausgewählten Eintrag.

## Baum und Ergebnisse {#tracking}

Der Chevron öffnet Aufgaben; ein Zeilenklick wählt Mission oder Aufgabe. Die Aktionen bleiben im Kopf. Missionen ohne Aufgaben haben keinen Chevron. Der Filter durchsucht geladene Einträge.

Das Auge schaltet die zentrale Zusammenfassung um und folgt der Auswahl. **Unterhaltung öffnen** führt zum jeweiligen Koordinator oder zur Aufgabe. Das ⋯-Menü enthält anwendbare Aktualisierungs-, Unterbrechungs-, Konfigurations- und Bearbeitungsaktionen.

Weitere Einträge und Aufgaben laden am Listenende automatisch. Aufgabenseiten bleiben unabhängig von dargestellten Zeilen im Cache. Lesefehler erhalten das letzte Bild und bieten einen expliziten neuen Versuch. Lesen startet keine Arbeit; der Kopf zeigt Hintergrundlesen an.

### Farben und Zustände {#status-colours}

Die Flagge zeigt den Missionszustand, der Chevron die Aufmerksamkeit ihrer Aufgaben. Wiederkehrende Einträge haben ein Wiederholungssymbol. Rot verlangt eine Antwort, pulsierendes Gelb zeigt beobachtete Arbeit, Orange Pause/Unterbrechung, Grün einen ungesehenen Abschluss und Blau Vorbereitung beziehungsweise noch nicht gestartete Aufgaben.

Auswahl oder grüne Aufgabensymbole bestätigen Ergebnisse; das Chevron-Menü bietet **Als gelesen markieren**. Status und Ergebnis sind getrennt: ein Blocker ist nicht zwingend eine Frage, ein Bericht beweist nicht das Ende aller nativen Vorgänge. Zurückgezogene Aufgaben bleiben im Verlauf.

### Fragen und Entscheidungen {#questions}

Der Koordinator soll selbst klären, was möglich ist, und verbleibende Entscheidungen, Zustimmung oder Zugangsdaten erfragen. Antworten Sie im Unterbrechungsdock. Exploration kennzeichnet eigene Entscheidungen und Ihre Antworten; unabhängige Sitzungen halten Entscheidungen in Notizen fest. Siehe [Playbooks](playbooks.md).

### Fortschrittsberichte {#briefings}

Berichte an Meilensteinen sind Einschätzungen des Koordinators. Fordern Sie über ⋯ ein Update an und lesen Sie die Zusammenfassung. Bei unbestätigter Zustellung zuerst die Unterhaltung prüfen.

## Kontext und Ergebnisse {#context-flow}

Der dauerhafte Plan hält Ziel, Notizen, Aufträge, Abhängigkeiten und Ergebnisse. Der Koordinator erhält Ziel, Notizen und Playbook. Native Aufgaben erhalten den Auftrag ihres Elternteils, unabhängige Aufgaben außerdem offene Zuweisungen; Helfer erhalten übergebenen Kontext. Der blinde Gutachter erhält anonymisierte Vergleichsdaten.

Neue Missionen und Durchläufe haben eigene Pläne. Übertragen Sie nützliche Ergebnisse ins Ziel oder in Notizen. OpenCode kann Modellkontext verdichten und den gespeicherten Verlauf behalten.

### Frühere Unterhaltungen suchen {#context-search}

Bei laufendem CodeNomad können Agenten gespeicherte Projektunterhaltungen suchen. Bitten Sie darum, wenn frühere Schlussfolgerungen wichtig sind; vollständiger Kontext wird nicht automatisch geerbt.

## Schließen und Neustarts {#lifetime}

CodeNomad zu schließen stoppt native Arbeit nicht. Aktivierte native Zeitpläne können bei verfügbarem Dienst/Host weiterlaufen; gesunde Kalender werden nach Dienstneustart fortgesetzt. Pausen, Stopps und ungewisse Ergebnisse behalten ihre Sperren. Bestehende tägliche Einträge brauchen Fortsetzen.

Einige Koordinations- und Wiederherstellungsaktionen benötigen den CodeNomad-Server. Folgen Sie Verbindungs-/Pluginfehlern im Panel.

## Pause, Stopp und unbestätigte Aktionen {#controls-recovery}

Einmalige Pause lässt aktuelle Schritte ohne neue Arbeit enden; sofortiges Unterbrechen fordert Unterbrechung an. Stopp ist endgültig und benötigt Bestätigung. Zeitplan-Pause sperrt neue Starts und fordert Unterbrechung des aktuellen Durchlaufs an. Werkzeugwirkungen können weiterlaufen.

Behalten Sie unbestätigte Originalanfragen. Nutzen Sie Statusprüfung, Quittungsaktualisierung oder den angebotenen Wiederholungsversuch statt einer Ersatzaktion. Passive Aktualisierung sendet nicht erneut. Bestätigte Aktionen können bis zur aktualisierten Anzeige gesperrt bleiben. Wiederherstellung prüft native Aktivität und offene Anfragen zuerst.

## Bearbeiten, löschen und Unterhaltungen bereinigen {#cleanup}

Die Aufgabenunterhaltungs-Bereinigung ist eine Option einmaliger Missionen. Das Löschen nativer Zeitpläne erhält ihre Unterhaltungen.

Die Bearbeitungsaktion im ⋯-Menü öffnet dasselbe Formular. Vor erstem Start sind entsperrte Vorbereitungsfelder bearbeitbar, danach Anweisungen und Notizen soweit erlaubt. Gesperrte Felder erklären warum. Bei Konflikten aktuelle Konfiguration laden und den vorherigen Entwurf vergleichen.

Arbeit vor dem Löschen stoppen. Eine einmalige Mission wird sofort entfernt; unbestätigtes Löschen behält seine ursprüngliche Wiederholung. Zeitplan-Löschen schließt zuerst zukünftige Starts. Die Missions-Einstellung zum Löschen von Aufgabenunterhaltungen betrifft nur zulässige Gespräche; Koordinatoren, wiederverwendete/geteilte oder nicht eindeutig zugeordnete bleiben erhalten. Die Bereinigung zeigt verbleibende Arbeit und explizite Wiederholungen.
