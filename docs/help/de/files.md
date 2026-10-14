# Dateien und Git

Der rechte Panel-Tab **Dateien** vereint das Durchsuchen von Checkouts, lokale Änderungen und Commit-Verlauf. Eine Zeile auszuwählen ist etwas anderes, als deren zentrale Leseansicht zu öffnen.

## Checkout durchsuchen {#browse-workspace}

1. Öffnen Sie **Dateien** und wählen Sie **Arbeitsbereich**.
2. Wählen Sie **Worktree ansehen**, wenn Sie einen anderen Checkout wünschen; klappen Sie Ordner nach Bedarf auf.
3. Klicken Sie eine Dateizeile zur Auswahl an. Verwenden Sie deren Augenaktion, um die zentrale Vorschau zu öffnen oder zu schließen.
4. Verwenden Sie **Aktualisieren**, wenn der sichtbare Schnappschuss erneut geprüft werden soll.

| Modus | Liest | Wirkung auf die Unterhaltung |
| --- | --- | --- |
| Arbeitsbereich | Dateien im durchsuchten Checkout | Keine Sitzungsverschiebung und kein Branch-Checkout |
| Änderungen | Änderungen im Index und Arbeitsbaum | Git-Änderungen erfolgen nur über ausdrückliche Aktionen |
| Commits | Seitenweiser Commit-Verlauf und Revisionsinhalte | Schreibgeschützter Verlauf; kein Checkout |

Aufgeklappte Ordner bleiben bei Moduswechseln erhalten. Listen/Status/Verlauf verwenden zwischengespeicherte Schnappschüsse und prüfen sie nach relevanten Dateisystemänderungen, Aktivierung oder expliziter Aktualisierung erneut; das Fokussieren des Panels garantiert kein erneutes Lesen.

Zeilenaktionen umfassen **Pfad kopieren** und, soweit der Client Backend-Pfade öffnen kann, Dateimanager-/Editor-/Terminal-Aktionen wie **Mit Standardanwendung öffnen**, **Im Ordner anzeigen**, **Im Dateimanager öffnen** und **Terminal hier öffnen**. Bei wenig Platz können Aktionen unter **Weitere Aktionen für {name}** erscheinen; der Datei- oder Ordnername ersetzt `{name}`. Ein Remote-Browser darf einen Serverpfad nicht als lokalen Gerätepfad voraussetzen; siehe [Fernsteuerung](remote-control.md).

## Quelltext bearbeiten und sicher speichern {#edit-save}

1. Öffnen Sie eine Textdatei im Arbeitsbereich mit ihrer Augenaktion.
2. Wählen Sie für Markdown **Quellcode anzeigen** zum Bearbeiten oder **Markdown-Vorschau** zum Lesen der Darstellung.
3. Bearbeiten Sie und wählen Sie **Speichern** oder drücken Sie **Ctrl/Cmd+S**, während der Editor fokussiert ist.
4. Wurde die Datei extern geändert, prüfen Sie die Überschreibbestätigung; wählen Sie **Abbrechen**, um den Entwurf ohne Überschreiben dieser Änderung zu behalten.

Speichern schreibt die tatsächliche Datei im durchsuchten Checkout einschließlich eines verknüpften Worktrees; es sendet keinen Prompt und staged/committet die Änderung nicht. Vor dem Speichern wird die maßgebliche Datei erneut gelesen. Der Konfliktdialog lautet **Die Datei wurde vom Agenten geändert. Die Änderungen des Agenten überschreiben?**; behandeln Sie Änderungen jedes externen Schreibers mit derselben Sorgfalt.

Ungespeicherte Quelltextentwürfe bleiben beim Schließen oder Wechseln von Leseansichten im Renderer-Speicher nach Projektinstanz, Verzeichnis und Pfad erhalten. Dateisystemaktualisierungen ersetzen sie nicht stillschweigend. Dies ist kein dauerhafter Dateispeicher: Speichern oder kopieren Sie wichtige Änderungen vor einem Client-Neustart/Neuladen. Lese-/Schreibfehler behalten den Entwurf. Explizites **Aktualisieren** warnt vor dem Verwerfen ungespeicherter Änderungen.

Das Schließen der Leseansicht über die abschließende Schließen-Schaltfläche führt zur Unterhaltung zurück; das Eingabefeld bleibt darunter verfügbar. Ein Sitzungs-/Worktree-Wechsel leert die ausgewählte Leseansicht und garantiert kein Speichern ihres Entwurfs. Eine Browser-Vorschau ersetzt die Leseansicht; eine Datei zu öffnen setzt diese Ansicht auf Chat-Modus zurück.

## Schreibgeschützte und begrenzte Vorschauen {#preview-limits}

1. Öffnen Sie ein Bild, eine Binärdatei oder historische Änderung mit der Augenaktion.
2. Verwenden Sie bei Diffs nach Bedarf **Zur geteilten Ansicht wechseln** / **Zur einheitlichen Ansicht wechseln**, Zeilenumbruch und die Steuerung unveränderter Bereiche.
3. Schließen Sie die Leseansicht, um zum Chat zurückzukehren.

| Inhalt | Verfügbares Verhalten |
| --- | --- |
| Arbeitsbereichstext einschließlich Markdown-Quelltext | Mit explizitem Speichern bearbeitbar |
| Arbeitsbereichsbild | Schreibgeschützte Bildvorschau |
| Andere Binärinhalte | Schreibgeschützter Hinweis auf nicht verfügbare Vorschau |
| Text-Diff aus Änderungen/Commits | Schreibgeschützter Vergleich, kein Editor für eine der Seiten |
| Git-Bild-Diff | Vorher-/Nachher-Bilder aus exakt den verglichenen Revisionen |

