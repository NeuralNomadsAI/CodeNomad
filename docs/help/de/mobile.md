# Mobil und PWA

Verwenden Sie die Browseroberfläche auf Telefon oder Tablet, um Arbeit auf dem Backend-Host fortzusetzen. Die PWA-Installation ändert, wie die Oberfläche geöffnet wird, nicht den Ort von Projekten, Zugangsdaten oder Agentenausführung.

## Mit Telefon oder Tablet verbinden {#connect}

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff → Fernsteuerung** und wählen Sie **Fernsteuerung starten**.
2. Scannen Sie den Kopplungs-QR-Code mit Ihrem Mobilgerät und öffnen Sie den Link im Browser, den Sie weiterverwenden möchten.
3. Alternativ konfigurieren Sie [Direktzugriff](remote-access.md), öffnen die erreichbare vertrauenswürdige HTTPS-URL des Hosts und melden sich mit dessen Serverpasswort an.

Fernsteuerung erfordert Gerätekopplung; Direktverbindungen benötigen Routing, erreichbaren Listener und Authentifizierung. Verwenden Sie auf dem Telefon nicht `localhost`, um Ihren Arbeitsplatzrechner zu erreichen. Verlust von Websitedaten oder Profilwechsel kann erneute Anmeldung/Kopplung erfordern; siehe [Fernsteuerung](remote-control.md).

## PWA installieren {#install-pwa}

1. Öffnen Sie die funktionierende CodeNomad-URL über vertrauenswürdiges HTTPS in einem Browser mit Installationsunterstützung.
2. Verwenden Sie in Chrome/Edge und ähnlichen Browsern die Installationsaktion in der Adressleiste oder die angebotene Browseraktion **Install CodeNomad**. Verwenden Sie auf iPhone/iPad in Safari **Share → Add to Home Screen**; der genaue Wortlaut hängt von OS/Browser ab.
3. Öffnen Sie den neuen Starter und schließen Sie dort Anmeldung/Kopplung ab, falls dessen Browserspeicher separat ist.

Installation gilt pro Gerät/Browser und Origin. Sie installiert weder Node, Git noch OpenCode auf dem Telefon, startet kein Backend und gewährt keine nativen Desktop-Integrationen. Das Entfernen des Starters löscht keine Host-Unterhaltungen; widerrufen Sie beim Entzug des Zugriffs ein gekoppeltes Gerät separat.

### Sicherer Kontext und Zertifikate {#secure-context}

Entfernte PWA-Installation und Mikrofonzugriff benötigen einen vom Browser anerkannten sicheren Kontext. Verwenden Sie ein vertrauenswürdiges HTTPS-Zertifikat für exakt den Hostnamen/die IP. Ein erzeugtes lokales Zertifikat muss vom Client-Gerät/Browser ausdrücklich als vertrauenswürdig eingestuft werden; Warnseite oder Umgehung sind keine zuverlässige Installationseinrichtung. Browserausnahmen für localhost gelten für dieses Gerät, nicht für eine HTTP-LAN-Adresse eines anderen Hosts.

Fehlt die Installation, prüfen Sie zuerst HTTPS-Vertrauen und Browserunterstützung und öffnen Sie dann die Seite im vollständigen Browser statt im eingebetteten QR-/In-App-Browser. Prüfen Sie bei Mikrofonfehlern Browser-/OS-Websiteberechtigungen und [Sprache](voice.md). Deaktivieren Sie zur Installationsreparatur weder Authentifizierung noch TLS-Prüfung.

## Touch-Layouts nutzen {#touch-layout}

Öffnen Sie Navigation und Werkzeuge über **Linke Seitenleiste** und **Rechte Seitenleiste**. In schmalen Layouts überlagern Panels die Unterhaltung, statt eine Desktop-breite Fläche zu erzwingen; ein schwebendes Panel zu öffnen schließt das andere. Aktionen im Unterhaltungskopf wandern bei Platzmangel ins Überlaufmenü.

Das Eingabefeld behält Agent, Modell und Denken in der Fußzeile. Seine Größe folgt der sichtbaren Unterhaltung einschließlich Bildschirmtastatur; lange Entwürfe bleiben scrollbar. Eine Unterbrechung verkleinert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Beantworten Sie Berechtigungen/Fragen im Dock darüber und halten Sie dessen Aktionsfußzeile erreichbar. Siehe [Unterhaltungen](conversations.md) und [Berechtigungen](permissions.md).

## Fähigkeits- und Verbindungsgrenzen {#limits}

| Funktion | Mobiler Browser / PWA |
| --- | --- |
| Projekte, Unterhaltungen, Dateien und Berechtigungen | Arbeiten auf dem verbundenen Backend-Host unter dessen Zugriffskontrollen. Geräteanhänge werden vom Telefon hochgeladen; Projektreferenzen auf dem Host aufgelöst. |
| Native Desktop-Fenster, OS-Menüs und hostnative Automatisierung | Werden nicht durch PWA-Installation bereitgestellt. |
| Browser-Vorschau | Erhält keine nativen Gastbrowserfähigkeiten; Ersatzdarstellung bleibt browserbegrenzt. |
| SideCar-Inhalte und WebSockets | Hängen vom Verbindungsweg ab; Fernsteuerung blockiert SideCar-Inhaltsproxy, Vorschauinhalte und WebSocket-Upgrades. Siehe deren [genaue Einschränkungen](remote-control.md). |
| Mikrofon, Zwischenablage, Benachrichtigungen und Installationsaufforderung | Hängen von Browser-/OS-Unterstützung, sicherem Kontext und Benutzerrechten ab. |
| Offline-Arbeit | Kein Offline-Backend und kein zwischengespeicherter API-Verlauf. Statische Oberflächendateien können im Cache liegen, Dokumente und API-Antworten sind aber kein Offline-Arbeitsbereich. |

Halten Sie das Backend erreichbar. Mobile OS-Suspendierung oder Netzwerkwechsel kann den Ereignisstrom trennen; Rückkehr verbindet neu und liest aktuellen Zustand ohne garantierte Ereigniswiederholung. Prüfen Sie vor Wiederholung, ob eine Aktion abgeschlossen wurde. PWA-Schließen stoppt kein eigenständiges Backend; das Beenden der Host-Desktop-App samt Backend macht Fernsteuerung bis zum nächsten Start unverfügbar.
