# Direkter Fernzugriff

Direktzugriff verbindet sich über das Serverpasswort mit CodeNomads HTTP-/HTTPS-Listenern. Er ist von der [Fernsteuerung](remote-control.md) getrennt: Kopplung benötigt weder LAN-Bindung noch eingehenden Port, und keiner der Wege weicht stillschweigend auf den anderen aus.

## Zugriffsweg wählen {#access-paths}

| Weg | Was Sie verwalten |
| --- | --- |
| Browser auf demselben Rechner | Loopback-Bindung beibehalten; ausgegebene lokale URL verwenden. |
| LAN oder VPN | Erreichbare Schnittstelle binden, Firewall auf vorgesehene Clients begrenzen und vertrauenswürdiges HTTPS verwenden. Ein VPN konfiguriert CodeNomads Listener nicht für Sie. |
| SSH-Weiterleitung | Backend an Loopback gebunden lassen; tatsächlich ausgegebenen Port weiterleiten. Der Tunnel schützt den Transport, ersetzt aber nicht CodeNomad-Authentifizierung. |
| Reverse-Proxy | Backend auf privater/Loopback-Schnittstelle belassen; vertrauenswürdiges TLS am Proxy terminieren, den Upstream-Abschnitt schützen und langlebige SSE sowie benötigte WebSockets Ihrer Direktzugriffswerkzeuge unterstützen. |
| Fernsteuerung | Gerät vom Host aus koppeln; eingeschränktere Oberfläche und Lebensdauer siehe [Fernsteuerung](remote-control.md). |

Eine Bindung erzeugt keine Firewallregeln, Portweiterleitung, DNS oder VPN. Veröffentlichen Sie keinen nicht authentifizierten HTTP-Listener im Internet. Ein Arbeitsbereichs-Stammverzeichnis ist keine Sicherheits-Sandbox; lesen Sie vor der Freigabe des Servers [Sicherheit](security.md).

## Direktzugriff aktivieren {#enable-direct-access}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff** und klappen Sie **Direktzugriff (lokales Netzwerk, erweitert)** auf.
2. Wählen Sie unter **Server-Passwort** entweder **Passwort festlegen** oder **Passwort ändern**, geben Sie **Neues Passwort** und **Passwort bestätigen** ein und wählen Sie **Passwort speichern**. Zur Laufzeit übergebene Passwörter können hier nicht geändert werden; siehe [Sicherheit](security.md).
3. Aktivieren Sie **Verbindungen von anderen IPs zulassen** unter **Abhörmodus (Listening mode)**. Lesen Sie die Neustartwarnung und wählen Sie **Jetzt neu starten** erst, wenn Sie für die vorübergehende Unterbrechung bereit sind.
4. Verwenden Sie nach dem Neustart **Aktualisieren** und prüfen Sie **Erreichbare Adressen**. Öffnen Sie die erreichbare HTTPS-Adresse auf dem anderen Gerät oder wählen Sie **QR anzeigen** auf dem Host und scannen Sie mit dem anderen Gerät; melden Sie sich dann an.

Dies ändert den direkten Abhörmodus des Hosts, nicht ein Projekt und nicht die Fernsteuerung. Der Abschnitt öffnet sich automatisch, solange der Server über localhost hinaus lauscht. Ist automatischer Neustart nicht verfügbar, starten Sie CodeNomad manuell neu; eigenständige Bereitstellungen müssen ihr Start-`--host` konsistent setzen. Zum Entfernen der Freigabe deaktivieren Sie den Schalter und starten neu oder starten die CLI erneut mit Loopback-Bindung. Dies widerruft keine gekoppelten Fernsteuerungsgeräte.

### Listener-Bindungsmatrix {#binding-matrix}

`--host` ist standardmäßig `127.0.0.1`; `localhost` wird auf diese Adresse normalisiert. Für aktivierte Listener gelten folgende Regeln:

| Start/Modus | HTTP bindet an | HTTPS bindet an |
| --- | --- | --- |
| Eigenständig, nur HTTPS (Standard) | Nur privater Loopback-Listener (siehe unten) | `--host` |
| Eigenständig, nur HTTP | **`--host`**, einschließlich LAN-/Wildcard-Adresse | Nicht aktiviert |
| Eigenständig, beide Listener | `127.0.0.1` unabhängig von `--host` | `--host` |
| Natives Desktop-Backend | Sein HTTP-Listener bleibt auf `127.0.0.1`, einschließlich des hostinternen Listeners | `--host`, wenn HTTPS aktiviert ist |

