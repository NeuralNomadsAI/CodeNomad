# Missionen

Missionen verbinden einen dauerhaften Projektplan mit nativen OpenCode-Unterhaltungen. Der Koordinator plant und delegiert; der Aufgabenbaum erfasst Abhängigkeiten und Ergebnisse. Ein gespeicherter Plan, eine angenommene Eingabe und beobachtete Ausführung sind unterschiedliche Tatsachen.

## Erstellen, dann ausdrücklich starten {#create}

1. Öffnen Sie **Missionen** im rechten Panel und wählen Sie **Mission erstellen**.
2. Füllen Sie **Was soll die Mission tun?** aus und prüfen Sie **Titel**, der aus dem ersten Satz vorbelegt wird (bis 60 Zeichen).
3. Wählen Sie unter **Wann** entweder **Einmal** oder **Täglich um**. Prüfen Sie für tägliche Arbeit die angezeigte Zeitzone; **Ändern** erlaubt eine IANA-Zone.
4. Klappen Sie **Optionen** für **Playbook**, **Notizen**, **Agenten und Modelle**, **Aufgabensitzungen**, gespeicherte Aufträge und optional verfolgte Unterhaltungen auf.
5. Wählen Sie **Erstellen**. Wählen Sie den neuen Eintrag und verwenden Sie bei Bereitschaft die separate ▶-Aktion: **Mission starten** für einmalige Arbeit oder **Zeitplan {id} starten** für einen täglichen Zeitplan.

**Erstellen startet niemals Arbeit.** Eine einmalige Mission ist vorbereitet; ein täglicher Zeitplan pausiert. Weder Erstellen noch das Speichern eines Auftrags aktiviert einen Timer. Die Erstellung gilt für das ausgewählte Projekt/die Location und friert angeforderte Profile sowie die Aufgabensitzungsrichtlinie ein. Validierung steht neben dem betroffenen Feld; eine Verweigerung mit dem Hinweis, dass nichts gesendet wurde, lässt den Entwurf zur Korrektur verfügbar.

### Playbooks {#playbooks}

| Playbook | Vorgesehene Arbeit |
| --- | --- |
| Flexible Mission | Koordinator wählt einen abhängigkeitsbewussten Plan für das Ziel. |
| Fehlerbehebung | Diagnose, Implementierung, getrennte Prüfung von Standards/Spezifikation und frische Validierung; die weitere Fehlerbehebung setzt die Arbeit in der bestehenden Implementierer-Unterhaltung fort. |
| Erkundung | Erfasst Unsicherheiten und arbeitet begrenzte Entscheidungen mit menschlichen Rückfragen ab. |
| Produktauslieferung | Koordiniert Produktanalyse, Architektur, Implementierung und Qualitätsrollen. |

Das Playbook leitet die Koordination; es umgeht keine nativen Berechtigungen und garantiert keinen Erfolg. Beantworten Sie Entscheidungsfragen der Erkundung über CodeNomads Unterbrechungsdock, damit eine ausdrückliche UI-Antwort erfasst wird, statt einen Agenten um vorgetäuschte Zustimmung zu bitten.

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
| Braucht Sie | Ein offenes natives Form/eine Frage oder Berechtigung benötigt eine Antwort. |
| Erledigt | Ein Aufgabenergebnis wurde erfasst; prüfen Sie dessen Belege und verbleibende native Arbeit. |

Der Graph enthält abgeschlossene und zurückgezogene Arbeit. Eine Aufgabe zurückzuziehen stoppt nicht von selbst deren Unterhaltung. **In Arbeit** ist der Lebenszykluszustand der Mission, kein Beweis, dass der Koordinator gerade läuft. Vollständiger Text gehört in die zentrale Leseansicht, nicht die Aufgabenliste des Panels; **Technische Details** klappt Kennungen und angeforderte Ausführungsinformationen ein.

### Lageberichte und Aktualisierungsanfragen {#briefings}

Der Koordinator erhält die Anweisung, nach dem ersten Plan, nach Aufgabenerledigungen, beim Warten auf Menschen und vor dem Abschlussbericht einen Projektlagebericht zu veröffentlichen. Dies ist eine verfasste Einschätzung, kein Live-Aktivitätszähler oder garantierter periodischer Heartbeat. Ein Hinweis kennzeichnet Änderungen der Karte seit dem Lagebericht.

