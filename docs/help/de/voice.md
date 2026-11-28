# Diktat, Wiedergabe und Sprachgespräch

## Sprache einrichten {#configure}

Öffnen Sie **Einstellungen → Sprache**. Die Karten **Diktat**, **Wiedergabe** und **Gespräch** zeigen jeweils ihren Status.

1. Wählen Sie in der lokalen Desktop-App unter **Diktat** die [Diktier-Engine](#desktop-dictation). Browser und Mobilgeräte verwenden ausschließlich die API.
2. Öffnen Sie für API-Diktat und Wiedergabe **API-Zugangsdaten** auf einer der beiden Karten. Geben Sie den **API-Schlüssel** und optional **Basis-URL**, **Transkriptionsmodell** und **Sprachmodell (TTS)** ein. Für verschiedene Dienste aktivieren Sie **Getrennte Anbieter für Ein- und Ausgabe**, füllen deren Felder aus und wählen **Speichern**.
3. **Wiedergabe** zeigt den **Anbieter**. Stellen Sie **Standardstimme**, **Wiedergabemodus** und **Ausgabeformat** ein und wählen Sie **Speichern**.

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
2. Wählen Sie **API-Eingabe testen**, erlauben Sie Mikrofonzugriff, sprechen Sie und wählen Sie **Aufnahme stoppen**. Prüfen Sie die zurückgegebene Transkription.
3. Wählen Sie **Wiedergabe testen**, um das Beispiel zu hören; **Beispiel stoppen** beendet es.

Der Wiedergabetest verwendet den gewählten Modus und das Format sofort, aber Endpunkt, Schlüssel, Modell und Stimme aus den gespeicherten Einstellungen. **API-Eingabe testen** sendet Audio unabhängig von der Diktier-Engine an den konfigurierten API-Anbieter. Dabei wird kein Unterhaltungsprompt gesendet. Der Anbieter kann die Tests berechnen.

## Prompt diktieren {#dictate}

1. Lassen Sie **Prompt-Spracheingabe** unter **Sprache** aktiviert (standardmäßig eingeschaltet).
2. Aktivieren Sie **Diktiermodus** unter **Weitere Aktionen**. Deaktivieren Sie den aktiven Modus, bevor Sie den anderen wählen.
3. Halten Sie das Mikrofon neben **Weitere Aktionen** gedrückt, sprechen Sie und lassen Sie zum Transkribieren los. Erlauben Sie bei Bedarf den Mikrofonzugriff. In einem kompatiblen Remote-Fenster öffnet ein Klick die lokale Diktiersteuerung.
4. Prüfen Sie den Text. Er ersetzt die ursprüngliche Auswahl nur, wenn Entwurf und Auswahl unverändert sind. Andernfalls wählen Sie vor dem nächsten Diktat **Transkription einfügen** im normalen Modus oder **Transkription verwerfen**. Beim Diktieren wird nichts gesendet.

Wenn die API unter Linux mit Tauri auf WAV ausweicht, endet die Aufnahme beim Diktieren und beim Eingabetest nach 24 Sekunden. Der Ausschnitt bleibt auf diesem Gerät, bis Sie ihn mit **Transkribieren** an den Sprachanbieter senden oder mit **Abbrechen** verwerfen.

Komprimierte API-Aufnahmen stoppen am Größenlimit und bieten ebenfalls **Transkribieren** oder **Abbrechen** an.

### Desktop-Engine auswählen {#desktop-dictation}

Wählen Sie in der lokalen Desktop-App unter **Einstellungen → Sprache → Diktat** die **Diktier-Engine auf diesem Gerät**. Die Wahl gilt für alle Projekte auf diesem Gerät. **API-Anbieter** nutzt die Einstellungen des verbundenen Servers und benötigt einen sicheren Kontext für das Mikrofon.

- Ist die gespeicherte Engine nicht verfügbar, wählen Sie hier **Hex (lokal)**, sofern angeboten, oder **API-Anbieter**. Auf Intel-Macs und Macs mit macOS vor Version 15 verwenden Sie **API-Anbieter**.
- Unter Sprache sehen Sie vorab, was Hex noch benötigt und wie groß der Download je Komponente und insgesamt ist. Ein Klick auf **Hex aktivieren** prüft kompatible Dateien, verwendet sie wieder, lädt Fehlendes und wählt das fertige Hex aus. Verfolgen Sie den Fortschritt dort; nutzen Sie **Hex-Aktivierung abbrechen** oder, wenn angeboten, **Hex-Aktivierung fortsetzen**. Bei Fehler oder Abbruch bleibt die bisherige Engine ausgewählt. Das Öffnen der Einstellungen, die Auswahl von bereits einsatzbereitem **Hex (lokal)** und das Diktieren lösen keinen Download aus.
- Hex wird für kompatible Geräte angeboten: Windows x64/arm64, Apple Silicon ab macOS 15 und Linux x64/arm64 mit glibc ab 2.36 und den von Hex benötigten Bibliotheken. Intel-Macs und Linux mit älterer glibc oder musl sind inkompatibel. Engine und Modelle sind nicht Teil des CodeNomad-Installers; ein Terminal oder API-Schlüssel ist nicht nötig.

Ubuntu 24.04 erfüllt die glibc-Anforderung, Ubuntu 22.04 hingegen nicht. Hex erkennt die gesprochene Sprache aus den [von Parakeet unterstützten Sprachen](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), darunter Englisch und Französisch. Diese Liste ist unabhängig von der App-Sprache.

Hex lädt sein Modell beim Start der Aufnahme im Hintergrund und hält es nach dem letzten Diktat drei Minuten bereit.

Die lokale Erkennung funktioniert offline, auch für WSL-Projekte in der lokalen App. Klicken Sie in einem kompatiblen Remote-Fenster auf das Mikrofon, um **Auf diesem Gerät diktieren** zu öffnen. Prüfen Sie das Ziel und verwenden Sie die Aufnahme- und Einfügefunktionen des Fensters. Nur der Text kehrt in den Entwurf zurück. Das Remote-Projekt braucht weiterhin seine Serververbindung.

In einem Tauri-Fenster für einen entfernten Server unter Linux prüft **API-Eingabe testen** die Sprach-API des Servers, ohne die Diktat-Engine zu ändern. Prüfen Sie vor jeder API-Aufnahme die Serveradresse im nativen Mikrofondialog und bestätigen Sie die Aufnahme. Die Aufnahme nutzt PulseAudio oder den PulseAudio-Dienst von PipeWire und hat immer das oben beschriebene WAV-Limit von 24 Sekunden.

Gemini Live und OpenAI Realtime sind in entfernten Tauri-Fenstern unter Linux nicht verfügbar: Diese Fenster nutzen für Diktat und Eingabetests die native Aufnahme, und WebKit blockiert den direkten Mikrofonzugriff.

## Nachrichten vorlesen {#playback}

1. Verwenden Sie **Nachricht vorlesen** an einer Nachricht oder dieselbe Aktion an einem Werkzeugaufruf, wenn TTS verfügbar ist.
2. Verwenden Sie **Wiedergabe stoppen** an derselben Steuerung, um sie zu beenden; eine andere Wiedergabe zu starten stoppt die laufende.
3. Ändern Sie Stimme, Modus oder Format unter **Wiedergabe** oder das Modell unter **API-Zugangsdaten** und speichern Sie.

Wiedergabe verwendet CodeNomads Textprojektion, keinen vorgelesenen Screenshot: Binär-/Bildbytes und Berechtigungsbelege sind kein Sprachinhalt. Sie führt keinen Prompt aus und ändert nicht das ausgewählte OpenCode-Modell.

## Sprachgespräch {#conversation}

Gemini Live und OpenAI Realtime sind nur für Sitzungen auf dem Server verfügbar, der dieses Fenster geöffnet hat.

Wählen Sie in **Gespräch** eine **Gesprächs-Engine**:

- **Klassisch** benötigt nur eine eingerichtete Wiedergabe in einem unterstützten Format. Aktivieren Sie **Gesprächsmodus** unter **Weitere Aktionen**. CodeNomad liest die fertige `spoken`-Zusammenfassung der Antwort in der aktiven Hauptsitzung vor. Der Modus gilt für den Projekt-Tab bis zur Deaktivierung oder zum Neuladen.
- **Gemini Live** und **OpenAI Realtime** haben jeweils einen eigenen **API-Schlüssel**, ein **Modell** und eine optionale **Stimme**. Speichern Sie die Einstellungen für den ausgewählten Anbieter. Öffnen Sie die Zielsitzung, wählen Sie **Gesprächsmodus** unter **Weitere Aktionen** und bei der Einwilligung **Zustimmen und starten**. Erlauben Sie den Mikrofonzugriff.

Wird der Anbieter bei geöffnetem Einwilligungsdialog nicht mehr verfügbar, öffnen Sie über **Spracheinstellungen** die Karte für Gespräche.

Das Sprachmodell kann den Status der beim Start festgelegten Sitzung, die letzte sichtbare Antwort und aktuelle Fehler lesen. Es hat keinen Dateizugriff. Wenn Sie es bitten, eine Anfrage an den Agenten zu senden, sendet es sie direkt als Nutzernachricht, ohne Bildschirmbestätigung. Der [Berechtigungsmodus der Unterhaltung](permissions.md#conversation-mode) und Rückfragen gelten wie gewohnt.

Der Server erlaubt gleichzeitig ein Live-Gespräch pro angemeldetem Nutzer oder bei Fernsteuerung pro gekoppeltem Gerät. **Stoppen** beendet die Audioübertragung und lässt die Abschrift offen. Sie bleibt bis zum Schließen des Fensters im Arbeitsspeicher; gesendete Anfragen bleiben in der Sitzung. Das Gespräch endet auch nach zwei Minuten ohne Sprache, nach insgesamt acht Minuten, beim Wechsel der Zielsitzung, beim Schließen des Fensters oder bei Verbindungsabbruch. Weder Wiederverbindung noch Anbieterwechsel erfolgen automatisch.

Bei OpenAI Realtime stoppt **Antwort unterbrechen** die Wiedergabe und fordert den Abbruch der aktuellen Antwort an. Bei Gemini Live stoppt **Wiedergabe stoppen** nur den Ton auf diesem Gerät. Gemini kann weiter antworten und Anfragen an den Agenten senden.

## Datenfluss und Datenschutz {#privacy}

Beim lokalen Diktieren bleibt Audio auf dem Gerät, ohne Wechsel zur API. Mit dem **API-Anbieter** geht es über das CodeNomad-Backend zum konfigurierten STT-Endpunkt. Zur Synthese ausgewählter Text geht durch dieses Backend zum TTS-Endpunkt; zurückgegebenes Audio spielt auf dem Client. API-Schlüssel bleiben serverseitig und werden nicht als gespeicherte Werte an das Einstellungsformular zurückgegeben.

Bei **Gemini Live** oder **OpenAI Realtime** erhält Google bzw. OpenAI Mikrofon-Audio, Projektname, Branch, Worktree, Sitzungstitel und Sitzungsstatus. Der Anbieter kann auch den Text der letzten sichtbaren Agentenantwort und aktuelle Fehler erhalten. Die Nutzung kann über Ihr Konto beim ausgewählten Anbieter abgerechnet werden.

Wählen Sie einen Anbieter, dem Sie diktierte, vorgelesene oder geteilte Inhalte anvertrauen. OpenCode-Zugangsdaten autorisieren Sprachdienste nicht automatisch. Lesen Sie vor der Serverfreigabe an andere Nutzer [Sicherheit](security.md).
