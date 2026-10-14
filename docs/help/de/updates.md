# Updates

## Release-Kanal wählen {#feed}

1. Öffnen Sie **Einstellungen → Info → Updates**.
2. Setzen Sie **Update-Kanal** auf **Stabile Releases** oder **Vorschau- und stabile Releases**.
3. Aktualisieren/prüfen Sie auf Updates und lesen Sie das angebotene Release vor Annahme einer Installation.

Der Kanal wird in CodeNomads Serverkonfiguration gespeichert und ändert nur angebotene Releases. Er ändert weder Desktop-Datenprofile, Entwürfe, Fenster, OpenCode-Sitzungen noch Dienstkonfiguration. Ohne explizite Auswahl verwenden als Vorschau gekennzeichnete Builds standardmäßig Vorschauen, andere Builds stabile Releases.

Stabil wählt das neueste endgültige Release. Vorschau folgt der Veröffentlichungsreihenfolge, da Entwicklungs-Builds eine Basisversionsnummer teilen können; vergleichen Sie nicht nur numerische Versionen. Vorschaupakete sind für Nutzer gedacht, die Vorabverhalten testen möchten; lesen Sie Release-Hinweise und schützen Sie wichtige Entwürfe vor Neustarts.

## Desktop-Installation aktualisieren {#desktop-update}

1. Verwenden Sie **Help → Get Updates...**, die Update-Benachrichtigung oder die Schaltfläche unter **Einstellungen → Info → Updates**.
2. Folgen Sie unter Electron der Release-Seite und laden Sie Archiv/Paket für verwendeten Host und Plattform.
3. Prüfen Sie bei geeigneten lokalen Tauri-Installationen das native Angebot und wählen Sie ausdrücklich **Installieren und neu starten**.
4. Sichern Sie vor Installation/Neustart wichtige Arbeit in jedem Fenster und prüfen Sie nach erneutem Start **Info**.

| Tauri-Installation | Eignung für In-App-Installation |
| --- | --- |
| Windows-x64-NSIS-Installation | Mit eingebettetem Updater-Schlüssel und signierten Release-Daten unterstützt. |
| macOS-x64-/arm64-Anwendung | Mit eingebettetem Updater-Schlüssel und signierten `.app.tar.gz`-Daten unterstützt. |
| Linux-x64-AppImage | Erfordert AppImage-Bundle-Markierung und nicht leeren `APPIMAGE`-Pfad sowie Unterstützung signierter Updates. `APPRUN` allein genügt nicht. |
| Debian/RPM, lose Windows-Programmdatei, unsignierter/schlüsselloser Build | Öffnet Release-Seite statt In-App-Installation. |

In Tauri-Anwendungsfenstern und nativen **Einstellungen**-Fenstern zeigt der Bereich Updates **Update installieren**, wenn ein Release angeboten wird. Er prüft den ausgewählten Kanal und bietet **Installieren und neu starten** an, wenn ein In-App-Update verfügbar ist; andernfalls öffnet er die dort angezeigte Release-Seite. Electron-, Web- und Remote-Fenster zeigen stattdessen den Link **Update herunterladen**, ohne native Updater-Prüfung.

Das Tauri-Menü **Help → Get Updates...** führt den Update-Ablauf im fokussierten Anwendungsfenster aus. Aus den Einstellungen oder einem Remote-Fenster bringt es das zuletzt verwendete Anwendungsfenster in den Vordergrund, um die Prüfung auszuführen; es installiert nicht über das Remote-Fenster. Wenn kein Anwendungsfenster die Aktion empfangen kann, auch wenn das Zielfenster eine Lade-, Anmelde- oder Kopplungsseite zeigt, öffnet das Menü stattdessen die Release-Seite.

Tauri bietet nur Releases mit veröffentlichtem Update-Manifest für gewählten Kanal/Ziel an. Ein neu angekündigtes Release ist möglicherweise noch nicht installierbar; die Benachrichtigung kann stattdessen dessen Release-Seite öffnen. Vor Installation ist native Signaturprüfung erforderlich. Updater-Signaturen unterscheiden sich von OS-Notarisierung/Code-Signaturzusicherungen.

