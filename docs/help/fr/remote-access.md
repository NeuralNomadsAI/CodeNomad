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
| Autonome, HTTPS seul (défaut) | Non activé | `--host` |
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

Ne supposez pas le port 9898 ou 9899 : les ports omis peuvent changer s’ils sont occupés. Un `--https-port` ou `--http-port` explicite non nul fixe le port et échoue si l’écoute est impossible ; `0` demande au système d’en attribuer un. Les **Local Connection URL** et **Remote Connection URL** affichées, et les **Adresses accessibles** actualisées, font autorité pour cette exécution. Voir la [référence CLI serveur](server.md) complète.

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

Le certificat serveur généré dure 30 jours. Le démarrage le renouvelle à moins de trois jours de l’expiration, si des SAN requis manquent, s’il échoue aux contrôles ou si son fichier de clé privée manque. L’AC générée dure 365 jours et est remplacée lorsqu’elle expire, échoue aux contrôles ou que son fichier de clé privée manque ; cela réémet aussi le certificat serveur. Les clés privées existantes corrompues, illisibles ou incompatibles ne sont pas réparées automatiquement. Les clients doivent faire confiance à l’AC de remplacement. Aucun renouvellement continu n’a lieu dans le processus : prévoyez un redémarrage délibéré avant expiration pour les déploiements de longue durée.

Si un client signale un avertissement de certificat, arrêtez-vous et vérifiez le nom d’hôte, les SAN, le magasin de confiance et l’expiration. Ne désactivez pas la vérification et ne faites pas du contournement des avertissements votre procédure de déploiement. Un HTTPS de confiance est aussi requis pour des fonctions de navigateur distant telles que [l’installation PWA et l’accès au microphone](mobile.md).

## Enregistrer un serveur distant {#saved-servers}

1. Dans l’accueil de bureau, sélectionnez **Serveurs**, puis **Se connecter à un serveur**.
2. Saisissez **Nom du serveur** et **URL du serveur** avec une origine HTTPS de confiance. Laissez **Ignorer la vérification TLS pour les certificats auto-signés.** décoché ; établissez plutôt la confiance.
3. Choisissez **Enregistrer** pour ajouter un favori, ou **Se connecter** pour l’enregistrer et l’ouvrir. Connectez-vous sur ce serveur.

Les favoris appartiennent à cette configuration CodeNomad, pas aux projets du serveur distant. Enregistrer une URL ne démarre pas le serveur et n’accorde pas l’accès. **Supprimer le serveur enregistré** retire le favori, pas les conversations distantes, le backend ou ses identifiants. Les serveurs enregistrés peuvent aussi s’ouvrir depuis la liste **Serveurs distants** du lanceur de nouvelle instance.

Pour le Contrôle à distance, collez plutôt un lien d’appairage récent dans **URL du serveur**. Le favori ne conserve que l’origine du tunnel, jamais le code d’appairage à usage unique ; voir [Contrôle à distance](remote-control.md) pour le réappairage après perte du cookie de l’appareil.
