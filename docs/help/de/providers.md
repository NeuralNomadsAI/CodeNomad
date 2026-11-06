# Anbieter und Konten

Anbieterauthentifizierung gehört zum verbundenen OpenCode-Dienst, nicht zum Browsergerät oder einem einzelnen CodeNomad-Projekt. Modellanzeige, Abonnementkontingente und Websuche haben unterschiedliche Geltungsbereiche.

## Modell- oder Suchanbieter verbinden {#connect}

1. Öffnen Sie einen Arbeitsbereich und dann **Einstellungen → Anbieter**. **Modelle** ist anfangs aufgeklappt; klappen Sie für Suchanbieter **Websuche** auf. **Bilder** enthält die Bildeinstellungen.
2. Wählen Sie in dieser Gruppe zuerst **Anbieter auswählen**, dann **Verbinden**.
3. Durchlaufen Sie bei einem Modellanbieter die angebotene native **Authentifizierungsmethode**: API-Schlüssel, OAuth oder Befehl. Verwenden Sie bei OAuth **Autorisierungsseite öffnen** und übermitteln Sie einen Autorisierungscode nur auf Aufforderung. Suchanbieter verbinden sich mit einem API-Schlüssel.
4. Prüfen Sie nach Abschluss die Zeile des konfigurierten Anbieters. **Modelle** liest nach Verbindungen, Kontoänderungen und Wiederverbindungen erneut; **Websuche** bietet zusätzlich **Aktualisieren**.

Reine Suchintegrationen erscheinen unter **Websuche**, nicht **Modelle**. Das Speichern der Authentifizierung wählt kein Modell und ändert keinen Standardsuchanbieter. API-Schlüssel und OAuth-Zugangsdaten speichert der aktive OpenCode-Server. Der Browser erhält Verbindungsmetadaten, keine gespeicherten Geheimnisse. Eine Verbindung aus Umgebungsvariablen ist hier schreibgeschützt: Ändern Sie deren zuständige Umgebung, statt sie hier trennen zu wollen.

Wird das Autorisierungsfenster blockiert, verwenden Sie **Autorisierungsseite öffnen**, **In diesem Tab öffnen** oder **Link kopieren** im Ablauf. Veröffentlichen Sie weder Autorisierungslink noch Code in Diagnosen.

## Konten auswählen und verwalten {#accounts}

1. Wählen Sie in der Anbieterzeile unter **Aktives Konto** gespeicherte Zugangsdaten.
2. Verwenden Sie **Konto hinzufügen**, um eine weitere Verbindung zu authentifizieren.
3. Wählen Sie zum Verwalten eines anderen gespeicherten Kontos dieses zuerst aus und verwenden Sie **Konto umbenennen** oder **Konto entfernen**. Umbenennen verwendet **Kontobezeichnung** und **Speichern**; **Konto entfernen** wirkt sofort, ohne Bestätigung.

Auswahl, Umbenennung und Entfernen betreffen diese Integration im gesamten OpenCode-Dienst einschließlich anderer Projekte und Clients. Das Entfernen von Zugangsdaten kann diesen Clients die Authentifizierung nehmen; es löscht keinen Unterhaltungsverlauf und widerruft nicht das externe Anbieterkonto. Umgebungsverbindungen lassen sich hier weder als beschreibbare gespeicherte Zugangsdaten auswählen noch entfernen. Schlägt ein Vorgang fehl, liest CodeNomad die Konten erneut: Prüfen Sie **Aktives Konto** noch einmal, bevor Sie handeln.

### Grenzen automatischer Auswahl {#automatic-selection}

Bei mehreren gespeicherten Zugangsdaten einer unterstützten Integration aktiviert **Konto automatisch auswählen** die kontingentbasierte Auswahl vor Annahme des nächsten Prompts/benutzerdefinierten Befehls über CodeNomad. Die Einstellung gilt pro Integration in der CodeNomad-Konfiguration; eine daraus resultierende Kontoauswahl gilt dienstweit.

