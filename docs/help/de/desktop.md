# Desktop-Fenster und Daten

## Fenster, Tabs und gemeinsamer Dienst {#windows-tabs}

1. Verwenden Sie **Neue Instanz**, um einen weiteren Projekt-/Startseiten-Tab im aktuellen Fenster zu öffnen.
2. Verwenden Sie das native **Window → New Window** (`Ctrl+Shift+N` oder `Cmd+Shift+N`) für ein separates Anwendungsfenster.
3. Aktivieren Sie unter **Einstellungen → Erweitert** die Option **Vorhandenes Fenster beim zweiten Start fokussieren**, wenn ein weiterer Start das zuletzt verwendete Fenster fokussieren statt ein neues öffnen soll.

Projekt-Tabs, ausgewählte Unterhaltungen und Layout gehören zum Fenster. OpenCode-Sitzungen/-Nachrichten gehören zum gemeinsamen nativen OpenCode-Dienst: Andere Fenster können dieselbe Unterhaltung sehen. Fenster- oder App-Tab-Schließen stoppt diesen Dienst nicht. **Arbeitsbereich stoppen** ist eine separate gemeinsame Aktion; siehe [Projekte](projects.md). Verwenden Sie geschlossene Fenster nicht als Beweis, dass Agent oder geplante Mission gestoppt wurde.

## Einstellungen und Startwiederherstellung {#preferences-startup}

1. Öffnen Sie Einstellungen aus dem zu konfigurierenden Fenster. Lokale Desktop-Einstiege fokussieren das eine native Einstellungsfenster mit Projekt/Location dieses öffnenden Fensters.
2. Aktivieren/deaktivieren Sie unter **Allgemein → Startverhalten** die Option **Vorherigen Zustand wiederherstellen**.
3. Verwenden Sie zum Vergessen des gespeicherten Fensterlayouts **Gespeicherten Zustand löschen**, nachdem Sie die Folgen gelesen haben.

Wiederherstellung kann Arbeitsbereichs-/SideCar-Tabs und aktive Sitzungen, ungesendeten Text, Scrollpositionen, Panels, Fensterposition und Zoom erneut öffnen. Es handelt sich um fensterbezogenen Client-Zustand, keine Kopie der nativen Unterhaltungsdatenbank. Löschen entfernt gespeicherte Tabs, Entwürfe und Layout; es löscht weder CodeNomad-Konfiguration noch OpenCode-Unterhaltungen. Sichern Sie wichtige ungesendete Entwürfe vorher anderswo.

Das Einstellungsfenster hat keinen separaten Wiederherstellungszustand: Startverhalten zielt auf exakt das Fenster, das es öffnete. Wird dieses geschlossen oder geändert, schreiben nicht verfügbare/veraltete Bedienelemente nicht stillschweigend den Zustand eines anderen Fensters. Öffnen Sie Einstellungen erneut vom vorgesehenen Fenster. Projektbezogene Einstellungen verwenden ebenfalls die Location des öffnenden Fensters und bleiben ohne sie nicht verfügbar.

Browser- und Remote-Einstellungen sind eingebettet, kein zweiter nativer Einstellungsbesitzer. Ein Fehler beim Öffnen nativer Einstellungen wird gemeldet; er bedeutet nicht, dass stattdessen eine versteckte eingebettete Einstellungsseite geöffnet wurde.

## Explizite Desktop-Datenprofile {#data-profiles}

Ohne explizites Profil verwenden paketierte Starts das für diese Konfiguration gemerkte Profil. Ist keine Auswahl gemerkt, prüft die App Standard-, `dev`- und `dev-v2`-Profile auf wiederherstellbare Arbeit: Sie wählt den einzigen Kandidaten, fragt bei mehreren oder verwendet ohne Kandidaten das Standardprofil. Auswahl verschiebt, vereint oder löscht keine Profildaten. Verwenden Sie `CODENOMAD_PROFILE`, um explizit ein anderes Profil zu öffnen.

1. Setzen Sie für bewusste Desktop-Isolation `CODENOMAD_PROFILE` vor dem Programmstart.
2. Verwenden Sie einen Namen mit 1–64 ASCII-Buchstaben/Ziffern, Punkten, Unterstrichen oder Bindestrichen, beginnend mit Buchstabe/Ziffer. Namen werden kleingeschrieben; `default` oder `stable` wählt das Standardprofil.
3. Prüfen Sie **Einstellungen → Info → Datenprofil** auf ein benanntes Profil. Ein ungültiger Name verhindert den Start, statt ein anderes Profil zu wählen.

Beispielsweise in PowerShell vor dem Start der gewünschten Desktop-Programmdatei:

```powershell
$env:CODENOMAD_PROFILE = "review"
```

