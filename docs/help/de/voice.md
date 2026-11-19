# Spracheingabe und Wiedergabe

## Sprach-API konfigurieren {#configure}

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

Dies sind Anfragen an den konfigurierten Dienst, keine Garantie, dass jeder kompatible Endpunkt jedes Modell, jede Stimme oder jedes Format implementiert.

## Ein- und Ausgabe testen {#test}

1. Speichern Sie zuerst Änderungen an Endpunkt, Schlüssel, Modell und Stimme.
2. Wählen Sie **Eingabe testen**, erlauben Sie Mikrofonzugriff, sprechen Sie und wählen Sie **Aufnahme stoppen**. Prüfen Sie die zurückgegebene Transkription.
3. Wählen Sie **Wiedergabe testen**, um das Beispiel zu hören; **Beispiel stoppen** beendet es.

Der Wiedergabetest verwendet gewählten Modus/Format sofort, aber Endpunkt, Schlüssel, Modell und Stimme aus gespeicherten Einstellungen. Eingabetests senden keinen Unterhaltungsprompt. Tests senden dennoch Audio/Text an den konfigurierten Sprachanbieter und können Kosten verursachen.

## Prompt diktieren {#dictate}

1. Lassen Sie **Prompt-Spracheingabe** unter **Sprache** aktiviert (standardmäßig eingeschaltet).
2. Wählen Sie im Eingabefeld **Weitere Aktionen → Diktieren** und erlauben Sie den Mikrofonzugriff. Erscheint **Diktieren: Einstellungen für Sprache öffnen**, wählen oder konfigurieren Sie dort die Engine und kehren Sie zum Entwurf zurück.
3. Wählen Sie **Aufnahme stoppen und transkribieren** für den Text oder **Diktat abbrechen**, um die Aufnahme zu verwerfen. Ein Gesprächswechsel oder das Schließen des Eingabefelds bricht das Diktat ebenfalls ab.
4. Prüfen Sie den Text. Er ersetzt die ursprüngliche Auswahl nur, wenn Entwurf und Auswahl unverändert sind. Andernfalls wählen Sie **Transkription einfügen** oder **Transkription verwerfen**. Beim Diktieren wird nichts gesendet.

Wenn die API unter Linux mit Tauri auf WAV ausweicht, endet die Aufnahme beim Diktieren und beim Eingabetest nach 24 Sekunden. Der Ausschnitt bleibt auf diesem Gerät, bis Sie ihn mit **Transkribieren** an den Sprachanbieter senden oder mit **Abbrechen** verwerfen.

### Desktop-Engine auswählen {#desktop-dictation}

Wählen Sie in den lokalen **Einstellungen → Sprache** der Desktop-App die **Diktier-Engine auf diesem Gerät**. Die Wahl gilt für alle Projekte auf diesem Gerät; die Karte **Sprache** konfiguriert weiterhin die API des verbundenen Servers. Browser und Mobilgeräte verwenden den konfigurierten API-Anbieter und benötigen für den Mikrofonzugriff einen sicheren Kontext.

- Die **Lokale System-Spracherkennung** läuft in CodeNomad, ohne das Diktierfenster des Betriebssystems zu öffnen. Unter Windows oder macOS muss ein lokaler Erkenner für die App-Sprache installiert sein. Unter Linux oder wenn Erkenner oder Sprache fehlen, versuchen Sie Hex, sofern es angeboten wird.
- Unter Sprache sehen Sie vorab, was Hex noch benötigt und wie groß der Download je Komponente und insgesamt ist. Ein Klick auf **Hex aktivieren** prüft kompatible Dateien, verwendet sie wieder, lädt Fehlendes und wählt das fertige Hex aus. Verfolgen Sie den Fortschritt dort; nutzen Sie **Hex-Aktivierung abbrechen** oder, wenn angeboten, **Hex-Aktivierung fortsetzen**. Bei Fehler oder Abbruch bleibt die bisherige Engine ausgewählt. Das Öffnen der Einstellungen, die Auswahl von bereits einsatzbereitem **Hex (lokal)** und das Diktieren lösen keinen Download aus.
- Hex wird für kompatible Geräte angeboten: Windows x64/arm64, Apple Silicon ab macOS 15 und Linux x64/arm64 mit glibc ab 2.36 und den von Hex benötigten Bibliotheken. Intel-Macs und Linux mit älterer glibc oder musl sind inkompatibel. Engine und Modelle sind nicht Teil des CodeNomad-Installers; ein Terminal oder API-Schlüssel ist nicht nötig.

