# Authentifizierung und Sicherheit

Zugriff auf CodeNomad kann über OpenCode Arbeit auf dem Backend-Host ausführen. Behandeln Sie Serverpasswörter, Browsersitzungen und gekoppelte Geräte als mächtige Zugangsdaten. CodeNomad ist keine mandantenfähige Ausführungs-Sandbox.

## Serverauthentifizierung wählen {#authentication}

| Methode | Lebensdauer und Geltungsbereich |
| --- | --- |
| `--password` oder `CODENOMAD_SERVER_PASSWORD` | Laufzeitüberschreibung für diesen Backend-Prozess. Bei jedem Start erneut nötig; nicht gespeichert. Übersteuert die verwaltete Passwortdatei. |
| In Einstellungen gesetztes Passwort | Speichert einen gesalzenen scrypt-Hash in `auth.json` neben der aktiven Konfigurations-YAML. Bei späteren Starts ohne Laufzeitüberschreibung verwendet. |
| `--generate-token` | Aktiviert lokale einmalige Ersteinrichtung; ausgegebenes Token gilt 60 Sekunden. Kein wiederverwendbares API-Token und kein Fernsteuerungslink. |
| Fernsteuerungskopplung | Separate Geräte-Cookie-Authentifizierung, vom Host verwaltet; siehe [Fernsteuerung](remote-control.md). |

Standardbenutzername ist `codenomad`. Eine gespeicherte Auth-Datei behält ihren Benutzernamen; nur `--username` zu ändern benennt diese gespeicherte Identität nicht um. Ohne konfiguriertes Passwort, Ersteinrichtungsmodus oder ausdrücklich übersprungene Authentifizierung verweigert der Server den Start.

Bevorzugen Sie geschützte Umgebungs-/Dienstgeheimnisse gegenüber Passwörtern in Befehlsargumenten oder Shell-Verlauf. Wer Ihre Prozessumgebung oder das Konfigurationsverzeichnis einsehen kann, kann die Bereitstellung möglicherweise dennoch kompromittieren.

## Dauerhaftes Passwort erstmalig einrichten {#bootstrap}

1. Starten Sie lokal ohne Laufzeit-Passwortüberschreibung. Verwenden Sie zur Loopback-Ersteinrichtung ohne vorherige Zertifikatseinrichtung `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch`.
2. Öffnen Sie auf dem Backend-Rechner `/auth/token` an der ausgegebenen **Local Connection URL** und übermitteln Sie den nach `CODENOMAD_BOOTSTRAP_TOKEN:` ausgegebenen Wert. Teilen Sie diese Ausgabe nicht.
3. Öffnen Sie **Einstellungen → Remote-Zugriff → Direktzugriff (lokales Netzwerk, erweitert) → Server-Passwort**.
4. Wählen Sie **Passwort festlegen**, füllen Sie **Neues Passwort** und **Passwort bestätigen** mit mindestens acht Zeichen aus und wählen Sie **Passwort speichern**.
5. Lassen Sie beim nächsten Start `--generate-token` weg und verwenden Sie für Direktverbindungen das gespeicherte Passwort. Konfigurieren Sie vor Fernzugriff [vertrauenswürdiges HTTPS](remote-access.md); der Loopback-HTTP-Einrichtungsbefehl ist kein Befehl für entfernte Bereitstellung.

Ersteinrichtung wird nur vom eigenen Loopback-Listener des Hosts angenommen, nicht von LAN-Clients oder Fernsteuerungseingängen. Behalten Sie dafür die standardmäßige Loopback-Bindung. Ein abgelaufenes/verbrauchtes Token erfordert einen neuen Ersteinrichtungsstart. Existiert bereits ein dauerhaftes Passwort, erlaubt die Ersteinrichtungssitzung stattdessen **Passwort ändern**.

