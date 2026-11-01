# Missionen

Missionen verbinden einen dauerhaften Projektplan mit nativen OpenCode-Unterhaltungen. Der Koordinator plant und delegiert; der Aufgabenbaum erfasst Abhängigkeiten und Ergebnisse. Ein gespeicherter Plan, eine angenommene Eingabe und beobachtete Ausführung sind unterschiedliche Tatsachen.

## Erstellen, dann ausdrücklich starten {#create}

1. Öffnen Sie **Missionen** im rechten Panel und wählen Sie **Mission erstellen**. Das Formular ersetzt die Missionsliste und die Aufgaben der ausgewählten Mission, bis Sie erstellen oder abbrechen.
2. Füllen Sie **Was soll die Mission tun?** aus und prüfen Sie **Titel**, der aus dem ersten Satz vorbelegt wird (bis 60 Zeichen).
3. Lassen Sie **Zeitplanung** für **Einmal, sofort** und **Ohne Bedingung** eingeklappt oder klappen Sie sie auf, um Häufigkeit, Bedingung und optionale Grenzen zu wählen. Prüfen Sie **Gespeicherte Zeitzone (IANA)** und die Vorschau, bevor Sie geplante Arbeit erstellen.
4. Klappen Sie **Optionen** für **Playbook**, **Notizen**, **Agenten und Modelle**, **Aufgabensitzungen**, die **Verschachtelungstiefe der Untersitzungen** des Projekts, gespeicherte Aufträge und optional verfolgte Unterhaltungen auf. Mit **Zwei Modelle vergleichen** erscheinen die Auswahlfelder **Modell A** und **Modell B** im Hauptformular.
5. Wählen Sie **Erstellen**. Wählen Sie den pausierten Eintrag, prüfen Sie ihn und verwenden Sie bei Bereitschaft ▶ **Starten**. Sofortige, bedingungslose Arbeit startet eine Mission; eine verzögerte, wiederkehrende oder bedingte Regel aktiviert die native Zeitplanung.

**Erstellen speichert eine pausierte Mission.** Erst ▶ **Starten** aktiviert Arbeit und native Kalender; Erstellen oder Speichern eines Auftrags erhält die Einstellung zur Überwachung des gemeinsamen Dienstes. Die Erstellung gehört zum ausgewählten Projekt/zur ausgewählten Location und erfasst die angeforderten Profile und die Aufgabensitzungsrichtlinie. Validierung steht neben dem betroffenen Feld; eine Ablehnung mit dem Hinweis, dass nichts gesendet wurde, erhält den Entwurf zur Korrektur. Ein einmaliger Koordinator kann auch eine separate Folgemission vorbereiten: Sie erscheint als **Vorbereitet** und startet über ihre eigene ▶-Aktion.

