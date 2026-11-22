# Projekte und Worktrees

Ein Projekt-Tab verbindet CodeNomad mit einem Ordner auf dem Backend-Rechner. Das Öffnen eines Tabs, Durchsuchen eines Checkouts und Verschieben einer Unterhaltungsfamilie sind verschiedene Vorgänge.

## Projekt öffnen {#open-project}

Klicken Sie auf **Neue Instanz** (`+`) oder drücken Sie `Ctrl/Cmd+N`, um einen neuen leeren Tab zu öffnen. Wählen Sie ein Projekt unter **Zuletzt verwendete Tabs** oder **Durchsuchen**. Wenn keine Tabs wiederhergestellt werden oder der letzte Tab geschlossen wird, zeigt CodeNomad einen leeren Tab. Klonen und temporäre Tabs verwenden das lokale Backend.

Unter den zuletzt verwendeten Tabs wechselt **Offen** zu einem Tab in diesem Fenster. Der grüne Punkt **Anderswo geöffnet** zeigt eine Verbindung auf dem Projektserver außerhalb dieses Fensters an. Ein Klick auf die Zeile öffnet einen eigenen Tab.

[Ein Remote-Projekt in einem Tab öffnen](remote-access.md#remote-project-tabs) · [SideCars](browser-sidecars.md#register-sidecar)

Für eine Repository-Kopie wählen Sie **Git-Repo klonen**, geben **Repository-URL** und **Zielordner** ein und wählen **Klonen**. **Zielordner** wird mit dem Repository-Namen im Ordner, der Ihren letzten Klon enthält vorbelegt, sonst neben Ihrem zuletzt geöffneten Projekt. **Durchsuchen** wählt den Ordner, der den Klon enthält; Sie können den Pfad auch bearbeiten, einschließlich des Ordnernamens des Klons.

Einen Remote-Server zu durchsuchen bedeutet, dessen Dateisystem zu durchsuchen, nicht Ihr Telefon oder Notebook. Das Öffnen eines Projekts erzeugt keinen separaten OpenCode-Daemon pro Tab. Unterhaltungen sind native OpenCode-Sitzungen; ihre Lebensdauer entspricht nicht der des Tabs.

Klonen schreibt ein Repository ins Zielverzeichnis. **Zielordner zuerst entfernen, falls er bereits existiert.** ist destruktiv: Aktivieren Sie dies nur, wenn alles dort Vorhandene gelöscht werden darf. Verwenden Sie im Zweifel ein neues Ziel. Ein fehlgeschlagener Klon ist kein Grund, ein vorhandenes Projekt zu löschen; prüfen Sie vor dem Wiederholen das gemeldete Ziel und den Fehler.

Zuletzt verwendete Einträge sind Verknüpfungen. Das Aktionsmenü im leeren Tab bietet je nach Eintrag **Arbeitsbereich umbenennen** und **Aus Liste entfernen**; Dateien und Unterhaltungen bleiben erhalten. Im leeren Tab und im Schnellstarter erzeugt ein Klick auf lokale/entfernte Projekte oder SideCars ein neues Vorkommen, auch wenn sie geöffnet sind. Die separate Aktion **Offen** (**Zum offenen Projekt wechseln**) wählt das vorhandene Vorkommen.

Die Aktion zum Wechseln wählt auch einen Tab aus, der auf seinen Server wartet, und schließt den leeren Ausgangstab.

## Schnellstarter für neue Instanzen verwenden {#new-instance-launcher}

Halten Sie `+` gedrückt oder klicken Sie mit der rechten Maustaste darauf; bei Tastaturfokus dort verwenden Sie **Alt+Down**, **Shift+F10** oder die Menütaste.
Tab öffnet die Suche, Pfeiltasten und Enter wählen aus, Escape setzt den Fokus zurück auf `+`.

## Projekt-Tab schließen {#close-stop}

1. Verwenden Sie die Schließen-Schaltfläche des Tabs oder **Tab schließen** in der Befehlspalette (`Ctrl/Cmd+W` im Renderer).
2. Das Schließen des Tabs schließt dieses Projekt in CodeNomad: CodeNomad verfolgt dessen Ereignisse und Anfragen nicht mehr. Sitzungen laufen in OpenCode weiter.
3. Öffnen Sie den Ordner über die Ordnersuche oder zuletzt verwendete Einträge erneut, um diese Unterhaltungen wiederzufinden.

| Aktion | Geltungsbereich und Wirkung | Was sie nicht tut |
| --- | --- | --- |
| Tab schließen | Entfernt die CodeNomad-Projektverbindung dieses Tabs; ein anderer, separat geöffneter Tab desselben Ordners bleibt unberührt | Löscht weder Projektdateien noch nativen Verlauf, stoppt keine Sitzungen und entlädt nicht die OpenCode-Location |
| Sitzung stoppen | Ausführung der ausgewählten Unterhaltung | Schließt weder Projekt noch löscht es dessen Verlauf |

Ungesendete Entwürfe und Anhänge des geschlossenen Tabs kehren zurück, wenn Sie denselben Ordner in diesem Fenster erneut öffnen; das Fenster behält sie für seine 16 zuletzt geschlossenen Projekte, bis es neu geladen oder geschlossen wird. Sie gehören nicht zur Startwiederherstellung.

Beim Schließen oder Neuladen eines Fensters oder Browser-Tabs und beim Beenden der App fordert CodeNomad die Server auf, die zugehörigen Projektverbindungen freizugeben. Auf einem nicht erreichbaren Server können die Einträge bestehen bleiben. Andere Fenster behalten ihre Tabs. Die Startwiederherstellung verbindet gespeicherte Tabs erneut und behält offene temporäre Ordner. Stoppen Sie Ausführungen ausdrücklich, wenn Sie sie beenden möchten. Hinweise zur Wartung des gemeinsamen Dienstes finden Sie unter [OpenCode-Einrichtung](opencode.md).

Bei aktivierter Startwiederherstellung stellt jeder verbleibende Tab seine eigenen Panel-Auswahlen, Missionsauswahl und -leseansicht sowie die Wahl zwischen Chat und Web-Vorschau wieder her. Browser-URLs und Verlauf werden pro Sitzung geteilt; gespeicherte Seiten laden erst beim ausdrücklichen erneuten Öffnen der Web-Vorschau. Das Schließen einer Instanz entfernt nur ihre gespeicherte Ansicht; erneutes Öffnen des Ordners erzeugt eine neue Instanz.

Ein duplizierter Browser-Tab öffnet eigene Projektverbindungen. Eine noch offene Verbindung kann nur beim Wiederherstellen desselben Tabs nach dem Verwerfen durch den Browser weiterverwendet werden.

## Remote-Tabs wiederherstellen {#restore-remote-tabs}

Beim Neuladen bleiben bei aktivierter Wiederherstellung Reihenfolge, Auswahl und Entwürfe der Remote-Tabs erhalten. Ein unerreichbarer Server hinterlässt einen wartenden Tab: Wählen Sie **Wiederholen**, sobald er erreichbar ist, oder **Verbinden** mit Benutzername/Passwort oder einem Link im Feld **Neuer Kopplungslink**. Andere Server bleiben nutzbar. **Server nicht gefunden** bedeutet, dass der gespeicherte Server fehlt.

**Wiederholen** verbindet das Projekt auf dem gespeicherten Server erneut und erstellt seine Verbindung bei Bedarf neu.

**Wiederholen** stellt wartende Tabs auch bei deaktivierter automatischer Startwiederherstellung wieder her. Benachrichtigungen wählen den vorhandenen wartenden Tab aus. Prüfen Sie das Ergebnis einer unbestätigten Konversationsaktion, bevor Sie sie erneut senden.

## Temporäre Arbeitsbereiche {#temporary-workspaces}

1. Wählen Sie oben im leeren Tab **Temporärer Tab**.
2. Arbeiten Sie im leeren, von CodeNomad verwalteten Ordner; Git wird nicht automatisch initialisiert.
3. Wählen Sie beim Schließen des Tabs **Behalten**, **Verwerfen** oder **Abbrechen**. Das Tab-Menü bietet auch **Als Projekt behalten**.

| Auswahl | Wirkung | Wiederherstellung |
| --- | --- | --- |
| Behalten | Schließt das Projekt in CodeNomad, behält Ordner und Unterhaltungen, entfernt den temporären Status und fügt ein zuletzt verwendetes Projekt hinzu | Über zuletzt verwendete Einträge erneut öffnen; der Ordner wird nicht verschoben |
| Verwerfen | Löscht Unterhaltungen, Dateien und ungesendete Entwürfe des temporären Arbeitsbereichs | Nicht rückgängig zu machen; benötigte Inhalte vorher anderswo sichern |
| Abbrechen | Lässt den temporären Arbeitsbereich geöffnet | Weiterarbeiten oder später entscheiden |

Ein unberührter temporärer Tab ohne Unterhaltung, Datei oder ungesendeten Entwurf wird beim Schließen stillschweigend verworfen. Geöffnete temporäre Tabs nehmen an der normalen Startwiederherstellung teil.

Verwerfen wird verweigert, während eine Unterhaltung läuft oder der Ordner in einem anderen Tab/Fenster geöffnet ist. Stoppen Sie zuerst die Ausführung und schließen Sie die anderen Ansichten. Nach fehlgeschlagenem Verwerfen bleibt der Ordner temporär: Beheben Sie das gemeldete Problem und versuchen Sie es erneut, statt manuell ein übergeordnetes Verzeichnis zu löschen.

## Worktree auswählen oder erstellen {#select-create-worktree}

1. Öffnen Sie eine übergeordnete Unterhaltung und verwenden Sie deren Worktree-Auswahl im Eingabefeld. In schmalen Layouts besteht sie nur aus einem Pfeil.
2. Wählen Sie einen vorhandenen gefundenen Worktree oder **+ Worktree erstellen**.
3. Geben Sie zum Erstellen **Name** ein und wählen Sie **Worktree erstellen und verwenden**.

Ist das Projekt ein Ordner innerhalb eines Repositorys, werden nur Worktrees aufgeführt, die diesen Ordner enthalten. Um aus einem solchen Ordner einen Worktree zu erstellen, muss Git ihn verfolgen. Ein neuer Branch-Name beginnt am HEAD des ausgewählten Checkouts. Ein vorhandener Branch-Name verwendet dessen aktuelle Revision; Git kann einen bereits anderswo ausgecheckten Branch verweigern. Worktrees verwenden standardmäßig `.codenomad/worktrees`. Nicht committete Änderungen bleiben im ursprünglichen Checkout; die Erstellung kopiert sie nicht in den neuen Worktree.

Die Auswahl im Eingabefeld verschiebt die übergeordnete Unterhaltung und ihre rekursiven Nachfahren als überprüfte Familie. Eine Untersitzung kann diese Auswahl nicht unabhängig ändern. Aktive Sitzungen blockieren den Vorgang: Lassen Sie die Familie zuerst fertig werden oder stoppen Sie deren Ausführung. Warten Sie den Abschluss einer Verschiebung ab, bevor Sie die nächste anfordern; prüfen Sie bei Fehlern vor dem Wiederholen den aktualisierten Unterhaltungs-/Worktree-Zustand.

**Worktree ansehen** unter [Dateien](files.md) ändert dagegen nur, welchen Checkout das Panel liest. Es verschiebt keine Unterhaltung, wechselt keinen Branch und ändert nicht den Ausführungsort des nächsten Shell-Befehls.

## Worktree entfernen {#remove-worktree}

1. Verwenden Sie in der Worktree-Liste des Eingabefelds **Worktree löschen** für einen entfernbaren Branch-Worktree.
2. Prüfen Sie den Zielordner. Lassen Sie **Löschen erzwingen (lokale Änderungen verwerfen)** deaktiviert, sofern lokale Änderungen nicht verloren gehen dürfen.
3. Bestätigen Sie die Löschung und prüfen Sie anschließend das Verzeichnis der Worktrees.

Die Löschung entfernt den lokalen Ordner des Worktrees. Gits Haupt-Checkout ist kein entfernbares Ziel. CodeNomad verschiebt betroffene Unterhaltungsfamilien zurück zum Stamm-Checkout und überprüft ihren Ort vor dem Entfernen des Worktrees; aktive Sitzungen können das Entfernen blockieren. Löschen ist weder Archivierung noch Sicherung nicht committeter Dateien.

Verweigert Git geänderte/nicht verfolgte Dateien, sichern oder bereinigen Sie diese vor dem Wiederholen. Erzwungenes Löschen verwirft sie ausdrücklich. Schließen Sie bei gesperrten Verzeichnissen darauf zugreifende Terminals, Editoren, Watcher und Hintergrundprozesse. Der Fehlerdialog bietet **Bereinigten Fehler kopieren** zum Teilen von Diagnosen; prüfen Sie auch bereinigten Text vorher.

## Git initialisieren oder ohne Git arbeiten {#initialize-git}

1. Öffnen Sie für einen normalen Ordner bei verfügbarem Git **Dateien → Änderungen** oder **Commits**.
2. Wählen Sie **Git initialisieren**. Die Aktion erfolgt sofort, ohne zusätzliche Bestätigung.
3. Warten Sie auf die Aktualisierung von Projektmetadaten und Unterhaltungen; verwenden Sie **Aktualisieren**, falls Git außerhalb von CodeNomad initialisiert wurde.

Die Initialisierung erstellt das Repository im ausdrücklich geöffneten Ordner, nicht dessen übergeordnetem Verzeichnis. Sie erstellt keinen Commit.

Kann das Backend Git nicht ausführen, bleiben Unterhaltungen und begrenztes Durchsuchen von Dateien für den ausdrücklich geöffneten Ordner im Verzeichnismodus verfügbar. Worktree-Vorgänge und Git-Initialisierung erfordern Git auf diesem Backend. Siehe [Installation](install.md) und [Dateien](files.md).
