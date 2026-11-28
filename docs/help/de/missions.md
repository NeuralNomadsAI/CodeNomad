# Missionen

Eine Mission verbindet ein Ziel, eine Koordinator-Unterhaltung, Aufgaben und Ergebnisse. Öffnen Sie **Missionen** im rechten Panel.

Ist Missions nicht verfügbar, öffnet **OpenCode-Einstellungen** die Dienstwiederherstellung für ein fehlendes oder fehlerhaftes Plugin. **Serverdiagnose** öffnet den Diagnosebericht unter Einstellungen → Info, wenn die lokale Missions-Verbindung des Servers nicht verfügbar ist.

## Missionen ein- oder ausblenden {#activation}

Aktivieren Sie unter **Rechtes Panel anpassen** das Kästchen **Missionen**, um den Tab einzublenden. Deaktivieren Sie es und bestätigen Sie, um ihn auszublenden. Das schreibt auch `codenomad.missions` oder `-codenomad.missions` in die globale Konfiguration des verbundenen OpenCode-Servers. Projektregeln können Vorrang haben. Beim Ausschalten wird nichts gelöscht oder pausiert, aber geplante Läufe können ausfallen. Schlägt das Schreiben fehl, bleibt die gewählte Sichtbarkeit erhalten. **Zurücksetzen** ändert nur das Layout. **Status → Plugins** lässt die Warnung bei genau dieser globalen Deaktivierung weg; bei anderen bleibt **Erneut aktivieren** verfügbar.

## Eine Mission erstellen {#create}

Remote-Verbindungen verwenden dasselbe Formular und dieselben Steuerelemente. Verwenden Sie vorzugsweise HTTPS, um den Netzwerkverkehr zu schützen.

**Mission erstellen** öffnet das Formular anstelle des Baums. Eine bestätigte Erstellung wählt die Mission aus; bei einer abgelehnten Erstellung bleibt das Formular bearbeitbar.

Bitten Sie einen Agenten in jeder Projektunterhaltung, auch einen Unteragenten oder geplanten Lauf, eine separate einmalige oder geplante Mission vorzubereiten. Seine Unterhaltung bleibt unverändert; standardmäßig wird eine neue Koordinator-Unterhaltung erstellt. Halten Sie das zuständige CodeNomad-Backend verfügbar. **Automatisch starten** erlaubt den ersten Start dieser neuen Mission; die Wiederherstellung liest das ursprüngliche Ergebnis. Agenten können außerdem alle Zeitpläne dieses Projekts auflisten, prüfen, starten, pausieren, stoppen, fortsetzen, sofort ausführen, bearbeiten und löschen, auch die im Editor erstellten. Dieselben Revisions- und Zulassungsprüfungen gelten; eine ausdrücklich deaktivierte Zeitplanung bleibt deaktiviert. Unbestätigte Aktionen behalten ihre ursprüngliche Anfrage zur schreibgeschützten Statusabfrage.

### Konfiguration {#saved-briefs}

Agenten können aus jeder zugehörigen Unterhaltung alle Missionen des Projekts lesen, auch Ihre. Schreibgeschützte Ansichten zeigen Aufgaben, Ergebnisse, Bereinigung, geplante Durchläufe und Quellenauswahl; das Lesen startet oder wiederholt keine Arbeit.

Agenten können die Zeitplanung prüfen, ihre Einstellungen unter Beibehaltung eines ausdrücklichen OFF vorbereiten und bestätigte Teiländerungen mit der ursprünglichen Anfrage fortsetzen.

**Konfiguration** lädt gespeichertes Ziel, Notizen, Playbook, Profile und Aufgabensitzungen. Der Name wird zum bearbeitbaren Titel. Prüfen Sie die Felder.

Agenten können Konfigurationen lesen, speichern, ersetzen oder umbenennen, entfernen und reparieren sowie die Anweisungen einer bestehenden Mission speichern. Sie können globale oder Playbook-spezifische Profil- und Aufgabensitzungsstandards ändern, Vererbung wiederherstellen, ungültige Einstellungen zurücksetzen und die Einstellung zum Löschen von Aufgabenunterhaltungen ändern. Bibliothek und Einstellungen gelten für alle Projekte des CodeNomad-Profils. Die Unteragententiefe des Projekts unterstützt 1–10 oder **Erben**, einschließlich der Reparatur eines leeren Konfigurationsblocks. Jede Änderung prüft den zuletzt gelesenen Wert und bewahrt zwischenzeitliche menschliche Änderungen.