Gespeicherte einmalige Missionen behalten ihre Ausführungssteuerung, ihren Aufgabenbaum, ihre Unterhaltungen und ihre Abschlussberichte. Bestehende tägliche Zeitpläne bleiben mit ihren täglichen Steuerelementen und [täglichen Zeitregeln](#existing-daily-schedules) aufgelistet. Wählen Sie den Eintrag und verwenden Sie die für dieses Objekt verfügbaren Steuerelemente.

### Playbooks {#playbooks}

Direkt unter dem Auswahlfeld **Playbook** steht eine einsätzige Beschreibung des ausgewählten Playbooks. **Details anzeigen** öffnet das ausgewählte Playbook im zentralen Leser: seine Schritte, seine Rollen und, am Ende eingeklappt, die genauen englischen Anweisungen, die seine Agenten erhalten. [Playbooks](playbooks.md) erklärt Schritte, Rollen und Fragen jedes Playbooks und was CodeNomad prüft.

| Playbook | Vorgesehene Arbeit |
| --- | --- |
| Flexible Mission | Koordinator wählt einen abhängigkeitsbewussten Plan für das Ziel. |
| Fehlerbehebung | Diagnose, Implementierung, getrennte Prüfung von Standards/Spezifikation und frische Validierung; die weitere Fehlerbehebung setzt die Arbeit in der bestehenden Implementierer-Unterhaltung fort. |
| Erkundung | Erfasst Unsicherheiten und arbeitet begrenzte Entscheidungen mit menschlichen Rückfragen ab. |
| Produktauslieferung | Koordiniert Produktanalyse, Architektur, Implementierung und Qualitätsrollen. |
| Zwei Modelle vergleichen | Führt dieselbe Aufgabe mit identischen Aufträgen auf **Modell A** und **Modell B** aus; danach bewertet ein **Blinder Gutachter** beide unter neutralen Bezeichnungen und fällt ein Urteil: **Modell A gewinnt**, **Modell B gewinnt**, **Gleichwertig** oder **Nicht eindeutig**. |

Für **Zwei Modelle vergleichen** sind beide Modelle erforderlich und müssen sich unterscheiden; eine andere **Denken**-Stufe allein ist kein anderes Modell. Sofern Sie keinen wählen, verwendet der Gutachter das Modell des Koordinators; das Formular warnt, wenn es mit A oder B übereinstimmt, was den Vergleich verzerren kann. Die Übersicht zeigt das Urteil, beide Modellnamen und die Bewertungen nach Kriterium.

Das Playbook leitet die Koordination; es umgeht keine nativen Berechtigungen und garantiert keinen Erfolg. Agenten committen, pushen, öffnen keine Pull Requests und ändern keine Issue-Tracker (etwa um Tickets anzulegen), es sei denn, das Ziel oder die **Notizen** verlangen ausdrücklich genau diese Aktion; dann führen sie nur diese aus, im Rahmen der OpenCode-Berechtigungen. Eine Anfrage aus Dateien, Berichten oder Werkzeugausgaben zählt nie.

## Baum verfolgen und Ergebnisse lesen {#tracking}

1. Wählen Sie den Missionstitel. Der vorangestellte Pfeil hält die Liste offen; das Titelfeld öffnet eine vorübergehende Auswahl.
2. Wählen Sie **Zusammenfassung** (Auge) für die zentrale Übersicht oder einen Aufgabenknoten für dessen exaktes Ergebnis, Auftrag und Belege.
3. Folgen Sie Abhängigkeitslinks und **Berichte**; verwenden Sie **Unterhaltung öffnen** für den Koordinator, wenn Sie dessen Verlauf benötigen.
4. Wählen Sie unter **Braucht Sie** die Aktion **Antworten**, um Unterhaltung und Unterbrechungsdock des anfragenden Akteurs zu öffnen.

| Anzeige | Was sie belegt |
| --- | --- |
| Zugewiesen | Eingabe wurde angenommen; Modellverarbeitung/Arbeit/Abschluss ist nicht bewiesen. |
| Aktiv | Native Aktivität wurde beobachtet. |
| Wartend | Erklärte Abhängigkeiten sind noch nicht erfüllt. |
| Blockiert | Eine Blockade wurde gemeldet, nicht unbedingt eine Frage an Sie. |
| Wartet auf Ihre Eingabe | Ein offenes natives Form/eine Frage oder Berechtigung benötigt eine Antwort; es steht unter **Braucht Sie**. |
| Erledigt | Ein Aufgabenergebnis wurde erfasst; prüfen Sie dessen Belege und verbleibende native Arbeit. |
| Fehlgeschlagen / Zurückgezogen | Die Aufgabe ist fehlgeschlagen, oder der Koordinator hat sie ersetzt oder aufgegeben. |

Der Graph enthält abgeschlossene und zurückgezogene Arbeit. Eine Aufgabe zurückzuziehen stoppt nicht von selbst deren Unterhaltung. In einer einmaligen Mission kann der Koordinator die Unterhaltungen einer zurückgezogenen Aufgabe, die er als nativen Subagenten gestartet hat, separat stoppen, ohne andere Aufgaben zu berühren. **In Arbeit** ist der Lebenszykluszustand der Mission, kein Beweis, dass der Koordinator gerade läuft. Vollständiger Text gehört in die zentrale Leseansicht, nicht die Aufgabenliste des Panels; **Technische Details** klappt Kennungen und angeforderte Ausführungsinformationen ein.

Ein großer Plan zeigt eine Seite seiner Aufgaben: die ersten 50 in Abhängigkeitsreihenfolge und bis zu 20, die Aufmerksamkeit brauchen, etwa Blockaden, Fehlschläge und die neuesten Ergebnisse. Jede Folge nicht geladener Aufgaben erscheint als **N Aufgaben nicht angezeigt**; **Mehr anzeigen** lädt dort die nächsten 50. Brauchen mehr Aufgaben Aufmerksamkeit, als die Seite fasst, nennt **N weitere Aufgaben brauchen Aufmerksamkeit** die Zahlen der Mission nach Art, und **Anzeigen** lädt diese Aufgaben. Ein gestrichelter Ansatz markiert eine nicht angezeigte Abhängigkeit oder abhängige Aufgabe, und ein Abhängigkeitslink im Leser einer Aufgabe lädt zuerst deren Aufgabe. Der Leser einer Aufgabe zeigt ihre neuesten Ergebnisse; **N frühere Ergebnisse nicht angezeigt** bietet **Alle anzeigen**, das ihren ganzen Verlauf lädt. Kann eine Aufgabe oder ein Bericht nicht geladen werden, sagt der Leser es; **Erneut versuchen** lädt sie erneut.

Aufgabenseiten erscheinen erst nach vollständigem Empfang. Bei fehlgeschlagenen oder geänderten Lesevorgängen bleiben die zuletzt gezeigten Aufgaben erhalten. Ändert sich die Liste während des Lesens, wählen Sie **Aktualisieren**, dann **Erneut versuchen**; die Seite wird von vorn gelesen. Ein fehlender Teil belegt niemals, dass eine Aufgabe oder Anfrage fehlt. Das Wiederholen eines Lesevorgangs startet keine Arbeit. Kann das Missions-Plugin die Seite nicht liefern, versuchen Sie es nach erneutem Verbinden oder Neuladen des Plugins.

### Farben und unterbrochene Missionen {#status-colours}

Missionsmarkierungen, Aufgabensymbole und das Chevron der Liste verwenden die Farben der Sitzungsliste: Farbe zeigt nur, was Sie jetzt braucht.

| Farbe | Bedeutung |
| --- | --- |
| Rot | Eine Antwort von Ihnen wird erwartet; sie steht unter **Braucht Sie**. |
| Gelb, pulsierend | Es wird gearbeitet. |
| Orange | Die Mission ist pausiert oder unterbrochen, mit einer Aktion zum Fortsetzen. |
| Grün | Eine abgeschlossene Mission, die Sie in diesem Fenster noch nicht geöffnet haben; sie wird neutral, sobald Sie sie auswählen. |
| Blau | Eine vorbereitete Mission, bereit zum Start wie ein verfasster Prompt. |

Alles andere ist neutral, auch erledigte und fehlgeschlagene Aufgaben: Ergebnisse stehen im Statustext und in den Symbolen. Ist die Liste eingeklappt, übernimmt ihr Chevron die dringendste Farbe aus Rot, Gelb und Grün unter den anderen Missionen; wie bei eingeklappten Sitzungen erscheinen Orange und Blau nur in ihren eigenen Zeilen.

Eine Mission ist **Unterbrochen**, wenn ihr Koordinator ohne Abschluss angehalten hat, während nichts anderes läuft. Eine als **Fehlgeschlagen** angezeigte Mission kann ebenfalls fortgesetzt werden. In beiden Fällen wird die erste Schaltfläche der Werkzeugleiste zu **Unterbrochene Mission wiederherstellen**: Sie bittet den Koordinator, anhand des gespeicherten Plans und der Ergebnisse neu zu bewerten, und öffnet eine fehlgeschlagene Mission zuvor wieder. Ein Koordinator beendet eine einmalige Mission nicht als fehlgeschlagen: Kann ohne Sie nichts mehr weitergehen, stellt er Ihnen eine Frage unter **Braucht Sie**. Nur Sie stoppen eine Mission.

### Fragen und Entscheidungen {#questions}

Nur der Koordinator stellt Ihnen Fragen. Aufgaben und die Subagenten, die sie starten, geben ihre offenen Fragen an ihn zurück, mit den Optionen, den Belegen und einer Empfehlung. Bevor er fragt, versucht der Koordinator, eine Frage selbst zu klären: Er liest das Projekt, recherchiert, lässt eine Aufgabe nachforschen oder wählt eine leicht umkehrbare Vorgabe und hält sie als Annahme fest. Er fragt nur, was er nicht selbst klären kann: Ihre Zustimmung, Zugangsdaten, schwer umkehrbare Entscheidungen oder Produktentscheidungen, die das Ziel offenlässt. Offene Fragen bündelt er in einem Formular unter **Braucht Sie** und startet zuvor die davon unabhängige Arbeit.

In der **Erkundung** bereiten Entscheidungsaufgaben eine Zusammenfassung vor, und der Koordinator klärt jede Entscheidung: Er entscheidet selbst, wenn die Belege reichen und die Wahl leicht umkehrbar ist, hält die Frage für später in den **Notizen** fest oder fragt Sie. Mit **Native Unteragenten** zeigt das Ergebnis der Entscheidungsaufgabe, wer entschieden hat:

| Bezeichnung | Bedeutung |
| --- | --- |
| **Entscheidung des Koordinators** | Der Koordinator hat entschieden, ohne Sie zu fragen; das Ergebnis zeigt seine Begründung und gegebenenfalls seine Hinweise zum Rückgängigmachen. Um sie zu ändern, schreiben Sie dem Koordinator über **Unterhaltung öffnen**. |
| **Ihre Antwort** | Sie haben diese Frage im Unterbrechungsdock von CodeNomad beantwortet. |

Nur eine Antwort, die Sie im Unterbrechungsdock geben, zählt als **Ihre Antwort**; ein Agent kann nicht für Sie antworten. Mit **Native Unteragenten** endet jede Entscheidungsfrage mit der Markierung der einen Entscheidung, die sie klärt, etwa `[decision choose-seam 3fa9c21b]`. Werden mehrere Entscheidungen zusammen erfragt, ist jede eine eigene Frage mit eigener Markierung; eine Frage, die zwei Entscheidungen nennt, klärt keine davon. Mit **Unabhängige Sitzungen** hält der Koordinator stattdessen jedes Ergebnis in den **Notizen** fest und nennt, ob er oder Sie entschieden haben. In der **Produktumsetzung** gilt ein Ziel, das die Verhaltensänderung bereits genau beschreibt, als genehmigte Spezifikation; andernfalls bittet der Koordinator Sie um Genehmigung und bündelt offene Genehmigungen.

### Lageberichte und Aktualisierungsanfragen {#briefings}

Der Koordinator erhält die Anweisung, nach dem ersten Plan, nach Aufgabenerledigungen, beim Warten auf Menschen und vor dem Abschlussbericht einen Projektlagebericht zu veröffentlichen. Dies ist eine verfasste Einschätzung, kein Live-Aktivitätszähler oder garantierter periodischer Heartbeat. Ein Hinweis kennzeichnet Änderungen der Karte seit dem Lagebericht.

Verwenden Sie **Update anfordern** unter der Symbolleiste für eine neue Koordinatoreinschätzung und lesen Sie dann **Zusammenfassung**. **Update angefordert…** bedeutet wartend, nicht beantwortet. **Zustellung unbestätigt** erlaubt kein automatisches erneutes Senden: Öffnen Sie die Koordinatorunterhaltung vor einer separaten neuen Anfrage. Dies ist normale native Eingabe, keine schreibgeschützte Sandbox; der Koordinator behält seine normalen Rechte.

## Wie Kontext durch eine Mission fließt {#context-flow}

Die Missionskarte ist das gemeinsame, dauerhafte Gedächtnis der Mission. Sie enthält das Ziel und die **Notizen**, jede Aufgabe mit ihrem **Aufgabenbrief**, ihren Abhängigkeiten (**Hängt ab von**) und ihrem Status, die für erledigte Arbeit erfassten **Berichte** (Zusammenfassung, **Nachweise**, **Empfohlene nächste Schritte** und gegebenenfalls **Strukturierter Bericht**), die Lageberichte des Koordinators und die **Planänderungen**. OpenCode speichert sie mit dem Projekt, sodass sie Unterhaltungen und Neustarts überdauert; die Missionszentrale zeigt sie an, und die Wiederherstellung setzt bei ihr an. Jeder Beteiligte erhält einen festgelegten Teil:

| Beteiligter | Was er erhält |
| --- | --- |
| Koordinator | Bei jedem Turn das Ziel, die Notizen und die Playbook-Anweisungen. Er liest die ganze Karte, wann immer er sie braucht; seine gespeicherte Unterhaltung behält jedes Ergebnis, das er gelesen hat, während OpenCode seinen Modellkontext [komprimieren](history.md#compact-session) kann. |
| Aufgabe (**Native Unteragenten**) | Ihre Zuweisung, die der Koordinator in einem gewöhnlichen OpenCode-Subagentenaufruf übergibt: das Ziel, Titel und Brief der Aufgabe, ihre Rollenanweisungen und die Aufgaben, von denen sie abhängt. Der Koordinator kann Kontext hinzufügen, etwa frühere Ergebnisse. |
| Aufgabe (**Unabhängige Sitzungen**) | Dieselbe Zuweisung als Nachricht in ihrer eigenen Unterhaltung. Bei jedem Turn erhält sie außerdem das Ziel, die Notizen und ihre offenen Zuweisungen, und sie kann die ganze Karte lesen. |
| Von einer Aufgabe gestartete Helfer | Was ihr Elternteil in den Aufruf schreibt. Die Playbooks weisen jedes Elternteil an, Umfang, Vorgaben und Sicherheitsregeln weiterzugeben, die seine Helfer brauchen. |

Ergebnisse gehen auf demselben Weg zurück. Ein nativer Subagent gibt sein Ergebnis an die Unterhaltung zurück, die ihn gestartet hat, normalerweise den Koordinator, der es als Bericht der Aufgabe erfasst. Eine unabhängige Sitzung erfasst ihren eigenen Bericht, und CodeNomad stellt dessen Zusammenfassung dem Koordinator als Nachricht zu.

Eine spätere Aufgabe baut auf zwei Wegen auf früherer Arbeit auf. Abhängigkeiten ordnen die Arbeit: Der Koordinator startet eine Aufgabe, sobald die Aufgaben, von denen sie abhängt, erledigt sind, und gibt die relevanten Ergebnisse in den Brief oder neben die Zuweisung; unabhängige Sitzungen können diese Berichte auch in der Karte lesen. Um die eigene Unterhaltung einer erledigten Aufgabe fortzusetzen, erklärt der Koordinator eine Folgeaufgabe, die sie wiederverwendet: Die Folgeaufgabe setzt dort mit dem aktuellen Kontext dieser Unterhaltung fort, den OpenCode möglicherweise [komprimiert](history.md#compact-session) hat, während frühere Einzelheiten für die Suche im gespeicherten Verlauf bleiben. Das Playbook Fehlerbehebung gibt so beide Prüfungen an den Implementierer zurück. Mit **Unabhängige Sitzungen** kann der Koordinator eine Aufgabe auch einer bestehenden Hauptunterhaltung zuweisen, die ihren Kontext behält, einschließlich früherer, nicht zugehöriger Arbeit. Andernfalls beginnt eine Aufgabe in einer neuen Unterhaltung mit ihrer Zuweisung, und der Verlauf einer anderen Aufgabe erreicht sie über den Koordinator oder eine Suche. Bei **Zwei Modelle vergleichen** lassen Zuweisung und Kontext des Gutachters Ziel und Notizen weg; sein Brief enthält die anonymisierten Ergebnisse.

Jeder geplante Durchlauf beginnt mit eigenem Koordinator und eigener Missionskarte, anhand seiner gespeicherten Anweisungen und festgehaltenen Eingaben. Verfolgte Unterhaltungen liefern begrenzten neuen Benutzer- und Assistententext; ihre Verbrauchszeiger werden nach einem erfolgreichen Durchlauf weitergesetzt. Frühere Durchläufe bleiben im Verlauf des Zeitplans. Innerhalb eines Durchlaufs gestartete Unterhaltungen können dessen Karte lesen. Eine neue einmalige Mission hat eine separate Karte: Schreiben Sie weiterzugebende Ergebnisse in ihr Ziel oder ihre **Notizen** oder bitten Sie den Koordinator, eine Folgemission mit diesem Kontext vorzubereiten.

### Frühere Unterhaltungen durchsuchen {#context-search}

Solange CodeNomad läuft, hat jede Agentenunterhaltung im Projekt, auch Missionskoordinatoren und Aufgaben, das Sitzungssuchwerkzeug von CodeNomad (`codenomad.session_search`, genutzt über den Code Mode von OpenCode). Es durchsucht die gespeicherten Unterhaltungen des Projektordners der Unterhaltung mit derselben Rangfolge wie die [Suche](history.md#full-history-search) **Gesamter Arbeitsbereich** und liefert kurze Auszüge mit Titel und Kennung jeder Unterhaltung sowie einen Weg, eine ganze Unterhaltung zu lesen. Es gelten die nativen Werkzeugberechtigungen. Ein Agent sucht, wenn er sich dafür entscheidet oder wenn Ziel, Notizen oder Ihre Nachricht ihn darum bitten, etwa um herauszufinden, was eine frühere Mission oder Aufgabe ergeben hat. Ein geplanter Durchlauf, der bei geschlossenem CodeNomad ausgeführt wird, arbeitet ohne dieses Werkzeug.

## Profile, Delegation und Tiefe {#profiles}

Das Speichern einer Tiefe erhält aktivierte native Zeitpläne in der Projektkonfiguration. Ein ausdrückliches `schedules:false` im Projekt bleibt deaktiviert; das Entfernen der Tiefe erhält die Zeitplaneinstellung. Gleichzeitige JSON- und JSONC-Dateien müssen vor dem Speichern nativer Einstellungen bereinigt werden.

1. Verwenden Sie das Missionszahnrad oder **Einstellungen → Missionen**, um **Vorgaben für neue Missionen** zu bearbeiten.
2. Wählen Sie unter **Anwenden auf** entweder **Alle Missionen** oder ein Playbook und legen Sie dann **Aufgabensitzungen** sowie unter **Agenten und Modelle** eine Zeile pro Rolle fest (Koordinator, dann die Rollen des Playbooks). Jede Auswahl wird sofort gespeichert; es gibt keine Speichern-Schaltfläche.
3. In einem Playbook-Bereich zeigen die Zeilen die globalen Werte mit der Kennzeichnung **Global**. Das Ändern eines Felds passt diese Rolle ausgehend von ihnen an; ihr Zurücksetzen-Symbol verwendet wieder die globalen Werte. **Zurücksetzen** (nach Bestätigung) löscht nur die Agenten und Modelle des angezeigten Bereichs.
4. Verwenden Sie beim Erstellen **Optionen → Agenten und Modelle** für bestimmte angeforderte Profile; **Gespeicherte Standardwerte verwenden** stellt die gespeicherten wieder her.
5. Bearbeiten Sie für native Rekursionsgrenzen **Verschachtelungstiefe der Untersitzungen → Vorgegebene Tiefe für das Projekt**, hier oder beim Erstellen unter **Optionen**. Enter oder das Verlassen des Felds speichert einen geänderten gültigen Wert; **Erben** speichert sofort; Escape verwirft einen ungespeicherten Wert.

| Einstellung | Geltungsbereich und Wirkung |
| --- | --- |
| Vorgaben für neue Missionen | Konfigurationsweite Vorgaben nur für **neue** Missionen; eine Playbook-Ausnahme übersteuert den allgemeinen Standard. |
| Agent / Modell / Denken | Bei Erstellung erfasste Koordinator-/Rollenauswahl; ein beschäftigter Akteur wird für spätere Arbeit nicht stillschweigend umgestellt. Geplante Durchläufe verwenden ihre gespeicherten angeforderten Profile; Änderungen gelten für künftige Durchläufe. |
| Native Subagenten | Aufgabensitzungen verwenden native subagent/all-Agenten unter dem Koordinator. |
| Unabhängige Sitzungen | Erklärte Aufgabensitzungen verwenden primary/all-Agenten und unabhängige Unterhaltungen; dies deaktiviert keine internen nativen Helfer. |
| Verschachtelungstiefe der Untersitzungen | Projektkonfiguration für **alle** dortigen OpenCode-Unterhaltungen, nicht nur Missionen. Leer bedeutet Vererbung: **Erben** entfernt die Projektüberschreibung und einen dadurch leer gewordenen `experimental`-Block oder einen, der nur noch den globalen Wert von **Bilder nur einmal speichern** enthält. OpenCode liest den `experimental`-Block des Projekts als Ganzes, sodass dort verbleibende andere experimentelle Einstellungen die globale Tiefe weiterhin verdecken. OpenCodes eingebauter **General**-Unteragent kann standardmäßig keine Unteragenten starten, daher verschachteln sich seine Unterhaltungen nie: Das Speichern einer beliebigen Projekttiefe fügt derselben Datei außerdem eine Regel hinzu, die Unteragenten erlaubt, bis zu dieser Tiefe eigene Unteragenten zu starten, und Vorrang vor Einschränkungen von General aus anderen Konfigurationsdateien hat (bei einer Tiefe von 1 verhindert OpenCodes Tiefenbegrenzung die Verschachtelung weiterhin); **Erben** entfernt sie. Unter **Effektive OpenCode-Tiefe** zeigt der Editor an, ob sich General-Unteragenten verschachteln können. Definiert das Projekt General im älteren Format mit einem einzelnen `permission`-Wert oder mit bereits gesetztem `task` und `subagent`, wird nur die Tiefe gespeichert und der Editor weist darauf hin: Erlauben Sie Unteragenten für General selbst in dieser Datei. Speichern lädt OpenCode nicht neu und ändert keine laufenden Unterhaltungen. |

**Nativer Standard** und **Global** unterscheiden sich: Ersteres fordert die eigenen Standards von OpenCode an, Letzteres erbt die globale Auswahl; native Standards in einem Playbook-Bereich zu wählen bleibt eine ausdrückliche Ausnahme. Katalogverfügbarkeit wird geprüft; ein angefordertes Profil beweist nicht das aktuell verwendete Profil einer Unterhaltung. Native Berechtigungen und konfigurierte Tiefe regeln interne Helferaufrufe weiterhin in beiden Aufgabenmodi.

Jede **Modell**-Liste zeigt, was die **Modell**-Auswahl der Unterhaltung zeigt, unter denselben Namen und nach Anbieter gruppiert: Ausgeblendete Modelle fehlen und, solange der Nur-Favoriten-Filter aktiv ist, auch die übrigen Modelle (siehe [Modellsichtbarkeit, Favoriten und Denken](providers.md#models)). Modelle ohne Werkzeugunterstützung fehlen ebenfalls. Ein gespeichertes Modell außerhalb der Liste bleibt ausgewählt. **Nicht verfügbar** kennzeichnet ein gespeichertes Modell, das die Auswahl derzeit nicht anbieten kann: Es fehlt im aktuellen Katalog des Projekts, ist veraltet oder unterstützt keine Werkzeuge.

Eine abgelehnte oder unbestätigte Auswahl wird nie erneut gesendet: Die gespeicherten Werte werden wieder angezeigt, und **Neu laden** erscheint nur, wenn sie nicht gelesen werden können. Ist eine Tiefenänderung unbestätigt, bleibt Ihr Wert erhalten; verwenden Sie vor einer weiteren Änderung **Tiefe dieses Projekts aktualisieren**. Interpretieren Sie **Effektive OpenCode-Tiefe unbekannt** nicht als null oder deaktiviert.

## Gespeicherten Auftrag wiederverwenden {#saved-briefs}

1. Öffnen Sie beim Erstellen **Optionen → Mit einem gespeicherten Auftrag beginnen** und wählen Sie den Auftrag.
2. Prüfen Sie vor **Erstellen** das kopierte Ziel, Notizen, Playbook, Profile und Delegation.
3. Verwenden Sie **Als Auftrag speichern**, um einen wiederverwendbaren Entwurf zu benennen. Auch eine ausgewählte einmalige Mission, einschließlich abgeschlossener, bietet **Als Auftrag speichern**.

Aufträge speichern Anweisungen und angeforderte Auswahl, keine Aufgabenpläne, Ergebnisse, Unterhaltungen, Zeitplanuhren oder Ausführungsbefugnis. Laden füllt einen normalen Erstellungsentwurf; es startet oder plant nichts. Entfernen eines Auftrags behält bestehende Missionen/Unterhaltungen. **Einstellungen → Missionen → Gespeicherte Aufträge** verwaltet die Bibliothek; wird die Bibliothek unlesbar, entfernt **Gespeicherte Bibliothek zurücksetzen** (nach Bestätigung) gespeicherte Aufträge, keine Ausführungen. Zeitpläne selbst haben keine Aktion zum Speichern als Auftrag.

## Zeitplanung, Nachholen und verfolgte Unterhaltungen {#daily-schedules}

### Native Zeitplanung {#native-scheduling}

Die **i**-Symbole neben den Beschriftungen erklären die Auswahl: per Mauszeiger, Tastaturfokus oder Antippen.

Klappen Sie **Zeitplanung** beim Erstellen oder Bearbeiten auf. **Häufigkeit** bietet:

| Auswahl | Zeitpunkt |
| --- | --- |
| Einmal, sofort | Ein Start über ▶ **Starten**, mit einer optionalen Bedingung, die wie unten beschrieben geprüft wird. |
| Einmal, an einem Datum | Ein gespeichertes Datum mit Uhrzeit in der IANA-Zone; ein beim Start bereits vergangenes Datum wird abgelehnt. |
| Einmal, nach einer Wartezeit | Eine positive ganzzahlige Dauer in Minuten oder Stunden, beginnend beim Start. |
| In einem Intervall | Mindestens 15 Minuten; die erste Aktivierung erfolgt ein Intervall nach dem Start. |
| Jeden Tag | Eine Ortszeit in der gespeicherten Zone. |
| Ausgewählte Wochentage | Eine Uhrzeit an den markierten Wochentagen. |
| Mehrmals täglich | Bis zu acht unabhängige Uhrzeiten, etwa 09:15 und 17:45; doppelte Uhrzeiten teilen sich einen Durchlauf. |
| Tag jedes Monats | Tag 1–31 zur gewählten Uhrzeit; Monate ohne diesen Tag werden übersprungen. |
| Erweitert (cron) | Ein nativer Cron-Ausdruck, höchstens einmal pro Minute. |

**Nächste Termine (bis zu fünf)** zeigt eine Vorschau mit gespeicherter Zone und angenommenem Startzeitpunkt. Mit einer Bedingung zeigt **Nächste Prüfungen (bis zu fünf)** die Prüfungen; ein Durchlauf hängt von einer bestätigten Änderung ab. Ein unverändertes gespeichertes Intervall behält seine native Phase. Eine pausierte oder unbekannte Phase wird als nicht verfügbar angezeigt, bis ihr nativer Zustand gelesen werden kann. Wartezeiten und Intervalle nutzen verstrichene Zeit; Ortszeitkalender folgen der gespeicherten Zone und den Sommerzeitregeln von OpenCode. Die angezeigten Daten sind Prognosen, abhängig von Dienst- und Hostverfügbarkeit.

Nach einem Ausfall liefert die native Zeitplanung höchstens einen nachgeholten Durchlauf, bevor sie zu künftigen Terminen zurückkehrt. Sie nutzt den gespeicherten nativen Fälligkeitstermin, der vor später verpassten Terminen liegen kann. Mehrere tägliche Uhrzeiten teilen sich dieses Nachholen und denselben Überschneidungsschutz. Ein ungeklärter Durchlauf wird unter seinen ursprünglichen Unterhaltungs- und Nachrichtenidentitäten abgeglichen, bevor ein weiterer starten kann. Das Fortsetzen einer ausdrücklich pausierten Wiederholung nutzt ihren nächsten zukünftigen Termin; ein pausierter einmaliger Start kann einmal verspätet eintreffen.

### Bedingungen und Quellen {#scheduling-conditions}

Wählen Sie eine optionale **Bedingung** und ihre **Quelle in diesem Projekt**: **Ein anderer Zeitplan ist erfolgreich**, **Neue Commits auf einem lokalen Branch**, **Eine einmalige Mission wird erfolgreich abgeschlossen**, **Neue Nachricht in einer verfolgten Unterhaltung** oder **Änderung expliziter Dateien**. Für eine Bedingung allein behalten Sie **Einmal, sofort**: Native Prüfungen erfolgen alle 15 Minuten, bis ihr einziger Durchlauf startet. Mit einem Kalender wird die Bedingung zu dessen Terminen geprüft. Wiederkehrende Bedingungen können nach neuen passenden Änderungen erneut starten.

Der erste Start legt die Ausgangsreferenz fest. Fortsetzen erhält sie, einschließlich nach einer Pause beobachteter Änderungen. Erfolgsquellen erfordern ein bestätigtes erfolgreiches Ergebnis und eine abschließend geklärte native Familie. Branchprüfungen nutzen lokale Commits und deren Abstammung ohne Abruf vom entfernten Repository. Unterhaltungsprüfungen warten auf vollständige, stabile neue Nachrichten und schließen technische Aktivierungen und die eigenen Unterhaltungen des Durchlaufs aus. Dateien verwenden bis zu 128 explizite projektbezogene relative Pfade, einen pro Zeile; rekursive Muster und verknüpfte Pfade werden abgelehnt. Eine fehlende, verschobene, mehrdeutige oder zu große Quelle blockiert die Zulassung mit einer Erklärung. Änderungen zwischen Prüfungen benötigen eine dauerhafte Spur in der Quelle, um erkannt zu werden.

Zusammen beobachtete Änderungen werden gebündelt. Ein Durchlauf hält die beobachteten Quellenbelege fest; ein erfolgreicher Abschluss verbraucht diesen Schnappschuss und lässt spätere Änderungen für eine künftige Prüfung übrig. Ein fehlgeschlagener Durchlauf behält seinen Quellenprüfpunkt und erfordert einen Eingriff. **Verfolgte Gespräche (optional)** unter **Optionen** liefert Kontext unabhängig von der Wahl einer Bedingung für Unterhaltungsnachrichten.

### Enden und Zählungen {#scheduling-limits}

Lassen Sie Grenzen für eine fortlaufende Wiederholung leer. **Letzter erlaubter Termin** und **Letzter Termin nach dieser Anzahl Stunden seit dem ersten Start (optional)** begrenzen zulässige Termine; die früheste Grenze gilt. Die Dauer beginnt beim ersten Start und läuft während einer Pause weiter. Ein vor dem Ende gespeicherter Termin kann nach einem langen Ausfall verspätet eintreffen. Ein bereits zugelassener Durchlauf bleibt bis zu seinem Ergebnis beobachtbar.

**Maximale gestartete Durchläufe** ist eine gemeinsame Gesamtzahl für alle Uhrzeiten und **Jetzt ausführen**. Ein Durchlauf zählt einmal bei Annahme der ersten Eingabe seines Koordinators, auch wenn er später fehlschlägt. Prüfungen, unveränderte Bedingungen und abgelehnte Aktivierungen verbrauchen keinen Platz; eine unbestätigte Zulassung hält ihren Platz bis zum Abgleich. Einmalige Regeln erlauben höchstens einen Durchlauf. Verbrauchte Plätze bleiben bei Änderungen und Neustarts erhalten; unveränderte Endgrenzen behalten ihren Ursprung beim ersten Start und ihr absolutes Terminende. Eine Änderung des Maximums ändert die Gesamtzahl über die gesamte Laufzeit; eine Gesamtzahl kleiner oder gleich der bereits verbrauchten Anzahl beendet den Zeitplan. Ein Häufigkeitswechsel kann beim Speichern eine neue Intervallphase beginnen, wie der Editor erklärt.

Der ausgewählte native Zeitplan zeigt **Gewünschter Zustand**, **Nativer Kalender**, **Nächste Aktivierung** oder **Nächste Prüfung**, **Prüfungen** mit **Erfasst seit…**, **Gestartete Durchläufe**, **Erfolgreiche Durchläufe**, sein Ende und **Frühere Läufe**. Lesen Sie einen früheren Durchlauf über **Unterhaltung öffnen**. **Zeitplan beendet** beschreibt das Ende des Zeitplans; prüfen Sie das Ergebnis des Durchlaufs separat. Ergebnisse behalten die neuesten 30 Einträge; Gesamtzählungen überdauern dieses Fenster. **Weitere Missions laden** lädt die nächste Seite gespeicherter Objekte.

Die Liste zeigt Bedingung und Ende nur, wenn festgelegt, und **Prüfungen** nur mit einer Bedingung.

### Bestehende tägliche Zeitpläne {#existing-daily-schedules}

Bestehende tägliche Zeitpläne verwenden die gespeicherte IANA-Zone und Ortszeit. Jeder Lauf hat eigenen Koordinator und eigene Missionskarte; wählen Sie seinen aktuellen Aufgabenbaum oder ein früheres Datum/Ergebnis zur zentralen Anzeige. Ihr aufbewahrter Verlauf enthält 30 Ergebnisse. Für diese Einträge gelten die folgenden täglichen Regeln:

| Situation | Planungsverhalten |
| --- | --- |
| Mehrere verpasste Fälligkeitstage | Führt nur den jüngsten fälligen Tag nach der erledigten Tagesmarkierung aus, nicht jeden verpassten Tag. |
| Lücke bei Zeitvorstellung | Geht zur ersten späteren gültigen Minute weiter; eine Lücke am Tagesende überschreitet die Tagesgrenze. |
| Wiederholte Uhrstunde | Verwendet das erste Auftreten; erzeugt keinen zweiten Tageslauf. |
| Vollständig übersprungener Kalendertag | Für diesen Tag existiert kein Lauf. |
| Uhr wird zurückgestellt | Macht einen bereits verarbeiteten Tag nicht erneut fällig. |
| Vorhandener Lauf noch offen | Überschneidet ihn nicht mit einem neuen Tageslauf. |

Auch die Erstellungszeit begrenzt zulässige tägliche Arbeit. **Jetzt ausführen** startet, wenn bei einem bestehenden täglichen Eintrag angeboten, einen separaten manuellen Lauf unter dem Schutz für offene Läufe und erhält dessen Tagesuhr. Eine angezeigte nächste Zeit ist eine Prognose, abhängig von Dienst- und Hostverfügbarkeit.

**Verfolgte Gespräche (optional)** ergänzt begrenzten Kontext aus ausgewählten Unterhaltungen. Nur ein abgeschlossener Lauf bewegt deren verarbeitete Nachrichtenzeiger vor; fehlgeschlagene/unterbrochene Läufe verbrauchen diesen Kontext nicht stillschweigend. Überschreiten Anweisungen plus Kontext die Kapazität, kürzen Sie Anweisungen oder entfernen Sie verfolgte Unterhaltungen, statt unbegrenzt gelesenen Verlauf anzunehmen.

## Lebensdauer und Dienstneustarts {#lifetime}

Das **i** neben **Technische Details** erklärt technische Aktivität und Kosten. Unter **Einstellungen → OpenCode** bleiben Überwachungsstatus und Fehler sichtbar; allgemeine Erklärungen stehen im **i**.

Klappen Sie bei einem nativen Zeitplan **Technische Details** auf, um seinen **Hauptträger** und **Abgleichträger**, deren native Kalender und eine etwaige Meldung **Bereinigung wartet auf Abgleich** zu sehen. Diese technischen Unterhaltungen bieten keine Aktion zur Nachrichteneingabe und erscheinen nicht in den üblichen Unterhaltungs- und Quellenauswahlen. Technische Aktivierungen, Titel und Kompaktierung nutzen das lokale Modell ohne HTTP-Anfragen an Anbieter; native Ereignisse und Statistiken können sie dennoch enthalten, während tatsächliche Durchläufe ihre üblichen Modellkosten behalten. Kompaktierung begrenzt den verarbeiteten Kontext bei gleichbleibender Identität der Unterhaltung und des Kalenders. Gespeicherte native Nachrichten und Ereignisse können bis zur ausdrücklichen Bereinigung eines beendeten Zeitplans anwachsen; die 30 aufbewahrten Mission-Ergebnisse sind davon getrennt. Die Tiefeneinstellung und **Zeitplanung** zeigen den Pfad unter **OpenCode-Konfigurationsdatei:**, wenn er verfügbar ist; die Tiefeneinstellung kennzeichnet das **Schreibziel des Projekts** separat.

| Komponente | Bedeutung des Schließens |
| --- | --- |
| CodeNomad-Projekt-Tab | Schließt das Projekt in CodeNomad; native Sitzungen laufen in OpenCode weiter. Öffnen Sie das Projekt erneut, um sie wiederzufinden. |
| Ganzes Fenster, App beenden oder Renderer neu laden | Bewahrt Projektverbindungen für die Wiederherstellung; stoppt weder native Arbeit noch den OpenCode-Dienst. |
| CodeNomad-Backend | Stoppt OpenCode nicht. Eine laufende einmalige Mission läuft weiter: Ihr Koordinator, ihre Aufgaben als native Subagenten und die Missionswerkzeuge laufen in OpenCode. Das Zuweisen von Aufgaben an unabhängige Sitzungen und das Zustellen ihrer Berichte an den Koordinator, vom Koordinator vorbereitete Missionen, das Stoppen der Unterhaltungen einer zurückgezogenen Aufgabe, Wiederherstellung und die Missionszentrale warten auf das Backend, ebenso das Fortsetzen einer einmaligen Mission nach einem OpenCode-Dienstneustart. |
| Aktivierter nativer Zeitplan | Dauerhaft gespeicherte OpenCode-Kalender aktivieren ihr Projekt und führen Durchläufe bei geschlossener CodeNomad-Oberfläche und geschlossenem Backend aus, solange Ausführungshost und Dienst verfügbar sind. |
| OpenCode-Dienstneustart — gesunder nativer Zeitplan | Ein gesunder Zeitplan mit gewünschtem Zustand „Aktiv“ setzt seinen Kalender automatisch fort. Offene Arbeit wird vor einer neuen Zulassung unter ihren ursprünglichen Identitäten abgeglichen. |
| Bestehender täglicher Zeitplan | Seine Plugin-Uhr läuft bei geschlossenem CodeNomad, solange der Dienst läuft. Ein Dienstneustart lässt ihn **Unterbrochen**; ausdrückliches **Fortsetzen** gleicht seinen offenen Lauf ab und aktiviert seine Tagesuhr erneut. |

Bei nativen Zeitplänen behalten ausdrückliches Pausieren, Stoppen, fehlgeschlagene Arbeit und ungewisse Ergebnisse ihre Zulassungssperren nach einem Neustart. Prüfen Sie den aufbewahrten Durchlauf und die ursprüngliche Anfrage; verwenden Sie gegebenenfalls **Durchlauf prüfen** oder **Gespeicherte Anfrage aktualisieren**, dann **Fortsetzen** nur, wenn der Zustand es erlaubt. Eine native Fortsetzung wird unter ihrer bestehenden Identität beobachtet. Ein belegter Fehlschlag oder ein Ende ohne Bericht erfordert menschliche Wiederherstellung; unvollständige Belege halten den Durchlauf ungewiss. Verwenden Sie einen Neustart niemals zum Wiederholen bereits ausgelöster Werkzeugeffekte.

[OpenCode gestartet halten](opencode.md#service-supervision) überwacht den gemeinsamen Dienst auf seinem Ausführungshost separat. Der erste Missionsstart aktiviert dies, sofern Sie nicht Aus gespeichert haben; das Erstellen einer pausierten Mission erhält diese Auswahl. Beim Ausschalten läuft OpenCode ohne automatischen Neustart weiter. Windows, macOS und WSL richten sich nach der Benutzeranmeldung; natives Linux nutzt Linger für Benutzerdienste, abhängig von Berechtigungen. Schlaf, Ruhezustand, die Lebensdauer eines inaktiven WSL und die Steuerung externer Hosts begrenzen die Verfügbarkeit; prüfen Sie den Überwachungszustand unabhängig vom Zeitplan.

Missionen funktionieren mit den Desktop-Apps und mit einem eigenständigen CodeNomad-[Server](server.md). Zeigt das Panel **Missionszentrale ist nicht verfügbar**, nennt seine Meldung die Ursache:

| Ursache | Was zu tun ist |
| --- | --- |
| Der OpenCode-Arbeitsbereich ist nicht bereit | Verbinden Sie das Projekt erneut und aktualisieren Sie dann. |
| OpenCode hat das Missions-Plugin nicht geladen | Aktualisieren Sie nach einem Moment; bleibt es so, verwenden Sie **OpenCode-Konfiguration neu laden** unter **Einstellungen → OpenCode**. |
| OpenCode konnte das Missions-Plugin nicht laden | Lesen Sie dessen Fehler in der Plugin-Liste und aktualisieren Sie nach der Behebung. |
| Der CodeNomad-Server konnte seine lokale Verbindung für Missionen (127.0.0.1) nicht öffnen | Prüfen Sie das Serverprotokoll; OpenCode neu zu laden hilft nicht. |

## Pause, Stop und ungewisse Ergebnisse {#controls-recovery}

1. Wählen Sie den Eintrag und prüfen Sie vor Aktionen aktuellen Zustand und Unterhaltung.
2. Verwenden Sie das Pausensymbol für eine fortsetzbare Unterbrechung oder Stoppsymbol mit Bestätigung für endgültigen Stopp. Einmalige Tooltips lauten **Mission pausieren** und **Mission endgültig stoppen**; Zeitplan-Tooltips nennen den Zeitplan.
3. Verwenden Sie bei unbestätigtem Ergebnis **Status prüfen** / **Steuerungsstatus prüfen**, um das vorhandene Ergebnis zu lesen. Fordern Sie keine Ersatzaktion an, um Ungewissheit zu umgehen.
4. Bei einmaligen Aktionen prüft **Aktualisieren und die unbestätigte Aktion erneut senden** im Kopf zuerst den Zustand und sendet nur genau diese weiterhin unbestätigte Aktion durch Ihren ausdrücklichen Klick erneut.

Einmalige Pause lässt laufende Arbeit zu Ende gehen: Der Koordinator und seine Sub-Agenten schließen ihren aktuellen Schritt ab, beginnen nichts Neues und halten an; das Panel zeigt währenddessen **Wird pausiert: Laufende Schritte werden abgeschlossen.** **Jetzt unterbrechen** hält sie stattdessen sofort an: Es unterbricht die native Missionsfamilie und parkt die Koordination. Stop unterbricht ebenfalls, storniert wartende Familieneingaben/-zustellungen und ist endgültig. Unterbrechungen sind begrenzt: **Einige Sub-Agenten laufen möglicherweise noch.** bedeutet, dass eine unvollständig ist. Prüfen Sie das erhaltene Ergebnis und verwenden Sie dessen ausdrücklichen Wiederholungsversuch, statt den Abbruch aller Shell-/Werkzeugauswirkungen anzunehmen. Fortsetzen informiert den Koordinator darüber, was pausiert oder unterbrochen wurde; er entscheidet über die Fortsetzung der Arbeit.

Bei nativen Zeitplänen schließt **Pausieren** künftige Zulassungen und fordert die Unterbrechung eines zugelassenen Durchlaufs an; **Fortsetzen** gleicht bestehende Arbeit vor der erneuten Aktivierung ab. **Stoppen…** ist endgültig. **Jetzt ausführen** nutzt denselben Schutz für offene Durchläufe und dasselbe Startkontingent und erhält dabei den Kalender. **Durchlauf prüfen** gleicht den ursprünglichen Durchlauf ab. Behalten Sie eine unbestätigte Aktion und verwenden Sie **Gespeicherte Anfrage aktualisieren**; passives Aktualisieren und Wiederverbinden erhalten diese Anfrage. Bereits ausgelöste Werkzeugeffekte können nach einer Unterbrechung weiterlaufen.

Bestehende tägliche Einträge behalten ihre täglichen Steuerelemente Pausieren/Stoppen/Fortsetzen/Jetzt ausführen/Durchlauf prüfen. Pausieren/Stoppen beenden ihre Uhr und fordern die Unterbrechung registrierter Wurzeln einschließlich unabhängiger Spezialisten an. Prüfen Sie deren native Familien und etwaige teilweise Unterbrechungsergebnisse. Vorübergehende tägliche Prüffehler werden mit ihrer angezeigten Warnung wiederholt; eine verlorene Antwort auf eine Benutzersteuerung bleibt an ihre ursprüngliche Anfrage gebunden. Ein gestoppter Eintrag bleibt endgültig gestoppt.

Bei einem einmaligen Koordinator, der ohne Bericht inaktiv ist, kann die primäre ▶-Aktion ihn prüfen und wiederherstellen; Aufgaben bieten gegebenenfalls gezielte Wiederherstellung fehlender Berichte. Wiederherstellung prüft zuerst native Aktivität, Nachfahren und Wartezustände; unbekannte Aktivität verweigert die Annahme. Sie wiederholt keine Zuweisungen und ersetzt keinen Plan. Öffnen Sie Unterhaltungen, um ausstehende Fragen, Berechtigungen, Shells oder Hintergrundarbeit zu klären.

Ist **Erstellen** unbestätigt, behält das Fenster die übermittelte Anfrage und deaktiviert weitere Erstellung für dieses Projekt; Worktree-Löschung kann weiter blockiert bleiben. Aktualisieren liest nur Zustand. Schließen/Öffnen des Editors behebt dies nicht. Prüfen Sie vor dem Fensterneuladen die Missionsliste: Neuladen entfernt die lokale Sperre, ist aber **kein Beweis für fehlgeschlagene Erstellung**. Erstellen Sie nach Neuladen oder Neustart nicht blind ein Duplikat.

## Unterhaltungen bearbeiten, löschen und bereinigen {#cleanup}

Ändern sich Ziel oder Notizen, während das Formular noch lädt, meldet es, dass sich die Mission seit dem Öffnen geändert hat, statt sie einzutragen; wählen Sie **Erneut öffnen**, um die aktuelle Fassung zu bearbeiten.

Zwischen Durchläufen kann ein pausierter oder laufender nativer Zeitplan Titel, Anweisungen, Notizen, angeforderte Profile, Aufgabensitzungsmodus, Quellen, Kalender und Grenzen bearbeiten, sofern kein Durchlauf und keine ungeklärte Steuerung das Objekt sperrt. Ein pausierter Zeitplan bleibt pausiert; ein aktivierter Zeitplan gleicht seinen Kalender vor dem Fortfahren ab. Speichern erhält frühere Ergebnisse, verbrauchte Quellen, Startanzahl und den Ursprung beim ersten Start; unveränderte Endgrenzen behalten ihr absolutes Terminende.

Während eines zugelassenen Durchlaufs folgen nur Anweisungen und Notizen dem Bearbeitungsvertrag aktiver Texte: Änderungen werden im Verlauf und für künftige Durchläufe gespeichert. Bestehende Aufgaben, Aufträge, Profile und Ausführungsidentitäten behalten ihre zugelassenen Werte. Strukturfelder bleiben bis zum Abschluss des Durchlaufs gesperrt, auch nach dem Pausieren. Ein Playbook bleibt gesperrt, sobald eine Aufgabe erstellt wurde, auch wenn diese abgeschlossen oder zurückgezogen ist. Unbestätigte Zulassung/Steuerung oder unvollständige Integritätsbelege halten strukturelle Bearbeitung schreibgeschützt. Erstellen und Bearbeiten prüfen denselben Kalender; die Vorschau berücksichtigt den geänderten letzten erlaubten Termin auch bei der gespeicherten nächsten, eventuell verspäteten Aktivierung.

Die Branchquelle enthält auch lokale Branches ohne Worktree und liest ausschließlich lokale Referenzen. Die Auswahl unterstützt bis zu 200 lokale Branches; bei größeren Beständen wird die Quelle als nicht verfügbar angezeigt. **Starten** und **Fortsetzen** fragen bei verfügbarer Aktivierung nach Zustimmung mit den genauen Konfigurationspfaden. **Jetzt ausführen** bleibt mit Erklärung deaktiviert, solange die native Zeitplanung inaktiv ist; aktivieren Sie `experimental.schedules` in der OpenCode-Konfiguration und aktualisieren Sie anschließend. Bei verlorener Aktivierungsantwort bleibt die ursprüngliche Anfrage zur Belegprüfung erhalten.

Vor dem ersten Play können Sie zum sofortigen, bedingungslosen Start zurückkehren und die verfolgten Unterhaltungen unter **Optionen** behalten. Play liest und fixiert deren vollständiges, stabiles Nachrichtenpräfix (höchstens 32 Nachrichten je Quelle, innerhalb von 16.384 Zeichen für die Starteingabe). Fehlende, verschobene oder zu große Quellen blockieren den Start mit einer Erklärung. Ein erneuter Versuch behält den fixierten Kontext und die ursprüngliche Startidentität.

Bestätigt das Lesen des Belegs eine teilweise Vorbereitung, erscheint **Erneut versuchen**. Der Klick prüft denselben Beleg erneut und setzt ausschließlich die ursprünglich gespeicherte Änderung fort; die Mission bleibt pausiert.

Vor dem ersten Start einer neu vorbereiteten Mission können Sie Titel, Anweisungen, Notizen, Playbook, gewünschte Agenten/Modelle/Denkeinstellungen, Aufgabensitzungsmodus und **Zeitplanung** bearbeiten. Sie können zwischen sofortigem, verzögertem, wiederkehrendem und bedingtem Start wechseln und dabei dieselbe Mission behalten. Speichern hält sie pausiert und bereitet einen neuen, leeren Koordinator vor; die ursprüngliche Unterhaltung bleibt erhalten. Erst Play startet Arbeit oder aktiviert einen Zeitplan. Nach dem Start gelten die Bearbeitungsregeln der aktiven Mission für Anweisungen und Notizen. Bei unbestätigtem Speichern liest **Gespeicherte Anfrage aktualisieren** das ursprüngliche Ergebnis; behalten Sie diese Anfrage, während eine teilweise Vorbereitung Start, Textänderungen und Löschen blockiert.

Verwenden Sie **Ausgewählte Mission bearbeiten** für eine bearbeitbare einmalige Mission oder einen nativen Zeitplan. Beachten Sie die Erklärungen neben gesperrten Feldern. Wählen Sie bei einem Revisionskonflikt **Aktuelle Konfiguration neu laden** und öffnen Sie anschließend **Vorheriger Entwurf zum Vergleich**, um den erhaltenen Entwurf vor dem erneuten Speichern zu prüfen. Bestehende tägliche Zeitpläne behalten die Steuerelemente ihrer eigenen Symbolleiste.

Bei einem nativen Zeitplan deaktiviert **Ausgewählte Mission löschen…** künftige Durchläufe vor dem Entfernen des Eintrags. Unterhaltungen und Ergebnisse bleiben erhalten; auf Abgleich wartende Bereinigung bleibt unter **Technische Details** sichtbar. Behalten Sie eine unbestätigte Löschung und aktualisieren Sie ihre ursprüngliche Anfrage.

1. Wählen Sie für eine nicht mehr benötigte einmalige Mission **Ausgewählte Mission löschen…** und prüfen Sie die Bestätigung.
2. Wählen Sie optional vor dem Bestätigen **Auch die für diese Mission erstellten Fachunterhaltungen löschen**.
3. Prüfen Sie **Gespräche bereinigen** auf entfernt/behalten/offen-Zahlen. Wiederholen Sie gegebenenfalls nur die verbleibende erfasste Bereinigung.

Eine Mission zu löschen ist nicht dasselbe wie sie zu stoppen; verwenden Sie zuerst Stop und prüfen Sie verbleibende Arbeit. Koordinatoren und wiederverwendete Unterhaltungen bleiben erhalten. Auch geteilte, verschobene oder nicht nachweislich zugehörige Spezialisten-Unterhaltungen sowie solche mit Untersitzungen können erhalten bleiben. Teilbereinigung wird nicht zurückgerollt und nicht stillschweigend im Hintergrund abgeschlossen. Die Missionskarte kann verschwinden, während die Bestätigung der Löschung noch aussteht, auch wenn die Gesprächsbereinigung 0 ausstehende Ziele anzeigt. Verwenden Sie weiterhin die ursprüngliche Aktion **Erneut versuchen**, bis die Löschung bestätigt ist; dabei bleiben derselbe Löschauftrag und dieselben Optionen erhalten. Die Übersicht behält die 20 zuletzt abgeschlossenen Bereinigungen. Gelöschte Missionen geben ihren Speicher im Projekt frei: Ältere gelöschte Missionen werden automatisch entfernt.

Siehe [Berechtigungen](permissions.md), [Unterhaltungen](conversations.md) und [OpenCode-Einrichtung](opencode.md) für native Arbeit und Dienststeuerung.
