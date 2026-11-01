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

Jeder Ersatz widerruft die Aktivierung in allen Projekten, selbst bei unveränderter Berechtigungsliste, und löscht die gespeicherten eigenen Einstellungen des Panels. Validierungs-/Konflikt-/Speicherfehler erhalten das installierte Paket. Es gibt keine stillen Erweiterungsupdates. Entfernen löscht Paket, Aktivierungseinstellungen und gespeicherte Panel-Einstellungen, keine OpenCode-Sitzungen oder Projektdateien. Deaktivieren Sie unerwünschten Code zur Wiederherstellung zuerst; installieren Sie nur ein überprüftes vertrauenswürdiges Paket erneut.

## Kontext, Asset-Zustimmung und Sandbox-Grenzen {#permissions-sandbox}

| Vertrag | Was Aktivierung erlaubt |
| --- | --- |
| API 1 / `session.context` | Aktuelle Sitzungskennung (oder keine), Oberflächensprache und Darstellung. Kein Verlaufstext oder Dateisystemzugriff. |
| API 2 / `session.assets.read` plus Kontext | Ausdrücklich geprüfte Berechtigung, begrenzte Bild-/Anhangsmetadaten aktueller Sitzungs-Werkzeugergebnisse aufzulisten und unterstützte eingebettete Bytes zu lesen. Kein allgemeiner Verlaufs-, Datei- oder URL-Zugriff. |
| API 3 / `repository.workItems.read` plus Kontext | Ausdrücklich geprüfte Berechtigung, begrenzte Seiten der Issues und Pull Requests des Projekt-Repositorys auf GitHub, GitLab oder Gitea/Forgejo aufzulisten und eines davon im Browser zu öffnen. Kein Zugriff auf Dateien, Anmeldedaten oder das Netzwerk allgemein. |
| API 4 / Kontext plus eine oder mehrere der folgenden Berechtigungen | Die Prüfung listet einen Satz je deklarierter Berechtigung; die Aktivierung gewährt alle zusammen, und ein Ersatz widerruft sie alle. |
| `session.images.read` | Die vom read-Werkzeug zurückgegebenen Bilder in der angezeigten Unterhaltung lesen, mit Generierungsstatus und Herkunft, sofern sie überprüfbar sind. |
| `session.images.prompts` (benötigt `session.images.read`) | Prompt und Modell jedes Bildes lesen, das in der Bilder-Unterhaltung des Projekts generiert wurde. |
| `composer.prefill` | Text zum Eingabefeld der angezeigten Unterhaltung hinzufügen. Sendet nie eine Nachricht. |
| `images.conversation` | Die Bilder-Unterhaltung dieses Projekts öffnen oder starten. |
| `opencode.designAgent` | Fügt OpenCode den Design-Agenten von CodeNomad und seine Bild-Skills hinzu, solange diese Erweiterung aktiviert ist. |
| `panel.preferences` | Die eigenen Einstellungen dieses Panels speichern. |
| `bundles.read` (Entwurf) | Den Katalog der OpenCode-Integrationen, ihren Zustand in diesem Projekt und verfügbare geöffnete Anwendungen lesen. |
| `bundles.manage` (benötigt `bundles.read`) | Installation, Aktualisierung oder Entfernung von Katalogintegrationen, deren Aktivierung oder Deaktivierung, Installation der Anwendungskomponente und Verbindung einer geöffneten Anwendung mit der angezeigten Unterhaltung anfordern. Jede Aktion erfordert eine eigene CodeNomad-Bestätigung. |

Die Verwaltung erfordert eine authentifizierte CodeNomad-Verbindung. Prüfen Sie Aktion, Version, Geltungsbereich Global/Projekt, Unterhaltung, Dokument und Warnung zum Ausführungsrechner in der vertrauenswürdigen Bestätigung. Abbrechen erhält zuerst den Fokus; Bestätigen wird nach 600 ms freigegeben, die Ansicht läuft nach zwei Minuten ab. Trennungsanfragen werden abgelehnt. Verbindungsinformationen betreffen allein die angezeigte Unterhaltung. Sitzungswechsel, Navigation, Verbindungstrennung oder Zustimmungswiderruf schließen die Bestätigung. **Erweiterung neu laden** in der Panel-Werkzeugleiste startet eine neue Einbindung und löscht die Sperrzeit nach wiederholtem Abbrechen; automatische Einbindungen behalten sie bei. Aktionen werden niemals automatisch wiederholt.