`auth.json` wird von der App verwaltet; bearbeiten Sie keinen Hash von Hand und veröffentlichen Sie die Datei nicht. Stammt das Passwort aus CLI/Umgebung, verweigern Einstellungen dessen Ersatz: Starten Sie ohne diese Überschreibung neu, um ein vorhandenes verwaltetes Passwort zu nutzen, oder setzen Sie eines über lokale Ersteinrichtung. Eine unlesbare/unbeschreibbare Auth-Datei benötigt eine OS-Rechte-/Pfadkorrektur, keine deaktivierte Authentifizierung.

## Browsersitzungen und Widerruf {#sessions}

Direkte Anmeldung erzeugt eine undurchsichtige Backend-Sitzung im Arbeitsspeicher und ein `codenomad_session`-Cookie (oder den konfigurierten Cookie-Namen). Cookies sind `HttpOnly`, `SameSite=Lax`, auf `/` begrenzt und bei Ausgabe über HTTPS als `Secure` markiert. Es sind Browsersitzungs-Cookies; ein Backend-Neustart macht die Sitzungen im Speicher ungültig. Authentifizieren Sie sich bei Aufforderung an Ort und Stelle neu, statt fehlgeschlagene Änderungen erneut zu senden.

Ein Passwortwechsel ändert spätere Zugangsdatenprüfungen; er macht bereits ausgegebene Direkt-Sitzungen oder Fernsteuerungsgeräte **nicht** ungültig. Bei Kompromittierungsverdacht:

1. Begrenzen Sie die Netzwerkfreigabe und setzen Sie auf dem Host ein neues Passwort oder ändern Sie Ihr Laufzeitgeheimnis und starten neu.
2. Starten Sie das Backend neu, um vorhandene Direkt-Sitzungen ungültig zu machen.
3. Verwenden Sie unter **Fernsteuerung → Gekoppelte Geräte** separat **Widerrufen** für unbekannte Geräte. Stoppen Sie Fernsteuerung, wenn Sie deren gesamten Zugriffsweg sofort abschneiden müssen.
4. Prüfen Sie betroffene Dateien, Anbieterkonten und native OpenCode-Aktivität. Zugriff zu beenden macht bereits angenommene Arbeit nicht rückgängig.

Die separate 30-Tage-Inaktivitätsgrenze und Fünf-Minuten-Kopplungslinks erläutert [Fernsteuerung](remote-control.md). Passwortwechsel ist kein Gerätewiderruf, Tunnelstopp keine Gerätelöschung.

## Transport und Listenerfreigabe schützen {#transport}