Installation sichert den Zustand aller Anwendungsfenster und stoppt das zugehörige CodeNomad-Backend vor Ersetzen/Neustart der App. Der unabhängig verwaltete OpenCode-Daemon gehört nicht zu diesem Herunterfahren. CodeNomad zu schließen entfernt dennoch Backend-abhängige Funktionen bis zur Rückkehr; schließen Sie aus einer weiterlaufenden OpenCode-Sitzung nicht auf ununterbrochene UI-Dienste.

Ist eine Prüfung beschäftigt, warten Sie den Vorgang des anderen Fensters ab. Lesen Sie bei Download-, Validierungs- oder Herunterfahrfehlern den Fehler und prüfen Sie neu; eine alte Benachrichtigung erlaubt keine Neuinstallation veralteter Bytes. Eine fehlgeschlagene Installation kann Backend und Fenster wiederherstellen und wiederholt die Installation nicht automatisch. Ist native Installation nicht verfügbar, nutzen Sie die Release-Seite für das passende Paket; siehe [Installation](install.md).

## Eigenständigen Server aktualisieren {#standalone-update}

1. Ermitteln Sie, wie CodeNomad gestartet wurde, und sichern Sie Backend-abhängige Arbeit.
2. Stoppen Sie diesen CodeNomad-Serverprozess über dessen normale Prozess-/Dienststeuerung.
3. Aktualisieren Sie dieselbe Paketinstallation und starten Sie mit vorgesehener Konfiguration und Flags neu.

| Start-/Installationsmethode | Update-Befehl |
| --- | --- |
| Einmaliger stabiler npm-Start | `npx @neuralnomads/codenomad@latest` mit Ihren normalen Flags |
| Globale stabile Installation | `npm install -g @neuralnomads/codenomad@latest` |
| Lokale stabile Installation | `npm install @neuralnomads/codenomad@latest` in diesem Paketverzeichnis |
| Einmaliger Vorschaustart | `npx @neuralnomads/codenomad-dev@latest` mit Ihren normalen Flags |
| Globale/lokale Vorschauinstallation | `@neuralnomads/codenomad-dev@latest` mit derselben globalen/lokalen npm-Form installieren |

Ein bereits laufender Prozess übernimmt neuen Code nicht allein durch npm-Installation. Behalten Sie bewusst denselben Konfigurationspfad; Kanalauswahl in Einstellungen ersetzt kein npm-Paket und wechselt nicht automatisch stabile/Vorschau-Paketnamen. Bewahren Sie beim Neustart Authentifizierungs-/TLS-Flags; siehe [Server](server.md).

## OpenCode-Wartung getrennt halten {#opencode-separate}

CodeNomad zu aktualisieren aktualisiert nicht die ausgewählte OpenCode-CLI. Diese CLI zu aktualisieren startet nicht den laufenden gemeinsamen Daemon neu. Native Konfiguration neu zu laden ist ein weiterer expliziter Vorgang mit eigenen Auswirkungen auf geladene Locations und Anfragen.

Desktop-Node-/npm-Ressourcen werden mit der Anwendung ausgeliefert; ein Anwendungsrelease liefert ihre Updates. Dies ersetzt weder System-Node/npm, Electrons interne Laufzeit, Plattform-Webview noch den unabhängig verwalteten OpenCode-Dienst.

Verwenden Sie **Einstellungen → OpenCode** für Laufzeitauswahl, Installation/Update und explizite Dienststeuerung. Prüfen Sie vor Neustart/Neuladen die [OpenCode-Einrichtung](opencode.md), besonders bei geteiltem Daemon mit anderen Fenstern/Nutzern oder Missionen. Wiederholen Sie niemals einen ungewissen Prompt/eine Änderung allein wegen abgeschlossenem Update/Wiederverbinden.