Das Entfernen einer Katalogintegration erfordert eine eigene vertrauenswürdige Bestätigung für genau eine beschreibbare Quelle und ihr unverändertes Konfigurationsdokument. Ein gültiger aktueller oder veralteter Katalog genügt; fehlende, mehrdeutige, mehrfache, geerbte oder außerhalb des bevorzugten Schreibziels liegende Quellen werden abgelehnt. Native Integrationen erfordern hier Global; Plugins kann auch eine genaue native Projektquelle entfernen. Das Entfernen kann Verfügbarkeit und Verbindungen unterbrechen; Global kann andere Projekte und Unterhaltungen betreffen. Neuinstallation, Neuladen oder erneutes Verbinden können nötig sein; unterbrochene Vorgänge werden möglicherweise nicht fortgesetzt. Andere Deklarationen, Aktivierungsregeln, gespeicherte Verbindungshinweise, Paketcache und Anwendungs-/Benutzerdateien bleiben erhalten. Erfolg folgt erst auf das beobachtete Entfernen der Quelle in diesem Dokument; bei verlorener Antwort oder einem Fehler nach Übermittlung lesen Sie die Konfiguration vor einer neuen ausdrücklichen Aktion erneut. Bestätigungen anderer Aktionen melden die Übermittlung; spätere Lesevorgänge liefern den tatsächlichen Zustand.

Asset-Zugriff folgt dem aktuell eingebundenen Host/der Sitzung, nicht einer vom Autor ausgewählten Sitzung. Lokale/entfernte Referenzen können als nicht verfügbar erscheinen; die Asset-API lädt keine beliebigen entfernten URLs und öffnet keine lokalen Dateien. Sitzungswechsel, Trennung oder Zustimmungswiderruf macht alten Zugriff ungültig.

Mit API 4 folgt das Lesen von Bildern ebenso der angezeigten Unterhaltung und zeigt nur die Bilder, die der Agent in sie zurückgelesen hat. Eine Erweiterung mit `session.images.prompts` kann die Prompts lesen, die Sie oder der Agent für Bilder in einer Bilder-Unterhaltung geschrieben haben, und könnte sie trotz Sandbox weitergeben; gewähren Sie sie daher nur Autoren, denen Sie diese anvertrauen. Von `composer.prefill` hinzugefügter Text bleibt im Eingabefeld, bis Sie ihn bearbeiten oder **Nachricht senden** wählen; er beginnt nie mit einem Befehl, endet nie mit einer offenen `@`-Erwähnung und nennt Bildpfade als reinen Text. Rückgängigmachen mit Ctrl+Z (Cmd+Z unter macOS) im Eingabefeld entfernt ihn nicht. Gespeicherte Panel-Einstellungen gehören zu diesem CodeNomad-Profil, höchstens 4 KiB pro Erweiterung; beim Deaktivieren einer Erweiterung bleiben sie erhalten.

Die Einträge stammen vom Remote `upstream` des Projektordners, sonst von `origin`. CodeNomad liest sie mit der bereits angemeldeten GitHub-, GitLab- oder Gitea-CLI (`gh`, `glab`, `tea`) oder bei öffentlichen Repositorys anonym und speichert kein Token; die Erweiterung sieht nur den Repository-Namen und die Einträge. Anonym gelesen werden github.com, gitlab.com, codeberg.org und gitea.com; eine selbst gehostete Forge nur über ihre dort angemeldete CLI. Beim Öffnen eines Eintrags öffnet CodeNomad dessen Seite auf derselben Forge im Browser, höchstens einmal pro Sekunde; andere Adressen kann die Erweiterung nicht öffnen.

