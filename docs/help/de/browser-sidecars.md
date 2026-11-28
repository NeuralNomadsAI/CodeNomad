# Browser-Vorschauen und SideCars

Iframe-Vorschauen und SideCars verweigern Verbindungen zu den eigenen Listener-Adressen und Ports von CodeNomad, auch über DNS-Aliase. Verwenden Sie den separaten Server-Port Ihrer Anwendung.

## Sitzungsbrowser öffnen {#session-browser}

1. Wählen Sie in der Symbolleiste einer Unterhaltung **Web-Vorschau öffnen**.
2. Geben Sie eine `http://`- oder `https://`-**Vorschau-URL** ohne Zugangsdaten ein und wählen Sie dann **Vorschau öffnen**. Verwenden Sie die Symbolleiste für Navigation, Aktualisieren sowie Zurück/Vorwärts.
3. Verwenden Sie die Schließen-Schaltfläche der Vorschau, um zum Chat zurückzukehren. Öffnen Sie sie zum Fortsetzen im selben Tab und in derselben Unterhaltung erneut.

Service Worker bleiben in entfernten Vorschauen deaktiviert.

Ein Klick auf einen `localhost`- oder `127.0.0.1`-Link in einer Unterhaltung öffnet ihn in der Web-Vorschau dieser Sitzung, auf jedem Client mit verfügbarer Vorschau. Über Remote Control, wenn der Host Web-Vorschauen deaktiviert hält, oder auf einem Client ohne verfügbare Vorschau behalten solche Links ihr normales Browser-Verhalten. Strg+Klick (⌘-Klick auf macOS) oder Mittelklick öffnet den Link stattdessen im Browser.

Die Seite der nativen Vorschau bleibt erhalten, wenn Sie zum Chat zurückkehren oder sie im selben Fenster verschieben.

Jede Registerkarte speichert ihre Chat-/Vorschauwahl; die Sitzung speichert gemeinsame URL, Viewport-Vorlage und Verlauf. Gespeicherte Seiten laden erst beim ausdrücklichen erneuten Öffnen des Sitzungsbrowsers. Gespeichert werden URLs und ein Zeiger; aktive Formulare, DOM, POST-Inhalte und JavaScript-Speicher enden mit dem Dokument. Der Verlauf ist auf 32 URLs je Sitzung und ein gemeinsames Fensterbudget begrenzt; ältere Einträge können gekürzt werden. Eine wiederhergestellte URL kann neu geladen werden.

Remote-Vorschauen nutzen den Projektserver und zeigen die Anwendungs-URL. Schließen der Vorschau oder des Tabs, Trennen des Servers oder Beenden beendet die Live-Seite. Beim erneuten Öffnen werden Adresse und Verlauf geladen, ungespeicherte Eingaben gehen verloren. Halten Sie interne Ladeadressen privat.

Native entfernte Vorschauen unterdrücken Kontextmenüs, Zwischenablageexport, Link-Ziehen, Drucken, Pop-ups, Downloads, Seitendialoge und Berechtigungsabfragen, damit interne Ladeadressen privat bleiben. Speichern Sie die Arbeit der Seite vor dem Schließen.

Die Vorschau-Bedienelemente erscheinen, sobald der Host und der Server des entfernten Projekts die Verfügbarkeit der Vorschau bestätigen.

Für die Fernsteuerung sind **Web-Vorschauen** unter **Einstellungen → Remote-Zugriff → Fernsteuerung** auf dem Host standardmäßig eingeschaltet. Das Ausschalten beendet Vorschauen und ihre WebSockets; nach dem Neuladen wird **Web-Vorschau öffnen** ausgeblendet. Beim Abmelden oder Widerrufen eines gekoppelten Geräts enden dessen Vorschauen und WebSocket-Verbindungen.

## Geteilte Anmeldungen und Automatisierungsgrenzen {#signins-automation}

