# Accès distant direct

L’accès direct se connecte aux écoutes HTTP/HTTPS de CodeNomad avec son mot de passe serveur. Il est distinct du [Contrôle à distance](remote-control.md) : l’appairage ne nécessite ni écoute LAN ni port entrant, et aucun chemin ne bascule silencieusement vers l’autre.

## Choisir un chemin d’accès {#access-paths}

| Chemin | Ce que vous administrez |
| --- | --- |
| Navigateur sur la même machine | Gardez l’écoute en boucle locale ; utilisez l’URL locale affichée. |
| LAN ou VPN | Écoutez sur une interface accessible, limitez le pare-feu aux clients voulus et utilisez un HTTPS de confiance. Un VPN ne configure pas l’écoute CodeNomad à votre place. |
| Transfert SSH | Gardez le backend en boucle locale ; transférez son port réellement affiché. Le tunnel protège le transport mais ne remplace pas l’authentification CodeNomad. |
| Proxy inverse | Gardez le backend sur une interface privée/de boucle locale ; terminez le TLS de confiance au proxy, protégez le saut amont et prenez en charge les SSE de longue durée ainsi que les WebSockets nécessaires aux outils d’accès direct. |
| Contrôle à distance | Appairez l’appareil depuis l’hôte ; voir [Contrôle à distance](remote-control.md) pour sa surface plus restreinte et sa durée de vie. |

L’adresse d’écoute ne crée pas de règles de pare-feu, transfert de ports, DNS ou VPN. Ne publiez pas une écoute HTTP non authentifiée sur Internet. Une racine d’espace de travail n’est pas un bac à sable de sécurité ; lisez [Sécurité](security.md) avant d’exposer le serveur.

## Activer l’accès direct {#enable-direct-access}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant** et développez **Accès direct (réseau local, avancé)**.
2. Sous **Mot de passe du serveur**, choisissez **Définir le mot de passe** ou **Changer le mot de passe**, saisissez **Nouveau mot de passe** et **Confirmer le mot de passe**, puis **Enregistrer le mot de passe**. Les mots de passe fournis à l’exécution ne se changent pas ici ; voir [Sécurité](security.md).
3. Activez **Autoriser les connexions depuis d'autres IP** sous **Mode d'écoute**. Lisez l’avertissement et choisissez **Redémarrer maintenant** seulement lorsque vous êtes prêt pour l’interruption temporaire.
4. Après redémarrage, utilisez **Rafraîchir** et vérifiez **Adresses accessibles**. Ouvrez l’adresse HTTPS accessible sur l’autre appareil, ou choisissez **Afficher le QR** sur l’hôte et scannez-le avec l’autre appareil, puis connectez-vous.

Cela change le mode d’écoute directe de l’hôte, pas un projet ni le Contrôle à distance. La section s’ouvre automatiquement tant que le serveur écoute au-delà de localhost. Si le redémarrage automatique est indisponible, redémarrez CodeNomad manuellement ; les déploiements autonomes doivent régler leur `--host` de lancement de manière cohérente. Pour retirer l’exposition, désactivez le commutateur et redémarrez, ou relancez la CLI en boucle locale. Cela ne révoque pas les appareils appairés au Contrôle à distance.

### Matrice des adresses d’écoute {#binding-matrix}

`--host` vaut `127.0.0.1` par défaut ; `localhost` est normalisé vers cette adresse. Les règles suivantes s’appliquent aux écoutes activées :

| Lancement/mode | HTTP écoute sur | HTTPS écoute sur |
| --- | --- | --- |
| Autonome, HTTPS seul (défaut) | Écoute privée en boucle locale uniquement | `--host` |
| Autonome, HTTP seul | **`--host`**, y compris une adresse LAN/générique | Non activé |
| Autonome, les deux écoutes | `127.0.0.1` quel que soit `--host` | `--host` |
| Backend de bureau natif | Son écoute HTTP reste sur `127.0.0.1`, y compris son écoute interne à l’hôte | `--host` quand HTTPS est activé |

