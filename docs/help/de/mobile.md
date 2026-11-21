# Mobil und PWA

Verwenden Sie die Browseroberfläche auf Telefon oder Tablet, um Arbeit auf dem Backend-Host fortzusetzen. Die PWA-Installation ändert, wie die Oberfläche geöffnet wird, nicht den Ort von Projekten, Zugangsdaten oder Agentenausführung.

## Mit Telefon oder Tablet verbinden {#connect}

Gespeicherte Server sind über **Durchsuchen** im leeren Tab und Einstellungen → Server verfügbar. [Remote-Tabs wiederherstellen](projects.md#restore-remote-tabs).

1. Öffnen Sie auf dem Host **Einstellungen → Remote-Zugriff → Fernsteuerung** und wählen Sie **Fernsteuerung starten**.
2. Scannen Sie den Kopplungs-QR-Code mit Ihrem Mobilgerät und öffnen Sie den Link im Browser, den Sie weiterverwenden möchten.
3. Alternativ konfigurieren Sie [Direktzugriff](remote-access.md), öffnen die erreichbare vertrauenswürdige HTTPS-URL des Hosts und melden sich mit dessen Serverpasswort an.

Fernsteuerung erfordert Gerätekopplung; Direktverbindungen benötigen Routing, erreichbaren Listener und Authentifizierung. Verwenden Sie auf dem Telefon nicht `localhost`, um Ihren Arbeitsplatzrechner zu erreichen. Verlust von Websitedaten oder Profilwechsel kann erneute Anmeldung/Kopplung erfordern; siehe [Fernsteuerung](remote-control.md). Ist der Tunnel blockiert, koppeln Sie stattdessen über eine vertrauenswürdige HTTPS-Adresse; siehe [Über direktes HTTPS koppeln](remote-control.md#direct-https).

## PWA installieren {#install-pwa}

1. Öffnen Sie die funktionierende CodeNomad-URL über vertrauenswürdiges HTTPS in einem Browser mit Installationsunterstützung.
2. Verwenden Sie in Chrome/Edge und ähnlichen Browsern die Installationsaktion in der Adressleiste oder die angebotene Browseraktion **Install CodeNomad**. Verwenden Sie auf iPhone/iPad in Safari **Share → Add to Home Screen**; der genaue Wortlaut hängt von OS/Browser ab.
3. Öffnen Sie den neuen Starter und schließen Sie dort Anmeldung/Kopplung ab, falls dessen Browserspeicher separat ist.

Installation gilt pro Gerät/Browser und Origin. Sie installiert weder Node, Git noch OpenCode auf dem Telefon, startet kein Backend und gewährt keine nativen Desktop-Integrationen. Das Entfernen des Starters löscht keine Host-Unterhaltungen; widerrufen Sie beim Entzug des Zugriffs ein gekoppeltes Gerät separat.

### Sicherer Kontext und Zertifikate {#secure-context}

Entfernte PWA-Installation und Mikrofonzugriff benötigen einen vom Browser anerkannten sicheren Kontext. Verwenden Sie ein vertrauenswürdiges HTTPS-Zertifikat für exakt den Hostnamen/die IP. Ein erzeugtes lokales Zertifikat muss vom Client-Gerät/Browser ausdrücklich als vertrauenswürdig eingestuft werden; Warnseite oder Umgehung sind keine zuverlässige Installationseinrichtung. Browserausnahmen für localhost gelten für dieses Gerät, nicht für eine HTTP-LAN-Adresse eines anderen Hosts.

Deaktivieren Sie zur Installationsreparatur weder Authentifizierung noch TLS-Prüfung.

## Touch-Layouts nutzen {#touch-layout}

Öffnen Sie Navigation und Werkzeuge über **Linke Seitenleiste** und **Rechte Seitenleiste**. In schmalen Layouts überlagern Panels die Unterhaltung, statt eine Desktop-breite Fläche zu erzwingen; ein schwebendes Panel zu öffnen schließt das andere. Die Auswahl einer Sitzung im schwebenden Sitzungspanel schließt es, um Ihre Auswahl zu zeigen, auch bei der bereits angezeigten Sitzung; **Zurück** und **Vorwärts** lassen es geöffnet. Aktionen im Unterhaltungskopf wandern bei Platzmangel ins Überlaufmenü.

Das Eingabefeld behält Agent, Modell und Denken in der Fußzeile. Seine Größe richtet sich nach der Höhe der Unterhaltung ohne Bildschirmtastatur. Bei geöffneter Tastatur kann das Feld vorübergehend kleiner werden, damit Bedienelemente und Nachrichten erreichbar bleiben. Das gespeicherte Höhenverhältnis bleibt dabei unverändert. Lange Entwürfe bleiben scrollbar. Auf reinen Touch-Geräten öffnet Senden die Bildschirmtastatur nicht erneut, damit Sie die Antwort lesen können; tippen Sie zum Fortfahren auf das Eingabefeld. Während eine Sitzung läuft, bietet das Menü **Weitere Aktionen** des Eingabefelds **Nachricht einreihen** oder **Jetzt einschieben** an, je nachdem, was Ihr normales Senden nicht tut, ohne ein Tastenkürzel einer Hardwaretastatur zu benötigen. Eine Unterbrechung verkleinert das Eingabefeld vorübergehend, ohne gespeicherte Höhe oder Entwurf zu ändern. Beantworten Sie Berechtigungen/Fragen im Dock darüber und halten Sie dessen Aktionsfußzeile erreichbar. Siehe [Unterhaltungen](conversations.md) und [Berechtigungen](permissions.md).

## Fähigkeits- und Verbindungsgrenzen {#limits}

| Funktion | Mobiler Browser / PWA |
| --- | --- |
| Projekte, Unterhaltungen, Dateien und Berechtigungen | Arbeiten auf dem verbundenen Backend-Host unter dessen Zugriffskontrollen. Geräteanhänge werden vom Telefon hochgeladen; Projektreferenzen auf dem Host aufgelöst. |
| Native Desktop-Fenster, OS-Menüs und hostnative Automatisierung | Werden nicht durch PWA-Installation bereitgestellt. |
| Browser-Vorschau | Erhält keine nativen Gastbrowserfähigkeiten; Ersatzdarstellung bleibt browserbegrenzt. |
| SideCar-Inhalte und WebSockets | Hängen vom Verbindungsweg ab; Fernsteuerung blockiert den SideCar-Inhaltsproxy und liefert Web-Vorschauen samt WebSockets aus, solange der Host sie erlaubt. Siehe deren [genaue Einschränkungen](remote-control.md). |
| Mikrofon, Zwischenablage, Benachrichtigungen und Installationsaufforderung | Hängen von Browser-/OS-Unterstützung, sicherem Kontext und Benutzerrechten ab. |
| Offline-Arbeit | Kein Offline-Backend und kein zwischengespeicherter API-Verlauf. Statische Oberflächendateien können im Cache liegen, Dokumente und API-Antworten sind aber kein Offline-Arbeitsbereich. |

Halten Sie das Backend erreichbar. Prüfen Sie vor Wiederholung, ob eine Aktion abgeschlossen wurde. PWA-Schließen stoppt kein eigenständiges Backend; das Beenden der Host-Desktop-App samt Backend macht Fernsteuerung bis zum nächsten Start unverfügbar.

Jeder Browser-Tab, auch die installierte PWA, behält für diesen Tab geöffnete Projekte, ausgewählte Unterhaltungen, nicht gesendete Entwürfe und Scrollpositionen: Sie kehren zurück, wenn die Seite neu lädt oder das mobile Betriebssystem sie nach einem App-Wechsel oder einer Bildschirmsperre neu lädt. Ein neuer Tab oder eine vom Betriebssystem vollständig geschlossene PWA öffnet einen leeren Tab. Schalten Sie dies für den Tab unter **Einstellungen → Allgemein → Vorherigen Zustand wiederherstellen** aus.