| Geeignete Integration | Geeigneter Kontotyp |
| --- | --- |
| OpenAI / Codex | Codex-Abonnementkonten mit Browser-/Geräte-OAuth, weder nutzungsabhängige OpenAI-Schlüssel noch die ChatGPT-Anmeldemethode, für die OpenAI keine Nutzungsdaten bereitstellt. |
| OpenCode Go | Go-Schlüssel oder OpenCode-Console-Anmeldung/-Schlüssel **nur für den Go-Anbieter**, keine nutzungsabhängigen Zen-Guthaben. |
| Anthropic | OpenCodes Claude-Pro/Max-OAuth-Anmeldung, **nicht** die Claude-Code-Anmeldung. |
| GitHub Copilot | OAuth mit lesbarem Premium-Anfragekontingent; Zugangsdaten für Enterprise-Endpunkte sind keine lesbaren Kandidaten. |
| Coding-Pläne | Schlüsselbasierte `zai-coding-plan`, `zhipuai-coding-plan`, `kimi-for-coding`, `minimax-coding-plan`, `minimax-cn-coding-plan`. |

Nur ein ausgeschöpftes aktuelles Konto löst einen Wechsel aus; eine bloß größere verfügbare Alternative nicht. Lesevorgänge prüfen explizite gespeicherte Zugangsdaten, ohne Kandidaten zu aktivieren oder Refresh-Tokens auszutauschen. Codex, Copilot und Coding-Pläne benötigen einen nachweislich verfügbaren Kandidaten. Go, Console und Claude können Kandidaten mit unbekanntem Kontingent verwenden, sofern sie nicht durch einen kürzlichen nativen Kontingentfehler als ausgeschöpft markiert sind. OpenCode-Go-Werte hängen von der verfügbaren API und den Zugriffsrechten ab.

Dies ist **kein Failover während der Ausführung**. Es wiederholt weder fehlgeschlagene Anfragen noch Prompts, Befehle oder Änderungen. Es rotiert keine Umgebungsverbindungen, beliebigen Anbieter, nutzungsabhängigen Guthaben oder externen Claude-Code-Anmeldungen. Manuelle Kontowechsel werden während der Auswahlvorbereitung respektiert; es gibt keine clientübergreifende Kontosperre. Prüfen Sie bei Kontingent-/Authentifizierungsfehlern **Aktives Konto**, aktualisieren Sie Nutzung und melden Sie sich bei Bedarf über den Eigentümer der Zugangsdaten an, bevor Sie bewusst erneut senden.

## Modellsichtbarkeit, Favoriten und Denken {#models}

1. Wählen Sie **Modelle verwalten** neben einem Modellanbieter.
2. Suchen Sie nach Name/ID und ändern Sie die Sichtbarkeit; **Alle anzeigen** und **Alle ausblenden** betreffen dessen Auswahlliste. Ziehen Sie über die Kontrollkästchen, um mehrere Modelle auf einmal zu ändern.
3. Verwenden Sie in der **Modell**-Auswahl einer Unterhaltung **Zu Favoriten hinzufügen** oder **Aus Favoriten entfernen**; **Alle Modelle anzeigen** verlässt den Nur-Favoriten-Filter.
4. Verwenden Sie **Denken** im Eingabefeld für die Varianten des ausgewählten Modells.

Sichtbarkeit und Favoriten ordnen CodeNomads Auswahlfelder; sie deinstallieren keine Modelle, entfernen keine Zugangsdaten und hindern andere OpenCode-Clients nicht an deren Nutzung. Ein Modell auszublenden trennt kein Konto. Denken wählt eine Modellvariante für spätere Eingaben, nicht die Sichtbarkeit bereits vorhandener Denkprozesse im Verlauf. Stellen Sie ausgeblendete Modelle über **Modelle verwalten → Alle anzeigen** wieder her.

## Nutzung, Tokenzahlen und abgelaufene Anmeldungen {#usage}

Verwenden Sie **Nutzung** im rechten Panel für die Anbieter-Planfenster, Rücksetzzeiten und unterstützten Guthaben der aktiven Unterhaltung. Diese Anbieterwerte unterscheiden sich von **Tokens** und Kostenschätzungen pro Nachricht: Ein Abonnementkontingent ist keine aus dem sichtbaren Verlauf berechnete Rechnung. Ein fehlender, veralteter oder unbekannter Wert bedeutet weder Nullnutzung noch nachgewiesene Restkapazität. **Anbieterguthaben** unter **Einstellungen → Erweitert** steuert ergänzende Guthabenanzeigen.