Ubuntu 24.04 erfüllt die glibc-Anforderung, Ubuntu 22.04 hingegen nicht. Hex erkennt die gesprochene Sprache aus den [von Parakeet unterstützten Sprachen](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), darunter Englisch und Französisch. Diese Liste ist unabhängig von der App-Sprache.

Die lokale Erkennung nutzt das Mikrofon dieses Geräts und funktioniert offline, auch für WSL-Projekte in der lokalen App. In einem kompatiblen Remote-Fenster öffnet **Diktieren** das lokale Fenster **Auf diesem Gerät diktieren**. Prüfen Sie das angezeigte Ziel und wählen Sie **Spracheingabe starten**, **Aufnahme stoppen und transkribieren** und **Transkription einfügen**. Nur der Text kehrt in den Entwurf zurück. Das Remote-Projekt braucht weiterhin seine Serververbindung.

In einem Tauri-Fenster für einen entfernten Server unter Linux prüft **Eingabe testen** die Sprach-API des Servers, ohne die Diktat-Engine zu ändern. Prüfen Sie vor jeder API-Aufnahme die Serveradresse im nativen Mikrofondialog und bestätigen Sie die Aufnahme. Die Aufnahme nutzt PulseAudio oder den PulseAudio-Dienst von PipeWire und hat immer das oben beschriebene WAV-Limit von 24 Sekunden.

## Nachrichten vorlesen {#playback}

1. Verwenden Sie **Nachricht vorlesen** an einer Nachricht oder dieselbe Aktion an einem Werkzeugaufruf, wenn TTS verfügbar ist.
2. Verwenden Sie **Wiedergabe stoppen** an derselben Steuerung, um sie zu beenden; eine andere Wiedergabe zu starten stoppt die laufende.
3. Ändern Sie gespeicherte Stimme, Modell, Modus oder Format unter **Sprache** für spätere Anfragen.

Wiedergabe verwendet CodeNomads Textprojektion, keinen vorgelesenen Screenshot: Binär-/Bildbytes und Berechtigungsbelege sind kein Sprachinhalt. Sie führt keinen Prompt aus und ändert nicht das ausgewählte OpenCode-Modell.

Verwenden Sie für automatische Unterhaltungssprache **Konversationsmodus aktivieren** im Menü **Weitere Aktionen** des Eingabefelds; er gilt für diesen Projekt-Tab und bleibt nach einem Neuladen nicht erhalten. Solange er aktiv ist, bittet CodeNomad den Agenten mit jedem gesendeten Prompt, seine Antwort mit einer kurzen Zusammenfassung in einem Markdown-Codeblock mit der Kennzeichnung `spoken` zu beginnen. Nur dieser abgeschlossene Block wird vorgelesen, in der aktiven Hauptsitzung; es ist kein automatisches Vorlesen jeder Antwort oder jedes Subagenten. **Konversationsmodus deaktivieren** stoppt dessen Warteschlange und fordert die Zusammenfassung nicht mehr an. Mikrofonstart stoppt ebenfalls aktive Unterhaltungssprache. Der Gesprächsmodus benötigt eine konfigurierte Wiedergabe mit einem unterstützten Format.

## Datenfluss und Datenschutz {#privacy}

Beim lokalen Diktieren bleibt Audio auf dem Gerät, ohne Wechsel zur API. Mit dem **API-Anbieter** geht es über das CodeNomad-Backend zum konfigurierten STT-Endpunkt. Zur Synthese ausgewählter Text geht durch dieses Backend zum TTS-Endpunkt; zurückgegebenes Audio spielt auf dem Client. API-Schlüssel bleiben serverseitig und werden nicht als gespeicherte Werte an das Einstellungsformular zurückgegeben.

Verwenden Sie einen Endpunkt, dem Sie das diktierte oder vorgelesene Material anvertrauen. OpenCode-Zugangsdaten autorisieren Sprache nicht automatisch. Eine Schlüssel- oder Endpunktänderung betrifft künftige Anfragen, nicht bereits gesendete Daten. Lesen Sie vor Serverfreigabe an andere Nutzer [Sicherheit](security.md).
