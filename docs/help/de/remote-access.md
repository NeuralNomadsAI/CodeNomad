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
| Eigenständig, nur HTTPS (Standard) | Nur privater Loopback-Listener | `--host` |
| Eigenständig, nur HTTP | **`--host`**, einschließlich LAN-/Wildcard-Adresse | Nicht aktiviert |
| Eigenständig, beide Listener | `127.0.0.1` unabhängig von `--host` | `--host` |
| Natives Desktop-Backend | Sein HTTP-Listener bleibt auf `127.0.0.1`, einschließlich des hostinternen Listeners | `--host`, wenn HTTPS aktiviert ist |

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

## Administratorrichtlinie {#administrator-policy}

Ein Administrator kann die Abhöradresse festlegen: Setzen Sie `CODENOMAD_LOCKED_HOST` systemweit auf die Adresse, die der Server verwenden muss, und starten Sie CodeNomad neu. Sie hat Vorrang vor `--host`, `CLI_HOST` und **Verbindungen von anderen IPs zulassen**, das das Ergebnis anzeigt, es aber nicht ändern kann. Verwenden Sie eine Intranetadresse, damit Kollegen den Server über das Firmennetz erreichen, oder `127.0.0.1`, um ihn auf diesem Computer zu halten. Damit jeder Zugriff im Firmennetz bleibt, setzen Sie zusätzlich `CODENOMAD_REMOTE_CONTROL=disabled` ([Fernsteuerung](remote-control.md#administrator-policy)).

## Erlaubte Ursprünge {#upgrading}

Setzen Sie für einen Hostnamen-Alias, Reverse-Proxy oder eine separat gehostete Oberfläche `CODENOMAD_ALLOWED_ORIGINS` im Backend auf die vertrauenswürdigen Origins der Oberfläche (Schema, Hostname und Port). Native LAN-Clients müssen bei schreibenden Anfragen einen erlaubten `Origin`-Header mitsenden. Seine HTTPS-Origins erlauben dem Host außerdem, Geräte ohne Tunnel zu koppeln; siehe [Über direktes HTTPS koppeln](remote-control.md#direct-https).

Stellen Sie eine separat gehostete Oberfläche zuerst bereit und laden Sie offene Tabs und Fenster neu, bevor Sie den Server aktualisieren. Stellt der Server die Oberfläche bereit, laden Sie sie nach dem Update neu.

Verwenden Sie eine Loopback-Verbindung für dem Host vorbehaltene Vorgänge: SideCar-Inhalte (`/sidecars/`) und WebSockets, Fernsteuerungsverwaltung (`/api/remote-control/`), Plugin-Brücke (`/api/opencode-plugin/`), Remote-Proxys (`/api/remote-proxy/`), Passwortänderungen und Token-Ersteinrichtung. Diese Vorgänge erfordern auch bei angemeldetem direktem LAN-Zugriff Loopback. Nur SideCars haben eine Ausnahme: Die Host-Einstellung **SideCars über HTTPS öffnen** gibt ihre Inhalte und WebSockets für Browser frei, die über einen vertrauenswürdigen HTTPS-Origin angemeldet sind ([SideCars](browser-sidecars.md#register-sidecar)). Inhalte aktiver Vorschauen (`/previews/`) sind mit einem gültigen Berechtigungstoken über direkten LAN-Zugriff verfügbar.

Die Registrierungs-APIs `/api/sidecars` bleiben für authentifizierte direkte LAN-Clients und gekoppelte Geräte verfügbar. Web-Vorschauen der Fernsteuerung bleiben mit ihrem Berechtigungstoken verfügbar, solange sie auf dem Host aktiviert sind. Hinweise zur Serververwaltung und zur sicheren Eingabe von Zugangsdaten: [Remote-Server speichern](remote-access.md#saved-servers).

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

Das erzeugte Serverzertifikat gilt 30 Tage. Beim Start wird es innerhalb von drei Tagen vor Ablauf, bei fehlenden erforderlichen SANs, fehlgeschlagenen Zertifikatsprüfungen oder fehlender privater Schlüsseldatei erneuert. Die erzeugte CA gilt 365 Tage und wird bei Ablauf, fehlgeschlagenen Zertifikatsprüfungen oder fehlender privater Schlüsseldatei ersetzt; dabei wird auch das Serverzertifikat neu ausgestellt. Clients müssen der Ersatz-CA vertrauen. Es gibt keine kontinuierliche Erneuerung im laufenden Prozess: Planen Sie für Langzeitbereitstellungen einen bewussten Neustart vor Ablauf.

Meldet ein Client eine Zertifikatswarnung, halten Sie an und prüfen Sie Hostname, SANs, Vertrauensspeicher und Ablauf. Deaktivieren Sie keine Prüfung und machen Sie das Wegklicken von Warnungen nicht zum Bereitstellungsverfahren. Vertrauenswürdiges HTTPS ist auch für entfernte Browserfunktionen wie [PWA-Installation und Mikrofonzugriff](mobile.md) erforderlich.

## Remote-Server speichern {#saved-servers}

Authentifizierte Remote-Clients können dieselben gespeicherten Server nutzen und verwalten wie lokale Clients. Für neue Serverpasswörter oder Kopplungslinks ist HTTPS oder Fernsteuerung erforderlich.

Öffnen Sie **Einstellungen → Server**: Fügen Sie eine Adresse oder einen Kopplungslink in **Serveradresse oder -link** ein oder bestätigen Sie die Eingabe mit Enter. Das speichert den Server, ohne ein Projekt zu öffnen. **Server bearbeiten** ändert **URL** oder den optionalen **Name**; Umbenennen bei gleicher URL und TLS-Richtlinie funktioniert offline. Nach der Bestätigung schließt **Entfernen** die Tabs des Servers in diesem Fenster und entfernt seine Einträge aus der Liste der zuletzt verwendeten Projekte. Bei temporären Projekten wählen Sie **Behalten** oder **Verwerfen**; **Verwerfen** löscht ihre Dateien und Unterhaltungen. Andere Projekte und Unterhaltungen bleiben auf dem Server.

Auf dem CodeNomad-Host muss OpenSSH installiert sein, und am Ziel muss CodeNomad bereits laufen. Wählen Sie unter **Einstellungen → Server** die Option **SSH-Server hinzufügen**. Geben Sie die CodeNomad-**URL** aus Sicht des SSH-Hosts und den **SSH-Host (optional)** oder Alias ein, dann **Speichern**. Das Profil lässt sich offline speichern. OpenSSH benötigt Schlüsselauthentifizierung und einen geprüften Hostschlüssel in `known_hosts`. Melden Sie sich am CodeNomad-Server an; HTTPS-Zertifikate werden geprüft.

Der Servereditor enthält das Kontrollkästchen **TLS-Prüfung überspringen**. Das Feld **Serveradresse oder -link** bietet die Option erst nach einem Zertifikatsfehler für diese Adresse an; eine neue Adresse setzt die Auswahl zurück. Bei der Kopplung wird TLS immer geprüft.

Nur wenn `multiBackend` auf `false` gesetzt ist, gelten die folgenden Schritte für separate Desktop-Fenster:

1. **Einstellungen → Remote-Zugriff → Server** → **CodeNomad-Server verbinden**.
2. Geben Sie in **Mit Server verbinden** **Servername** und **Server-URL** mit einer vertrauenswürdigen HTTPS-Origin ein. Lassen Sie **TLS-Verifizierung für selbstsignierte Zertifikate überspringen.** deaktiviert; richten Sie stattdessen Vertrauen ein.
3. Wählen Sie **Speichern** für ein Lesezeichen oder **Verbinden** zum Speichern und Öffnen. Melden Sie sich auf diesem Server an.

Wenn Sie das letzte lokale Fenster schließen, während Remote-Fenster geöffnet bleiben, behält es seine Tabs: **Fenster → Neues Fenster** in einem Remote-Fenster oder ein erneuter Start von CodeNomad öffnet es wieder.

Fügen Sie für Fernsteuerung stattdessen einen frischen Kopplungslink in **Server-URL** ein. Das Lesezeichen behält nur die Tunnel-Origin, nie den Einmal-Kopplungscode; siehe [Fernsteuerung](remote-control.md) zur erneuten Kopplung nach Verlust des Geräte-Cookies.

## Ein Remote-Projekt in einem Tab öffnen {#remote-project-tabs}

Wählen Sie in einem leeren Tab **Durchsuchen** und dann einen Server. Fügen Sie eine Adresse oder einen Kopplungslink in **Serveradresse oder -link** ein. Melden Sie sich bei Bedarf an. Klicken Sie auf einen Ordner, um ihn zu durchsuchen. Drücken Sie im Pfadfeld die Eingabetaste oder wählen Sie **Öffnen**, um ihn zu öffnen. Mit **Zurück zu Durchsuchen** gelangen Sie zur Serverliste.

Lokale und entfernte Projekte teilen sich das Fenster. **Zuletzt verwendete Tabs** zeigt beim Durchsuchen die Einträge des ausgewählten Servers. In der gemischten Liste stehen Serversymbol und Servername bei den hier geöffneten Projekten. [Remote-Tabs wiederherstellen](projects.md#restore-remote-tabs).

Unter **Einstellungen → Server** wählt **Öffnen** den Server in **Durchsuchen** und verwendet einen bereits geöffneten leeren Tab, falls vorhanden.

### `--connect-server` {#connect-server}

`--connect-server <name-or-url>` öffnet unabhängig von `multiBackend` ein separates Remote-Fenster. Geben Sie einen gespeicherten Namen, eine gespeicherte ID oder eine HTTP(S)-URL an. Eine neue URL wird unter ihrem Hostnamen gespeichert. Die URL darf weder Benutzername noch Passwort oder Kopplungscode enthalten. Syntax und Start ohne lokales Fenster stehen in der [Tabelle der Desktop-Startargumente](desktop.md#desktop-cli).
