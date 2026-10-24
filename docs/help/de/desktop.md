# Desktop-Fenster und Daten

## Fenster, Tabs und gemeinsamer Dienst {#windows-tabs}

1. Verwenden Sie **Neue Instanz**, um einen weiteren Projekt-/Startseiten-Tab im aktuellen Fenster zu öffnen.
2. Verwenden Sie das native **Fenster → Neues Fenster** (`Ctrl+Shift+N` oder `Cmd+Shift+N`) für ein separates Anwendungsfenster.
3. Aktivieren Sie unter **Einstellungen → Erweitert** die Option **Vorhandenes Fenster beim zweiten Start fokussieren**, wenn ein weiterer Start das zuletzt verwendete Fenster fokussieren statt ein neues öffnen soll.

Projekt-Tabs, ausgewählte Unterhaltungen und Layout gehören zum Fenster. OpenCode-Sitzungen/-Nachrichten gehören zum gemeinsamen nativen OpenCode-Dienst: Andere Fenster können dieselbe Unterhaltung sehen. Das Schließen eines Projekt-Tabs schließt das Projekt in CodeNomad, nicht seine OpenCode-Sitzungen; öffnen Sie es erneut, um sie wiederzufinden. Ein anderes Fenster, das dieselbe Projektverbindung anzeigt, schließt seinen Tab ebenfalls und zeigt eine Benachrichtigung; separat geöffnete Tabs desselben Ordners sind nicht betroffen. Das Schließen eines ganzen Fensters, Beenden oder Neuladen bewahrt Projektverbindungen für die Wiederherstellung; siehe [Projekte](projects.md). Verwenden Sie geschlossene Fenster nicht als Beweis, dass Agent oder geplante Mission gestoppt wurde.

Native Anwendungsmenüs verwenden die Oberflächensprache von CodeNomad, sobald ein Fenster geladen ist; bis dahin erscheinen sie auf Englisch. **Hilfe → Über CodeNomad** (auch im macOS-Anwendungsmenü) öffnet **Einstellungen → Info** mit Version, Updates und Diagnose.

## Einstellungen und Startwiederherstellung {#preferences-startup}

1. Öffnen Sie Einstellungen aus dem zu konfigurierenden Fenster. Lokale Desktop-Einstiege fokussieren das eine native Einstellungsfenster mit Projekt/Location dieses öffnenden Fensters.
2. Schalten Sie unter **Allgemein** die Option **Vorherigen Zustand wiederherstellen** ein oder aus.
3. Verwenden Sie zum Vergessen des gespeicherten Fensterlayouts **Gespeicherten Startzustand löschen**. Dies wirkt sofort, ohne Bestätigung.

Wiederherstellung kann Arbeitsbereichs-/SideCar-Tabs und aktive Sitzungen, ungesendeten Text, Scrollpositionen, Panels, Fensterposition und Zoom erneut öffnen. Es handelt sich um fensterbezogenen Client-Zustand, keine Kopie der nativen Unterhaltungsdatenbank. Löschen entfernt gespeicherte Tabs, Entwürfe und Layout; es löscht weder CodeNomad-Konfiguration noch OpenCode-Unterhaltungen. Sichern Sie wichtige ungesendete Entwürfe vorher anderswo.

Das Einstellungsfenster hat keinen separaten Wiederherstellungszustand: Diese Bedienelemente zielen auf das Fenster, das es öffnete. Ist dieses geschlossen oder unbekannt, weil die Einstellungen beim Start wieder geöffnet wurden, folgen sie stattdessen dem zuletzt verwendeten Fenster; eine für ein anderes Fenster vorbereitete Änderung wird nie angewendet, die Bedienelemente zeigen zuerst den Wert des neuen Fensters. Um ein bestimmtes Fenster zu konfigurieren, öffnen Sie die Einstellungen aus diesem Fenster. Projektbezogene Einstellungen verwenden ebenfalls die Location des öffnenden Fensters und bleiben ohne sie nicht verfügbar. Werden die Einstellungen beim Start wieder geöffnet, verbinden sie sich erneut, sobald dieses Projekt fertig geöffnet ist; solange der Ordner noch startet oder in mehreren Tabs geöffnet ist, bleiben sie nicht verfügbar, bis Sie die Einstellungen aus dem gewünschten Fenster öffnen.

Browser- und Remote-Einstellungen sind eingebettet, kein zweiter nativer Einstellungsbesitzer. Ein Fehler beim Öffnen nativer Einstellungen wird gemeldet; er bedeutet nicht, dass stattdessen eine versteckte eingebettete Einstellungsseite geöffnet wurde.

## Desktop-Datenprofile {#data-profiles}