Verwenden Sie **Update anfordern** unter der Symbolleiste für eine neue Koordinatoreinschätzung und lesen Sie dann **Zusammenfassung**. **Update angefordert…** bedeutet wartend, nicht beantwortet. **Zustellung unbestätigt** erlaubt kein automatisches erneutes Senden: Öffnen Sie die Koordinatorunterhaltung vor einer separaten neuen Anfrage. Dies ist normale native Eingabe, keine schreibgeschützte Sandbox; der Koordinator behält seine normalen Rechte.

## Profile, Delegation und Tiefe {#profiles}

1. Verwenden Sie das Missionszahnrad oder **Einstellungen → Missionen**, um **Vorgaben für neue Missionen** zu bearbeiten.
2. Wählen Sie globale Vorgaben und Playbook-Ausnahmen, dann **Speichern**. Verwenden Sie beim Erstellen **Optionen → Agenten und Modelle** für bestimmte angeforderte Profile.
3. Wählen Sie **Aufgabensitzungen** unabhängig vom **Playbook**.
4. Verwenden Sie für native Rekursionsgrenzen separat **OpenCode-Tiefe → Maximale Tiefe → Tiefe dieses Orts speichern**.

| Einstellung | Geltungsbereich und Wirkung |
| --- | --- |
| Vorgaben für neue Missionen | Konfigurationsweite Vorgaben nur für **neue** Missionen; eine Playbook-Ausnahme übersteuert den allgemeinen Standard. |
| Agent / Modell / Denken | Bei Erstellung erfasste Koordinator-/Rollenauswahl; ein beschäftigter Akteur wird für spätere Arbeit nicht stillschweigend umgestellt. Tägliche Läufe verwenden ihre eingefrorenen angeforderten Profile erneut. |
| Native Subagenten | Aufgabensitzungen verwenden native subagent/all-Agenten unter dem Koordinator. |
| Unabhängige Sitzungen | Erklärte Aufgabensitzungen verwenden primary/all-Agenten und unabhängige Unterhaltungen; dies deaktiviert keine internen nativen Helfer. |
| OpenCode-Tiefe | Location-/Projektkonfiguration für **alle** dortigen Unterhaltungen, nicht nur Missionen. Leer bedeutet Vererbung. Speichern lädt OpenCode nicht neu und ändert keine laufenden Unterhaltungen. |

**Nativer Standard** und **Globale Standardwerte übernehmen** unterscheiden sich: Ersteres fordert native Standards an, Letzteres nutzt das konfigurierte globale Profil. Katalogverfügbarkeit wird geprüft; ein angefordertes Profil beweist nicht das aktuell verwendete Profil einer Unterhaltung. Native Berechtigungen und konfigurierte Tiefe regeln interne Helferaufrufe weiterhin in beiden Aufgabenmodi.

Ist das Speichern von Vorgaben/Tiefe unbestätigt, behalten Sie den Entwurf und verwenden Sie **Neu laden** für Vorgaben oder **Tiefe dieses Orts aktualisieren** vor einer weiteren Änderung. Interpretieren Sie **Effektive Tiefe unbekannt** nicht als null oder deaktiviert.

## Gespeicherten Auftrag wiederverwenden {#saved-briefs}

1. Öffnen Sie beim Erstellen **Optionen → Mit einem gespeicherten Auftrag beginnen** und wählen Sie den Auftrag.
2. Prüfen Sie vor **Erstellen** das kopierte Ziel, Notizen, Playbook, Profile und Delegation.
3. Verwenden Sie **Als Auftrag speichern**, um einen wiederverwendbaren Entwurf zu benennen. Auch eine ausgewählte einmalige Mission, einschließlich abgeschlossener, bietet **Als Auftrag speichern**.

Aufträge speichern Anweisungen und angeforderte Auswahl, keine Aufgabenpläne, Ergebnisse, Unterhaltungen, Zeitplanuhren oder Ausführungsbefugnis. Laden füllt einen normalen Erstellungsentwurf; es startet oder plant nichts. Entfernen eines Auftrags behält bestehende Missionen/Unterhaltungen. **Einstellungen → Missionen → Gespeicherte Aufträge** verwaltet die Bibliothek; ein ausdrückliches Zurücksetzen entfernt gespeicherte Aufträge, keine Ausführungen. Zeitpläne selbst haben keine Aktion zum Speichern als Auftrag.

## Tägliche Zeit, Nachholen und verfolgte Unterhaltungen {#daily-schedules}

Tägliche Zeitpläne verwenden die gespeicherte IANA-Zeitzone und Ortszeit, kein verstrichenes 24-Stunden-Intervall. Zeiten werden in der Zeitplanzone angezeigt und bei Abweichung von der Betrachterzone gekennzeichnet. Jeder Lauf erhält eigenen Koordinator und isolierte Missionskarte; der ausgewählte Zeitplan zeigt aktuellen Aufgabenbaum und Datums-/Ergebnisverlauf. Wählen Sie einen vergangenen Lauf zur zentralen Anzeige. Der Verlauf ist auf 30 Ergebnisse begrenzt.

