# Fernsteuerung

Fernsteuerung ermöglicht einem gekoppelten Browser- oder Desktop-Client die Nutzung Ihres laufenden CodeNomad-Backends ohne eingehenden Netzwerkport. Sie benötigt weder Serverpasswort, ein nicht an Loopback gebundenes `--host` noch VPN. Dies ist ein separater Zugriffsweg gegenüber [direkten Verbindungen](remote-access.md).

## Starten und koppeln {#start-and-pair}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff**.
2. Wählen Sie **Fernsteuerung starten**. Warten Sie auf **Bereit für Remote-Verbindungen**; erstmalige Bereitstellung von Tunnelidentität und Zertifikat kann dauern.
3. Scannen Sie unter **Weiteres Gerät verbinden** den QR-Code oder wählen Sie **Link kopieren** und öffnen Sie diesen Einmallink auf dem vorgesehenen Gerät.
4. Behalten Sie die Websitedaten des gekoppelten Browsers. Öffnen Sie die Tunneladresse erneut zur Wiederverbindung, solange das Backend läuft.

Der Link gilt **fünf Minuten** und funktioniert **einmal**. Behandeln Sie ihn als Zugangsdaten: Wer ihn einlöst, kann ein gekoppeltes Gerät werden. Der Code steht im URL-Fragment, nicht in der Abfragezeichenfolge. **Neuen Kopplungslink erstellen** macht den vorherigen ungenutzten Link sofort ungültig. Das Backend-Ende storniert den offenen Kopplungslink; Stop und Tunnelfehler stornieren einen Tunnel-Link.

Fügen Sie auf dem anderen Computer den Kopplungslink in **Einstellungen → Server → Serveradresse oder -link** ein.

Fügen Sie zum erneuten Koppeln den neuen Link in das Anmeldeformular des Servers oder Projekts ein.

## Über direktes HTTPS koppeln {#direct-https}