**Konfiguration speichern** unten neben Abbrechen und Erstellen speichert eine wiederverwendbare Konfiguration, ohne eine Mission zu erstellen oder zu starten. Zeitplanung und automatischer Start werden separat gewählt. Das Zahnrad öffnet die Einstellungen und die Bibliothek; das Entfernen einer Konfiguration erhält Missionen und Unterhaltungen.

Um eine gespeicherte Konfiguration zu ersetzen, verwenden Sie ihren Namen und wählen **Ersetzen**. Tragen mehrere Konfigurationen diesen Namen, laden Sie zuerst die gewünschte. Mit einem neuen Namen speichern Sie eine Kopie, solange in der Bibliothek Platz ist.

### Ziel, Titel und Notizen {#mission-instructions}

Bei einmaligen Missions können Agenten starten, fortsetzen, sanft pausieren, sofort unterbrechen, stoppen, bearbeiten, löschen, die Koordination nach einem Fehler fortsetzen, einen fehlenden Bericht oder einen Zwischenstand anfordern. Das gilt auch für Ihre Missions, mit denselben Zulassungs- und Revisionsprüfungen wie im Panel. Beim Löschen gilt Ihre Einstellung für verwaltete Sitzungen, sofern Sie nichts anderes angeben. Unbestätigte Aktionen und Bereinigungen behalten ihre ursprüngliche Identität; vor dem ausdrücklichen Fortsetzen einer bestätigten Teilaktion lesen Agenten den gespeicherten Status.

**Ziel** beschreibt das gewünschte Ergebnis und seine Prüfung. **Titel** benennt den Baumeintrag; bei einer leeren Mission folgt er dem ersten Satz des Ziels, bis 60 Zeichen, und bleibt bearbeitbar. **Notizen** enthalten optional Kontext, Einschränkungen oder zusätzliche Anweisungen für die Agenten.

### Optionen und Playbook {#playbooks}

**Playbook** wählt die Arbeitsweise; [Playbooks](playbooks.md) beschreibt Rollen und Schritte. Native Berechtigungen gelten weiterhin. Commits, Pushes, Pull Requests und Änderungen an Tickets benötigen einen ausdrücklichen Auftrag für diese Handlung im Ziel oder in den Notizen.

### Delegation und Tiefe {#profiles}

**Aufgabensitzungen** wählt native Unteragenten des Koordinators oder unabhängige Sitzungen. Beide unterliegen OpenCodes Berechtigungen und Verschachtelungsgrenzen.

**Tiefe der Unteragenten** gilt für alle OpenCode-Unterhaltungen des Projekts. **Erben** oder 1–10 wird sofort gespeichert. Das **ⓘ** zeigt beobachtete effektive Tiefe, Berechtigungen und Konfigurationspfade.

Die Informationen zur Unteragententiefe nennen die wirksame Quelle unter **OpenCode-Konfigurationsdatei:**.

Eine Projekttiefe erlaubt außerdem Unteragenten, innerhalb dieser Tiefe selbst zu delegieren, und überschreibt dabei unterstützte General-Beschränkungen anderer Konfigurationsdateien. **Erben** entfernt die hinzugefügte Regel. Speichern lädt OpenCode nicht neu und ändert keine laufenden Unterhaltungen.

### Agenten und Modelle {#agents-models}

Öffnen Sie **Agenten und Modelle** für eine Zeile Agent / Modell / Denken pro Rolle. Zugeklappt bleiben die angeforderten Werte in der Zusammenfassung sichtbar. Die Vorgaben kommen aus den Einstellungen; Änderungen im Formular gelten für diese Mission.

