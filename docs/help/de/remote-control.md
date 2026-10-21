# Fernsteuerung

Fernsteuerung ermöglicht einem gekoppelten Browser- oder Desktop-Client die Nutzung Ihres laufenden CodeNomad-Backends ohne eingehenden Netzwerkport. Sie benötigt weder Serverpasswort, ein nicht an Loopback gebundenes `--host` noch VPN. Dies ist ein separater Zugriffsweg gegenüber [direkten Verbindungen](remote-access.md).

## Starten und koppeln {#start-and-pair}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff**.
2. Wählen Sie **Fernsteuerung starten**. Warten Sie auf **Bereit für Remote-Verbindungen**; erstmalige Bereitstellung von Tunnelidentität und Zertifikat kann dauern.
3. Scannen Sie unter **Weiteres Gerät verbinden** den QR-Code oder wählen Sie **Link kopieren** und öffnen Sie diesen Einmallink auf dem vorgesehenen Gerät.
4. Behalten Sie die Websitedaten des gekoppelten Browsers. Öffnen Sie die Tunneladresse erneut zur Wiederverbindung, solange das Backend läuft.

Der Link gilt **fünf Minuten** und funktioniert **einmal**. Behandeln Sie ihn als Zugangsdaten: Wer ihn einlöst, kann ein gekoppeltes Gerät werden. Der Code steht im URL-Fragment, nicht in der Abfragezeichenfolge. **Neuen Kopplungslink erstellen** macht den vorherigen ungenutzten Link sofort ungültig. Stop, Backend-Ende und Tunnelfehler stornieren offene Kopplungslinks.

Um einen weiteren CodeNomad-Desktop zu koppeln, wählen Sie auf dessen Startseite **CodeNomad-Server verbinden**, fügen den Link in **Server-URL** ein und wählen **Verbinden**. Ein Kopplungslink öffnet sein Fenster auch über **Speichern**, weil das Öffnen den Code einlöst. Nur die Tunnel-Origin wird als Lesezeichen gespeichert; der Code bleibt nicht erhalten. TLS-Prüfung bleibt für Kopplungslinks aktiviert.

## Gekoppelte Geräte verwalten {#paired-devices}

1. Kehren Sie auf dem Host zu **Einstellungen → Remote-Zugriff → Fernsteuerung** zurück.
2. Prüfen Sie **Gekoppelte Geräte** und deren **Zuletzt gesehen:**-Zeit. Jedes Gerät ist nach der Plattform und dem Browser benannt, die es gekoppelt haben, etwa `iPhone · Safari`.
3. Wählen Sie **Widerrufen** für ein Gerät, das nicht länger zugreifen soll.

Widerruf beendet aktuelle HTTP-/SSE-Verbindungen des Geräts sowie zukünftigen Zugriff. Koppeln Sie zum Wiederherstellen mit einem neuen Link. Ein Gerät verfällt nach **30 Tagen ohne Nutzung**. Bei der **Grenze von 32 Geräten** ersetzt eine neue Kopplung das am längsten nicht gesehene Gerät und schließt dessen Verbindungen.

Das Backend speichert Zugangsdaten-Hashes, keine Rohzugangsdaten, in `remote-control-devices.json` unter seiner Konfigurationsbasis. Der Client hält ein hostbezogenes Geräte-Cookie mit `Secure`, `HttpOnly`, `SameSite=Lax`. Dessen Browserlebensdauer kann die serverseitige 30-Tage-Inaktivitätsgrenze übersteigen; maßgeblich bleibt das Register. Websitedaten löschen, Browserprofile wechseln oder privates Surfen kann erneute Kopplung erfordern.

Eine Änderung des Direktzugriffspassworts widerruft Geräte **nicht**. **Fernsteuerung beenden** trennt den Tunnel, behält aber die Geräteliste; verwenden Sie **Widerrufen**, um die Berechtigung zu entfernen.

### Ohne Positionsverlust erneut koppeln {#re-pair}

1. Zeigt der Client **Dieses Gerät erneut koppeln**, lassen Sie diese Seite offen.
2. Wählen Sie auf dem Host **Neuen Kopplungslink erstellen** und öffnen Sie ihn im **selben Client-Browser/-Profil**. Verbinden Sie bei gespeichertem Desktop-Server mit dem frischen Link neu, damit der vorhandene Remote-Fensterspeicher wiederverwendet wird.
3. Kehren Sie zur wartenden Seite zurück und wählen Sie **Verbindung prüfen**; sie prüft auch erneut, wenn die Seite wieder den Fokus erhält.

Die Wiederherstellung bewahrt die geöffnete Seite und Entwürfe; sie wiederholt keine fehlgeschlagene Aktion. Prüfen Sie vor Wiederholung, ob Senden, Antworten oder Löschen wirksam war. Ein Direktzugriffspasswort kann die Fernsteuerungskopplung nicht wiederherstellen.

## Verfügbarkeit und Lebensdauer {#lifetime}

