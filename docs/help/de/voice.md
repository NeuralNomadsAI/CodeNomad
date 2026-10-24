# Spracheingabe und Wiedergabe

## Sprache konfigurieren {#configure}

1. Öffnen Sie **Einstellungen → Sprache**. Die Karte **Sprache** verwendet einen OpenAI-kompatiblen serverseitigen Adapter, unabhängig vom Modellanbieter Ihrer Unterhaltung.
2. Geben Sie **API-Schlüssel**, optional **Basis-URL**, **Transkriptionsmodell**, **Sprachmodell (TTS)** und **Standardstimme** ein.
3. Benötigen Ein- und Ausgabe verschiedene Dienste, aktivieren Sie **Getrennte Anbieter für Ein- und Ausgabe** und füllen Sie Schlüssel-, Basis-URL- und Modellfelder für Ein-/Ausgabe aus.
4. Wählen Sie **Wiedergabemodus** und **Ausgabeformat**, dann **Speichern** (verfügbar, solange Änderungen ungespeichert sind). Prüfen Sie vor Tests den Status neben den Testschaltflächen, **Konfiguriert**, **Teilweise konfiguriert** oder **API-Schlüssel fehlt**; ein fehlgeschlagenes Speichern zeigt **Speichern fehlgeschlagen**.

Spracheinstellungen und Schlüssel gehören zur verbundenen CodeNomad-Serverkonfiguration, nicht zum ausgewählten Projekt oder zur OpenCode-Anbieterverbindung. Andere Clients derselben Konfiguration verwenden sie ebenfalls. Gespeicherte Schlüssel sind verborgen: Ein leeres Schlüsselfeld behält den Wert; **Gespeicherten Schlüssel löschen** merkt dessen Entfernung beim Speichern vor. Eine Richtung ohne eigenen Endpunkt und Schlüssel kann gemeinsame Einstellungen nutzen; ein separater Endpunkt braucht einen eigenen Schlüssel, ein separater Schlüssel seinen Endpunkt. Geben Sie bei Endpunktänderung ausdrücklich den vorgesehenen Schlüssel an und prüfen Sie die gespeicherte Konfiguration; Endpunktänderungen löschen den gespeicherten Schlüssel dieses Platzes, statt ihn an einen anderen Host zu senden.

Das Backend kann außerdem `OPENAI_API_KEY` und `OPENAI_BASE_URL` als gemeinsame Vorgaben verwenden. Gespeicherte Schlüssel zu löschen entfernt keine Umgebungszugangsdaten; ändern Sie zum Entfernen dieses Rückfalls die Backend-Umgebung und starten Sie es neu.

| Einstellung | Bedeutung / Standard |
| --- | --- |
| Basis-URL | OpenAI-kompatible API-Wurzel, Standard `https://api.openai.com/v1`. Eingabe verwendet `audio/transcriptions`, Ausgabe `audio/speech`. |
| Transkriptionsmodell / Eingabemodell | Vom STT-Endpunkt akzeptiertes Modell; Standard `gpt-4o-mini-transcribe`. |
| Sprachmodell (TTS) / Ausgabemodell | Vom TTS-Endpunkt akzeptiertes Modell; Standard `gpt-4o-mini-tts`. |
| Standardstimme | Anbieter-Stimmenkennung; Standard `alloy`. Keine OS-Stimmenauswahl. |
| Streaming | Standard. Beginnt Wiedergabe beim Eintreffen von Audio, sofern Anbieter/Browser das gewählte Format unterstützen. |
| Gepuffert | Wartet vor Wiedergabe auf die vollständige Audioantwort. |
| Ausgabeformat | `mp3`, `wav`, `opus` oder `aac`; Standard `mp3`. Kompatibilität variiert nach Browser/Anbieter. |

Dies sind Anfragen an den konfigurierten Dienst, keine Garantie, dass jeder kompatible Endpunkt jedes Modell, jede Stimme oder jedes Format implementiert. Fehlgeschlagenes Speichern zeigt einen Fehler; prüfen Sie die Konfiguration vor weiteren Änderungen.

## Ein- und Ausgabe testen {#test}

1. Speichern Sie zuerst Änderungen an Endpunkt, Schlüssel, Modell und Stimme.
2. Wählen Sie **Eingabe testen**, erlauben Sie Mikrofonzugriff, sprechen Sie und wählen Sie **Aufnahme stoppen**. Prüfen Sie die zurückgegebene Transkription.
3. Wählen Sie **Wiedergabe testen**, um das Beispiel zu hören; **Beispiel stoppen** beendet es.

Der Wiedergabetest verwendet gewählten Modus/Format sofort, aber Endpunkt, Schlüssel, Modell und Stimme aus gespeicherten Einstellungen. Eingabetests senden keinen Unterhaltungsprompt. Tests senden dennoch Audio/Text an den konfigurierten Sprachanbieter und können Kosten verursachen.

