# Tastenkürzel

## Befehle entdecken und Hilfe öffnen {#discover-commands}

1. Öffnen Sie die **Befehlspalette** mit `Ctrl+Shift+P` unter Windows/Linux oder `Cmd+Shift+P` unter macOS oder über deren sichtbare Schaltfläche/Menüpunkt.
2. Geben Sie einen Aktionsnamen ein. Die Palette enthält Anwendungsaktionen und benutzerdefinierte Befehle der aktuellen Location; Verfügbarkeit hängt von der aktiven Ansicht ab.
3. Führen Sie **Hilfe öffnen** aus, um diese Anleitung in der aktuellen Oberflächensprache in einem externen Browserkontext zu öffnen. Natives **Help → CodeNomad Help** öffnet dieselbe Anleitung.

Hilfe lässt Anwendungsansicht und Entwurf unangetastet. Scheitert das Öffnen, besuchen Sie [CodeNomad Help](https://neuralnomadsai.github.io/CodeNomad/) direkt. Ein auffindbarer Befehl hat nicht zwangsläufig ein anpassbares Tastenkürzel: Die Verwaltung umfasst einen festen Renderer-Katalog mit 49 Befehlen, nicht jede Palette- oder native Menüaktion.

## Aufzeichnen, deaktivieren und zurücksetzen {#customize}

1. Öffnen Sie **Einstellungen → Tastenkürzel** und finden Sie die Aktion mit **Tastenkürzel filtern**.
2. Wählen Sie **Bearbeiten** und drücken Sie unter **Tastenkombination drücken** die gewünschte Kombination. Aufzeichnen speichert diese Belegung.
3. **Deaktivieren** entfernt die Renderer-Belegung dieser Aktion, **Zurücksetzen** stellt deren Standard wieder her, **Alle zurücksetzen** alle Renderer-Belegungen.
4. Beheben Sie Warnungen an jeder Konfliktzeile; Konflikte werden gemeldet, nicht stillschweigend deaktiviert.

Belegungen werden in CodeNomads UI-Konfiguration gespeichert und betreffen Clients derselben Konfiguration. Sie bearbeiten weder OpenCodes CLI-/TUI-Belegungen noch native Menü-Tastenkürzel. Aufzeichnen unterdrückt App-Renderer-Kürzel, aber nicht Betriebssystem oder natives Menü. **Abbrechen**, Fokusverlust, Abschnittsschließen oder Verlassen des Fensters beendet die Aufzeichnung. Reine Modifikatortasten und IME-Komposition werden ignoriert; Tab/Shift+Tab ohne weitere Tasten bewegt den Fokus.

Schlägt Speichern fehl, behalten Sie das alte Kürzel verfügbar und prüfen Sie vor dem Wiederholen die angezeigte Belegung. Zurücksetzen ist die sichere Wiederherstellung bei versehentlicher Zuweisung.

## Renderer-Standards {#renderer-defaults}

`Mod` bedeutet `Ctrl` unter Windows/Linux und `Cmd` unter macOS. Dies sind Vorgaben, keine Garantie, dass OS/nativer Host die Taste durchreichen. Der Kontext zählt: Dieselbe Taste kann auf Startseite, im Eingabefeld oder in der Suche andere Aktionen bedienen.

| Aktion | Standard |
| --- | --- |
| Befehlspalette öffnen | `Mod+Shift+P` |
| Neue Instanz / Ordner auf der Startseite durchsuchen | `Mod+N` |
| App-Tab schließen | `Mod+W` |
| Vorheriger / nächster App-Tab | `Mod+[` / `Mod+]` |
| App-Tab 1–9 | `Mod+1` bis `Mod+9` |
| Instanz umbenennen (Tab-Kontext) | `F2` |
| Neue Sitzung | `Mod+Shift+N` |
| Sitzung schließen | `Mod+Shift+W` |
| Vorherige / nächste Sitzung | `Mod+Shift+[` / `Mod+Shift+]` |
| Sitzungs-Tab 1–9 | `Mod+Shift+1` bis `Mod+Shift+9` |
| Instanz-Info | `Mod+Shift+L` |
| Sitzungsverlauf durchsuchen | `Mod+F` |
| Nächstes / vorheriges Suchergebnis (Suche fokussiert) | `Enter` / `Shift+Enter` |
| Eingabe fokussieren / leeren | `Mod+P` / `Mod+K` |
| Modell- / Agentenauswahl öffnen | `Mod+Shift+M` / `Mod+Shift+A` |
| Modellvariante wählen | `Mod+Shift+T` |
| Blockierende Werkzeuge in Hintergrund verschieben (Eingabefeld) | `Mod+B` |
| Eingabe senden | `Enter` |
| Mit alternativem Folgeprompt-Verhalten senden | `Mod+Shift+Enter` |
| Neue Zeile einfügen | `Shift+Enter` oder `Mod+Enter` |
| Vorheriger / nächster Prompt (Eingabefeld) | `ArrowUp` / `ArrowDown` |
| Eingabefokus verlassen / Shell-Modus verlassen | `Escape`, je nach Eingabekontext |
| Sitzung stoppen | Zweimal `Escape`; erstes Drücken zeigt Bestätigung |
| Nebenfrage senden (`/btw`-Fenster) | `Mod+Enter` |
| Datei speichern (Arbeitsbereichseditor) | `Mod+S` |

Bei deaktiviertem Senden mit Enter ist **Eingabe senden** standardmäßig `Mod+Enter` und **Neue Zeile einfügen** `Enter` oder `Shift+Enter`. Eine explizite Kürzelüberschreibung ersetzt diese Vorgabe. Die Verwaltung zeigt die wirksame Belegung. Vorherige/nächste Sitzung durchläuft die Sitzungsliste; dies ist nicht der browserartige **Zurück**-/ **Vorwärts**-Verlauf der Seitenleiste, der kein Tastenkürzel hat.

## Native Tasten und Abfangen durch die Plattform {#native-keys}

Native Tasten sind fest und bleiben auch nach Änderung/Deaktivierung der entsprechenden Renderer-Belegung aktiv. Insbesondere verwendet natives **New Window** `Mod+Shift+N`, den Renderer-Standard für Neue Sitzung. Verwenden Sie eine sichtbare Neue-Sitzung-Steuerung oder belegen Sie die Renderer-Aktion um, falls das native Menü sie abfängt. Ebenso kann natives `Mod+W` das Fenster statt nur eines App-Tabs schließen.

| Native Aktion | Electron | Tauri |
| --- | --- | --- |
| New Window | `Mod+Shift+N` | `Mod+Shift+N` |
| New Instance / Command Palette | `Mod+N` / `Mod+Shift+P` | `Mod+N` / `Mod+Shift+P` |
| Reload / Force Reload | `Mod+R` / `Mod+Shift+R` | `Mod+R` / `Mod+Shift+R` |
| Actual Size | `Mod+0` | `Mod+0` |
| Zoom | `Mod+Plus` / `Mod+-` | View-Menüsteuerung und Zoom-Eingabe der Plattform-Webview |
| Full Screen | `F11` unter Windows/Linux; `Ctrl+Cmd+F` unter macOS | `Ctrl+Cmd+F` als Menü-Tastenkürzel unter macOS; auf anderen Plattformen Menü verwenden |
| Developer Tools | `Ctrl+Shift+I` unter Windows/Linux; `Alt+Cmd+I` unter macOS | `Alt+Mod+I` |

Normale Browserfenster behalten ebenfalls ihre Browserkürzel. Erreicht eine Belegung CodeNomad nie, wählen Sie eine andere Kombination, statt Sicherheit abzuschalten oder OS-weite Tasten zu ändern.

## Tastaturlayouts und Texteingabe {#layouts-ime}

Kürzel der Ziffernreihe und eckigen Klammern verwenden physische Tastenpositionen für Aufzeichnen, Ausführen und Konfliktprüfung, auch bei AZERTY/QWERTZ. Andere Tasten verwenden logische Werte. Zeichnen Sie auf der vorgesehenen Tastatur auf und prüfen Sie das angezeigte Ergebnis.

Während IME-Komposition hat Texteingabe Vorrang. Prompt-Verlauf und Escape-Aktionen hängen ebenfalls von Fokus, Auswahl-/Shell-Zustand und aktuellem Vorgang ab; nehmen Sie nicht an, dass jedes ArrowUp oder Escape bedingungslos global wirkt. Hover-Tooltips und Kürzelverwaltung zeigen aktuelle Zuweisungen ohne permanente Tastaturhilfeleiste.
