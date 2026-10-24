# Panel-Erweiterungen

## Installierte und Online-Erweiterungen durchsuchen {#browse}

1. Öffnen Sie **Rechtes Panel anpassen** in der rechten Panel-Tableiste.
2. Klappen Sie **Erweiterungen** unter der Trennlinie auf.
3. Verwenden Sie **Erweiterungen suchen** für die gemeinsame Liste installierter Add-ons und des offiziellen Online-Katalogs. Zeigen Sie auf einen Eintrag oder fokussieren Sie ihn für Metadaten.

Der Abschnitt beginnt bei jedem Öffnen des Anpassungs-Popups eingeklappt. Installierte und Online-Einträge werden nach Erweiterungs-ID zusammengeführt; es gibt weder separates Verwaltungsfenster noch Installiert-/Online-Modus. Das Durchsuchen von Katalogmetadaten lädt oder startet keinen Panel-Code des Autors. Der Katalog wird in [CodeNomad Extensions](https://github.com/NeuralNomadsAI/CodeNomad-Extensions) gepflegt; Aufnahme und angegebene Autorennamen sind weder Signaturen noch Vertrauensbeweis.

Ist der Katalog nicht verfügbar, bleiben installierte Erweiterungen und **Aus ZIP installieren…** verfügbar. Aktualisieren Sie zur erneuten Suche. Einklappen/Schließen des Popups verwirft dessen offene Prüf-/Bestätigungsoberfläche; es installiert nichts stillschweigend.

## Prüfen und deaktiviert installieren {#install}

1. Wählen Sie **Installieren…** an einem Katalogeintrag oder **Aus ZIP installieren…** für ein separat beschafftes Paket.
2. Prüfen Sie Paket-ID, Autor, Repository, Version, API/Berechtigungen und SHA-256-Digest. Klappen Sie technische Details bei Bedarf auf.
3. Prüfen Sie den Herausgeber und vergleichen Sie den Digest, soweit verfügbar, über einen vertrauenswürdigen Kanal.
4. Wählen Sie nur bei Vertrauen in den Code **Ich vertraue diesem Paket und seinem Autor**, dann **Deaktiviert installieren**.

Prüfung lädt/validiert das gewählte Paket erneut; dabei wird kein Autorencode ausgeführt. Ein Digest identifiziert exakte Bytes, nicht die Autorenidentität. Katalogpakete stammen aus exakt der erklärten GitHub-Release-Datei, nicht aus beliebiger URL. Manuelle Pakete sind ZIPs mit ausschließlich `manifest.json` und eigenständigem `panel.html`; ungültige oder nicht unterstützte Pakete werden abgelehnt.

Installation benötigt keinen OpenCode-Neustart und gewährt niemals automatisch Aktivierung. Fehlgeschlagene Validierung, Konflikt oder Speicheroperation erlaubt keinen Wiederholungsversuch mit anderen Bytes. Prüfen Sie das Paket vor einer neuen Installation erneut.

## Aktivieren und Geltungsbereich verstehen {#activate-scope}

1. Kehren Sie zur Add-on-Zeile über dem Abschnitt **Erweiterungen** in **Rechtes Panel anpassen** zurück. Installierte deaktivierte Add-ons bleiben in dieser Liste.
2. Aktivieren Sie das Kontrollkästchen zur Aktivierung. Deaktivieren Sie dasselbe Kontrollkästchen zum Abschalten.

Dieses Kontrollkästchen ist die einzige Aktivierungssteuerung: Es gibt keinen zusätzlichen Verwaltungsschalter oder fensterbezogene Sichtbarkeitssperre. Aktivierung gilt konfigurationsweit über Projekte hinweg, nicht pro Ordner. Bei Remote-Verbindung betrifft sie den Erweiterungsspeicher des Servers, nicht nur Ihr Anzeigegerät.

Der Erweiterungsspeicher ist `panel-extensions/` neben der ausgewählten CodeNomad-Konfiguration. Separate Desktop-Datenprofile isolieren Erweiterungen **nicht**, wenn diese Profile dasselbe Konfigurationsverzeichnis verwenden. Umgekehrt erlaubt das Öffnen einer anderen Konfiguration nicht die Ausführung eines anderswo installierten Add-ons. Die Unterscheidung erläutert [Desktop-Fenster und Daten](desktop.md).

Ein aktiviertes Panel kann bei Auswahl eingebunden werden; Ausblenden kann dessen vorübergehenden Oberflächenzustand freigeben. Deaktivieren widerruft die Aktivierung. **Zurücksetzen** in der Anpassung stellt nur integriertes Layout wieder her und aktiviert, deaktiviert oder deinstalliert keine Erweiterungen.

## Ersetzen oder entfernen {#replace-remove}

1. Verwenden Sie **Version ändern…** oder prüfen Sie eine andere ZIP mit derselben ID zum Ersetzen eines installierten Pakets.
2. Prüfen Sie neuen Digest und Berechtigungen, bestätigen Sie Vertrauen und installieren Sie deaktiviert.
3. Reaktivieren Sie über das normale Kontrollkästchen erst nach Ihrer Entscheidung, dem Ersatz zu vertrauen.
4. Verwenden Sie zum Deinstallieren **Entfernen…** und **Entfernen bestätigen** nach Zielprüfung.

Jeder Ersatz widerruft die Aktivierung in allen Projekten, selbst bei unveränderter Berechtigungsliste. Validierungs-/Konflikt-/Speicherfehler erhalten das installierte Paket. Es gibt keine stillen Erweiterungsupdates. Entfernen löscht Paket und Aktivierungseinstellungen, keine OpenCode-Sitzungen oder Projektdateien. Deaktivieren Sie unerwünschten Code zur Wiederherstellung zuerst; installieren Sie nur ein überprüftes vertrauenswürdiges Paket erneut.

## Kontext, Asset-Zustimmung und Sandbox-Grenzen {#permissions-sandbox}

| Vertrag | Was Aktivierung erlaubt |
| --- | --- |
| API 1 / `session.context` | Aktuelle Sitzungskennung (oder keine), Oberflächensprache und Darstellung. Kein Verlaufstext oder Dateisystemzugriff. |
| API 2 / `session.assets.read` plus Kontext | Ausdrücklich geprüfte Berechtigung, begrenzte Bild-/Anhangsmetadaten aktueller Sitzungs-Werkzeugergebnisse aufzulisten und unterstützte eingebettete Bytes zu lesen. Kein allgemeiner Verlaufs-, Datei- oder URL-Zugriff. |

Asset-Zugriff folgt dem aktuell eingebundenen Host/der Sitzung, nicht einer vom Autor ausgewählten Sitzung. Lokale/entfernte Referenzen können als nicht verfügbar erscheinen; die Asset-API lädt keine beliebigen entfernten URLs und öffnet keine lokalen Dateien. Sitzungswechsel, Trennung oder Zustimmungswiderruf macht alten Zugriff ungültig.

Autorencode läuft in einem eingeschränkten iframe, nicht im vertrauenswürdigen Anwendungsrenderer. Er erhält keine native/OpenCode-Brücke, Zugangsdatenzugriff, allgemeines RPC, Formulare, Popups oder Downloads; Netzwerk-APIs und externe Ressourcen sind beschränkt. Erweiterungen sind UI-Add-ons, keine [OpenCode-Plugins](integrations.md).

Die Sandbox ist keine Prozess-/CPU-Isolation und kein Versprechen harmlosen genehmigten Codes. Eine bösartige Erweiterung kann ihren Renderer stören. Installieren Sie nur vertrauenswürdige Autoren, geben Sie keine Geheimnisse an und deaktivieren/entfernen Sie Add-ons bei unerwartetem Verhalten.