| Situation | Planungsverhalten |
| --- | --- |
| Mehrere verpasste Fälligkeitstage | Führt nur den jüngsten fälligen Tag nach der erledigten Tagesmarkierung aus, nicht jeden verpassten Tag. |
| Lücke bei Zeitvorstellung | Geht zur ersten späteren gültigen Minute weiter; eine Lücke am Tagesende überschreitet die Tagesgrenze. |
| Wiederholte Uhrstunde | Verwendet das erste Auftreten; erzeugt keinen zweiten Tageslauf. |
| Vollständig übersprungener Kalendertag | Für diesen Tag existiert kein Lauf. |
| Uhr wird zurückgestellt | Macht einen bereits verarbeiteten Tag nicht erneut fällig. |
| Vorhandener Lauf noch offen | Überschneidet ihn nicht mit einem neuen Tageslauf. |

Auch die Erstellungszeit begrenzt zulässige tägliche Arbeit; der Start eines neuen Zeitplans erlaubt keine Verarbeitung von Daten vor seiner Existenz. **Jetzt ausführen** startet, soweit angeboten, einen separaten manuellen Lauf; es ersetzt weder die Tagesuhr noch umgeht es einen offenen Lauf. Eine angezeigte nächste Zeit ist eine Projektion, keine Garantie minutengenauer Ausführung.

**Verfolgte Gespräche (optional)** ergänzt begrenzten Kontext aus ausgewählten Unterhaltungen. Nur ein abgeschlossener Lauf bewegt deren verarbeitete Nachrichtenzeiger vor; fehlgeschlagene/unterbrochene Läufe verbrauchen diesen Kontext nicht stillschweigend. Überschreiten Anweisungen plus Kontext die Kapazität, kürzen Sie Anweisungen oder entfernen Sie verfolgte Unterhaltungen, statt unbegrenzt gelesenen Verlauf anzunehmen.

## Lebensdauer und Dienstneustarts {#lifetime}

| Komponente | Bedeutung des Schließens |
| --- | --- |
| CodeNomad-Tab/-Fenster | Trennt die Ansicht; stoppt weder native Arbeit noch OpenCode-Dienst. |
| CodeNomad-Backend | Stoppt OpenCode nicht. Einmalige CodeNomad-Koordination hängt von der Backend-Präsenz ab; nehmen Sie keine weitere Verfügbarkeit neuer einmaliger Vergaben/Steuerung bei geschlossenem Backend an. |
| Laufender täglicher Zeitplan | Uhr und Durchlauf laufen im OpenCode-Plugin/-Dienst, auch bei geschlossener CodeNomad-Oberfläche und Backend. Ausführungshost und OpenCode-Dienst müssen weiterlaufen. |
| OpenCode-Dienstneustart | Verliert prozesslokale Zeitplanjobs. Ein auf laufend gesetzter Zeitplan wird **Unterbrochen** bis zu einem ausdrücklichen **Fortsetzen**; erneutes Öffnen von CodeNomad aktiviert ihn nicht wieder. |

Prüfen Sie nach einem Neustart den offenen Lauf und wählen Sie bei Bereitschaft **Fortsetzen**. Dies gleicht den vorhandenen Lauf ab, ohne die Koordinatoreingabe doppelt zu senden; es garantiert keine Fortsetzung eines unterbrochenen nativen Turns. Ein durch Neustart abgeschnittener Turn kann ohne Bericht enden, mit **Durch Neustart unterbrochen**. Verwenden Sie Neustarts nicht zum Wiederholen von Werkzeugnebenwirkungen.

## Pause, Stop und ungewisse Ergebnisse {#controls-recovery}

1. Wählen Sie den Eintrag und prüfen Sie vor Aktionen aktuellen Zustand und Unterhaltung.
2. Verwenden Sie das Pausensymbol für eine fortsetzbare Unterbrechung oder Stoppsymbol mit Bestätigung für endgültigen Stopp. Einmalige Tooltips lauten **Mission pausieren** und **Mission endgültig stoppen**; Zeitplan-Tooltips nennen den Zeitplan.
3. Verwenden Sie bei unbestätigtem Ergebnis **Status prüfen** / **Steuerungsstatus prüfen**, um das vorhandene Ergebnis zu lesen. Fordern Sie keine Ersatzaktion an, um Ungewissheit zu umgehen.
4. Bei einmaligen Aktionen prüft **Aktualisieren und die unbestätigte Aktion erneut senden** im Kopf zuerst den Zustand und sendet nur genau diese weiterhin unbestätigte Aktion durch Ihren ausdrücklichen Klick erneut.