Jedes Backend behält außerdem einen HTTP-Listener auf `127.0.0.1` für CodeNomads eigene mitgelieferte OpenCode-Plugins wie Missionen. Wurde HTTP nicht angefordert oder ist der angeforderte HTTP-Listener an eine andere Adresse als `127.0.0.1` oder `0.0.0.0` gebunden, ergänzt das Backend einen privaten HTTP-Listener auf einem zufälligen `127.0.0.1`-Port. Er wird nie ausgegeben oder als Verbindungsadresse angeboten, ist von anderen Rechnern nicht erreichbar und stellt dieselbe authentifizierte Anwendung bereit.

Eine konkrete LAN-Adresse muss keine Loopback-Verbindungen annehmen. `0.0.0.0` bedeutet alle IPv4-Schnittstellen; `::` ist der Dual-Stack-Wildcard-Listener. Verwenden Sie im Browser eine tatsächlich erreichbare Adresse, keine Wildcard. IPv6-Zonenkennungen werden in `--host` nicht unterstützt.

Setzen Sie für eine eigenständige HTTPS-Bereitstellung ein Passwort über die [Ersteinrichtung](security.md) und führen Sie dann aus:

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

Für reines Loopback-HTTP, etwa hinter einem lokalen vertrauenswürdigen Proxy:

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

Setzen Sie Port 9898 oder 9899 nicht voraus: Nicht angegebene Ports können bei Belegung ausweichen. Ein expliziter von null verschiedener `--https-port` oder ein `--http-port` bei aktiviertem HTTP legt den Port fest und schlägt bei fehlgeschlagener Bindung fehl; `0` fordert eine OS-Zuweisung an. Die ausgegebenen **Local Connection URL** und **Remote Connection URL** sowie aktualisierte **Erreichbare Adressen** sind für diesen Lauf maßgeblich. Siehe die vollständige [Server-CLI-Referenz](server.md).

## Vertrauenswürdiges TLS konfigurieren {#tls}

### Eigenes Zertifikat bereitstellen {#custom-certificates}

1. Beschaffen Sie ein Zertifikat, dessen Subject Alternative Names (SANs) den tatsächlich von Clients verwendeten Hostnamen oder die IP abdecken.
2. Geben Sie sowohl `--tls-key <path>` als auch `--tls-cert <path>` als PEM-Dateien an. Ergänzen Sie `--tls-ca <path>`, falls Ihre Bereitstellung eine CA-Kette/ein Bundle benötigt.
3. Starten Sie CodeNomad neu und prüfen Sie Zertifikat sowie ausgegebene HTTPS-Adresse vom Client-Gerät aus.

Eigene Zertifikatsdateien werden beim Start gelesen und niemals von CodeNomad umgeschrieben. Erneuerung und erforderlicher Neustart zum Laden erneuerter Dateien liegen bei Ihnen. `--tlsSANs` konfiguriert erzeugte Zertifikate; es kann einem bereitgestellten Zertifikat keine Namen hinzufügen. Schützen Sie private Schlüssel und vertrauen Sie nur Zertifikaten mit überprüfter Hostidentität.

### Erzeugte lokale CA verwenden {#generated-certificates}

Bei aktiviertem HTTPS ohne bereitgestelltes Schlüssel-/Zertifikatspaar erstellt CodeNomad lokale CA und Serverzertifikat unter der Konfigurationsbasis:

| Datei | Zweck |
| --- | --- |
| `tls/ca-cert.pem` | Öffentliches CA-Zertifikat zur sicheren Verteilung an von Ihnen verwaltete Clients. |
| `tls/ca-key.pem` | Privater CA-Schlüssel; niemals verteilen. |
| `tls/server-cert.pem` | Serverzertifikat. |
| `tls/server-key.pem` | Privater Serverschlüssel; niemals verteilen. |