Une adresse LAN précise n’accepte pas nécessairement les connexions de boucle locale. `0.0.0.0` désigne toutes les interfaces IPv4 ; `::` est l’écoute générique double pile. Utilisez une adresse réellement accessible dans un navigateur, pas une adresse générique. Les identifiants de zone IPv6 ne sont pas pris en charge dans `--host`.

Pour un déploiement HTTPS autonome, définissez un mot de passe par la [procédure d’initialisation](security.md), puis exécutez :

```sh
codenomad --host 0.0.0.0 --https=true --http=false
```

Pour du HTTP en boucle locale uniquement, par exemple derrière un proxy local de confiance :

```sh
codenomad --host 127.0.0.1 --https=false --http=true
```

Ne supposez pas le port 9898 ou 9899 : les ports omis peuvent changer s’ils sont occupés. Un `--https-port` explicite non nul, ou un `--http-port` avec HTTP activé, fixe le port et échoue si l’écoute est impossible ; `0` demande au système d’en attribuer un. Les **Local Connection URL** et **Remote Connection URL** affichées, et les **Adresses accessibles** actualisées, font autorité pour cette exécution. Voir la [référence CLI serveur](server.md) complète.

## Politique de l’administrateur {#administrator-policy}

Un administrateur peut fixer l’adresse d’écoute : définissez `CODENOMAD_LOCKED_HOST` pour tout le système avec l’adresse que le serveur doit utiliser, puis redémarrez CodeNomad. Elle l’emporte sur `--host`, `CLI_HOST` et **Autoriser les connexions depuis d'autres IP**, qui affiche le résultat sans pouvoir le changer. Utilisez une adresse intranet pour que vos collègues joignent le serveur par le réseau de l’entreprise, ou `127.0.0.1` pour le garder sur cet ordinateur. Pour que tout accès reste dans le réseau de l’entreprise, définissez aussi `CODENOMAD_REMOTE_CONTROL=disabled` ([contrôle à distance](remote-control.md#administrator-policy)).

## Origines autorisées {#upgrading}