Einmalige Pause unterbricht die native Missionsfamilie und parkt die Koordination; Stop storniert zusätzlich wartende Familieneingaben/-zustellungen und ist endgültig. Diese Vorgänge sind begrenzt: **Einige Sub-Agenten laufen möglicherweise noch.** bedeutet unvollständigen Stopp. Prüfen Sie das erhaltene Ergebnis und verwenden Sie dessen ausdrücklichen Wiederholungsversuch, statt den Abbruch aller Shell-/Werkzeugauswirkungen anzunehmen. Fortsetzen informiert den Koordinator über unterbrochene Nachfahren; er muss über die Fortsetzung der Arbeit entscheiden.

Tägliche Pause/Stop beenden die Planung und fordern die Unterbrechung registrierter Wurzelakteure einschließlich Koordinator und unabhängiger Spezialisten an, **beweisen aber nicht, dass diese Unterhaltungen oder ihre Nachfahren gestoppt wurden**. Prüfen Sie die nativen Familien. Stop ist endgültig: Ein gestoppter Zeitplan kann weder gestartet noch fortgesetzt noch sofort ausgeführt werden. **Durchlauf prüfen** gleicht einen offenen Lauf ab, ohne erneut zu senden. Vorübergehende geplante Prüffehler zeigen den letzten Fehler und werden automatisch wiederholt; eine verlorene Benutzersteuerungsantwort verursacht kein automatisches erneutes Senden der Steuerung.

Bei einem einmaligen Koordinator, der ohne Bericht inaktiv ist, kann die primäre ▶-Aktion ihn prüfen und wiederherstellen; Aufgaben bieten gegebenenfalls gezielte Wiederherstellung fehlender Berichte. Wiederherstellung prüft zuerst native Aktivität, Nachfahren und Wartezustände; unbekannte Aktivität verweigert die Annahme. Sie wiederholt keine Zuweisungen und ersetzt keinen Plan. Öffnen Sie Unterhaltungen, um ausstehende Fragen, Berechtigungen, Shells oder Hintergrundarbeit zu klären.

Ist **Erstellen** unbestätigt, behält das Fenster die übermittelte Anfrage und deaktiviert weitere Erstellung für dieses Projekt; Worktree-Löschung kann weiter blockiert bleiben. Aktualisieren liest nur Zustand. Schließen/Öffnen des Editors behebt dies nicht. Prüfen Sie vor dem Fensterneuladen die Missionsliste: Neuladen entfernt die lokale Sperre, ist aber **kein Beweis für fehlgeschlagene Erstellung**. Erstellen Sie nach Neuladen oder Neustart nicht blind ein Duplikat.

## Unterhaltungen bearbeiten, löschen und bereinigen {#cleanup}

Verwenden Sie **Ausgewählte Mission bearbeiten** für eine bearbeitbare einmalige Mission; schließen/öffnen Sie bei Konflikten den Editor, um die aktuelle Revision zu laden, statt sie zu überschreiben. Tägliche Zeitpläne bieten keine Bearbeiten-/Löschen-Steuerung.

1. Wählen Sie für eine nicht mehr benötigte einmalige Mission **Ausgewählte Mission löschen…** und prüfen Sie die Bestätigung.
2. Wählen Sie optional vor dem Bestätigen **Auch die für diese Mission erstellten Fachunterhaltungen löschen**.
3. Prüfen Sie **Gespräche bereinigen** auf entfernt/behalten/offen-Zahlen. Wiederholen Sie gegebenenfalls nur die verbleibende erfasste Bereinigung.

Eine Mission zu löschen ist nicht dasselbe wie sie zu stoppen; verwenden Sie zuerst Stop und prüfen Sie verbleibende Arbeit. Koordinatoren und wiederverwendete Unterhaltungen bleiben erhalten. Auch geteilte, verschobene oder nicht nachweislich zugehörige Spezialisten-Unterhaltungen sowie solche mit Untersitzungen können erhalten bleiben. Teilbereinigung wird nicht zurückgerollt und nicht stillschweigend im Hintergrund abgeschlossen. Abgeschlossener Bereinigungsverlauf bleibt in der Übersicht verfügbar.

Siehe [Berechtigungen](permissions.md), [Unterhaltungen](conversations.md) und [OpenCode-Einrichtung](opencode.md) für native Arbeit und Dienststeuerung.