1. Ergänzen Sie jeden für Clients verwendeten DNS-Namen/jede IP mit `--tlsSANs "host.example.test,192.0.2.10"`. Wildcard-Bindung findet nicht alle LAN-Adressen für SANs.
2. Starten Sie das Backend neu, um das Zertifikat zu erzeugen/erneut zu prüfen.
3. Prüfen Sie Host/CA über einen vertrauenswürdigen Kanal und importieren Sie dann **nur das CA-Zertifikat** in den Vertrauensspeicher jedes vorgesehenen Clients/Browsers. Alternativ verwenden Sie ein öffentlich vertrauenswürdiges Zertifikat oder einen TLS-Reverse-Proxy.

Das erzeugte Serverzertifikat gilt 30 Tage. Beim Start wird es innerhalb von drei Tagen vor Ablauf, bei fehlenden erforderlichen SANs, fehlgeschlagenen Zertifikatsprüfungen oder fehlender privater Schlüsseldatei erneuert. Die erzeugte CA gilt 365 Tage und wird bei Ablauf, fehlgeschlagenen Zertifikatsprüfungen oder fehlender privater Schlüsseldatei ersetzt; dabei wird auch das Serverzertifikat neu ausgestellt. Vorhandene beschädigte, unlesbare oder unpassende private Schlüssel werden nicht automatisch repariert. Clients müssen der Ersatz-CA vertrauen. Es gibt keine kontinuierliche Erneuerung im laufenden Prozess: Planen Sie für Langzeitbereitstellungen einen bewussten Neustart vor Ablauf.

Meldet ein Client eine Zertifikatswarnung, halten Sie an und prüfen Sie Hostname, SANs, Vertrauensspeicher und Ablauf. Deaktivieren Sie keine Prüfung und machen Sie das Wegklicken von Warnungen nicht zum Bereitstellungsverfahren. Vertrauenswürdiges HTTPS ist auch für entfernte Browserfunktionen wie [PWA-Installation und Mikrofonzugriff](mobile.md) erforderlich.

## Remote-Server speichern {#saved-servers}

1. Öffnen Sie auf der Startseite, einem leeren Tab oder im Starter **Tab öffnen** den Bereich **Durchsuchen**. Geben Sie Adresse oder Kopplungslink in **Serveradresse oder -link** ein: Einfügen fügt sofort hinzu, die Eingabetaste bestätigt getippten Text. Der Server wird nur unter seinem Hostnamen gespeichert und seine Zeile fokussiert; der Starter bleibt offen. Klicken Sie auf diese Zeile, um Projekte an Ort und Stelle zu durchsuchen. **Einstellungen → Server** bietet dasselbe Feld.
2. Verwenden Sie einen vertrauenswürdigen HTTPS-Ursprung. Besteht sein Zertifikat die Prüfung nicht, erscheint unter dem Feld **TLS-Prüfung überspringen**: Aktivieren Sie dies nur für einen vertrauenswürdigen Server und speichern Sie erneut mit der Eingabetaste. Die Auswahl eines Ordners oder Projekts dieses Profils öffnet ein eigenes Fenster.
3. Wählen Sie seine Zeile unter **Durchsuchen**, um Projekte an Ort und Stelle zu durchsuchen. Geben Sie bei Bedarf Benutzername und Passwort im eingeblendeten Formular ein. Name und Adresse ändern Sie mit **Server bearbeiten** unter **Einstellungen → Server**.

**Einstellungen → Server** verwaltet Profile (**Server bearbeiten**, **Gespeicherten Server entfernen**). Beim Entfernen werden zuerst die Zugangsdaten und die Suchsitzung im Backend vergessen, dann das Lesezeichen entfernt und seine Tabs geschlossen. Entfernte Projekte und Unterhaltungen bleiben auf ihrem Server. Das lokale Backend speichert Suchzugangsdaten privat in `remote-server-credentials.json` neben seiner Konfiguration; schützen Sie diese Datei wie ein Passwort. Eingebettete Ansichten behalten eine separate Authentifizierung.