Wenn der Tunnel blockiert ist, das Backend aber über vertrauenswürdiges HTTPS erreichbar ist, etwa über einen Reverse-Proxy mit echtem Zertifikat, können Geräte stattdessen über diese Adresse koppeln. Zulässig sind die eigenen HTTPS-Adressen dieses Backends und die HTTPS-Origins in `CODENOMAD_ALLOWED_ORIGINS` (siehe [Erlaubte Ursprünge](remote-access.md#upgrading)); Loopback-Namen und einfaches HTTP koppeln nie. Die Fernsteuerung muss nicht gestartet sein.

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff → Fernsteuerung**.
2. Wählen Sie unter **Direkte HTTPS-Kopplung** bei mehreren Einträgen die **HTTPS-Adresse** und dann **HTTPS-Kopplungslink erstellen**.
3. Öffnen Sie den Link auf dem Gerät wie einen Tunnel-Link. Sie können ihn auf einer anderen Seite anklicken.

Für den Link gelten dieselben Regeln (fünf Minuten, einmalig); er ersetzt jeden ungenutzten Link, und wiederholte falsche Codes werden gedrosselt. Ein Reverse-Proxy muss vertrauenswürdiges TLS terminieren, die ursprünglichen Header `Host` und `Origin` weitergeben und das Backend über Loopback oder ein geschütztes Netz erreichen.

Ein solches Gerät verbindet sich nur über seine HTTPS-Adresse, nie über den Tunnel, und **Gekoppelte Geräte** zeigt diese Adresse unter seinem Namen. Das Beenden der Fernsteuerung storniert den Link nicht und trennt diese Geräte nicht; **Widerrufen**, 30 Tage ohne Nutzung, das Limit von 32 Geräten oder das Entfernen der Adresse aus der Konfiguration beenden ihren Zugriff. Ein Browser mit widerrufenen oder abgelaufenen Gerätezugangsdaten für diese Adresse kann nicht auf das Serverpasswort ausweichen: Koppeln Sie erneut oder löschen Sie die Websitedaten, um sich mit dem Passwort anzumelden.

Siehe [verfügbare Funktionen](#remote-surface), einschließlich der direkten HTTPS-Ausnahme für SideCar-Inhalte. Die Kopplung erteilt keine Loopback-Rechte, auch nicht über einen Proxy auf dem Host.

## Gekoppelte Geräte verwalten {#paired-devices}

1. Kehren Sie auf dem Host zu **Einstellungen → Remote-Zugriff → Fernsteuerung** zurück.
2. Prüfen Sie **Gekoppelte Geräte** und deren **Zuletzt gesehen:**-Zeit. Jedes Gerät ist nach der Plattform und dem Browser benannt, die es gekoppelt haben, etwa `iPhone · Safari`.
3. Wählen Sie **Widerrufen** für ein Gerät, das nicht länger zugreifen soll. Steht dort **Widerruf ausstehend**, wählen Sie vor dem Neustart des Hosts erneut **Widerrufen**.

Widerruf beendet aktuelle HTTP-/SSE-Verbindungen des Geräts sowie zukünftigen Zugriff. Koppeln Sie zum Wiederherstellen mit einem neuen Link. Ein Gerät verfällt nach **30 Tagen ohne Nutzung**. Bei der **Grenze von 32 Geräten** ersetzt eine neue Kopplung das am längsten nicht gesehene Gerät und schließt dessen Verbindungen.

Websitedaten löschen, Browserprofile wechseln oder privates Surfen kann erneute Kopplung erfordern.

Eine Änderung des Direktzugriffspassworts widerruft Geräte **nicht**. **Fernsteuerung beenden** trennt den Tunnel, behält aber die Geräteliste; verwenden Sie **Widerrufen**, um die Berechtigung zu entfernen.

### Ohne Positionsverlust erneut koppeln {#re-pair}

1. Zeigt der Client **Dieses Gerät erneut koppeln**, lassen Sie diese Seite offen.
2. Erstellen Sie auf dem Host einen Link für die ursprüngliche Verbindung: **Neuen Kopplungslink erstellen** für den Tunnel oder unter **Direkte HTTPS-Kopplung** die ursprüngliche **HTTPS-Adresse** wählen und dann **HTTPS-Kopplungslink erstellen**. Öffnen Sie den Link im **selben Client-Browser/-Profil**. Ein separates Remote-Fenster verwendet seinen vorhandenen Speicher.
3. Kehren Sie zur wartenden Seite zurück und wählen Sie **Verbindung prüfen**; sie prüft auch erneut, wenn die Seite wieder den Fokus erhält.

Die Wiederherstellung bewahrt die geöffnete Seite und Entwürfe; sie wiederholt keine fehlgeschlagene Aktion. Prüfen Sie vor Wiederholung, ob Senden, Antworten oder Löschen wirksam war. Ein Direktzugriffspasswort kann die Fernsteuerungskopplung nicht wiederherstellen.

## Verfügbarkeit und Lebensdauer {#lifetime}

| Aktion/Zustand | Wirkung |
| --- | --- |
| Fernsteuerung starten | Verbindet dieses Backend und merkt die Auswahl für künftige Starts. |
| Remote-Browser schließen | Stoppt weder Host-Backend noch widerruft es das Gerät. |
| Fernsteuerung beenden | Trennt den Tunnelzugriff und löscht automatisches Fortsetzen beim Start; behält Gerätedatensätze. |
| Backend-Ende / letztes Desktop-Fenster schließt und App endet | Fernsteuerung geht offline. OpenCodes gemeinsamer Dienst kann weiterlaufen, kann diese Oberfläche aber nicht durch ein gestopptes Backend bereitstellen. |
| Start nach aktiviert gelassener Fernsteuerung | Verbindet im Hintergrund ohne neuen Kopplungslink. Niemals gestartete Installationen aktivieren sich nicht selbst. |

Automatisches Fortsetzen beim Start ist auf ein Backend pro Konfigurationsverzeichnis begrenzt. Starten Sie keine konkurrierenden Hosts mit gleicher Konfiguration für zusätzliche Tunnelkapazität. Soll ein Host nach Desktop-Ende erreichbar bleiben, betreiben Sie einen separat verwalteten [eigenständigen Server](server.md); Fernsteuerung ist kein unabhängiger Daemon.

## Verfügbare und nicht verfügbare Oberflächen {#remote-surface}

Gekoppelte Geräte können normale Projekt-/Unterhaltungs-APIs verwenden, Prompts senden, Dateien prüfen und Berechtigungen/Forms unter denselben Zugehörigkeitsprüfungen beantworten. Kopplung ist mächtiger Zugriff, kein schreibgeschützter Freigabelink. Sie gewährt niemals Loopback-Rechte, auch wenn der Tunnel intern auf dem Host weiterleitet.

| Oberfläche | Über Fernsteuerung |
| --- | --- |
| Normale authentifizierte Oberfläche, Arbeitsbereiche, Unterhaltungen und SSE | Für gekoppelte Geräte verfügbar. |
| Passwortanmeldung/-abmeldung, Passwortänderungen, lokale Token-Ersteinrichtung | Nicht verfügbar; Gerätezugangsdaten sind auch bei deaktivierter direkter Authentifizierung nötig. |
| Fernsteuerungsstatus | Für gekoppelte Geräte lesbar; Verwaltung nicht verfügbar. Start/Stop, Kopplungserstellung, Geräteliste und Widerruf bleiben auf dem Host-Zugriffsweg. |
| Gespeicherte Server und Backend-Relay | Authentifizierte Remote-Clients können alle Host-Server nutzen/verwalten, wenn Funktion und Host-Fähigkeiten dies erlauben. Neue Serverpasswörter/Kopplungslinks erfordern Fernsteuerung oder HTTPS statt unverschlüsseltem LAN-HTTP. Siehe [gespeicherte Server](remote-access.md#saved-servers). |
| Desktop-Remote-Fenster und Fenster-Proxy | Nur auf dem Host (`/api/remote-proxy/`). |
| SideCar-Inhalte und WebSockets (`/sidecars/`) | Über den Tunnel nicht verfügbar. Nutzen Sie Loopback oder aktivieren Sie den [direkten HTTPS-Zugriff auf SideCars](browser-sidecars.md#register-sidecar) auf dem Host. |
| SideCar-Registrierung (`/api/sidecars`) | Für gekoppelte Geräte und authentifizierte direkt verbundene Clients verfügbar. |
| Inhalt der Web-Vorschau | [Sitzungsbrowser öffnen](browser-sidecars.md#session-browser) |
| Automatisierungsbrücke | Nicht verfügbar (`/api/opencode-plugin/`). Native Desktop-Fähigkeiten werden nicht zu Browserfähigkeiten. |
| WebSocket-Upgrades | Für Web-Vorschauen und auf gekoppelten Geräten für [Live-Sprachgespräche](voice.md#conversation) verfügbar. |

Verwenden Sie eine Loopback-Verbindung auf dem Host für hostgebundene Proxy-/WebSocket-Funktionen und die Fernsteuerungsverwaltung (`/api/remote-control/`). Auch direkter LAN-Zugriff erfordert dafür Loopback; siehe [Erlaubte Ursprünge](remote-access.md#upgrading).

## Relay und Datenschutz {#relay-privacy}

CodeNomad verwendet [OpenTunnel](https://github.com/anomalyco/opentunnel) und beansprucht eine zufällige Route auf der gemeinsamen Standard-Tunnelidentität des Rechners.

TLS endet im CodeNomad-Backend. Das Relay leitet Chiffretext weiter und kann Anwendungsinhalte nicht lesen, aber Hostnamen, Verbindungszeiten und Datenmengen beobachten. Tunnelzertifikat und privater Schlüssel bleiben auf dem Host. Schützen Sie Tunnelspeicher und CodeNomad-Konfiguration des Hosts wie Zugangsdaten; eine nicht erratbare Adresse ist keine Autorisierung.

`CODENOMAD_REMOTE_CONTROL_API` wählt eine selbst gehostete OpenTunnel-API; ohne Wert gilt der gehostete Dienst. Dies ändert die Tunnelbereitstellung, nicht Kopplungsanforderungen oder blockierte Oberflächen. Zum Umgang mit Zugangsdaten und Diagnosen siehe [Sicherheit](security.md).

## Administratorrichtlinie {#administrator-policy}

Ein Administrator kann die Fernsteuerung für alle Benutzer eines Computers ausschalten: Setzen Sie die Umgebungsvariable `CODENOMAD_REMOTE_CONTROL=disabled` systemweit und starten Sie CodeNomad neu. Das Backend verbindet dann nie einen Tunnel, lehnt **Fernsteuerung starten** und Kopplungslinks ab und verbindet sich beim Start nicht erneut; die Einstellungen zeigen **Vom Administrator deaktiviert**. Zuvor gekoppelte Geräte können sich nicht verbinden und bleiben zum Widerrufen aufgelistet. Nicht gesetzt oder leer bedeutet keine Richtlinie; jeder andere Wert, auch nur Leerzeichen, verhindert den Start des Backends.