Das Zahnrad öffnet Vorgaben für alle Missionen oder ein Playbook. Dort wird jede Änderung sofort gespeichert. Modelllisten folgen Sichtbarkeit und Favoriten der Unterhaltungsauswahl; gespeicherte Werte außerhalb der Liste bleiben erhalten.

**Zwei Modelle vergleichen** benötigt unterschiedliche Modelle für A und B. Eine andere Denken-Stufe reicht nicht. Der Gutachter verwendet ohne eigene Auswahl das Koordinatormodell; A oder B als Gutachter kann verzerren.

Kalenderbasierte Zeitplanung benötigt einen expliziten Agenten und ein Modell für den Koordinator und jede Playbook-Rolle.

### Automatisch starten {#automatic-start}

**Automatisch starten** steht außerhalb der Zeitplanung und ist standardmäßig aus. Ausgeschaltet erstellt es eine pausierte Mission für späteres ▶ Starten. Eingeschaltet fordert es den Start nach bestätigter Erstellung mit den üblichen Prüfungen und automatischer Vorbereitung der Zeitplanung an.

### Koordinator mit /goal aktiv halten {#coordinator-goal}

**Koordinator mit /goal aktiv halten** steht für einmalige Missionen bereit und ist standardmäßig aus. Aktiviert setzt der Start OpenCode `/goal` auf dem Koordinator; Pausieren und Fortsetzen der Mission pausieren und setzen das Ziel fort, Abschluss oder Stopp entfernen es. Startet OpenCode während der Ausführung neu, setzt Missions das durch den Neustart pausierte Ziel automatisch fort (bei aktivierten OpenCode-Automationen auch bei geschlossenem CodeNomad); manuelle Pausen, Stillstand und Rundenlimits bleiben unberührt. Status und Steuerung erscheinen in der Missionsübersicht.

## Zeitplanung {#daily-schedules}

Eine Mission mit wiederkehrendem Zeitplan oder Ereignis bleibt eine einzige Zeile der Liste: Jeder Start ersetzt den vorherigen in derselben Koordinator-Unterhaltung und wartet, solange der vorherige noch aktiv ist. Ihr Detail zeigt **Starten, wenn**, **Gewünschter Zustand**, die nächste Aktivierung oder Prüfung, **Gestartete Durchläufe** und **Frühere Läufe** (die letzten 20 Starts). Ist **Automatisch starten** aus, wird sie pausiert erstellt. **Ausgewählte Mission bearbeiten** öffnet das Erstellungsformular erneut, und der nächste Start verwendet, was Sie speichern. **Ausgewählte Mission löschen…** entfernt zuerst ihre Zeitplanung. ⏸ in der Symbolleiste pausiert sie vollständig, den laufenden Start und ihre Zeitplanung, und ▶ setzt beides fort. ■ stoppt den laufenden Start; läuft nichts mehr, stoppt es die Zeitplanung endgültig und lässt die Mission in der Liste.

### Kriterien {#native-scheduling}