| Aktion/Zustand | Wirkung |
| --- | --- |
| Fernsteuerung starten | Verbindet dieses Backend und merkt die Auswahl für künftige Starts. |
| Remote-Browser schließen | Stoppt weder Host-Backend noch widerruft es das Gerät. |
| Fernsteuerung beenden | Trennt den Zugriff und löscht automatisches Fortsetzen beim Start; behält Gerätedatensätze. |
| Backend-Ende / letztes Desktop-Fenster schließt und App endet | Fernsteuerung geht offline. OpenCodes gemeinsamer Dienst kann weiterlaufen, kann diese Oberfläche aber nicht durch ein gestopptes Backend bereitstellen. |
| Start nach aktiviert gelassener Fernsteuerung | Verbindet im Hintergrund ohne neuen Kopplungslink. Niemals gestartete Installationen aktivieren sich nicht selbst. |
| Fehlgeschlagenes Fortsetzen oder schwerer Tunnelfehler | Gemerkte Auswahl bleibt und der Host zeigt den Fehler; das Aktualisieren-Symbol der Fernsteuerungskarte liest ihren Zustand erneut. **Fernsteuerung starten** versucht es sofort erneut; **Fernsteuerung beenden** löscht die Auswahl. Andernfalls versucht es ein späterer Start erneut. |

Automatisches Fortsetzen beim Start ist auf ein Backend pro Konfigurationsverzeichnis begrenzt. Starten Sie keine konkurrierenden Hosts mit gleicher Konfiguration für zusätzliche Tunnelkapazität. Soll ein Host nach Desktop-Ende erreichbar bleiben, betreiben Sie einen separat verwalteten [eigenständigen Server](server.md); Fernsteuerung ist kein unabhängiger Daemon.

## Verfügbare und nicht verfügbare Oberflächen {#remote-surface}

Gekoppelte Geräte können normale Projekt-/Unterhaltungs-APIs verwenden, Prompts senden, Dateien prüfen und Berechtigungen/Forms unter denselben Zugehörigkeitsprüfungen beantworten. Kopplung ist mächtiger Zugriff, kein schreibgeschützter Freigabelink. Sie gewährt niemals Loopback-Rechte, auch wenn der Tunnel intern auf dem Host weiterleitet.

| Oberfläche | Über Fernsteuerung |
| --- | --- |
| Normale authentifizierte Oberfläche, Arbeitsbereiche, Unterhaltungen und SSE | Für gekoppelte Geräte verfügbar. |
| Passwortanmeldung/-abmeldung, Passwortänderungen, lokale Token-Ersteinrichtung | Nicht verfügbar; Gerätezugangsdaten sind auch bei deaktivierter direkter Authentifizierung nötig. |
| Fernsteuerungsstatus | Für gekoppelte Geräte lesbar; Verwaltung nicht verfügbar. Start/Stop, Kopplungserstellung, Geräteliste und Widerruf bleiben auf dem Host-Zugriffsweg. |
| Desktop-Remote-Fenster-/Serververwaltung und Proxy-Routen | Nicht verfügbar (`/api/remote-servers/`, `/api/remote-proxy/`). |
| SideCar-**Inhaltsproxy** | Nicht verfügbar (`/sidecars/`). Dies bedeutet **nicht**, dass alle SideCar-APIs blockiert sind: Gekoppelte Clients können weiterhin die Registrierungs-APIs `/api/sidecars` nutzen. |
| Vorschauinhalt und Automatisierungsbrücke | Nicht verfügbar (`/previews/`, `/api/opencode-plugin/`). Native Desktop-Fähigkeiten werden nicht zu Browserfähigkeiten. |
| WebSocket-Upgrades | Am Fernsteuerungseingang nicht verfügbar. |

Verwenden Sie eine entsprechend geschützte [Direktverbindung](remote-access.md), wenn ein Ablauf eine blockierte Proxy-/WebSocket-Oberfläche benötigt. Fernsteuerung wechselt nicht automatisch dorthin.

## Relay und Datenschutz {#relay-privacy}

CodeNomad verwendet [OpenTunnel](https://github.com/anomalyco/opentunnel) und beansprucht eine zufällige Route auf der gemeinsamen Standard-Tunnelidentität des Rechners. Stoppen gibt CodeNomads Brücke frei, nicht die von anderen Anwendungen verwendete gemeinsame Identität.

TLS endet im CodeNomad-Backend. Das Relay leitet Chiffretext weiter und kann Anwendungsinhalte nicht lesen, aber Hostnamen, Verbindungszeiten und Datenmengen beobachten. Tunnelzertifikat und privater Schlüssel bleiben auf dem Host. Schützen Sie Tunnelspeicher und CodeNomad-Konfiguration des Hosts wie Zugangsdaten; eine nicht erratbare Adresse ist keine Autorisierung.

`CODENOMAD_REMOTE_CONTROL_API` wählt eine selbst gehostete OpenTunnel-API; ohne Wert gilt der gehostete Dienst. Dies ändert die Tunnelbereitstellung, nicht Kopplungsanforderungen oder blockierte Oberflächen. Zum Umgang mit Zugangsdaten und Diagnosen siehe [Sicherheit](security.md).
