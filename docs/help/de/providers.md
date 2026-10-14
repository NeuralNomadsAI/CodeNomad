# Anbieter und Konten

Anbieterauthentifizierung gehört zum verbundenen OpenCode-Dienst, nicht zum Browsergerät oder einem einzelnen CodeNomad-Projekt. Modellanzeige, Abonnementkontingente und Websuche haben unterschiedliche Geltungsbereiche.

## Modell- oder Suchanbieter verbinden {#connect}

1. Öffnen Sie einen Arbeitsbereich und dann **Einstellungen → Anbieter**.
2. Wählen Sie unter **Modelle** oder **Websuche** zuerst **Anbieter auswählen**, dann **Verbinden**.
3. Durchlaufen Sie die angebotene native **Authentifizierungsmethode**: API-Schlüssel, OAuth oder Befehl. Verwenden Sie bei OAuth **Autorisierungsseite öffnen** und übermitteln Sie einen Autorisierungscode nur auf Aufforderung.
4. Prüfen Sie nach Abschluss die Zeile des konfigurierten Anbieters; verwenden Sie bei unklarem Ergebnis **Aktualisieren**.

Reine Suchintegrationen erscheinen unter **Websuche**, nicht **Modelle**. Das Speichern der Authentifizierung wählt kein Modell und ändert keinen Standardsuchanbieter. API-Schlüssel und OAuth-Zugangsdaten speichert der aktive OpenCode-Server. Der Browser erhält Verbindungsmetadaten, keine gespeicherten Geheimnisse. Eine Verbindung aus Umgebungsvariablen ist hier schreibgeschützt: Ändern Sie deren zuständige Umgebung, statt sie hier trennen zu wollen.

Wird das Autorisierungsfenster blockiert, verwenden Sie **Autorisierungsseite öffnen**, **In diesem Tab öffnen** oder **Link kopieren** im Ablauf. Veröffentlichen Sie weder Autorisierungslink noch Code in Diagnosen.

## Konten auswählen und verwalten {#accounts}

1. Wählen Sie in der Anbieterzeile unter **Aktives Konto** gespeicherte Zugangsdaten.
2. Verwenden Sie **Konto hinzufügen**, um eine weitere Verbindung zu authentifizieren.
3. Wählen Sie zum Verwalten eines anderen gespeicherten Kontos dieses zuerst aus und verwenden Sie **Konto umbenennen** oder **Konto entfernen**. Umbenennen verwendet **Kontobezeichnung** und **Speichern**.

Auswahl, Umbenennung und Entfernen betreffen diese Integration im gesamten OpenCode-Dienst einschließlich anderer Projekte und Clients. Das Entfernen von Zugangsdaten kann diesen Clients die Authentifizierung nehmen; es löscht keinen Unterhaltungsverlauf und widerruft nicht das externe Anbieterkonto. Umgebungsverbindungen lassen sich hier weder als beschreibbare gespeicherte Zugangsdaten auswählen noch entfernen. Aktualisieren und prüfen Sie bei einem Fehler **Aktives Konto**, bevor Sie erneut handeln.

### Grenzen automatischer Auswahl {#automatic-selection}

Bei mehreren gespeicherten Zugangsdaten einer unterstützten Integration aktiviert **Konto automatisch auswählen** die kontingentbasierte Auswahl vor Annahme des nächsten Prompts/benutzerdefinierten Befehls über CodeNomad. Die Einstellung gilt pro Integration in der CodeNomad-Konfiguration; eine daraus resultierende Kontoauswahl gilt dienstweit.