Setzen Sie für unabhängige Serverkonfiguration zusätzlich vor dem Start `CLI_CONFIG` auf eine separate Konfigurationsdatei. Standard ist `~/.config/codenomad/config.yaml`. Ein Profilname allein ändert weder diese Datei noch den gemeinsamen OpenCode-Dienst.

| Durch Desktop-Datenprofil isoliert | Nicht automatisch isoliert |
| --- | --- |
| Fenster-/Tab-Wiederherstellung, ungesendete Entwürfe und Desktop-Singleton-/Backend-Geltungsbereich | OpenCode-Sitzungen, Nachrichten, Anbieterzugangsdaten und Ausführung |
| Nativer Chromium-/WebView-Speicher dieses Profils unter Plattformgrenzen | CodeNomad-Konfiguration/Einstellungen, Sprachschlüssel, SideCars und Erweiterungsaktivierung bei geteilter Konfiguration |
| Nativer Vorschauspeicher innerhalb Host/Profil | Dateien geöffneter Projekte; Daten entfernter Server |

Unter macOS-Tauri teilen Profile System-WebKit-Speicher, Anmeldungen und Cache; verwenden Sie Profilnamen nicht zur sicherheitsbezogenen Kontentrennung. Electron speichert Webdaten im Profil. Installierte Version und **Update-Kanal** wählen niemals ein anderes Datenprofil. Nicht paketierte Entwicklungsstarts verwenden ohne explizite Auswahl das Profil `dev`.

## Andere gespeicherte Profile löschen {#delete-profiles}

1. Suchen Sie unter nativen **Einstellungen → Allgemein → Startverhalten** nach **Andere gespeicherte Profile**. Dies erscheint nur bei anderen vorhandenen Profilen auf dem Rechner.
2. Aktualisieren Sie bei Bedarf die Liste, wählen Sie **Löschen…** und lesen Sie Ziele und übersprungene Profile.
3. Bestätigen Sie erst nach Sicherung benötigter Entwürfe/Anmeldungen. Prüfen Sie vor Wiederholung Berichte zu unvollständiger Entfernung.

Die Löschung entfernt gespeicherte Tabs, Entwürfe, Layout und zugehörigen Webspeicher/Cache/Anmeldungen anderer Profile, einschließlich aufgelisteter Profile anderer Konfigurationen. Sie bewahrt geöffnetes Profil, OpenCode-Unterhaltungen und Projektdateien. Offene Profile oder Profile mit unbekanntem Zustand werden übersprungen; schließen Sie relevante CodeNomad-Fenster vor expliziter Aktualisierung/Wiederholung. Unbekannte Inhalte werden behalten und gemeldet statt pauschal gelöscht.

Der gemeinsame WebKit-Speicher von macOS-Tauri bleibt erhalten, da dessen Löschung andere Profile betreffen würde. Diese Bereinigung ist nicht rückgängig zu machen: Eine erhaltene native Unterhaltung stellt keinen gelöschten ungesendeten Entwurf wieder her. **Gespeicherten Zustand löschen** ist die kleinere Aktion, wenn Sie nur das aktuelle Fenster zurücksetzen möchten.

## Zoom und Panel-Geometrie {#zoom-panels}

1. Verwenden Sie nativ **View → Zoom In**, **Zoom Out** oder **Actual Size**; Tastatur/Mausrad folgen ebenfalls der Host-Unterstützung.
2. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den festen äußeren Kopfecken zum Umschalten. Heften/lösen Sie Schubladen, soweit das Layout dies erlaubt.
3. Passen Bedienelemente nicht mehr, verringern Sie den Zoom oder verbreitern das Fenster; schmale Layouts verschieben Bedienelemente in Menüs und Panels in Überlagerungen.

Lokale und entfernte Desktop-Hauptfenster reservieren mindestens 390 × 600 CSS-Pixel, skaliert mit Anwendungszoom und begrenzt durch die Monitor-Arbeitsfläche. Hineinzoomen kann ein zu kleines Fenster vergrößern; Herauszoomen verkleinert kein bereits größeres. Einstellungs- und Browser-Vorschau-Unterfenster haben eigene Größenregeln.

Panels lassen vor dem Schweben eine Mindestbreite für die Unterhaltung. Unter 420 CSS-Pixeln Unterhaltungsbreite wird die Timeline ausgeblendet und Kopfaktionen verwenden ihr Überlaufmenü; die gespeicherte Timeline-Einstellung bleibt erhalten. Diese Geometrieänderungen verändern weder Prompt-Entwurf noch native Sitzung. Siehe [Einstellungen und Layout](settings.md) und [Browser-Vorschauen und SideCars](browser-sidecars.md).