Unter Electron und Tauri für Windows startet der automatisierte Neustart (`codenomad.act`, `restart`) das geprüfte Profil mit derselben Konfiguration und demselben Build neu. Wird das ursprüngliche Fenster wiederhergestellt, wird es erneut geprüft; andernfalls meldet die Automatisierung das fehlende Fenster und prüft kein anderes. Eine erfolgreiche Prüfung während der Wiederverbindung hat Vorrang.

Wird der Neustart abgebrochen, listen Sie die offenen Fenster mit `codenomad.inspect` und `targets: true` auf und prüfen Sie das gewünschte Fenster anhand seines `target`.

Native Vorschauen teilen Cookies, Anmeldungen und Websitespeicher über Projekte/Sitzungen innerhalb derselben Desktop-Engine und desselben Profil-/Konfigurationsbereichs, getrennt vom vertrauenswürdigen CodeNomad-Renderer. Abmelden von einer Website in einer Vorschau betrifft andere Vorschauen desselben Speichers. Dokumente, Formulare, Sitzungsspeicher, Navigationsverläufe und Automatisierungszuordnungen gehören jeweils zur Sitzung.

Jede Sitzung hat eine native Vorschau. Zeigt eine doppelte Registerkarte **Vorschau in einer anderen Registerkarte geöffnet**, wählen Sie **Zur Registerkarte**, um dorthin zu wechseln, oder **Hier öffnen**, um die Vorschau im selben Fenster zu verschieben. Die bisherige Registerkarte zeigt dann dieselbe Meldung. Nach dem Schließen der Registerkarte mit der Vorschau lässt sie sich in einer anderen öffnen.

Solange ein Desktop-Fenster eine Unterhaltung zeigt, können ihre Agenten deren Vorschau mit den Browser-Werkzeugen von OpenCode steuern (OpenCode 2.4 oder neuer); Seitenskripte auszuführen wird abgelehnt, und in der Tauri-App unter macOS und Linux können sie nicht zurück, vor oder neu laden. In Electron und der Windows-Tauri-App können sie außerdem Konsolenmeldungen und Netzwerkanfragen der Vorschau lesen; sie sehen Header und Textinhalte von Anfragen und Antworten, solange die Vorschau sie noch vorhält, außer den Werten der Cookie- und Autorisierungs-Header. Der Agent öffnet die Vorschau in der Registerkarte, der sie gehört, oder sonst in der zuletzt für die Sitzung verwendeten Registerkarte. Seitenaktionen gelten für die sichtbare native Vorschau. Seiten laden wie in der sichtbaren Vorschau über das Netzwerk dieses Computers; `localhost` ist also dieser Computer, auch wenn OpenCode in WSL läuft.

Vor einer Aktion oder Aufnahme erstellt der Agent einen Snapshot der Vorschau. Ändert sich die Vorschau, bricht der Befehl ab, statt eine andere Vorschau zu verwenden.

| Client | Vorschauimplementierung | Agenten-Browser-Automatisierung | Mobilvorlagen |
| --- | --- | --- | --- |
| Electron auf unterstützten Desktop-Plattformen | Nativer Chromium-Gast; OAuth-Pop-ups, Downloads und Dialoge | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Android-/Chromium-Identität, Touch- und Dichteemulation |
| Windows-Tauri | Natives WebView2-Unterfenster; OAuth-Pop-ups, Downloads und Dialoge | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Android-/Chromium-Identität, Touch- und Dichteemulation |
| macOS-Tauri (14+) | Natives WKWebView-Unterfenster; OAuth-Pop-ups, Downloads und Dialoge | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Mobile WebKit-Identität und CSS-Viewport; native Eingabegrenzen |
| Linux-Tauri | Natives WebKitGTK-Unterfenster; OAuth-Pop-ups, Downloads und Dialoge | Für sichtbare zugehörige Sitzungsvorschau unterstützt | Mobile WebKit-Identität und CSS-Viewport; native Dichte-/Eingabegrenzen |
| Normaler Browser/Remote-Ansicht | Iframe-Ersatz | Kein lokales natives Vorschauziel | Nur Abmessungen |