| Geeignete Integration | Geeigneter Kontotyp |
| --- | --- |
| OpenAI / Codex | Codex-OAuth-Abonnementkonten, keine nutzungsabhängigen OpenAI-Schlüssel. |
| OpenCode Go | Go-Schlüssel oder OpenCode-Console-Anmeldung/-Schlüssel **nur für den Go-Anbieter**, keine nutzungsabhängigen Zen-Guthaben. |
| Anthropic | OpenCodes Claude-Pro/Max-OAuth-Anmeldung, **nicht** die Claude-Code-Anmeldung. |
| GitHub Copilot | OAuth mit lesbarem Premium-Anfragekontingent; Zugangsdaten für Enterprise-Endpunkte sind keine lesbaren Kandidaten. |
| Coding-Pläne | Schlüsselbasierte `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Nur ein ausgeschöpftes aktuelles Konto löst einen Wechsel aus; eine bloß größere verfügbare Alternative nicht. Lesevorgänge prüfen explizite gespeicherte Zugangsdaten, ohne Kandidaten zu aktivieren oder Refresh-Tokens auszutauschen. Codex, Copilot und Coding-Pläne benötigen einen nachweislich verfügbaren Kandidaten. Go, Console und Claude können Kandidaten mit unbekanntem Kontingent verwenden, sofern sie nicht durch einen kürzlichen nativen Kontingentfehler als ausgeschöpft markiert sind. OpenCode Gos Nutzungsendpunkt und Console-OAuth-Nutzung bleiben upstream ungeprüft; Verfügbarkeit ist daher nicht garantiert.

Dies ist **kein Failover während der Ausführung**. Es wiederholt weder fehlgeschlagene Anfragen noch Prompts, Befehle oder Änderungen. Es rotiert keine Umgebungsverbindungen, beliebigen Anbieter, nutzungsabhängigen Guthaben oder externen Claude-Code-Anmeldungen. Manuelle Kontowechsel werden während der Auswahlvorbereitung respektiert; es gibt keine clientübergreifende Kontosperre. Prüfen Sie bei Kontingent-/Authentifizierungsfehlern **Aktives Konto**, aktualisieren Sie Nutzung und melden Sie sich bei Bedarf über den Eigentümer der Zugangsdaten an, bevor Sie bewusst erneut senden.

## Modellsichtbarkeit, Favoriten und Denken {#models}

1. Wählen Sie **Modelle verwalten** neben einem Modellanbieter.
2. Suchen Sie nach Name/ID und ändern Sie die Sichtbarkeit; **Alle anzeigen** und **Alle ausblenden** betreffen dessen Auswahlliste.
3. Verwenden Sie in der **Modell**-Auswahl einer Unterhaltung **Zu Favoriten hinzufügen** oder **Aus Favoriten entfernen**; **Alle Modelle anzeigen** verlässt den Nur-Favoriten-Filter.
4. Verwenden Sie **Denken** im Eingabefeld für die Varianten des ausgewählten Modells.

Sichtbarkeit und Favoriten ordnen CodeNomads Auswahlfelder; sie deinstallieren keine Modelle, entfernen keine Zugangsdaten und hindern andere OpenCode-Clients nicht an deren Nutzung. Ein Modell auszublenden trennt kein Konto. Denken wählt eine Modellvariante für spätere Eingaben, nicht die Sichtbarkeit bereits vorhandener Denkprozesse im Verlauf. Stellen Sie ausgeblendete Modelle über **Modelle verwalten → Alle anzeigen** wieder her.

## Nutzung, Tokenzahlen und abgelaufene Anmeldungen {#usage}

Verwenden Sie **Nutzung** im rechten Panel für die Anbieter-Planfenster, Rücksetzzeiten und unterstützten Guthaben der aktiven Unterhaltung. Diese Anbieterwerte unterscheiden sich von **Tokens** und Kostenschätzungen pro Nachricht: Ein Abonnementkontingent ist keine aus dem sichtbaren Verlauf berechnete Rechnung. Ein fehlender, veralteter oder unbekannter Wert bedeutet weder Nullnutzung noch nachgewiesene Restkapazität. **Anbieterguthaben** in den Chat-Einstellungen steuert ergänzende Guthabenanzeigen.

Nutzung folgt den ausgewählten nativen Zugangsdaten. Claude über `anthropic`/`claude` verwendet OpenCodes Anthropic-OAuth. Der Anbieter `claude-code` verwendet die Claude-Code-Anmeldung auf dem Daemon-Host einschließlich dessen WSL-Distribution: zuerst `CLAUDE_CODE_OAUTH_TOKEN`, dann die gespeicherte Anmeldung, wobei `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` oder `~/.claude` den Dateispeicher bestimmen; lokales macOS kann den Schlüsselbund verwenden. CodeNomad ersetzt keine Claude-Anmeldung durch die andere.

Aktualisieren/melden Sie sich bei abgelaufener Anbieteranmeldung über deren Eigentümer an – OpenCode, Claude Code oder Codex CLI – und aktualisieren Sie dann CodeNomad. CodeNomad tauscht keine extern verwalteten Refresh-Tokens aus. Eine abgelaufene CodeNomad-Serveranmeldung ist davon getrennt: Verbinden/melden Sie sich bei CodeNomad neu an, ohne die Wiederholung einer fehlgeschlagenen Anbieteranfrage anzunehmen. Siehe [Fehlerbehebung](troubleshooting.md).

### Optionale Umgebungsvariablen für Nutzung {#usage-environment}

Setzen Sie diese vor dem Start in der Umgebung des **CodeNomad-Backend-Prozesses**. Sie sind Zugangsdaten für Nutzungsleser, keine Browsereinstellungen oder Modellauswahl. Änderungen im Sitzungseditor **Umgebungsvariablen** aktualisieren nicht das `process.env` eines laufenden Backends für diese Leser. Starten Sie bei Änderungen das Backend mit der vorgesehenen Umgebung neu; starten Sie nicht nur wegen einer Nutzungslesevariable den gemeinsamen OpenCode-Dienst neu.

| Nutzungsintegration | Umgebungsvariable |
| --- | --- |
| Cursor | `CURSOR_ACCESS_TOKEN`, ersatzweise `CURSOR_TOKEN` |
| Ollama Cloud | `OLLAMA_CLOUD_COOKIE` |
| Ergänzende OpenCode-Go-Nutzung | `OPENCODE_GO_WORKSPACE_ID` und `OPENCODE_GO_AUTH_COOKIE` zusammen |
| ZenMux | `ZENMUX_PLATFORM_API_KEY` — Plattformschlüssel, getrennt vom Inferenzschlüssel |
| exe.dev | `EXE_DEV_USAGE_TOKEN` |
| Command Code | `COMMAND_CODE_API_KEY` als Ersatz, wenn native Zugangsdaten fehlen |

Halten Sie Tokens/Cookies aus Shell-Verlauf, Screenshots und Berichten heraus. Optionale Leser hängen von Anbieter-APIs und gültigen Zugangsdaten ab; eine konfigurierte Variable garantiert keine nutzbaren Kontingentdaten.

## Websuche-Standard und Projektüberschreibung {#web-search}

1. Verbinden Sie unter **Einstellungen → Anbieter → Websuche** die Suchintegration, falls Authentifizierung nötig ist.
2. Wählen Sie **Standardsuche** für die globale Konfiguration.
3. Verwenden Sie **Für das aktuelle Projekt** als Überschreibung für die aktive Location. Prüfen Sie **Suche in diesem Projekt** für das wirksame Ergebnis.

Änderungen speichern automatisch. **Standard / geerbt** verwendet geerbte Konfiguration oder die gespeicherte native Auswahl; eine Projektüberschreibung hat Vorrang vor Global. **Deaktiviert** schaltet die Suche im gewählten Geltungsbereich aus; **Automatischer Anbieter** fordert native automatische Anbieterauswahl an. Eine umgebungsbasierte Auswahl wird schreibgeschützt angezeigt.

Suchzugangsdaten bleiben dienstglobal, auch bei projektbezogener Anbieterwahl. Das Speichern eines Schlüssels wählt ihn nicht als Suchstandard. Aktualisieren Sie bei Lese-/Speicherfehlern vor dem Wiederholen; ersetzen Sie Konfiguration nicht blind. Native Konfigurationsdetails finden Sie in der [OpenCode-Dokumentation](https://opencode.ai/v2/docs/) und [OpenCode-Einrichtung](opencode.md).
