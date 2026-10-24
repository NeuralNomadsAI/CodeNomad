# Projekte und Worktrees

Ein Projekt-Tab verbindet CodeNomad mit einem Ordner auf dem Backend-Rechner. Das Öffnen eines Tabs, Durchsuchen eines Checkouts und Verschieben einer Unterhaltungsfamilie sind verschiedene Vorgänge.

## Projekt öffnen {#open-project}

1. Klicken Sie auf **Neue Instanz** (`+`), um die Startseite zu öffnen.
2. Wählen Sie **Ordner durchsuchen**, wählen und öffnen Sie den Backend-Ordner; oder wählen Sie einen Eintrag unter **Letzte Ordner**.
3. Für eine Repository-Kopie wählen Sie **Git-Repo klonen**, geben **Repository-URL** und **Zielordner** ein und wählen **Klonen**.

Einen Remote-Server zu durchsuchen bedeutet, dessen Dateisystem zu durchsuchen, nicht Ihr Telefon oder Notebook. Das Öffnen eines Projekts erzeugt keinen separaten OpenCode-Daemon pro Tab. Unterhaltungen sind native OpenCode-Sitzungen; ihre Lebensdauer entspricht nicht der des Tabs.

Klonen schreibt ein Repository ins Zielverzeichnis. **Zielordner zuerst entfernen, falls er bereits existiert.** ist destruktiv: Aktivieren Sie dies nur, wenn alles dort Vorhandene gelöscht werden darf. Verwenden Sie im Zweifel ein neues Ziel. Ein fehlgeschlagener Klon ist kein Grund, ein vorhandenes Projekt zu löschen; prüfen Sie vor dem Wiederholen das gemeldete Ziel und den Fehler.

Zuletzt verwendete Einträge sind Verknüpfungen. **Arbeitsbereich umbenennen** ändert den Anzeigenamen; **Aus Liste entfernen** entfernt die Verknüpfung, nicht die Dateien oder Unterhaltungen. Ein Klick auf ein bereits geöffnetes zuletzt verwendetes Projekt öffnet einen neuen Tab; seine Schaltfläche **Offen** (**Zum offenen Projekt wechseln**) wählt stattdessen den vorhandenen Tab.

## Schnellstarter für neue Instanzen verwenden {#new-instance-launcher}

1. Halten Sie `+` gedrückt oder klicken Sie mit der rechten Maustaste darauf; bei Tastaturfokus dort verwenden Sie **Alt+Down**, **Shift+F10** oder die Menütaste.
2. Suchen Sie zuletzt verwendete Projekte oder wählen Sie **Durchsuchen…**, **Temporär** oder **Klonen…**.

Ein normaler Klick öffnet weiterhin die vollständige Startseite. Der Schnellstarter ist ein Direktzugriff, keine Verwaltungsoberfläche: Benennen/entfernen Sie zuletzt verwendete Projekte und verwalten Sie Server-Lesezeichen auf der Startseite. Escape schließt den Schnellstarter und setzt den Fokus auf `+` zurück.

## Projekt-Tab schließen {#close-stop}

1. Verwenden Sie die Schließen-Schaltfläche des Tabs oder **Tab schließen** in der Befehlspalette (`Ctrl/Cmd+W` im Renderer).
2. Das Schließen des Tabs schließt dieses Projekt in CodeNomad: CodeNomad verfolgt dessen Ereignisse und Anfragen nicht mehr. Sitzungen laufen in OpenCode weiter.
3. Öffnen Sie den Ordner über die Ordnersuche oder zuletzt verwendete Einträge erneut, um diese Unterhaltungen wiederzufinden.

| Aktion | Geltungsbereich und Wirkung | Was sie nicht tut |
| --- | --- | --- |
| Tab schließen | Entfernt die CodeNomad-Projektverbindung dieses Tabs; ein anderer, separat geöffneter Tab desselben Ordners bleibt unberührt | Löscht weder Projektdateien noch nativen Verlauf, stoppt keine Sitzungen und entlädt nicht die OpenCode-Location |
| Sitzung stoppen | Ausführung der ausgewählten Unterhaltung | Schließt weder Projekt noch löscht es dessen Verlauf |