Scheitert Streaming, wählen Sie **Gepuffert**, versuchen `mp3`, speichern und testen erneut. „Konfiguriert“ bestätigt Einstellungen, nicht erfolgreiche Anbieterauthentifizierung oder Codec-Wiedergabe. Prüfen Sie vor Wiederholung Endpunkterreichbarkeit vom Server-Host, Modell-/Stimmennamen und Kontingent.

## Prompt diktieren {#dictate}

1. Lassen Sie **Prompt-Spracheingabe** unter **Sprache** aktiviert (standardmäßig eingeschaltet).
2. Öffnen Sie im Eingabefeld **Weitere Aktionen**, wählen Sie **Spracheingabe starten** und erlauben Sie Mikrofonzugriff auf diesem Gerät.
3. Wählen Sie nach dem Sprechen im selben Menü **Aufnahme stoppen und transkribieren**; während der Verarbeitung erscheint **Audio wird transkribiert**.
4. Prüfen und bearbeiten Sie den eingefügten Text, bevor Sie den Prompt normal senden.

Transkription fügt Text an der aktuellen Auswahl ein; sie sendet ihn nicht automatisch an OpenCode. Der Menüeintrag erscheint nur bei konfigurierter STT und unterstützter Aufnahme im Client. Die Aufnahme verwendet das Mikrofon des Client-Geräts, auch bei CodeNomad auf einem Remote-Server.

Prüfen Sie bei fehlendem Eintrag Schalter und STT-Konfiguration. Erlauben Sie bei Berechtigungsfehlern das Mikrofon in Browser- und OS-Datenschutzeinstellungen. Entfernte Browseraufnahme benötigt sicheren Kontext, normalerweise vertrauenswürdiges HTTPS; siehe [Mobiler Zugriff](mobile.md) und [Direkter Fernzugriff](remote-access.md). Wegwechseln oder Schließen des Eingabefelds beendet dessen Aufnahmelebenszyklus; verlassen Sie sich nicht auf wiederherstellbares ungesendetes Audio. Ihr getippter Entwurf bleibt der Ort zur Ergebnisprüfung.

## Nachrichten vorlesen {#playback}

1. Verwenden Sie **Nachricht vorlesen** an einer Nachricht oder dieselbe Aktion an einem Werkzeugaufruf, wenn TTS verfügbar ist.
2. Verwenden Sie **Wiedergabe stoppen** an derselben Steuerung, um sie zu beenden; eine andere Wiedergabe zu starten stoppt die laufende.
3. Ändern Sie gespeicherte Stimme, Modell, Modus oder Format unter **Sprache** für spätere Anfragen.

Wiedergabe verwendet CodeNomads Textprojektion, keinen vorgelesenen Screenshot: Binär-/Bildbytes und Berechtigungsbelege sind kein Sprachinhalt. Sie führt keinen Prompt aus und ändert nicht das ausgewählte OpenCode-Modell. Browser-Audiounterstützung und Anbieterantworten können Wiedergabe auch bei auswählbarem Format verhindern.

Verwenden Sie für automatische Unterhaltungssprache **Konversationsmodus aktivieren** im Menü **Weitere Aktionen** des Eingabefelds; er gilt für diesen Projekt-Tab und bleibt nach einem Neuladen nicht erhalten. Solange er aktiv ist, bittet CodeNomad den Agenten mit jedem gesendeten Prompt, seine Antwort mit einer kurzen Zusammenfassung in einem Markdown-Codeblock mit der Kennzeichnung `spoken` zu beginnen. Nur dieser abgeschlossene Block wird vorgelesen, in der aktiven Hauptsitzung; es ist kein automatisches Vorlesen jeder Antwort oder jedes Subagenten. **Konversationsmodus deaktivieren** stoppt dessen Warteschlange und fordert die Zusammenfassung nicht mehr an. Mikrofonstart stoppt ebenfalls aktive Unterhaltungssprache. Der Schalter erscheint mit Spracheingabe oder bei bereits aktivem Konversationsmodus und benötigt zum Aktivieren funktionierendes TTS.

## Datenfluss und Datenschutz {#privacy}

Mikrofonaudio geht vom Client zum CodeNomad-Backend und dann zum konfigurierten STT-Endpunkt. Zur Synthese ausgewählter Text geht durch dieses Backend zum TTS-Endpunkt; zurückgegebenes Audio spielt auf dem Client. API-Schlüssel bleiben serverseitig und werden nicht als gespeicherte Werte an das Einstellungsformular zurückgegeben.

Verwenden Sie einen Endpunkt, dem Sie das diktierte oder vorgelesene Material anvertrauen. Dies garantiert keine Offline-Transkription, und OpenCode-Zugangsdaten autorisieren Sprache nicht automatisch. Stoppen Sie Aufnahme/Wiedergabe anschließend; Schlüssel-/Endpunktänderung betrifft künftige Anfragen, nicht bereits an Anbieter gesendete Daten. Lesen Sie vor Serverfreigabe an andere Nutzer [Sicherheit](security.md).
