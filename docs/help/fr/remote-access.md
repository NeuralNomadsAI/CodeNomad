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
| Autonome, HTTPS seul (défaut) | Écoute privée en boucle locale uniquement (voir ci-dessous) | `--host` |
| Autonome, HTTP seul | **`--host`**, y compris une adresse LAN/générique | Non activé |
| Autonome, les deux écoutes | `127.0.0.1` quel que soit `--host` | `--host` |
| Backend de bureau natif | Son écoute HTTP reste sur `127.0.0.1`, y compris son écoute interne à l’hôte | `--host` quand HTTPS est activé |

Chaque backend conserve aussi une écoute HTTP sur `127.0.0.1` pour les plugins OpenCode fournis avec CodeNomad, comme Missions. Lorsque HTTP n’a pas été demandé, ou que l’écoute HTTP demandée est liée à une autre adresse que `127.0.0.1` ou `0.0.0.0`, le backend ajoute une écoute HTTP privée sur un port aléatoire de `127.0.0.1`. Elle n’est jamais affichée ni proposée comme adresse de connexion, n’est pas accessible depuis d’autres machines et sert la même application authentifiée.

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

1. Utilisez **Parcourir** sur l'accueil ou dans le panneau droit d'un onglet vide, puis saisissez l'adresse ou le lien d'appairage dans **Adresse ou lien du serveur**. Coller ajoute immédiatement ; Entrée ajoute le texte saisi. Le serveur est enregistré, sa ligne reçoit le focus et le sélecteur reste en place ; un lien appaire aussi le backend local pour le parcours. Cliquez sur la ligne pour parcourir. **Paramètres → Serveurs** propose le même champ.
2. Utilisez une origine HTTPS de confiance. Les erreurs de certificat et de serveur inaccessible sont localisées ; leur contrôle d'information révèle le diagnostic technique à la demande. **Ignorer la vérification TLS** exige votre choix explicite : réservez-le aux serveurs de confiance, puis validez de nouveau. L'action d'ouverture annonce au choix du projet la fenêtre séparée utilisée par ce profil.
3. Le nom du serveur reste visible à la connexion et pendant la navigation, avec des champs libellés et les sections **Récents** et **Dossiers**. Les erreurs d'appairage nomment le serveur concerné. **Modifier le serveur** dans **Paramètres → Serveurs** change URL et nom ; ses boutons `i` révèlent l'aide URL/TLS à la demande.

**Paramètres → Serveurs** gère les profils (**Modifier le serveur**, **Supprimer le serveur enregistré**). La suppression oublie d’abord les identifiants et la session de parcours conservés par le backend, puis retire le favori et ferme ses onglets. Les projets et conversations distants restent sur leur serveur. Le backend local conserve les secrets de parcours dans `remote-server-credentials.json`, à côté de sa configuration ; protégez ce fichier comme un mot de passe.

Pour ouvrir un serveur enregistré directement depuis la ligne de commande, lancez l’application de bureau avec `--connect-server <nom>` (ou `--connect-server=<nom>`), en indiquant le nom enregistré du serveur ou son URL `https://`. CodeNomad n’ouvre que la fenêtre distante, avec les vérifications TLS du profil et la connexion propre à la fenêtre distante native ; si CodeNomad est déjà lancé, sa fenêtre actuelle l’ouvre au lieu d’une nouvelle fenêtre. Une URL qui ne correspond à aucun serveur enregistré est enregistrée sous son nom d’hôte. Les valeurs de lancement ne portent jamais d’identifiants : une URL avec un nom d’utilisateur, un mot de passe ou un code d’appairage est refusée. Si le nom est inconnu, l’URL invalide ou la connexion échoue, CodeNomad démarre normalement et affiche l’erreur. Quand la connexion demande une confirmation, comme l’installation du certificat local pour un serveur auto-signé, CodeNomad démarre aussi normalement et la demande là. Sous Windows, la version Tauri refuse de démarrer quand un argument de lancement contient `|` ; utilisez plutôt l’URL du serveur, ou renommez le serveur.

Une fenêtre distante laisse toujours un moyen de revenir sur cet ordinateur. Fermer la dernière fenêtre locale alors que des fenêtres distantes restent ouvertes conserve ses onglets : **Fenêtre → Nouvelle fenêtre** dans une fenêtre distante, ou un nouveau lancement de CodeNomad, la rouvre. Si un serveur ne peut pas être chargé, sa fenêtre l’indique et propose **Réessayer**, **Ouvrir une fenêtre locale** et **Fermer la fenêtre** ; dans la version Tauri, utilisez le bouton d’actualisation de la page et **Fenêtre → Nouvelle fenêtre**.

