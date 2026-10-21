# Browser-Vorschauen und SideCars

## Sitzungsbrowser öffnen {#session-browser}

1. Wählen Sie in der Symbolleiste einer Unterhaltung **Web-Vorschau öffnen**.
2. Geben Sie eine `http://`- oder `https://`-**Vorschau-URL** ohne Zugangsdaten ein und wählen Sie dann **Vorschau öffnen**. Verwenden Sie die Symbolleiste für Navigation, Aktualisieren sowie Zurück/Vorwärts.
3. Verwenden Sie die Schließen-Schaltfläche der Vorschau, um zum Chat zurückzukehren. Öffnen Sie sie in dieser Unterhaltung zum Fortsetzen erneut.

Jede Vorschau gehört zu ihrem Projektordner und ihrer Sitzung. Wechsel von Unterhaltung, Projekt, Info oder Chat verbirgt einen ausdrücklich geöffneten nativen Gast, ohne dessen aktives Dokument/Verlauf zu verwerfen. Verborgene Gäste sind keine Automatisierungsziele. Projekt-/Fensterschließen oder Renderer-Neustart beendet das aktive Dokument.

Gespeicherter Verlauf wird nur wiederhergestellt, wenn Sie den Sitzungsbrowser ausdrücklich erneut öffnen, nicht beim Start/bei Sitzungsauswahl. Er speichert URLs und einen Zeiger, keine ungesendeten Formulare, DOM, POST-Inhalte oder JavaScript-Speicher. Verlauf ist auf 32 URLs pro Sitzung und ein gemeinsames Layoutbudget begrenzt; ältere Einträge können gekürzt werden. URL-Wiederherstellung kann eine frische Seite laden; sie ist keine Transaktionswiederholung.

## Geteilte Anmeldungen und Automatisierungsgrenzen {#signins-automation}

Native Vorschauen teilen Cookies, Anmeldungen und Websitespeicher über Projekte/Sitzungen innerhalb derselben Desktop-Engine und desselben Profil-/Konfigurationsbereichs, getrennt vom vertrauenswürdigen CodeNomad-Renderer. Abmelden von einer Website in einer Vorschau betrifft andere Vorschauen desselben Speichers. Dokumente, Formulare, Sitzungsspeicher, Navigationsverläufe und Automatisierungszuordnungen bleiben sitzungsbezogen. Iframe-Vorschauen sind kein vollständiges gemeinsames natives Browserprofil.

| Client | Vorschauimplementierung | Agenten-Browser-Automatisierung | Mobilvorlagen |
| --- | --- | --- | --- |
| Electron auf unterstützten Desktop-Plattformen | Nativer Chromium-Gast | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Android-/Chromium-Identität, Touch- und Dichteemulation |
| Windows-Tauri | Natives WebView2-Unterfenster | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Android-/Chromium-Identität, Touch- und Dichteemulation |
| macOS-/Linux-Tauri | Iframe in Sandbox | Keine native Browser-Automatisierung | Nur Abmessungen |
| Normaler Browser/Remote-Ansicht | Iframe-Ersatz | Kein lokales natives Vorschauziel | Nur Abmessungen |

Es gibt weder Entwicklermodus-Schalter noch zusätzlichen Aktivierungsneustart. Native Automatisierung wird beim Desktop-Start vorbereitet und nutzt das sitzungsgebundene Werkzeug `codenomad.browser` zum Öffnen, Navigieren, Schnappschuss, Screenshot und für Seitenaktionen: Klicken, Tippen, Auswählen, Überfahren, Ziehen, Scrollen, Tastendrücke und Warten auf Text. Werkzeugverfügbarkeit autorisiert nicht jedes Fenster: Ausführung prüft zuständiges Backend, native Fähigkeiten, Sitzung und sichtbares Ziel. Eine Aktion, deren Seite inzwischen verborgen, ersetzt oder weiternavigiert wurde, wird abgelehnt statt an eine andere Seite gesendet, und eine Aktion wird nie automatisch wiederholt. Seiteninhalte bleiben nicht vertrauenswürdig. Ein iframe kann scheitern, weil das Ziel Einbettung verbietet; nutzen Sie einen externen Browser, statt Schutzmaßnahmen zu schwächen.

## Eine von sechs Ansichtsgrößenvorlagen wählen {#templates}

1. Öffnen Sie das Ansichtsgrößenmenü der Vorschau.
2. Wählen Sie eine Vorlage unten. Verwenden Sie Hoch-/Querformat direkt; es gibt keine separate Drehsteuerung.
3. Rechnen Sie mit nativem Neuladen beim Aktivieren/Ändern mobiler Emulation oder Rückkehr zu einer reinen Abmessungsvorlage.

| Vorlage | CSS-Ansichtsgröße |
| --- | --- |
| Responsive Ansichtsgröße | Verfügbarer Vorschauplatz |
| Desktop-Ansichtsgröße | 1440 × 900 |
| Tablet-Ansichtsgröße | 768 × 1024 |
| Tablet-Querformat | 1024 × 768 |
| Mobile Ansichtsgröße | 390 × 844 |
| Mobiles Querformat | 844 × 390 |

