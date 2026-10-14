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
| Eigenständig, nur HTTPS (Standard) | Nicht aktiviert | `--host` |
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

Setzen Sie Port 9898 oder 9899 nicht voraus: Nicht angegebene Ports können bei Belegung ausweichen. Ein expliziter von null verschiedener `--https-port` oder `--http-port` legt den Port fest und schlägt bei fehlgeschlagener Bindung fehl; `0` fordert eine OS-Zuweisung an. Die ausgegebenen **Local Connection URL** und **Remote Connection URL** sowie aktualisierte **Erreichbare Adressen** sind für diesen Lauf maßgeblich. Siehe die vollständige [Server-CLI-Referenz](server.md).

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

1. Wählen Sie auf der Desktop-Startseite **Server**, dann **Mit Server verbinden**.
2. Geben Sie **Servername** und **Server-URL** mit einer vertrauenswürdigen HTTPS-Origin ein. Lassen Sie **TLS-Verifizierung für selbstsignierte Zertifikate überspringen.** deaktiviert; richten Sie stattdessen Vertrauen ein.
3. Wählen Sie **Speichern** für ein Lesezeichen oder **Verbinden** zum Speichern und Öffnen. Melden Sie sich auf diesem Server an.

Lesezeichen gehören zu dieser CodeNomad-Konfiguration, nicht den Projekten des Remote-Servers. Eine URL zu speichern startet keinen Server und gewährt keinen Zugriff. **Gespeicherten Server entfernen** entfernt das Lesezeichen, nicht entfernte Unterhaltungen, Backend oder Zugangsdaten. Gespeicherte Server lassen sich auch aus **Remote-Server** im Instanz-Schnellstarter öffnen.

Fügen Sie für Fernsteuerung stattdessen einen frischen Kopplungslink in **Server-URL** ein. Das Lesezeichen behält nur die Tunnel-Origin, nie den Einmal-Kopplungscode; siehe [Fernsteuerung](remote-control.md) zur erneuten Kopplung nach Verlust des Geräte-Cookies.