Pour un alias de nom d’hôte, un proxy inverse ou une interface hébergée séparément, définissez `CODENOMAD_ALLOWED_ORIGINS` sur le backend avec les origines de confiance de l’interface (protocole, nom d’hôte et port). Les clients natifs du LAN doivent fournir un en-tête `Origin` autorisé pour les requêtes de modification. Ses origines HTTPS permettent aussi à l’hôte d’appairer des appareils sans le tunnel ; voir [Appairer en HTTPS direct](remote-control.md#direct-https).

Si l’interface est hébergée séparément, déployez-la et rechargez les onglets et fenêtres ouverts avant de mettre à jour le serveur. Si le serveur fournit l’interface, rechargez-les après la mise à jour.

Utilisez une connexion en boucle locale pour les opérations réservées à l’hôte : contenu SideCar (`/sidecars/`) et WebSockets, gestion du Contrôle à distance (`/api/remote-control/`), pont des plugins (`/api/opencode-plugin/`), proxys distants (`/api/remote-proxy/`), changement de mot de passe et initialisation par jeton. Ces opérations exigent la boucle locale, même avec une connexion authentifiée directe depuis le LAN. Seuls les SideCars font exception : le réglage **Ouvrir les SideCars en HTTPS** de l’hôte ouvre leur contenu et leurs WebSockets aux navigateurs connectés via une origine HTTPS de confiance ([SideCars](browser-sidecars.md#register-sidecar)). Le contenu des aperçus actifs (`/previews/`) est accessible directement depuis le LAN avec un jeton de capacité valide.

Les API d’enregistrement `/api/sidecars` restent accessibles aux clients LAN directs authentifiés et aux appareils appairés. Les aperçus web du Contrôle à distance restent accessibles avec leur jeton de capacité lorsqu’ils sont activés sur l’hôte. Pour gérer les serveurs et saisir des identifiants en toute sécurité, voir [Enregistrer un serveur distant](remote-access.md#saved-servers).

## Configurer un TLS de confiance {#tls}

### Fournir son propre certificat {#custom-certificates}

1. Obtenez un certificat dont les noms alternatifs du sujet (SAN) couvrent le nom d’hôte ou l’IP réellement utilisés par les clients.
2. Fournissez à la fois `--tls-key <path>` et `--tls-cert <path>` comme fichiers PEM. Ajoutez `--tls-ca <path>` si votre déploiement nécessite une chaîne/un ensemble d’AC.
3. Redémarrez CodeNomad et vérifiez le certificat et l’adresse HTTPS affichée depuis l’appareil client.

Les fichiers de certificat personnalisés sont lus au démarrage et jamais réécrits par CodeNomad. Vous gérez leur renouvellement et le redémarrage nécessaire au chargement des fichiers renouvelés. `--tlsSANs` configure les certificats générés ; il ne peut pas ajouter des noms à un certificat fourni. Protégez les clés privées et ne faites confiance qu’aux certificats dont vous avez vérifié l’identité d’hôte.

### Utiliser l’AC locale générée {#generated-certificates}

Avec HTTPS activé et sans paire clé/certificat fournie, CodeNomad crée une AC locale et un certificat serveur sous la base de configuration :

| Fichier | Utilité |
| --- | --- |
| `tls/ca-cert.pem` | Certificat public d’AC à distribuer de façon sûre aux clients que vous administrez. |
| `tls/ca-key.pem` | Clé privée d’AC ; ne jamais distribuer. |
| `tls/server-cert.pem` | Certificat serveur. |
| `tls/server-key.pem` | Clé privée serveur ; ne jamais distribuer. |

1. Ajoutez chaque nom DNS/IP visible des clients avec `--tlsSANs "host.example.test,192.0.2.10"`. Une écoute générique ne découvre pas toutes vos adresses LAN pour les SAN.
2. Redémarrez le backend pour générer/revérifier le certificat.
3. Vérifiez l’hôte/l’AC par un canal de confiance, puis importez **uniquement le certificat d’AC** dans chaque magasin de confiance client/navigateur voulu. Sinon, utilisez un certificat reconnu publiquement ou un proxy inverse TLS.

Le certificat serveur généré dure 30 jours. Le démarrage le renouvelle à moins de trois jours de l’expiration, si des SAN requis manquent, s’il échoue aux contrôles ou si son fichier de clé privée manque. L’AC générée dure 365 jours et est remplacée lorsqu’elle expire, échoue aux contrôles ou que son fichier de clé privée manque ; cela réémet aussi le certificat serveur. Les clients doivent faire confiance à l’AC de remplacement. Aucun renouvellement continu n’a lieu dans le processus : prévoyez un redémarrage délibéré avant expiration pour les déploiements de longue durée.

Si un client signale un avertissement de certificat, arrêtez-vous et vérifiez le nom d’hôte, les SAN, le magasin de confiance et l’expiration. Ne désactivez pas la vérification et ne faites pas du contournement des avertissements votre procédure de déploiement. Un HTTPS de confiance est aussi requis pour des fonctions de navigateur distant telles que [l’installation PWA et l’accès au microphone](mobile.md).

## Enregistrer un serveur distant {#saved-servers}

Les clients distants authentifiés peuvent utiliser et gérer les mêmes serveurs enregistrés que les clients locaux. Saisir un nouveau mot de passe de serveur ou un lien d’appairage exige HTTPS ou le Contrôle à distance.

Dans **Paramètres → Serveurs**, collez une adresse ou un lien d’appairage dans **Adresse ou lien du serveur**, ou saisissez-le et validez par Entrée. Cela enregistre le serveur sans ouvrir de projet. **Modifier le serveur** change son **URL** ou son **Nom** facultatif ; renommer à URL et politique TLS identiques fonctionne hors ligne. Après confirmation, **Supprimer** ferme les onglets de ce serveur dans cette fenêtre et retire ses raccourcis récents. Pour les projets temporaires, choisissez **Garder** ou **Jeter** ; **Jeter** supprime leurs fichiers et conversations. Les autres projets et conversations restent sur le serveur.

OpenSSH doit être installé sur l’hôte CodeNomad, et CodeNomad doit déjà être en cours d’exécution à destination. Dans **Paramètres → Serveurs**, choisissez **Ajouter un serveur SSH**. Saisissez l’**URL** de CodeNomad telle que l’hôte SSH y accède, puis l’**Hôte SSH (facultatif)** ou son alias et choisissez **Enregistrer**. Le profil peut être enregistré hors ligne. OpenSSH exige une authentification par clé et une clé d’hôte vérifiée dans `known_hosts`. Connectez-vous à CodeNomad sur ce serveur ; les certificats HTTPS sont toujours vérifiés.

L’éditeur de serveur comporte la case **Ignorer la vérification TLS**. Le champ **Adresse ou lien du serveur** ne propose cette option qu’après un échec de certificat pour cette adresse ; changer d’adresse efface ce choix. L’appairage vérifie toujours TLS.

Uniquement si `multiBackend` est réglé sur `false`, utilisez les fenêtres de bureau séparées ci-dessous :

1. **Paramètres → Accès distant → Serveurs** → **Se connecter au serveur CodeNomad**.
2. Dans **Se connecter à un serveur**, saisissez **Nom du serveur** et **URL du serveur** avec une origine HTTPS de confiance. Laissez **Ignorer la vérification TLS pour les certificats auto-signés.** décoché ; établissez plutôt la confiance.
3. Choisissez **Enregistrer** pour ajouter un favori, ou **Se connecter** pour l’enregistrer et l’ouvrir. Connectez-vous sur ce serveur.

Fermer la dernière fenêtre locale alors que des fenêtres distantes restent ouvertes conserve ses onglets : **Fenêtre → Nouvelle fenêtre** dans une fenêtre distante, ou un nouveau lancement de CodeNomad, la rouvre.

Pour le Contrôle à distance, collez plutôt un lien d’appairage récent dans **URL du serveur**. Le favori ne conserve que l’origine du tunnel, jamais le code d’appairage à usage unique ; voir [Contrôle à distance](remote-control.md) pour le réappairage après perte du cookie de l’appareil.

## Ouvrir un projet distant dans un onglet {#remote-project-tabs}

Dans un onglet vide, choisissez **Parcourir**, puis un serveur. Collez une adresse ou un lien d’appairage dans **Adresse ou lien du serveur** pour l’enregistrer. Connectez-vous si nécessaire. Cliquez sur un dossier pour y entrer ; utilisez Entrée dans le champ de chemin ou **Ouvrir** (la flèche) pour l’ouvrir. **Retour à Parcourir** revient à la liste des serveurs.

Les projets locaux et distants partagent la même fenêtre. **Onglets récents** affiche les raccourcis du serveur parcouru ; les récents mixtes indiquent l’icône et le nom du serveur pour les projets ouverts ici. [Restaurer les onglets distants](projects.md#restore-remote-tabs).

Dans **Paramètres → Serveurs**, **Ouvrir** sélectionne le serveur dans **Parcourir** et réutilise un onglet vide s’il y en a un.

### `--connect-server` {#connect-server}

`--connect-server <name-or-url>` ouvre une fenêtre distante séparée, quelle que soit la valeur de `multiBackend`. Utilisez un nom ou un identifiant enregistré, ou une URL HTTP(S). Une nouvelle URL est enregistrée sous son nom d’hôte. L’URL de lancement ne peut contenir ni nom d’utilisateur, ni mot de passe, ni code d’appairage. Voir le [tableau des arguments de lancement](desktop.md#desktop-cli) pour la syntaxe et le démarrage en fenêtre distante seule.
