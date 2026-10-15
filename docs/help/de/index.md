# CodeNomad-Hilfe

Diese Anleitung beschreibt die Bedienung des aktuellen CodeNomad-Desktop- oder Browser-Arbeitsbereichs mit Ihrem OpenCode-Dienst. Im Mittelpunkt stehen die Bedienelemente, Ausführungsgrenzen und Wiederherstellung von CodeNomad – keine Einführung in die OpenCode-Konfiguration und kein Versionsarchiv.

## Zuerst lesen {#read-this-first}

CodeNomad verbindet Ihren Arbeitsbereich mit einem gemeinsam genutzten OpenCode-Hintergrunddienst. Sitzungen und Nachrichten gehören zu OpenCode; Tabs, Eingabeentwürfe und Layout zum CodeNomad-Client. Das Schließen eines Projekt-Tabs schließt das Projekt in CodeNomad; Sitzungen laufen in OpenCode weiter und sind nach erneutem Öffnen des Projekts wieder verfügbar. CodeNomad zu schließen beendet nicht OpenCode.

1. Prüfen Sie die [Host-Anforderungen](install.md#requirements) und die [OpenCode-Einrichtung](opencode.md).
2. [Öffnen Sie ein Projekt](projects.md) und wählen Sie dann Agent, Modell und Denkaufwand der Unterhaltung.
3. Prüfen Sie vor Änderungen an Zugangsdaten, Dienstneustarts oder dem Löschen von Verlauf den betroffenen Geltungsbereich. Andere Clients können denselben nativen Dienst verwenden.

Die öffentliche Hilfe funktioniert ohne CodeNomad, dessen Backend oder Anmeldung. **Hilfe → CodeNomad-Hilfe** auf dem Desktop und **Hilfe öffnen** in der Befehlspalette öffnen sie separat in der aktuellen Oberflächensprache. Sprachänderungen übersetzen keine gespeicherten Unterhaltungen.

**Einstellungen** öffnet in einem lokalen Desktop-Client das native Fenster **Einstellungen**; Browser- und Remote-Clients verwenden eingebettete Einstellungen. Pfade wie **Einstellungen → Anbieter** bezeichnen auf beiden Oberflächen denselben Einstellungsbereich.

Für einen eigenständigen Browser-Arbeitsbereich auf einem vorbereiteten Host erklärt die [Server-Anleitung](server.md) diesen Start sowie die Anforderungen an Authentifizierung und TLS:

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

## Client auswählen {#choose-your-client}

| Funktion | Lokaler Desktop | Direkter Browser oder Remote-Server-Fenster | Gekoppeltes Fernsteuerungsgerät |
| --- | --- | --- | --- |
| Projekte, Unterhaltungen, Dateien und Verlauf | Ordner und native Sitzungen des Backends | Ordner und Sitzungen des verbundenen Servers | Autorisierte Arbeitsbereichsoberflächen des Hosts |
| Native Einstellungen und Desktop-Fenster | Verfügbar | Browser-/Remote-Einstellungen bleiben im Client | Nur auf dem Host verfügbare Desktop-Steuerung nicht verfügbar |
| Browser-Vorschau der Sitzung | Nativ in Electron und Windows-Tauri; iframe auf anderen Tauri-Plattformen | iframe, soweit verfügbar | Nur auf dem Host verfügbare Vorschau-Endpunkte nicht verfügbar |
| Native Desktop-/Browser-Automatisierung | Zugeordnete lokale Fenster/Vorschauen | Kein Ersatz für native Desktop-Automatisierung | Nur auf dem Host verfügbare Automatisierungs-Endpunkte nicht verfügbar |
| Authentifizierung | Lokale Ersteinrichtung oder Passwortsitzung | Server-Passwortsitzung | Zugangsdaten des gekoppelten Geräts |
| PWA-Installation | Native App oder Browser verwenden | Browserabhängig; sicherer Kontext erforderlich | Browserabhängig; Kopplung weiterhin erforderlich |

Die genauen Grenzen erläutern [Browser-Vorschauen und SideCars](browser-sidecars.md), [Fernsteuerung](remote-control.md) und [Mobil/PWA](mobile.md). Ein Remote-Fenster macht das Dateisystem Ihres Geräts nicht zum Server-Arbeitsbereich.

## Zuständigkeit für den Zustand verstehen {#state-and-scope}

| Begriff | Bedeutung in CodeNomad |
| --- | --- |
| Projekt-Tab / Arbeitsbereich / Instanz | Eine CodeNomad-Verbindung zu einem ausdrücklich geöffneten Ordner; mehrere Tabs können den gemeinsamen Dienst nutzen. |
| Unterhaltung / Sitzung | Nativer OpenCode-Verlauf und Ausführung, die einem Verzeichnis zugeordnet sind. |
| Familie | Eine Unterhaltung mit ihren rekursiven Untersitzungen; relevant für Verschieben, Aktivität, Yolo und Missionssteuerung. |
| Worktree | Ein zugehöriger Repository-Checkout, der zum Durchsuchen oder als Sitzungsort ausgewählt wurde. Ihn zu durchsuchen verschiebt keine Unterhaltung. |
| Location | Der verzeichnisbezogene native Laufzeitkontext von OpenCode; das Schließen eines Projekt-Tabs schließt das Projekt nur in CodeNomad und entfernt keine native Location. |
| CodeNomad-Backend | Der Server für Arbeitsbereiche, Git, Authentifizierung und Client-Verbindungen. Sein Konto und seine Umgebung bestimmen den Dateisystemzugriff des Backends. |
| Konfiguration | CodeNomad-Einstellungen im Konfigurationsverzeichnis des Servers; globale/projektbezogene OpenCode-Einstellungen haben ihren eigenen nativen Geltungsbereich. |
| Fenster | Eigene Tabs, Navigation, Entwürfe und wiederhergestellte Ansicht. Der native Verlauf wird gemeinsam genutzt, nicht für jedes Fenster kopiert. |
| Desktop-Datenprofil | Explizite Auswahl des nativen/Client-Speichers; isoliert nicht automatisch OpenCode-Sitzungen oder jede gemeinsam genutzte Konfiguration. |

Das Arbeitsbereichs-Stammverzeichnis begrenzt, welche Ordner CodeNomad öffnet; es ist keine Agenten-Sandbox. Lesen Sie die [Sicherheitshinweise](security.md), bevor Sie einen Host zugänglich machen oder umfassenden Werkzeugzugriff erlauben.

## Nach Aufgabe erkunden {#explore-by-task}

| Aufgabe | Anleitung |
| --- | --- |
| Arbeitsbereich installieren oder bereitstellen | [Installation](install.md), [Server-Referenz](server.md), [Netzwerk und TLS](remote-access.md) |
| Über Checkouts und Unterhaltungen hinweg arbeiten | [Projekte](projects.md), [Unterhaltungen](conversations.md), [Dateien](files.md) |
| Verlauf finden oder sicher bereinigen | [Verlauf](history.md) |
| Native Fragen und Berechtigungsanfragen beantworten | [Berechtigungen](permissions.md) |
| Begrenzte oder tägliche Arbeit koordinieren | [Missionen](missions.md) |
| Ausführung und Integrationen konfigurieren | [OpenCode](opencode.md), [Anbieter](providers.md), [Integrationen](integrations.md) |
| Weiteres Gerät verbinden | [Fernsteuerung](remote-control.md), [Sicherheit](security.md), [Mobil](mobile.md) |
| Arbeitsbereich anpassen | [Einstellungen](settings.md), [Tastenkürzel](shortcuts.md), [Sprache](voice.md), [Erweiterungen](extensions.md) |
| Native Anwendung verwalten | [Desktop](desktop.md), [Browser-Vorschauen und SideCars](browser-sidecars.md), [Updates](updates.md) |
| Probleme untersuchen oder beitragen | [Fehlerbehebung](troubleshooting.md), [Support und Quellcode-Builds](support.md) |

## Arbeit beobachten, ohne sie zu verändern {#monitor-work}

Das Status-Panel zeigt die Anbieternutzung und nativen Hintergrund-Shells der aktiven Sitzung. Unterhaltungsstatus und Unteraktivität kennzeichnen arbeitende, komprimierende und auf Eingaben wartende Sitzungen. Eine Hintergrund-Shell zu beobachten ist etwas anderes, als im Eingabefeld eine Shell-Anfrage zu senden oder einen separat gehosteten Terminal-SideCar zu verwenden.

1. Öffnen Sie **Status → Hintergrund-Shells** für die Location der ausgewählten Unterhaltung (oder den geöffneten Arbeitsbereich, wenn keine Unterhaltung ausgewählt ist).
2. Prüfen Sie Befehl, Shell, Verzeichnis, Status, PID und Exit-Code, soweit vorhanden; wählen Sie **Ausgabe anzeigen** für die verfügbare native Ausgabe.
3. Zum Entfernen verwenden Sie während der Ausführung **Stoppen und entfernen** oder nach dem Ende **Entfernen** und bestätigen das Ziel.

Das Entfernen einer laufenden Shell beendet diesen Prozess; das Schließen ihres Ausgabefensters nicht. Aktualisieren/Wiederverbinden liest den aktuellen nativen Zustand, statt verpasste Ausgabeereignisse zu rekonstruieren.

Anzeigeschnappschüsse werden nach nativen Änderungen, Wiederverbindungen und bei sichtbarem Bedarf aktualisiert. Sie sind keine garantierten Wiederholungsprotokolle. Ist ein Ergebnis ungewiss, aktualisieren Sie vor dem Wiederholen einer Änderung den maßgeblichen Zustand; senden Sie nicht allein wegen einer verpassten Benachrichtigung oder eines verpassten Ereignisses erneut.