Für kostenlose OpenCode-Zen-Modelle schätzt **Nutzung** den Verbrauch anhand der seit 00:00 UTC aufgezeichneten Schritte dieses Dienstes bei angenommenen 200 Anfragen/Tag und einer geschätzten Rücksetzung zur nächsten UTC-Mitternacht. Schritte nähern Anfragen an; anderer Datenverkehr und variable IP-Limits können die tatsächliche Kontingentnutzung abweichen lassen.

Für eine ChatGPT-Anmeldemethode stellt OpenAI keine Nutzungsdaten bereit: Nutzung weist darauf hin, statt Kontingentfenster anzuzeigen. Wählen Sie [ChatGPT-Nutzung anzeigen](https://chatgpt.com/settings/usage), um die App-Nutzung einzusehen und den Zugriff auf Ihren Tarif und Ihr Guthaben in ChatGPT zu verwalten. Chatten funktioniert weiterhin, und eine erneute Verbindung derselben Anmeldung stellt den Wert nicht wieder her.

Nutzung folgt den ausgewählten nativen Zugangsdaten. Claude über `anthropic`/`claude` verwendet OpenCodes Anthropic-OAuth. OpenCodes Anbieter **Claude Agent** (`claude-agent`) und der Anbieter `claude-code` verwenden die Claude-Code-Anmeldung auf dem Daemon-Host einschließlich dessen WSL-Distribution: zuerst `CLAUDE_CODE_OAUTH_TOKEN`, dann die gespeicherte Anmeldung, wobei `CLAUDE_SECURESTORAGE_CONFIG_DIR` / `CLAUDE_CONFIG_DIR` oder `~/.claude` den Dateispeicher bestimmen; lokales macOS kann den Schlüsselbund verwenden. CodeNomad ersetzt keine Claude-Anmeldung durch die andere.

Aktualisieren/melden Sie sich bei abgelaufener Anbieteranmeldung über deren Eigentümer an – OpenCode, Claude Code oder Codex CLI – und aktualisieren Sie dann CodeNomad. CodeNomad tauscht keine extern verwalteten Refresh-Tokens aus. Eine abgelaufene CodeNomad-Serveranmeldung ist davon getrennt: Verbinden/melden Sie sich bei CodeNomad neu an, ohne die Wiederholung einer fehlgeschlagenen Anbieteranfrage anzunehmen. Siehe [Fehlerbehebung](troubleshooting.md).

Wenn MiniMax erfolgreich ohne Limits antwortet, zeigt **Nutzung** statt Kontingentwerten **MiniMax teilt seine Limits nicht mit** an.

Bei OpenRouter zeigt **Schlüssellimit** den verbleibenden USD-Betrag im Verhältnis zum Ausgabenlimit des Schlüssels; Schlüssel ohne Limit haben diese Zeile nicht. Kontoguthaben erscheint separat, wenn die API den Zugriff erlaubt. Die Nutzung verwendet die konfigurierte `baseURL` des Anbieters einschließlich Pfadpräfix oder ohne Einstellung `https://openrouter.ai/api/v1`. Verwenden Sie einen öffentlichen HTTPS-Hostnamen ohne Zugangsdaten, expliziten Port, Abfrage oder Fragment; IP-Adressen und localhost werden abgelehnt. Eine ungültige URL oder ein Gateway ohne `/key` macht die Nutzung nicht verfügbar; der Schlüssel bleibt am konfigurierten Ziel, Weiterleitungen werden abgelehnt.

Bei z.ai und Zhipu bevorzugt Nutzung den konfigurierten `apiKey`, einschließlich der von OpenCode auf seinem Host aufgelösten Werte `{env:…}` und `{file:…}`. Ist dieser Schlüssel nicht verfügbar, werden die gespeicherten Zugangsdaten verwendet. Ohne Schlüssel und gespeicherte Zugangsdaten wird der Anbieter als nicht konfiguriert angezeigt. Fachliche API-Fehler zeigen eine übersetzte Anbieterfehlermeldung und gegebenenfalls den numerischen Code statt Kontingentwerten. Planguthaben nutzt Fünf-Stunden- und Wochenfenster; MCP-Werkzeuge haben ein separates Kontingent.

Die **Nutzung** von GitHub Copilot zeigt den Verbrauch als **verbraucht / Limit verbraucht** oder verbrauchte Credits eines unbegrenzten Pools, wenn GitHub diese liefert; andernfalls erscheint **Unbegrenzt**. Premium-Anfragen behalten ihre Bezeichnung. Die Fußzeile zeigt den erkannten Tarifnamen. Enterprise-Verbindungen verwenden `https://api.<host>/copilot_internal/user` mit dem Hostnamen oder der HTTPS-Stamm-URL der gespeicherten Verbindung. Verwenden Sie einen qualifizierten Hostnamen ohne Zugangsdaten, expliziten Port (auch `:443`), Pfad über `/` hinaus, Abfrage oder Fragment; IP-Adressen und localhost werden vor dem Senden des Tokens abgelehnt. Weiterleitungen werden abgelehnt. Bei ungültigem Ziel oder einem Server ohne diese API bleibt die Nutzung nicht verfügbar. Enterprise-Verbindungen bleiben von der automatischen Kontoauswahl ausgeschlossen.

Kimi unterstützt `kimi-code-plan-cn` (kimi.com), `kimi-code-plan-global` (kimi.ai), `kimi-for-coding` und `kimi`. **Nutzung** versucht den aktiven gespeicherten Schlüssel jeder Integration, beginnend mit der Integration der Unterhaltung, innerhalb einer gemeinsamen Frist. Verfügbare Fünf-Stunden-, Wochen-, **Monatlich**- und **Monatliches Coding**-Limits zeigen den verbrauchten Prozentsatz. Monatslimits folgen dem Rücksetzdatum des Anbieters; ein `kimi-for-coding`-Konto mit einem ausgeschöpften Monatslimit ist für die automatische Auswahl nicht verfügbar, selbst wenn ein kürzeres Zeitfenster noch Kapazität hat.

OpenCode-Go-API-Schlüssel zeigen verfügbare verbrauchte Prozentsätze und Rücksetzzeiten. Die OpenCode-Console-Anmeldung liest bei ausreichenden Abrechnungsrechten auch das Wallet-Guthaben in USD. Aktivieren Sie **Anbieterguthaben**, um dieses separate Guthaben anzuzeigen (standardmäßig aus); Go-Kontingente und Extra Usage bleiben getrennt. Ein Guthaben allein lässt das Kontingent für die automatische Auswahl unbekannt. Bei **Der OpenCode-Go-Schlüssel ist abgelaufen.** wählen Sie [Neuen Schlüssel in OpenCode Console erstellen und ersetzen](https://opencode.ai/console/login). Erstellen Sie einen Schlüssel unter **Account → Personal API keys** (oder bitten Sie einen Administrator um einen Dienstkontoschlüssel) und ersetzen Sie den gespeicherten Schlüssel über den Anbieter-Verbindungsablauf. Ein abgelaufener Schlüssel muss ersetzt werden.

### Optionale Umgebungsvariablen für Nutzung {#usage-environment}

Cursor Enterprise verwendet private Dashboard-APIs nach Verfügbarkeit. Mit Teammitgliedschaft und Team-ID im Profil zeigt **Nutzung** den erkannten Anfragebereich `gpt-4` sowie separate USD-Beträge für **Limit pro Nutzer** / **Teamlimit**, sofern vorhanden. Bei unbekannten Ausgaben erscheint nur das Limit; bei unbekanntem Anfragelimit nur die verbrauchte Anzahl. Unbekannte Bereiche und Rücksetztermine bleiben unverfügbar. Fehlendes Team, verweigerter Zugriff und abgelaufene Tokens haben eigene Meldungen; verifizierte Teilergebnisse bleiben sichtbar.

Geben Sie über die folgenden Variablen ein aktuelles Cursor-Zugriffstoken an. Enterprise-Abfragen erfordern Leserechte für die Dashboard-Daten des Teams; die [Admin-API](https://cursor.com/docs/account/teams/admin-api) verwendet einen separaten Administrationsschlüssel. Aktualisieren Sie abgelaufene Tokens und starten Sie das Backend mit der aktualisierten Umgebung neu.

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

1. Klappen Sie unter **Einstellungen → Anbieter** die Gruppe **Websuche** auf und verbinden Sie die Suchintegration mit ihrem API-Schlüssel, falls sie einen benötigt.
2. Wählen Sie **Standardsuche** für die globale Konfiguration.
3. Verwenden Sie **Für das aktuelle Projekt** als Überschreibung für die aktive Location. Zeigen Sie auf dieses Auswahlfeld oder fokussieren Sie es, um **Suche in diesem Projekt** mit dem wirksamen Ergebnis zu sehen.

Änderungen speichern automatisch. **Standard / geerbt** verwendet geerbte Konfiguration oder die gespeicherte native Auswahl; eine Projektüberschreibung hat Vorrang vor Global. **Deaktiviert** schaltet die Suche im gewählten Geltungsbereich aus; **Automatischer Anbieter** fordert native automatische Anbieterauswahl an. **Websuche** lädt ihre Verbindungen und Auswahlen nur, solange sie aufgeklappt ist. **Trennen** entfernt einen gespeicherten Suchschlüssel; eine von einer Umgebungsvariable bereitgestellte Verbindung ist als schreibgeschützt gekennzeichnet und hat kein **Trennen**.

Suchzugangsdaten bleiben dienstglobal, auch bei projektbezogener Anbieterwahl. Das Speichern eines Schlüssels wählt ihn nicht als Suchstandard. Aktualisieren Sie bei Lese-/Speicherfehlern vor dem Wiederholen; ersetzen Sie Konfiguration nicht blind. Native Konfigurationsdetails finden Sie in der [OpenCode-Dokumentation](https://opencode.ai/v2/docs/) und [OpenCode-Einrichtung](opencode.md).

## Bildgenerierung und -speicherung {#images}

1. Klappen Sie unter **Einstellungen → Anbieter** den Bereich **Bilder** auf.
2. **Bildgenerierung** steht auf **An, automatisches Modell**, solange Sie nichts ändern: Wählen Sie stattdessen eines der Bildmodelle Ihrer verbundenen Anbieter oder **Aus**, um sie in der globalen Konfiguration abzuschalten.
3. Aktivieren Sie **Bilder nur einmal speichern**, damit jedes angehängte oder erzeugte Bild nur einmal gespeichert wird statt in jeder Nachricht, die es verwendet.

Änderungen werden automatisch in der globalen OpenCode-Konfiguration gespeichert und gelten für alle Projekte. Beides sind experimentelle OpenCode-Funktionen: **Bilder** zeigt nur die Einstellungen, die die verbundene OpenCode-Version unterstützt. Agenten erhalten das Bildwerkzeug nur, solange ein verbundener Anbieter ein Bildmodell anbietet. Jedes Bild wird im Hintergrund erzeugt und als Datei gespeichert; der Agent nennt ihren Pfad. **Bilder nur einmal speichern** gilt für neue Nachrichten. Entscheidet die eigene OpenCode-Konfigurationsdatei des Projekts über **Bilder nur einmal speichern**, zeigt das Kästchen den dort geltenden Wert, und das Speichern schreibt ihn auch in diese Datei. Entscheidet ansonsten eine andere OpenCode-Konfiguration, etwa die des Projekts, über eine Einstellung, zeigt **Bilder** das unter dieser Einstellung an. Würde das Speichern die experimentellen Einstellungen einer anderen OpenCode-Konfigurationsdatei verdecken, bleibt **Bilder** schreibgeschützt und weist darauf hin; ändern Sie die Optionen dann in jener Datei.

Um Bilder in einer eigenen Unterhaltung zu erstellen, zu vergleichen und zu verfeinern, siehe [Bilder mit der Design-Erweiterung erstellen](extensions.md#design).