Zeigt ein anderes Fenster dieselbe Projektverbindung, schließt sich dessen Tab ebenfalls und dieses Fenster zeigt eine Benachrichtigung. Das auslösende Fenster zeigt keine. Das Schließen erfolgt sofort; kann das Backend das Projekt nicht schließen, erscheint ein Fehler, und **Zum offenen Projekt wechseln** auf der Startseite erreicht es weiterhin. Es gibt keine automatische Wiederholung. Ungesendete Entwürfe des geschlossenen Tabs werden nicht in die Startwiederherstellung übernommen.

Das Schließen eines ganzen Fensters, Beenden oder Neuladen schließt dessen Projektverbindungen nicht; die normale Startwiederherstellung gilt weiterhin. Stoppen Sie relevante Ausführungen ausdrücklich, wenn Sie sicherstellen müssen, dass sie beendet sind. CodeNomad entlädt niemals native Locations; die Wartung des gemeinsamen Dienstes beschreibt die [OpenCode-Einrichtung](opencode.md).

## Temporäre Arbeitsbereiche {#temporary-workspaces}

1. Wählen Sie **Temporär** im Schnellstarter oder **Neue temporäre Instanz** auf der Startseite.
2. Arbeiten Sie im leeren, von CodeNomad verwalteten Ordner; Git wird nicht automatisch initialisiert.
3. Wählen Sie beim Schließen des Tabs **Behalten**, **Verwerfen** oder **Abbrechen**. Das Tab-Menü bietet auch **Als Projekt behalten**.

| Auswahl | Wirkung | Wiederherstellung |
| --- | --- | --- |
| Behalten | Schließt das Projekt in CodeNomad, behält Ordner und Unterhaltungen, entfernt den temporären Status und fügt ein zuletzt verwendetes Projekt hinzu | Über zuletzt verwendete Einträge erneut öffnen; der Ordner wird nicht verschoben |
| Verwerfen | Löscht Unterhaltungen und Dateien des temporären Arbeitsbereichs | Nicht rückgängig zu machen; benötigte Inhalte vorher anderswo sichern |
| Abbrechen | Lässt den temporären Arbeitsbereich geöffnet | Weiterarbeiten oder später entscheiden |

Ein unberührter temporärer Tab ohne Unterhaltung, Datei oder ungesendeten Entwurf wird beim Schließen stillschweigend verworfen. Geöffnete temporäre Tabs nehmen an der normalen Startwiederherstellung teil, aber die Startseite hat keine separate Liste zum Fortsetzen geschlossener temporärer Ordner.

Verwerfen wird verweigert, während eine Unterhaltung läuft oder der Ordner in einem anderen Tab/Fenster geöffnet ist. Stoppen Sie zuerst die Ausführung und schließen Sie die anderen Ansichten. Nach fehlgeschlagenem Verwerfen bleibt der Ordner temporär: Beheben Sie das gemeldete Problem und versuchen Sie es erneut, statt manuell ein übergeordnetes Verzeichnis zu löschen.

## Worktree auswählen oder erstellen {#select-create-worktree}

1. Öffnen Sie eine übergeordnete Unterhaltung und verwenden Sie deren Worktree-Auswahl im Eingabefeld. In schmalen Layouts besteht sie nur aus einem Pfeil.
2. Wählen Sie einen vorhandenen gefundenen Worktree oder **+ Worktree erstellen**.
3. Geben Sie zum Erstellen **Name** ein und wählen Sie **Worktree erstellen und verwenden**.