Verwenden Sie vertrauenswürdiges HTTPS für direkten Fernzugriff. Reines HTTP offenbart Passwörter, Sitzungscookies und Arbeitsinhalte jedem, der diesen Netzwerkabschnitt beobachten kann. Endet TLS an einem Reverse-Proxy, halten Sie den Backend-Abschnitt auf Loopback oder einem anderen geschützten Netzwerk; Proxy-TLS verschlüsselt keine offenliegende Upstream-HTTP-Verbindung.

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH` deaktiviert CodeNomads Direkt-Listener-Anmeldung und behandelt Anfragen als authentifiziert. Dies macht eine Serverfreigabe **nicht** sicher. Ein ohne durchsetzende Schutzgrenze erreichbarer Listener gewährt jedem Erreichenden Zugriff; ein VPN allein unterscheidet keine vertrauenswürdigen von nicht vertrauenswürdigen VPN-Nutzern. Lassen Sie Authentifizierung aktiviert, sofern Sie nicht jeden Zugriffsweg unabhängig entworfen und geprüft haben. Fernsteuerung benötigt auch mit diesem Flag ein gekoppeltes Gerät.

Prüfen Sie [Bindungsmatrix und TLS-Verfahren](remote-access.md), besonders den eigenständigen Nur-HTTP-Modus: Er beachtet `--host` und kann Klartext über Loopback hinaus freigeben. Beheben Sie Zertifikatsfehler niemals durch deaktivierte Prüfung.

**`CODENOMAD_SKIP_AUTH=false` lässt die Authentifizierung aktiviert, sofern `--dangerously-skip-auth` nicht angegeben wird.** `1`, `true`, `yes` oder `on` aktivieren die Authentifizierungsumgehung; Groß-/Kleinschreibung und umgebende Leerzeichen werden ignoriert. `0`, `false`, `no`, `off`, leere oder nur aus Leerzeichen bestehende Werte sowie eine nicht gesetzte Variable lassen sie aus. Jeder andere Wert verhindert den Serverstart, auch mit dem CLI-Flag. Das Flag hat Vorrang vor einem gültigen Aus-Wert; siehe [CLI-Referenz](server.md#cli-reference).

## Host-Grenze verstehen {#host-boundary}

`--workspace-root` begrenzt die zu öffnenden Arbeitsbereiche, `--unrestricted-root` lockert die Ordnersuche. Keines ist OS-Gefängnis, Container, Dateisystem-Sandbox oder Einschränkung autorisierter nativer Werkzeuge. Agenten, Shell-Befehle, Plugins und MCP-Werkzeuge handeln mit den Rechten des Ausführungshosts und ihren konfigurierten Zugangsdaten.

[SideCars](browser-sidecars.md) sind vertrauenswürdige Ergänzungen. CodeNomad hält seine Anmelde- und Geräte-Cookies vom SideCar-Dienst zurück, aber die SideCar-Seite lädt im selben Origin wie CodeNomad, und ihre Skripte können mit Ihrer angemeldeten Sitzung handeln. Registrieren Sie nur Dienste, denen Sie ebenso vertrauen wie CodeNomad selbst.

Verwenden Sie für echte Isolation OS-Konten, Container/VMs und vorgelagerte Berechtigungskonfiguration. Gewähren Sie einem Gerät nicht nur deshalb Zugriff, weil es Ihrer Erwartung nach nur einen Tab sehen wird. Serverkonfiguration und gemeinsamer OpenCode-Dienst können andere Unterhaltungen/Projekte betreffen; deren separate Grenzen erläutern [OpenCode-Einrichtung](opencode.md), [Berechtigungen](permissions.md) und [Erweiterungen](extensions.md).

## Zugangsdaten und Diagnosen privat halten {#privacy}

OpenCode verwaltet Anbieterverbindungen und seinen globalen Unterhaltungsspeicher. CodeNomad liest Verbindungsmetadaten und ausgewählte Zugangsdaten serverseitig für unterstützte Nutzungsintegrationen; Browser-APIs liefern keine geheimen Anbieterwerte zurück. Die Erneuerung extern verwalteter OAuth-Anmeldungen liegt bei deren Eigentümer; CodeNomad tauscht deren Refresh-Tokens nicht aus. Siehe [Anbieter](providers.md).

| Material | Umgang |
| --- | --- |
| Passwörter, Ersteinrichtungstokens, Kopplungslinks, Cookies | Niemals in Issues, Screenshots, Shell-Mitschnitte oder geteilte Logs einfügen. |
| `auth.json`, private TLS-Schlüssel, Tunnelidentität, Konfigurationsgeheimnisse | Mit OS-Rechten und verschlüsselten Sicherungen schützen; keine vollständigen Verzeichnisse für Support hochladen. |
| Unterhaltungstext, Anhänge, Arbeitsbereichspfade und Remote-Adressen | Vor Teilen prüfen/schwärzen; sie können Personen, Projekte oder Infrastruktur identifizieren. |
| Anbieterschlüssel und Sprachzugangsdaten | Nur in den vorgesehenen Einstellungen/beim Zugangsdatenverwalter eingeben; prüfen, welcher Anbieter Daten erhält. Siehe [Sprache](voice.md). |
| Debug-/Trace-Logs und Netzwerkmitschnitte | Nur Nötiges sammeln, lokal prüfen und vor Meldung schwärzen. Nicht voraussetzen, dass jede nachgelagerte Werkzeugausgabe frei von Geheimnissen ist. |

**Einstellungen → Info → Fehler melden** bereitet begrenzte Diagnosen vor, ohne Listener, Adressen, Pfade, Zugangsdaten oder Unterhaltungsinhalte vorauszufüllen. Prüfen Sie vor dem Absenden alles selbst Ergänzte. Siehe [Support](support.md).