Autorencode läuft in einem eingeschränkten iframe, nicht im vertrauenswürdigen Anwendungsrenderer. Er erhält keine native/OpenCode-Brücke, Zugangsdatenzugriff, allgemeines RPC, Formulare, Popups oder Downloads; Netzwerk-APIs und externe Ressourcen sind beschränkt. Erweiterungen sind UI-Add-ons, keine [OpenCode-Plugins](integrations.md).

Die Sandbox ist keine Prozess-/CPU-Isolation und kein Versprechen harmlosen genehmigten Codes. Eine bösartige Erweiterung kann ihren Renderer stören. Installieren Sie nur vertrauenswürdige Autoren, geben Sie keine Geheimnisse an und deaktivieren/entfernen Sie Add-ons bei unerwartetem Verhalten.

## Bilder mit der Design-Erweiterung erstellen {#design}

Die Erweiterung **Design** ist ein Leuchttisch für die Bilder, die Sie mit dem Design-Agenten von CodeNomad in der **Bilder-Unterhaltung** eines Projekts erstellen. Sie zeigt die Bilder, bereitet Anfragen im Nachrichtenfeld vor und überlässt jede Generierung den Nachrichten, die Sie senden.

1. Verbinden Sie einen Anbieter, der ein Bildmodell bietet. Die Bildgenerierung ist eingeschaltet, sofern sie nicht unter **Einstellungen → Anbieter → Bilder** abgeschaltet wurde ([Bildgenerierung und -speicherung](providers.md#images)).
2. Installieren Sie unter **Rechtes Panel anpassen → Erweiterungen** **Design** aus dem Katalog ([Prüfen und deaktiviert installieren](#install)), nachdem Sie seine Berechtigungen geprüft haben ([Kontext, Asset-Zustimmung und Sandbox-Grenzen](#permissions-sandbox)), und aktivieren Sie dann sein Kontrollkästchen ([Aktivieren und Geltungsbereich verstehen](#activate-scope)).
3. Öffnen Sie das Panel **Design** und wählen Sie **Bilder-Unterhaltung öffnen**.

Solange die Erweiterung aktiviert ist, fügt CodeNomad OpenCode seinen Design-Agenten und seine Bild-Skills hinzu. Ihr eigener `design`-Agent und Ihre eigenen `design-*`-Skills haben immer Vorrang; wenn Sie einen eigenen `design`-Agenten bereitstellen, zeigt das Panel **Ihr eigener Design-Agent wird verwendet.** Das Panel meldet auch, wenn die Bildgenerierung, ein Bildmodell oder der Design-Agent fehlt.

### Bilder-Unterhaltung {#design-conversation}

Jeder Projektordner und jeder Worktree hat seine eigene Bilder-Unterhaltung mit dem Titel **Bilder**. **Bilder-Unterhaltung öffnen** findet sie oder erstellt sie mit dem Design-Agenten und dem Modell, das CodeNomad für eine neue Unterhaltung mit diesem Agenten wählt, und zeigt sie dann mit dem Fokus im Nachrichtenfeld; das Öffnen sendet nichts. Eine bestehende Bilder-Unterhaltung behält ihr eigenes Modell. **Neue Bilder-Unterhaltung** beginnt eine weitere mit leerem Leuchttisch; das Panel schlägt sie vor, sobald eine Unterhaltung viele Bilder enthält, und **Öffnen** zeigt danach die neueste. Archivierte und gelöschte Bilder-Unterhaltungen werden übersprungen.

Beschreiben Sie, was Sie brauchen, und senden Sie es: Der Agent stellt einige Rahmenfragen, sagt an, wie viele Bilder er erzeugen wird, erzeugt sie, liest jedes zurück und beurteilt es. Bilder werden in `.codenomad/design/` des Projektordners gespeichert. CodeNomad trägt diesen Ordner in die lokalen Git-Ausschlüsse des Repositorys ein (`.git/info/exclude`) und lässt `.gitignore` unverändert; gelingt das nicht, zeigt das Panel **Bilder an diesem Ort können in Git erscheinen.** Das Rückgängigmachen einer Runde entfernt ihre Bilder vom Leuchttisch, behält aber ihre Dateien, und ein vom Agenten überschriebenes Bild lässt sich nicht wiederherstellen. Der Agent fordert Bilder von etwa 1K Pixeln an, Anbieter können aber größere liefern, und mehrere große Bilder gleichzeitig können viel Speicher im gemeinsamen OpenCode-Dienst belegen.

Fehlt der Design-Agent in einer Bilder-Unterhaltung, die ihn verwendet, zeigt das Nachrichtenfeld **Der Design-Agent ist nicht verfügbar** und blockiert das Senden: Wählen Sie **Standard-Agent verwenden** oder aktivieren Sie die Design-Erweiterung wieder. Kann das Chatmodell der Unterhaltung keine Bilder empfangen, warnt das Panel, dass der Agent sie nicht visuell beurteilen kann; die zurückgelesenen Bilder erscheinen weiterhin auf dem Leuchttisch.

### Leuchttisch {#design-light-table}

Der **Leuchttisch** zeigt die Bilder, die der Agent in die angezeigte Unterhaltung zurückgelesen hat, das neueste zuerst und nach Antwort gruppiert. Ein ausgewähltes Bild erscheint größer, mit Vorschauen unter **Kleine Größen** bei 16, 32 und 64 px; **Vergleichen** stellt zwei Bilder nebeneinander, und **In voller Größe ansehen** öffnet einen Betrachter. Verbreitern Sie ein schmales Panel zum Vergleichen. Die Abstammung (**Erstellt aus**, **Verwendet für**) und in der Bilder-Unterhaltung Prompt und Modell erscheinen nur, wenn CodeNomad prüfen kann, welche Generierung das Bild erzeugt hat; sonst behält das Bild seine Pixel und zeigt **Herkunft nicht überprüfbar**. **Generierungen** listet jede Bildgenerierung mit ihrem Status; verfolgen Sie ihren Fortschritt in der Unterhaltung. In einer anderen Unterhaltung zeigt das Panel deren zurückgelesene Bilder ohne Prompts und Anfragen und bietet an, die Bilder-Unterhaltung zu öffnen.

In der Bilder-Unterhaltung fügen **Starten mit** (ein Rezept wie ein App-Symbol oder ein Logo), **Verfeinern**, **Varianten**, **Richtung anwenden**, **Im Projekt speichern…**, **Agent bitten, es zu zeigen** und **Wiederholen** nur bearbeitbaren Text ins Nachrichtenfeld ein: Das Panel sendet nie eine Nachricht und erzeugt nie ein Bild. Aktionen zu einem ausgewählten Bild zitieren dessen Pfad relativ zum Projekt, und zitiert werden können nur Bilder des Projekts mit überprüfbarer Herkunft. Bearbeiten Sie die Anfrage und senden Sie sie dann selbst. **Im Projekt speichern…** bittet den Agenten, das Bild an das Ziel zu kopieren, das Sie nach der Anfrage eingeben. **Bilder pro Runde** (1 bis 4, standardmäßig 3) wird in Anfragen übernommen, die neue Bilder erzeugen, und in den gespeicherten Einstellungen des Panels behalten. Auf einem Telefon schwebt das Panel und schließt sich, wenn es eine Anfrage hinzufügt.

### Den Design-Agenten ohne CodeNomad verwenden {#design-without-codenomad}

Der Design-Agent und seine Skills sind gewöhnliche OpenCode-Dateien. Um sie ohne CodeNomad in der OpenCode-TUI oder einem anderen Client zu verwenden, kopieren Sie den Inhalt des [Design-Inhaltsordners](../../../packages/server/src/opencode/design/opencode/) in den Ordner `.opencode/` eines Projekts oder in Ihren globalen OpenCode-Konfigurationsordner (`~/.config/opencode/`), mit `NOTICE.md` und der Lizenz daneben. Wählen Sie dann den Agenten **design**; er lädt seine Skills über ihren Namen, und andere Agenten verwenden sie nur, wenn Sie sie nennen.

Der Design-Agent und seine Skills adaptieren Material aus [Open Design](https://github.com/nexu-io/open-design) (Apache-2.0) und [taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT); `NOTICE.md` listet jede adaptierte Datei. Die Design-Erweiterung verwendet Code der Erweiterung MCP Assets (MIT) wieder.