1. Klappen Sie in den nativen **Einstellungen → Allgemein** unter **Vorherigen Zustand wiederherstellen** den Eintrag **Datenprofil** auf. Er listet alle Profile auf diesem Computer mit Größe, Erstellungsdatum und letzter Verwendung auf, das geöffnete zuerst.
2. Wählen Sie das Profil, das der nächste Start öffnet, oder wählen Sie **Neues Profil** und geben Sie einen Namen aus 1–64 Kleinbuchstaben, Ziffern, Punkten, Bindestrichen oder Unterstrichen ein, beginnend mit einem Buchstaben oder einer Ziffer.
3. Wählen Sie **In … neu starten**, um sofort zu wechseln; andernfalls öffnet sich das gewählte Profil beim nächsten Start. Erneutes Auswählen des geöffneten Profils hebt die Änderung auf.

Profile aus einer anderen Konfiguration werden aufgelistet, können hier aber nicht gewählt werden. Ohne gemerkte Auswahl prüft ein paketierter Start Standard-, `dev`- und `dev-v2`-Profil auf wiederherstellbare Arbeit und öffnet das zuletzt verwendete davon, oder das Standardprofil, wenn keines solche Arbeit enthält. Die Auswahl eines Profils verschiebt, vereint oder löscht keine Profildaten.

Ein vor dem Programmstart gesetztes `CODENOMAD_PROFILE` hat Vorrang vor dieser Auswahl; **Datenprofil** zeigt die Profile dann an, ohne eine Auswahl zu erlauben. `default` oder `stable` wählt das Standardprofil, und ein ungültiger Name verhindert den Start, statt ein anderes Profil zu wählen. Beispielsweise in PowerShell vor dem Start der gewünschten Desktop-Programmdatei:

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

## Ein gespeichertes Profil löschen {#delete-profiles}

1. Klappen Sie **Datenprofil** wie oben auf und aktualisieren Sie bei Bedarf die Liste.
2. Wählen Sie die Löschschaltfläche des zu entfernenden Profils. Das geöffnete Profil hat keine.
3. Bestätigen Sie erst nach Sicherung benötigter Entwürfe/Anmeldungen. Prüfen Sie vor Wiederholung Berichte zu unvollständiger Entfernung.

Die Löschung entfernt gespeicherte Tabs, Entwürfe, Layout und zugehörigen Webspeicher/Cache/Anmeldungen dieses Profils, auch bei einem aufgelisteten Profil einer anderen Konfiguration. Sie bewahrt geöffnetes Profil, OpenCode-Unterhaltungen und Projektdateien. Ein geöffnetes Profil oder eines mit unbekanntem Zustand kann nicht gelöscht werden; schließen Sie die relevanten CodeNomad-Fenster, aktualisieren Sie die Liste und versuchen Sie es erneut. Unbekannte Inhalte werden behalten und gemeldet statt pauschal gelöscht.

Der gemeinsame WebKit-Speicher von macOS-Tauri bleibt erhalten, da dessen Löschung andere Profile betreffen würde. Diese Bereinigung ist nicht rückgängig zu machen: Eine erhaltene native Unterhaltung stellt keinen gelöschten ungesendeten Entwurf wieder her. **Gespeicherten Startzustand löschen** ist die kleinere Aktion, wenn Sie nur das aktuelle Fenster zurücksetzen möchten.

## Zoom und Panel-Geometrie {#zoom-panels}

1. Verwenden Sie nativ **Ansicht → Vergrößern**, **Verkleinern** oder **Originalgröße**; Tastatur/Mausrad folgen ebenfalls der Host-Unterstützung.
2. Verwenden Sie **Linke Seitenleiste** und **Rechte Seitenleiste** an den festen äußeren Kopfecken zum Umschalten. Heften/lösen Sie Schubladen, soweit das Layout dies erlaubt.
3. Passen Bedienelemente nicht mehr, verringern Sie den Zoom oder verbreitern das Fenster; schmale Layouts verschieben Bedienelemente in Menüs und Panels in Überlagerungen.

Lokale und entfernte Desktop-Hauptfenster reservieren mindestens 390 × 600 CSS-Pixel, skaliert mit Anwendungszoom und begrenzt durch die Monitor-Arbeitsfläche. Hineinzoomen kann ein zu kleines Fenster vergrößern; Herauszoomen verkleinert kein bereits größeres. Einstellungs- und Browser-Vorschau-Unterfenster haben eigene Größenregeln.

Panels lassen vor dem Schweben eine Mindestbreite für die Unterhaltung. Unter 420 CSS-Pixeln Unterhaltungsbreite wird die Timeline ausgeblendet und Kopfaktionen verwenden ihr Überlaufmenü; die gespeicherte Timeline-Einstellung bleibt erhalten. Diese Geometrieänderungen verändern weder Prompt-Entwurf noch native Sitzung. Siehe [Einstellungen und Layout](settings.md) und [Browser-Vorschauen und SideCars](browser-sidecars.md).