Vorschaulesevorgänge sind begrenzt; große/nicht unterstützte Inhalte sind gegebenenfalls nicht verfügbar, statt unbegrenzt geladen zu werden. Historische Bilder ersetzen niemals die aktuelle Worktree-Datei. Ein Vorschaufehler bedeutet nicht, dass die zugrunde liegende Datei fehlt. Öffnen Sie die Datei gegebenenfalls mit einer geeigneten externen Anwendung, ohne nur für eine Vorschau ihre Revision zu ändern.

## Stagen, Unstagen und Committen {#stage-commit}

1. Wählen Sie **Änderungen** und prüfen Sie **Gestagte Änderungen** und **Änderungen**.
2. Verwenden Sie **Datei stagen** / **Datei unstagen**, wählen Sie mehrere Zeilen für die entsprechende Auswahlaktion oder ziehen Sie Zeilen zwischen den Abschnitten.
3. Geben Sie oben in **Gestagte Änderungen** eine Nachricht ein und wählen Sie **Commit erstellen**.

Eingeklappte Abschnittsköpfe bleiben Ablageziele. Einklappen oder Moduswechsel bewahren deren Zustand und den Commit-Nachrichtenentwurf. Stagen/Unstagen ändert den Index im durchsuchten Worktree; Committen erfasst ausschließlich gestagte Inhalte. Unstagen verwirft die Änderung im Worktree nicht.

Prüfen Sie gestagte Dateien vor dem Commit, besonders wenn Agenten oder andere Clients dort ebenfalls schreiben. Ein fehlgeschlagener Commit wird nicht automatisch wiederholt. Aktualisieren Sie Status/Verlauf und prüfen Sie vor dem Wiederholen den Fehler, denn eine verlorene Antwort beweist nicht, dass kein Commit erstellt wurde.

## Commit-Verlauf lesen {#commit-history}

1. Wählen Sie **Commits** und einen Commit, um dessen Nachricht und geänderte Dateien zu lesen.
2. Verwenden Sie **Geladene Commits filtern…** für die geladene Menge oder **Ältere Commits laden** für eine weitere Seite.
3. Öffnen Sie eine geänderte Datei mit ihrer Augenaktion.

Der Textverlauf vergleicht den Commit mit seinem ersten Eltern-Commit (oder einer leeren Basis beim Stamm-Commit). Er wechselt weder HEAD noch verschiebt er Sitzungen. Geladene Commits zu filtern ist keine serverweite Git-Log-Suche. Aktualisieren Sie nach neuen Commits, um vom aktuellen Verlauf auszugehen; vorhandene Seitennavigation behält ihren anfänglichen Verlaufsschnappschuss.

## Leerraum und Zeilenenden {#whitespace-line-endings}

1. Öffnen Sie **Einstellungen → Erweitert → Reine Leerraumänderungen ausblenden**.
2. Deaktivieren Sie dies, wenn Sie nicht gestagte reine Leerraumänderungen prüfen müssen, die in Änderungen fehlen.
3. Prüfen Sie vor dem Commit den tatsächlichen Diff und die gestagten Inhalte.

Die Einstellung ist standardmäßig aktiviert. Sie blendet hauptsächlich passende nicht gestagte Änderungen verfolgter Textdateien aus der Änderungsliste, Zählung, Auswahl, Sammel-Staging und Ziehaktionen aus. Ausgeblendete Dateien bleiben ungestagt. Gestagte Dateien bleiben sichtbar, ebenso nicht verfolgte, hinzugefügte/gelöschte/umbenannte und binäre Dateien. Fehlgeschlagene/nicht unterstützte Erkennung lässt Dateien sichtbar, statt zu raten.

Gits Listenerkennung kann inneren Leerraum, reine CRLF-Änderungen und hinzugefügte/entfernte abschließende Zeilenumbrüche ignorieren. Der Leerraumvergleich in der Diff-Leseansicht ist enger: Einrückung und abschließende Leerzeichen/Tabulatoren, nicht sämtlicher innerer Leerraum. Stagen und Committen arbeiten unabhängig von der Anzeigeeinstellung immer mit dem exakten Inhalt.

Unterschiede bei Zeilenenden und Byte-Order-Mark können statt hervorgehobener Zeilen einen sachlichen Hinweis erzeugen. Das Deaktivieren der Einstellung kann den Editor nicht dazu bringen, jede Zeilenende-/BOM-Änderung oder jeden gleich langen Austausch abschließenden Leerraums darzustellen. Ein optisch leerer Diff beweist keine identischen Bytes.

## Git initialisieren {#initialize-git}

1. Öffnen Sie **Änderungen** oder **Commits** in einem Ordner ohne Repository.
2. Wählen Sie **Git initialisieren**; dies erfolgt sofort ohne Bestätigung.
3. Warten Sie auf die Projekt-/Sitzungsaktualisierung und stagen/committen Sie anschließend ausdrücklich, wenn Sie bereit sind.

Die Initialisierung erstellt `.git` im ausdrücklich geöffneten Ordner; sie initialisiert kein übergeordnetes Verzeichnis und erstellt keinen ersten Commit. Fehlt Git im Backend, bleiben verzeichnisgebundene Unterhaltungen und das Durchsuchen des Arbeitsbereichs möglich, aber Initialisierung und Git-Vorgänge sind nicht verfügbar. Aktualisieren Sie bei ungewissem Fehler vor dem Wiederholen; keine Initialisierungsanfrage wird automatisch wiederholt. Siehe [Projekte](projects.md).