Die Schaltfläche **i** öffnet die [Zeitplanungshilfe](missions.md#native-scheduling).

Erstes Kriterium ist **Einmal, jetzt**. **Kriterium hinzufügen** ergänzt ein weiteres. Wählen Sie den Typ, entfernen Sie eine Karte mit × oder verschieben Sie sie am Griff; Alt+Auf/Ab bewegt den fokussierten Griff.

Verfügbar sind einmal jetzt, alle N Stunden, täglich, ausgewählte Wochentage, Monatstag und Cron. Es gilt die gespeicherte Zeitzone; das Zonenfeld erscheint bei Abweichung vom System. Monate ohne den gewählten Tag werden übersprungen.

Einmal jetzt erhält seinen Zeitpunkt beim Start und bietet nur eine Gelegenheit; eine nicht erfüllte Bedingung kann diese verbrauchen. Zeitplanung benötigt den verfügbaren OpenCode-Dienst und Ausführungshost.

Beim Starten oder Fortsetzen wird die Zeitplanung automatisch in der OpenCode-Projektkonfiguration vorbereitet. Ein ausdrückliches OFF bleibt erhalten: **Zeitplanungseinstellungen öffnen** öffnet, wenn angeboten, die zuständige Datei; **i** zeigt Herkunft oder Umgebungsdetails.

### Ereignisse und Kombinationen {#scheduling-conditions}

Wählen Sie **Repository-Aktivität → Ereignis**, danach optionale Filter in derselben Karte. Git-Commits teilen dieses Menü mit Ereignissen des automatisch erkannten GitHub-, GitLab- oder Gitea-Repositorys, wie in Contribute (`upstream`, dann `origin`). Alle drei unterstützen neue und zusammengeführte PRs/MRs sowie neue Issues mit optionalem **Autor**, einschließlich `dependabot[bot]`. Die Ereignisauswahl legt das Repository fest; gespeicherte Kriterien behalten ihr Ziel.

Forge-Prüfungen verwenden `gh`, `glab` oder `tea` auf dem OpenCode-Host, auch bei geschlossenem CodeNomad; öffentliche Repositorys erlauben anonymen Zugriff. Selbst gehostete Forges erfordern eine dort angemeldete CLI. **github.com** bietet außerdem Kontobenachrichtigungen und Dependabot-Warnungen über angemeldetes `gh` mit [Benachrichtigungszugriff](https://docs.github.com/en/rest/activity/notifications) oder [Lesezugriff auf Warnungen](https://docs.github.com/en/rest/dependabot/alerts). Benachrichtigungen behalten ihren Lesestatus; Warnungen umfassen behobene oder verworfene Einträge. Gespeicherte Benachrichtigungen mit leerem **GitHub-Repository** umfassen das Konto. Der erste Start setzt die Referenz.

Ereignisse beziehen sich auf erfolgreiche andere Missionen/Zeitpläne, lokale Commits, neue Nachrichten oder explizite Dateien des Projekts. Wählen Sie die Quelle im jeweiligen Kriterium. Die Suche ignoriert Groß- und Kleinschreibung, auch bei Buchstaben mit Akzenten. Während einer Suche setzen Sie mit **Weitere Quellen laden** fort, auch wenn die Seite bereits Treffer enthält. Die für neue Nachrichten gewählte Unterhaltung liefert auch Kontext für den Durchlauf. Ein anderer Kriteriumstyp leert die Quelle. Gespeicherter Unterhaltungskontext bleibt beim Bearbeiten erhalten.

**oder** verbindet benachbarte Zeitpläne oder Ereignisse. **wenn** macht Ereignisse nach Zeitplänen zu Bedingungen: seit dem letzten erfolgreichen Durchlauf muss eines eingetreten sein. **sonst** macht nachfolgende Zeitpläne zum Rückfall: seit ihrem vorherigen Termin beziehungsweise ihrer Aktivierung darf oben kein Durchlauf gestartet sein. Ereignisse danach bedingen diesen Rückfall.

Führende Ereignisse werden alle 15 Minuten geprüft. Der erste Start setzt die Referenz, Erfolg schreibt sie fort, Fehlschlag erhält sie. Durchläufe überlappen nicht.

### Zähler und Verlauf {#scheduling-limits}

**Koordinator-Sitzung** verwendet standardmäßig für jeden Durchlauf eine **Neue Sitzung**. Mit einem Zeitplan oder Ereignis können Sie unter **Vorhandene Sitzung** eine Stamm-Unterhaltung dieses Projekts und derselben Ausführungs-Location wählen. Jeder Durchlauf setzt sie mit dem konfigurierten Agenten und Modell fort; Verlauf, Titel und Berechtigungen bleiben erhalten. Missionssteuerungen betreffen auch vorhandene Arbeit darin. Jeder Durchlauf behält sein eigenes Ergebnis und Journal im Verlauf. Bei jedem Start wird die Unterhaltung auf Agent, Modell und Denken des Koordinators umgestellt.

Sie können einen Agenten bitten, den Zeitplan mit seiner aktuellen Stamm-Unterhaltung vorzubereiten. Die Durchläufe warten, bis die Unterhaltung inaktiv ist.

Der ausgewählte Zeitplan zeigt Zustand, nächsten Termin beziehungsweise Prüfung, gestartete/erfolgreiche Durchläufe und frühere Ergebnisse. Der Verlauf hält 30 Ergebnisse; Gesamtzähler bleiben. Ein zugelassenes **Jetzt ausführen** zählt mit. Nicht darstellbare gespeicherte Regeln bleiben bis zum ausdrücklichen Ersetzen erhalten; prüfen Sie gespeicherte Enden und Grenzen vor Änderungen.

Wählen Sie unter **Verfolgte Gespräche** mit **Gespräch hinzufügen** ein Gespräch aus, auch für eine sofortige Mission. Ändern Sie die Auswahl vor dem Start oder entfernen Sie sie mit ×.

Wählen Sie **Neue Commits auf einem lokalen Branch**, um eine lokale Git-Referenz zu beobachten, oder **Neue Commits auf einem Remote-Branch** und geben Sie den Branch-Namen ein (z. B. `dev`). Die Prüfung liest das erkannte Repository direkt, ohne lokalen Fetch. Mehrere Commits zwischen Prüfungen ergeben einen Durchlauf.

## Baum und Ergebnisse {#tracking}

Der Chevron öffnet Aufgaben; ein Zeilenklick wählt Mission oder Aufgabe. Die Aktionen bleiben im Kopf. Missionen ohne Aufgaben haben keinen Chevron. Der Filter durchsucht geladene Einträge. Einmalige und wiederkehrende Missionen stehen in einer Liste, neueste Aktivität zuerst; ein laufender geplanter Durchlauf steht ganz oben.

Das Auge schaltet die zentrale Zusammenfassung um und folgt der Auswahl. **Unterhaltung öffnen** führt zum jeweiligen Koordinator oder zur Aufgabe. Das ⋯-Menü enthält anwendbare Aktualisierungs-, Unterbrechungs-, Konfigurations- und Bearbeitungsaktionen.

Auswahl, aufgeklappte Abschnitte und Leseansicht gehören zu jedem Projekt-Tab und werden mit ihm wiederhergestellt. Mehrere Tabs desselben Projekts können unterschiedliche Berichte lesen oder in einem einen Bericht und im anderen die Unterhaltung, eine Datei oder eine Webvorschau bereithalten. Das Öffnen oder Schließen einer Leseansicht ändert nur diesen Tab; Missionsarbeit und Lesebestätigungen abgeschlossener Ergebnisse bleiben innerhalb des Fensters gemeinsam.

Weitere Einträge und Aufgaben laden am Listenende automatisch. Schlägt das Laden der Aufgaben fehl, wählen Sie **Erneut versuchen**, um fortzufahren.

### Farben und Zustände {#status-colours}

Die Flagge zeigt den Missionszustand, der Chevron die Aufmerksamkeit ihrer Aufgaben. Wiederkehrende Einträge haben ein Wiederholungssymbol. Rot verlangt eine Antwort, Gelb zeigt beobachtete Arbeit. Ein orangefarbenes Pausensymbol bedeutet Pause: nichts läuft weiter oder startet, bis Sie fortsetzen; ein orangefarbenes Warndreieck bedeutet Unterbrechung. Grün kennzeichnet eine abgeschlossene Mission, Aufgabe oder einen erfolgreichen Durchlauf zum Ansehen.

Eine Sanduhr in der Akzentfarbe bedeutet **Wartet auf geplanten Durchlauf**: der nächste Weckzeitpunkt ist bestätigt. Der Akzent folgt der Palette. Das Akzentsymbol allein steht für Vorbereitung oder noch nicht gestartete Aufgaben. Angesehene Abschlüsse, gestoppte Zeitpläne und **Status unbestätigt** sind neutral; lesen Sie den Statustext.

Auswahl oder Klick/Streichen über grüne Aufgabensymbole bestätigt Ergebnisse; das Chevron-Menü bietet **Als gelesen markieren**. Bei **Erfolgreicher Durchlauf zum Ansehen** wählen Sie die wiederkehrende Zeile im aktiven Fenster ausdrücklich aus oder nutzen **Als gelesen markieren**. Bei aktiver Zeitplanung kehrt das Symbol zum Warten zurück, sonst zu neutral. Neue Ergebnisse in einer bereits ausgewählten Zeile bleiben ungelesen. Zurückgezogene Aufgaben bleiben im Verlauf.

### Fragen und Entscheidungen {#questions}

Der Koordinator soll selbst klären, was möglich ist, und verbleibende Entscheidungen, Zustimmung oder Zugangsdaten erfragen. Antworten Sie im Unterbrechungsdock. Exploration kennzeichnet eigene Entscheidungen und Ihre Antworten; unabhängige Sitzungen halten Entscheidungen in Notizen fest. Siehe [Playbooks](playbooks.md).

### Fortschrittsberichte {#briefings}

Berichte an Meilensteinen sind Einschätzungen des Koordinators. Fordern Sie über ⋯ ein Update an und lesen Sie die Zusammenfassung.

## Kontext und Ergebnisse {#context-flow}

Neue Missionen und Durchläufe haben eigene Pläne. Übertragen Sie nützliche Ergebnisse ins Ziel oder in Notizen.

### Frühere Unterhaltungen suchen {#context-search}

Bei laufendem CodeNomad können Agenten gespeicherte Projektunterhaltungen suchen. Bitten Sie darum, wenn frühere Schlussfolgerungen wichtig sind; vollständiger Kontext wird nicht automatisch geerbt.

## Schließen und Neustarts {#lifetime}

CodeNomad zu schließen stoppt native Arbeit nicht. Aktivierte native Zeitpläne können bei verfügbarem Dienst/Host weiterlaufen; gesunde Kalender werden nach Dienstneustart fortgesetzt. Pausen, Stopps und ungewisse Ergebnisse behalten ihre Sperren.

Einige Koordinations- und Wiederherstellungsaktionen benötigen den CodeNomad-Server.

Eine laufende einmalige Mission weist ihre Aufgaben weiter zu und stellt deren Berichte zu, auch wenn kein CodeNomad-Fenster das Projekt geöffnet hat. In CodeNomad geänderte Umgebungsvariablen und Berechtigungseinstellungen gelten für diese Unterhaltungen wieder, sobald das Projekt geöffnet ist.

## Pause, Stopp und unbestätigte Aktionen {#controls-recovery}

Einmalige Pause lässt aktuelle Schritte ohne neue Arbeit enden; sofortiges Unterbrechen fordert Unterbrechung an. Stopp ist endgültig und benötigt Bestätigung. Zeitplan-Pause sperrt neue Starts und fordert Unterbrechung des aktuellen Durchlaufs an. Werkzeugwirkungen können weiterlaufen.

Behalten Sie unbestätigte Originalanfragen: Solange die Ansicht eines nativen Zeitplans oder der Editor geöffnet ist, liest CodeNomad sie automatisch erneut bis zur Klärung und wiederholt nur eine exakt aufgezeichnete Teilvorbereitung selbstständig. Nutzen Sie **Status prüfen** für Steuerungen einmaliger Missionen und **Missionskarte aktualisieren** für eine gewöhnliche einmalige Erstellung, wenn angeboten; erstellen Sie keine Ersatzaktion. Ein nativer Zeitplan bietet **Status prüfen** in seinem Menü **Weitere Aktionen** an.

## Bearbeiten, löschen und Unterhaltungen bereinigen {#cleanup}

Die Aufgabenunterhaltungs-Bereinigung ist eine Option einmaliger Missionen. Das Löschen nativer Zeitpläne erhält ihre Unterhaltungen.

Die Bearbeitungsaktion im ⋯-Menü öffnet dasselbe Formular. Vor erstem Start sind entsperrte Vorbereitungsfelder bearbeitbar, danach Anweisungen und Notizen soweit erlaubt. Gesperrte Felder erklären warum.

Arbeit vor dem Löschen stoppen. Eine einmalige Mission wird sofort entfernt. Zeitplan-Löschen schließt zuerst zukünftige Starts. Die Missions-Einstellung zum Löschen von Aufgabenunterhaltungen betrifft nur zulässige Gespräche; Koordinatoren, wiederverwendete/geteilte oder nicht eindeutig zugeordnete bleiben erhalten. Die Bereinigung zeigt verbleibende Arbeit und explizite Wiederholungen.