Native Mobilvorlagen setzen Android-/Chromium-Identität, Ausrichtung, Touch und DPR 2.75 nur auf dem zugehörigen Gast. Rückkehr zu responsiv/Desktop/Tablet entfernt diese Überschreibungen und lädt neu. Iframe-Ersatz ändert nur die Größe. Dies sind reproduzierbare Layoutreferenzen, keine Safari-/Firefox-Emulation oder Simulation von Telefontastaturen, Browser-/Systemleisten oder mobilen OS-Texteinstellungen. Sichern Sie Seitenarbeit vor Vorlagenwechsel, da Neuladen ungesendeten Seitenzustand verwerfen kann.

## SideCar registrieren {#register-sidecar}

1. Starten Sie das Webwerkzeug separat auf dem CodeNomad-Backend-Host, lauschend auf `127.0.0.1:<port>`.
2. Öffnen Sie **Einstellungen → SideCars**. Geben Sie **Name** und **Port** ein; prüfen Sie den abgeleiteten **Basispfad** (`/sidecars/<id>`).
3. Setzen Sie **Protokoll** passend zum Upstream-Dienst und wählen Sie **Präfix-Modus**.
4. Wählen Sie **SideCar hinzufügen**, dann **SideCar öffnen** auf der Startseite, um dessen Tab zu öffnen.

| Auswahl | Exakte Wirkung |
| --- | --- |
| HTTPS (Formularstandard) | CodeNomad verbindet sich zum Upstream als `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad verbindet sich zum Upstream als `http://127.0.0.1:<port>`. Dies ändert die TLS-Einstellung der öffentlichen CodeNomad-Verbindung nicht. |
| Präfix entfernen (Standard) | `/sidecars/<id>/path` wird als `/path` an den Upstream weitergegeben. |
| Präfix beibehalten | `/sidecars/<id>/path` wird unverändert weitergegeben. Konfigurieren Sie den eigenen Basispfad des Dienstes entsprechend. |

Registrierung ist von Clients geteilte Serverkonfiguration; sie installiert oder startet den Dienst nicht. Der Port liegt auf dem Backend-Host, nicht auf Ihrem anzeigenden Notebook/Telefon. **Läuft** bezeichnet Erreichbarkeit, nicht funktionierende Anwendung/Authentifizierung des Werkzeugs. Entfernen der Registrierung stoppt den separat gestarteten Prozess nicht. Auch Tab-Schließen stoppt ihn nicht.

Prüfen Sie bei Nichterreichbarkeit Prozess und Port auf dem Backend. Lädt HTML, aber scheitern Dateien/WebSockets, prüfen Sie Basispfad und Präfix-Modus des Werkzeugs. Erstellen Sie eine falsche Registrierung mit den vorgesehenen Einstellungen neu; geben Sie den Upstream nicht nur zum Umgehen eines Proxyfehlers öffentlich frei. SideCar-Anwendungen können Terminal oder Dateien mit der Autorität des Serverkontos freigeben; vertrauen Sie ihren Benutzern und ihrer Konfiguration.

Ein SideCar ist eine vertrauenswürdige Erweiterung von CodeNomad, keine Vorschau in einer Sandbox: Seine Seite läuft unter dem eigenen Origin von CodeNomad, sodass seine Skripte CodeNomad mit Ihrem angemeldeten Zugang nutzen können. Registrieren Sie nur Dienste, deren Code Sie vertrauen. CodeNomad leitet seine eigenen Anmelde-Cookies nicht an den Dienst weiter, während die eigenen Cookies des Dienstes erhalten bleiben. Fernsteuerung stellt keinen SideCar-Anwendungsproxyverkehr bereit; verwenden Sie den passenden Direktzugriffsweg unter [Fernzugriff](remote-access.md) und [Fernsteuerung](remote-control.md).

## OpenVSCode-Server-Rezept {#openvscode}

1. Führen Sie auf dem Backend-Host Docker mit an Loopback gebundenem Dienst aus:

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Registrieren Sie **Name** `VSCode`, **Port** `8000`, **Protokoll** `HTTP`, **Präfix-Modus** **Präfix beibehalten**.
3. Prüfen Sie den angezeigten Basispfad `/sidecars/vscode` und öffnen Sie den SideCar.

Dieses Shell-Rezept bindet Ihr Home-Verzeichnis in den Container ein; verwenden Sie eine engere Einbindung, wenn der Editor nur darauf zugreifen soll. `--server-base-path` des Dienstes muss exakt der Registrierung entsprechen. Stoppen Sie den Container anschließend separat; SideCar-Löschung entfernt weder ihn noch seine Dateien.

## ttyd-Terminal-Rezept {#ttyd}

1. Starten Sie auf dem Backend-Host ein beschreibbares, an Loopback gebundenes Shell-Terminal:

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Registrieren Sie **Name** `Terminal`, **Port** `7681`, **Protokoll** `HTTP`, **Präfix-Modus** **Präfix entfernen**.
3. Öffnen Sie den SideCar unter seinem angezeigten Basispfad `/sidecars/terminal`.

Das Terminal läuft mit den Rechten des Kontos, das ttyd gestartet hat. Wählen Sie eine andere Shell, falls `zsh` fehlt. Verwenden Sie bei geändertem ttyd-Standard den tatsächlichen Port und stoppen Sie ttyd anschließend separat. Authentifizieren und schützen Sie CodeNomad-Zugriff; ein beschreibbares Terminal ist keine Sandbox.
