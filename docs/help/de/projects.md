# Projekte und Worktrees

Bei aktiviertem Multi-Backend klappen Sie **REMOTE** auf der Startseite oder im `+`-Schnellstarter auf. Wählen Sie **+ Projekt** neben einem gespeicherten CodeNomad-Server, durchsuchen Sie dort seine Ordner und wählen Sie **Öffnen**. Zum Hinzufügen fügen Sie den Kopplungslink oder die Adresse unter der Serverliste ein. Hier geöffnete Projekte bleiben auch bei getrenntem Server mit Symbol und Servernamen in der gemeinsamen Liste. Durchsuchen, Klonen und temporäre Projekte verwenden diesen Computer.

Ein Projekt-Tab verbindet CodeNomad mit einem Ordner auf dem Backend-Rechner. Das Öffnen eines Tabs, Durchsuchen eines Checkouts und Verschieben einer Unterhaltungsfamilie sind verschiedene Vorgänge.

**+ Projekt** beginnt beim zuletzt bekannten Projektpfad. Wurde der Ordner verschoben oder gelöscht, wählen Sie **Server-Stammordner**. Beim Öffnen eines zuletzt verwendeten Projekts führt **Abbrechen** zurück zur Serverliste.

In der Liste erscheinen nur Remote-Projekte, die Sie hier erfolgreich öffnen. Beim Durchsuchen von Ordnern kommen keine Einträge hinzu. Gespeicherte Verknüpfungen bleiben für genau diese Verbindung (Profil, Adresse, TLS-Prüfeinstellung und SSH-Ziel) auch offline verfügbar. Gibt es für den Ordner bereits einen wartenden Tab, wird er mit seinen Entwürfen ausgewählt. Sie entscheiden, wann Sie es erneut versuchen.

Eine entfernte Verknüpfung bleibt ausgeblendet, bis Sie den Ordner erneut öffnen.

## Projekt öffnen {#open-project}

1. Klicken Sie auf **Neue Instanz** (`+`), um die Startseite zu öffnen.
2. Wählen Sie **Ordner durchsuchen**, wählen und öffnen Sie den Backend-Ordner; oder wählen Sie einen Eintrag unter **Letzte Ordner**.
3. Für eine Repository-Kopie wählen Sie **Git-Repo klonen**, geben **Repository-URL** und **Zielordner** ein und wählen **Klonen**. **Zielordner** wird mit dem Repository-Namen im Ordner, der Ihren letzten Klon enthält vorbelegt, sonst neben Ihrem zuletzt geöffneten Projekt. **Durchsuchen** wählt den Ordner, der den Klon enthält; Sie können den Pfad auch bearbeiten, einschließlich des Ordnernamens des Klons.

Einen Remote-Server zu durchsuchen bedeutet, dessen Dateisystem zu durchsuchen, nicht Ihr Telefon oder Notebook. Das Öffnen eines Projekts erzeugt keinen separaten OpenCode-Daemon pro Tab. Unterhaltungen sind native OpenCode-Sitzungen; ihre Lebensdauer entspricht nicht der des Tabs.

Klonen schreibt ein Repository ins Zielverzeichnis. **Zielordner zuerst entfernen, falls er bereits existiert.** ist destruktiv: Aktivieren Sie dies nur, wenn alles dort Vorhandene gelöscht werden darf. Verwenden Sie im Zweifel ein neues Ziel.

Zuletzt verwendete Einträge sind Verknüpfungen. **Arbeitsbereich umbenennen** ändert den Anzeigenamen; **Aus Liste entfernen** entfernt die Verknüpfung, nicht die Dateien oder Unterhaltungen. Ein Klick auf ein bereits geöffnetes zuletzt verwendetes Projekt öffnet einen neuen Tab; seine Schaltfläche **Offen** (**Zum offenen Projekt wechseln**) wählt stattdessen den vorhandenen Tab.

Öffnen Sie denselben Ordner zweimal und wählen Sie in beiden Tabs dieselbe Unterhaltung, um in einem den Chat und im anderen eine Webvorschau, eine Datei oder einen Missionsbericht anzuzeigen. Jeder Tab behält seine eigene Ansicht, Scrollposition der Unterhaltung, Auswahl im rechten Panel und seinen Dateien-Modus; Nachrichten, Ausführung und Projektdaten bleiben gemeinsam.

## Schnellstarter für neue Instanzen verwenden {#new-instance-launcher}

1. Halten Sie `+` gedrückt oder klicken Sie mit der rechten Maustaste darauf; bei Tastaturfokus dort verwenden Sie **Alt+Down**, **Shift+F10** oder die Menütaste.
2. Suchen Sie zuletzt verwendete Projekte oder wählen Sie **Durchsuchen…**, **Temporär** oder **Klonen…**.

Ein normaler Klick öffnet die Startseite. Der Schnellstarter wechselt zum offenen Projekt; die Startseite öffnet einen neuen Tab, sofern kein wartender Tab ausgewählt wird. In **REMOTE** kehrt Escape zur Serverliste zurück, klappt sie zu und schließt dann den Schnellstarter mit Fokus auf `+`.

## Projekt-Tab schließen {#close-stop}