Elementkommentare sind im nativen Modus nicht verfügbar. GTK-Zwischenablagezugriff erfolgt ausdrücklich mit Strg+V; Schreiben und natives Kopieren/Einfügen funktionieren. Bei blockierter Iframe-Einbettung verwenden Sie einen externen Browser.

Native Pop-ups teilen Vorschau-Anmeldungen, behalten `opener`/`postMessage` und schließen mit ihrer Ursprungsseite. Eingegebene/wiederhergestellte Adressen erlauben HTTP(S) ohne Zugangsdaten; Websites können auch leere und gleichursprüngliche Blob-Dokumente öffnen. Datei- und App-Schemata bleiben gesperrt. Downloads landen mit bereinigten, eindeutigen Namen im Downloads-Ordner, ohne Überschreiben oder automatisches Öffnen. Kamera, Mikrofon, Standort und Benachrichtigungen werden verweigert; klassifizierte Berechtigungen benötigen Zustimmung, unbekannte Anfragen zeigen einen Fehler. Tauri und Electron unterstützen `alert`/`confirm`/`prompt`; Electrons Prompt-Dialog gilt für Hauptseiten der Vorschau, Pop-ups und Unterframes.

Websites können beim Schließen eines nativen Pop-ups eine Bestätigung verlangen. Von [WebKit 323277](https://bugs.webkit.org/show_bug.cgi?id=323277) betroffene WebKitGTK-Versionen, einschließlich 2.52.6, benötigen für Uploads die Dateiauswahl der Seite, da der Zugriff auf abgelegte Dateien aus Sicherheitsgründen gesperrt ist. Speichern Sie die Arbeit auf der Seite, bevor Sie das zugehörige CodeNomad-Fenster schließen oder neu laden.

Fokussieren Sie unter Tauri macOS/Linux die Vorschau, um sie mit ⌘/Strg +, − oder 0 oder über das Zoommenü der App zu zoomen. Bei anderem Fokus zoomen diese Menüaktionen die App.

## Eine von sechs Ansichtsgrößenvorlagen wählen {#templates}

1. Öffnen Sie das Ansichtsgrößenmenü der Vorschau.
2. Wählen Sie eine Vorlage unten. Verwenden Sie Hoch-/Querformat direkt; es gibt keine separate Drehsteuerung.
3. Rechnen Sie in Electron und Windows-Tauri mit nativem Neuladen beim Aktivieren/Ändern mobiler Emulation oder Rückkehr zu einer reinen Abmessungsvorlage.

| Vorlage | CSS-Ansichtsgröße |
| --- | --- |
| Responsive Ansichtsgröße | Verfügbarer Vorschauplatz |
| Desktop-Ansichtsgröße | 1440 × 900 |
| Tablet-Ansichtsgröße | 768 × 1024 |
| Tablet-Querformat | 1024 × 768 |
| Mobile Ansichtsgröße | 390 × 844 |
| Mobiles Querformat | 844 × 390 |

Unter Electron und Windows-Tauri setzen Mobilvorlagen Android-/Chromium-Identität, Ausrichtung, Touch und DPR 2.75 nur auf dem zugehörigen Gast. Rückkehr zu responsiv/Desktop/Tablet entfernt diese Überschreibungen und lädt neu. Tauri macOS/Linux verwenden eine generische mobile WebKit-Kennung für HTTP und JavaScript und passen CSS-Viewports unabhängig von App-Zoom/DPI ein; Vorlagenwechsel und Zurücksetzen laden neu. macOS nutzt DPR 2,75, soweit nativ verfügbar; GTK-Dichte folgt Einpassungszoom und Monitor. Der Iframe-Ersatz ändert nur die Größe. Die Profile dienen als Layoutreferenz; Telefontastaturen, Systemleisten und mobile Texteinstellungen liegen außerhalb ihres Umfangs. Sichern Sie Seitenarbeit vor Vorlagenwechsel, da Neuladen ungesendeten Seitenzustand verwerfen kann.

## SideCar registrieren {#register-sidecar}

1. Starten Sie das Webwerkzeug separat auf dem CodeNomad-Backend-Host, lauschend auf `127.0.0.1:<port>`.
2. Öffnen Sie **Einstellungen → SideCars**. Geben Sie **Name** und **Port** ein; prüfen Sie den abgeleiteten **Basispfad** (`/sidecars/<id>`).
3. Setzen Sie **Protokoll** passend zum Upstream-Dienst und wählen Sie **Präfix-Modus**.
4. Wählen Sie **SideCar hinzufügen** und öffnen Sie ihn über **Durchsuchen**. [Projekt-Tabs](projects.md#open-project).

Ein laufender SideCar bleibt nach dem Schließen seines Tabs in der Liste der letzten Tabs.

| Auswahl | Exakte Wirkung |
| --- | --- |
| HTTPS (Formularstandard) | CodeNomad verbindet sich zum Upstream als `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad verbindet sich zum Upstream als `http://127.0.0.1:<port>`. Dies ändert die TLS-Einstellung der öffentlichen CodeNomad-Verbindung nicht. |
| Präfix entfernen (Standard) | `/sidecars/<id>/path` wird als `/path` an den Upstream weitergegeben. |
| Präfix beibehalten | `/sidecars/<id>/path` wird unverändert weitergegeben. Konfigurieren Sie den eigenen Basispfad des Dienstes entsprechend. |

Registrierung ist von Clients geteilte Serverkonfiguration; sie installiert oder startet den Dienst nicht. Der Port liegt auf dem Backend-Host, nicht auf Ihrem anzeigenden Notebook/Telefon. Entfernen der Registrierung stoppt den separat gestarteten Prozess nicht. Auch Tab-Schließen stoppt ihn nicht.

Prüfen Sie bei Nichterreichbarkeit Prozess und Port auf dem Backend. Lädt HTML, aber scheitern Dateien/WebSockets, prüfen Sie Basispfad und Präfix-Modus des Werkzeugs. Erstellen Sie eine falsche Registrierung mit den vorgesehenen Einstellungen neu; geben Sie den Upstream nicht nur zum Umgehen eines Proxyfehlers öffentlich frei. SideCar-Anwendungen können Terminal oder Dateien mit der Autorität des Serverkontos freigeben; vertrauen Sie ihren Benutzern und ihrer Konfiguration.

Ein SideCar ist eine vertrauenswürdige Erweiterung von CodeNomad, keine Vorschau in einer Sandbox: Seine Seite läuft unter dem eigenen Origin von CodeNomad, sodass seine Skripte CodeNomad mit Ihrem angemeldeten Zugang nutzen können. Registrieren Sie nur Dienste, deren Code Sie vertrauen. CodeNomad leitet seine eigenen Anmelde-Cookies nicht an den Dienst weiter, während die eigenen Cookies des Dienstes erhalten bleiben.

SideCar-Inhalte (`/sidecars/`) und SideCar-WebSockets erfordern eine Loopback-Verbindung auf dem Host. Um sie auch von anderen Geräten zu öffnen, aktivieren Sie auf dem Host **SideCars über HTTPS öffnen** unter **Einstellungen → SideCars**: Browser, die über die HTTPS-Adressen dieses Servers oder einen HTTPS-Origin aus `CODENOMAD_ALLOWED_ORIGINS` angemeldet sind, etwa hinter einem TLS-Reverse-Proxy, können dann SideCars öffnen. Einfaches HTTP, `localhost`-Adressen und die Fernsteuerung bleiben dem Host vorbehalten. Die Registrierung über `/api/sidecars` ist für gekoppelte Geräte und authentifizierte direkte LAN-Clients verfügbar. Inhalte aktiver Vorschauen (`/previews/`) sind mit einem gültigen Berechtigungstoken über direkten LAN-Zugriff verfügbar; Web-Vorschauen der [Fernsteuerung](remote-control.md#remote-surface) bleiben mit ihrem Berechtigungstoken verfügbar, solange sie aktiviert sind. Anforderungen für den Direktzugriff stehen unter [Erlaubte Ursprünge](remote-access.md#upgrading).

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