Um einen gespeicherten Server direkt von der Befehlszeile zu öffnen, starten Sie die Desktop-App mit `--connect-server <name>` (oder `--connect-server=<name>`) und dem gespeicherten Namen des Servers oder seiner `https://`-URL. CodeNomad öffnet nur das Remote-Fenster, mit den TLS-Prüfungen des Profils und der eigenen Anmeldung des nativen Remote-Fensters; läuft CodeNomad bereits, öffnet sein aktuelles Fenster den Server statt eines neuen Fensters. Eine URL, die zu keinem gespeicherten Server passt, wird unter ihrem Hostnamen gespeichert. Startwerte enthalten nie Zugangsdaten: Eine URL mit Benutzername, Passwort oder Kopplungscode wird abgelehnt. Ist der Name unbekannt, die URL ungültig oder schlägt die Verbindung fehl, startet CodeNomad normal und zeigt den Fehler an. Braucht die Verbindung eine Bestätigung, etwa die Installation des lokalen Zertifikats für einen selbstsignierten Server, startet CodeNomad ebenfalls normal und fragt dort nach. Unter Windows startet der Tauri-Build nicht, wenn ein Startargument `|` enthält; verwenden Sie stattdessen die URL des Servers oder benennen Sie den Server um.

Ein Remote-Fenster lässt immer einen Weg zurück zu diesem Computer. Wenn Sie das letzte lokale Fenster schließen, während Remote-Fenster geöffnet bleiben, behält es seine Tabs: **Fenster → Neues Fenster** in einem Remote-Fenster oder ein erneuter Start von CodeNomad öffnet es wieder. Kann ein Server nicht geladen werden, zeigt sein Fenster das an und bietet **Erneut versuchen**, **Lokales Fenster öffnen** und **Fenster schließen**; in der Tauri-Version verwenden Sie die Schaltfläche zum Neuladen der Seite und **Fenster → Neues Fenster**.

Das Einfügen eines Fernsteuerungslinks speichert nur den Tunnel-Ursprung und meldet, dass serverseitige Kopplung nicht verfügbar ist; der Code wird verworfen. Öffnen Sie den Link zum Koppeln im gewünschten Browser. Siehe [Fernsteuerung](remote-control.md).

## Ein Remote-Projekt in einem Tab öffnen {#remote-project-tabs}

In der Desktop-App (Electron oder Tauri unter Windows) kann ein gespeicherter Server eines seiner Projekte auch in einem Tab dieses Fensters öffnen, neben Ihren lokalen Projekten:

1. Öffnen Sie auf der Startseite, einem leeren Tab oder im Starter **Tab öffnen** den Bereich **Durchsuchen** und wählen Sie einen gespeicherten Server. Fügen Sie neue Server zuerst über **Serveradresse oder -link** hinzu und klicken Sie dann auf deren Zeile.
2. Die Liste zeigt dort die zuletzt verwendeten Projekte und Ordner dieses Servers. Melden Sie sich bei Bedarf im eingeblendeten Formular an. Wählen Sie ein Projekt oder navigieren Sie zu einem Ordner und wählen Sie **Aktuellen auswählen**. **Zurück zu Durchsuchen** führt zur Serverliste.
3. Die Ordnerwahl öffnet den Remote-Projekttab und ersetzt den ursprünglichen leeren Tab. Der `+`-Starter bleibt bis zu dieser Wahl offen. Das Projekt erscheint zum direkten Wiederöffnen unter **Zuletzt verwendet**.

Unterhaltungen, Dateien, Git, Einstellungen und Missions des Tabs laufen auf dem Remote-Server. Seine eingebettete Ansicht teilt den Speicher des Remote-Fensters und kann eine eigene Anmeldung unabhängig von Durchsuchen verlangen. Remote-Tabs werden beim Start wiederhergestellt. Server ohne eingebetteten Modus zeigen ihre vollständige Oberfläche; Profile ohne TLS-Prüfung und Tauri unter macOS/Linux öffnen ein separates Fenster. Die eingebettete Seite bleibt auf ihrem Server und hat nur Benachrichtigungszugriff auf den Host. Webclients und Fernsteuerungsgeräte haben keine Remote-Tabs.

Die Backend-Suche akzeptiert die Zieladresse jedes gespeicherten Profils, einschließlich Loopback, RFC1918-LAN, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS und `*.ts.net`, IPv6-ULA/Link-Local sowie Namen, die zu diesen Adressen aufgelöst werden. Ihre Netzwerkrouten und TLS-Konfiguration müssen die Verbindung ermöglichen. Die Zertifikatsprüfung folgt dem gespeicherten Profil und seiner ausdrücklichen TLS-Bestätigung.