1. Verwenden Sie die Schließen-Schaltfläche des Tabs oder **Tab schließen** in der Befehlspalette (`Ctrl/Cmd+W` im Renderer).
2. Das Schließen des Tabs schließt dieses Projekt in CodeNomad: CodeNomad verfolgt dessen Ereignisse und Anfragen nicht mehr. Sitzungen laufen in OpenCode weiter.
3. Öffnen Sie den Ordner über die Ordnersuche oder zuletzt verwendete Einträge erneut, um diese Unterhaltungen wiederzufinden.

| Aktion | Geltungsbereich und Wirkung | Was sie nicht tut |
| --- | --- | --- |
| Tab schließen | Entfernt die CodeNomad-Projektverbindung dieses Tabs; ein anderer, separat geöffneter Tab desselben Ordners bleibt unberührt | Löscht weder Projektdateien noch nativen Verlauf, stoppt keine Sitzungen und entlädt nicht die OpenCode-Location |
| Sitzung stoppen | Ausführung der ausgewählten Unterhaltung | Schließt weder Projekt noch löscht es dessen Verlauf |

Zeigt ein anderes Fenster dieselbe Projektverbindung, schließt sich dessen Tab ebenfalls und dieses Fenster zeigt eine Benachrichtigung. Ungesendete Entwürfe und Anhänge des geschlossenen Tabs kehren zurück, wenn Sie denselben Ordner in diesem Fenster erneut öffnen; das Fenster behält sie für seine 16 zuletzt geschlossenen Projekte, bis es neu geladen oder geschlossen wird. Sie gehören nicht zur Startwiederherstellung.

Das Schließen eines ganzen Fensters, Beenden oder Neuladen schließt dessen Projektverbindungen nicht; die normale Startwiederherstellung gilt weiterhin. Stoppen Sie relevante Ausführungen ausdrücklich, wenn Sie sicherstellen müssen, dass sie beendet sind. CodeNomad entlädt niemals native Locations; die Wartung des gemeinsamen Dienstes beschreibt die [OpenCode-Einrichtung](opencode.md).

Bei aktivierter Startwiederherstellung stellt jeder verbleibende Tab seine eigenen Panel-Auswahlen, Missionsauswahl und -leseansicht sowie die Wahl zwischen Chat und Web-Vorschau wieder her. Browser-URLs und Verlauf werden pro Sitzung geteilt; gespeicherte Seiten laden erst beim ausdrücklichen erneuten Öffnen der Web-Vorschau. Das Schließen einer Instanz entfernt nur ihre gespeicherte Ansicht; erneutes Öffnen des Ordners erzeugt eine neue Instanz.

## Remote-Tabs wiederherstellen {#restore-remote-tabs}

Bei aktiviertem Multi-Backend behalten gespeicherte Remote-Projekte ihre Tab-Reihenfolge, Auswahl und eigenen Entwürfe pro Tab. Ein unerreichbarer Server hinterlässt einen wartenden Tab: Wählen Sie **Wiederholen**, sobald er erreichbar ist, oder **Verbinden** mit Benutzername/Passwort oder einem neuen **Kopplungslink**. Andere Server bleiben nutzbar.

**Wiederholen** stellt wartende Tabs auch bei deaktivierter automatischer Startwiederherstellung wieder her. Benachrichtigungen wählen den vorhandenen wartenden Tab aus. Prüfen Sie das Ergebnis einer unbestätigten Konversationsaktion, bevor Sie sie erneut senden.

Bevor Sie einen Server entfernen oder seine Adresse ändern, schließen Sie seine Projekttabs in allen Fenstern und öffnen Sie **Einstellungen** von einem anderen Projekt aus, falls die Einstellungen noch diesen Server verwenden. Ein unerreichbarer Projektbestand blockiert die Änderung bis zur Prüfung.

## Temporäre Arbeitsbereiche {#temporary-workspaces}

1. Wählen Sie **Temporär** im Schnellstarter oder **Neue temporäre Instanz** auf der Startseite.
2. Arbeiten Sie im leeren, von CodeNomad verwalteten Ordner; Git wird nicht automatisch initialisiert.
3. Wählen Sie beim Schließen des Tabs **Behalten**, **Verwerfen** oder **Abbrechen**. Das Tab-Menü bietet auch **Als Projekt behalten**.

| Auswahl | Wirkung | Wiederherstellung |
| --- | --- | --- |
| Behalten | Schließt das Projekt in CodeNomad, behält Ordner und Unterhaltungen, entfernt den temporären Status und fügt ein zuletzt verwendetes Projekt hinzu | Über zuletzt verwendete Einträge erneut öffnen; der Ordner wird nicht verschoben |
| Verwerfen | Löscht Unterhaltungen, Dateien und ungesendete Entwürfe des temporären Arbeitsbereichs | Nicht rückgängig zu machen; benötigte Inhalte vorher anderswo sichern |
| Abbrechen | Lässt den temporären Arbeitsbereich geöffnet | Weiterarbeiten oder später entscheiden |

Ein unberührter temporärer Tab ohne Unterhaltung, Datei oder ungesendeten Entwurf wird beim Schließen stillschweigend verworfen. Geöffnete temporäre Tabs nehmen an der normalen Startwiederherstellung teil, aber die Startseite hat keine separate Liste zum Fortsetzen geschlossener temporärer Ordner.

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