CodeNomad findet Worktrees über OpenCode und prüft ihre Zugehörigkeit zum geöffneten Repository. Ein neuer Branch-Name beginnt am HEAD des ausgewählten Checkouts. Ein vorhandener Branch-Name verwendet dessen aktuelle Revision; Git kann einen bereits anderswo ausgecheckten Branch verweigern. Worktrees verwenden standardmäßig `.codenomad/worktrees`. Nicht committete Änderungen bleiben im ursprünglichen Checkout; die Erstellung kopiert sie nicht in den neuen Worktree.

Die Auswahl im Eingabefeld verschiebt die übergeordnete Unterhaltung und ihre rekursiven Nachfahren als überprüfte Familie. Eine Untersitzung kann diese Auswahl nicht unabhängig ändern. Aktive Sitzungen blockieren den Vorgang: Lassen Sie die Familie zuerst fertig werden oder stoppen Sie deren Ausführung. Warten Sie den Abschluss einer Verschiebung ab, bevor Sie die nächste anfordern; prüfen Sie bei Fehlern vor dem Wiederholen den aktualisierten Unterhaltungs-/Worktree-Zustand.

**Worktree ansehen** unter [Dateien](files.md) ändert dagegen nur, welchen Checkout das Panel liest. Es verschiebt keine Unterhaltung, wechselt keinen Branch und ändert nicht den Ausführungsort des nächsten Shell-Befehls.

## Worktree entfernen {#remove-worktree}

1. Verwenden Sie in der Worktree-Liste des Eingabefelds **Worktree löschen** für einen entfernbaren Branch-Worktree.
2. Prüfen Sie den Zielordner. Lassen Sie **Löschen erzwingen (lokale Änderungen verwerfen)** deaktiviert, sofern lokale Änderungen nicht verloren gehen dürfen.
3. Bestätigen Sie die Löschung und prüfen Sie anschließend das Verzeichnis der Worktrees.

Die Löschung entfernt den lokalen Ordner des Worktrees. Gits Haupt-Checkout ist kein entfernbares Ziel. CodeNomad verschiebt betroffene Unterhaltungsfamilien zurück zum Stamm-Checkout und überprüft ihren Ort vor dem Entfernen des Worktrees; aktive Sitzungen können das Entfernen blockieren. Löschen ist weder Archivierung noch Sicherung nicht committeter Dateien.

Verweigert Git geänderte/nicht verfolgte Dateien, sichern oder bereinigen Sie diese vor dem Wiederholen. Erzwungenes Löschen verwirft sie ausdrücklich. Schließen Sie bei gesperrten Verzeichnissen darauf zugreifende Terminals, Editoren, Watcher und Hintergrundprozesse. Aktualisieren Sie bei fehlendem Eintrag die Worktrees und prüfen Sie vor einem erneuten Versuch den Pfad. Der Fehlerdialog bietet **Bereinigten Fehler kopieren** zum Teilen von Diagnosen; prüfen Sie auch bereinigten Text vorher.

## Git initialisieren oder ohne Git arbeiten {#initialize-git}

1. Öffnen Sie für einen normalen Ordner bei verfügbarem Git **Dateien → Änderungen** oder **Commits**.
2. Wählen Sie **Git initialisieren**. Die Aktion erfolgt sofort, ohne zusätzliche Bestätigung.
3. Warten Sie auf die Aktualisierung von Projektmetadaten und Unterhaltungen; verwenden Sie **Aktualisieren**, falls Git außerhalb von CodeNomad initialisiert wurde.

Die Initialisierung erstellt das Repository im ausdrücklich geöffneten Ordner, nicht dessen übergeordnetem Verzeichnis. Sie erstellt keinen Commit. Prüfen Sie bei Fehlern die Meldung und aktualisieren Sie vor dem Wiederholen: Eine ungewisse Antwort wird nicht automatisch erneut ausgeführt.

Kann das Backend Git nicht ausführen, bleiben Unterhaltungen und begrenztes Durchsuchen von Dateien für den ausdrücklich geöffneten Ordner im Verzeichnismodus verfügbar. Worktree-Vorgänge und Git-Initialisierung erfordern Git auf diesem Backend. Siehe [Installation](install.md) und [Dateien](files.md).