Coller un lien neuf du Contrôle à distance enregistre l’origine du tunnel et appaire le backend local pour le parcours ; son identifiant d’appareil reste privé et persiste entre les lancements. Le code est supprimé après la tentative. Après révocation, choisissez **Retour à Parcourir** et collez un lien neuf dans **Adresse ou lien du serveur**. Les vues intégrées partagent le cookie, la durée de vie et la révocation de cet appareil. Si l’appairage côté serveur est indisponible, mettez le serveur distant à jour ou utilisez son URL d’écoute directe pour la connexion par mot de passe ; les adresses de tunnel exigent un appairage. Voir [Contrôle à distance](remote-control.md).

## Ouvrir un projet distant dans un onglet {#remote-project-tabs}

Dans l'application de bureau (Electron, ou Tauri sous Windows), un serveur enregistré peut aussi ouvrir l'un de ses projets dans un onglet de cette fenêtre, à côté de vos projets locaux :

1. Sur l'accueil ou un onglet vide, ouvrez **Parcourir** et choisissez un serveur enregistré. Ajoutez un serveur avec **Adresse ou lien du serveur**, puis cliquez sur sa ligne.
2. Connectez-vous dans le formulaire intégré avec libellés si nécessaire. Les dossiers du serveur apparaissent sur place sous un chemin modifiable : cliquez sur un dossier pour y entrer ou sur **Dossier parent** pour remonter, puis appuyez sur Entrée ou sur la flèche au bout du chemin pour ouvrir ce dossier. Les projets récents du serveur apparaissent dans **Onglets récents**. **Retour à Parcourir** revient à la liste des serveurs.
3. Le dossier choisi crée une nouvelle occurrence distante à la place de l'onglet vide et rejoint **Récents**. L'action séparée **Ouvert** rejoint l'occurrence existante. Une ouverture en fenêtre séparée est annoncée par l'action au moment du choix, notamment pour le repli TLS et Tauri macOS/Linux.

Les conversations, fichiers, Git, paramètres et Missions de l’onglet s’exécutent sur le serveur distant. Sa vue intégrée partage le stockage de la fenêtre distante de ce serveur. Le backend local prépare une session dédiée par une nouvelle connexion par mot de passe sans cookie. Ne transmettez jamais le mot de passe conservé au renderer ou à l'hôte natif. Le cookie lié à l'origine transite de façon éphémère par le renderer vers le magasin de cookies natif avant l'ouverture de l'URL intégrée. Ne journalisez jamais ce cookie et ne le conservez jamais dans l'état de l'interface. L'accès appairé partage le cookie existant de l'appareil, sa durée de vie et sa révocation ; isoler l'authentification d'appareil nécessite un mécanisme distinct.

Si les identifiants d'un projet distant récent manquent, l'accueil, le panneau **Onglets récents** à gauche d'un nouvel onglet et le menu `+` affichent un formulaire sur place avant d'ouvrir l'onglet du projet. Un onglet restauré affiche le formulaire dans son onglet. Le nom d'utilisateur est toujours `codenomad`, le focus commence sur le mot de passe et les erreurs restent dans le formulaire pour réessayer. Utilisez la réparation d'appairage ci-dessus pour un appareil révoqué.

Les onglets distants participent à la restauration au démarrage. Les serveurs sans mode intégré affichent leur interface complète ; les profils ignorant TLS et Tauri sous macOS/Linux ouvrent une fenêtre distincte. La page intégrée reste sur son serveur et dispose seulement des notifications sur l’hôte. Les clients web et appareils du Contrôle à distance n’ont pas d’onglets distants.

Le parcours par le backend accepte l’adresse de destination de chaque profil enregistré, y compris le bouclage, les réseaux locaux RFC1918, Docker, Hyper-V, CGNAT/Tailscale (`100.64.0.0/10`), MagicDNS et `*.ts.net`, les adresses IPv6 ULA/link-local et les noms résolus vers ces adresses. Vos routes réseau et votre configuration TLS doivent permettre la connexion. La vérification des certificats suit le profil enregistré et sa confirmation TLS explicite.
