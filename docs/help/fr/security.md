# Authentification et sécurité

L’accès à CodeNomad peut exécuter du travail sur l’hôte du backend via OpenCode. Traitez les mots de passe serveur, sessions navigateur et appareils appairés comme des identifiants puissants. CodeNomad n’est pas un bac à sable d’exécution multilocataire.

## Choisir l’authentification du serveur {#authentication}

| Méthode | Durée de vie et portée |
| --- | --- |
| `--password` ou `CODENOMAD_SERVER_PASSWORD` | Remplacement d’exécution pour ce processus backend. Requis à chaque démarrage ; non enregistré. Remplace le fichier de mot de passe géré. |
| Mot de passe défini dans les paramètres | Enregistre un hachage scrypt salé dans `auth.json` à côté du YAML de configuration actif. Utilisé aux démarrages suivants sans remplacement d’exécution. |
| `--generate-token` | Active une initialisation locale à usage unique ; le jeton affiché dure 60 secondes. Ce n’est ni un jeton API réutilisable ni un lien de Contrôle à distance. |
| Appairage de Contrôle à distance | Authentification distincte par cookie d’appareil, gérée depuis l’hôte ; voir [Contrôle à distance](remote-control.md). |

Le nom d’utilisateur par défaut est `codenomad`. Un fichier d’authentification enregistré conserve son nom ; changer seulement `--username` ne renomme pas cette identité. Sans mot de passe configuré, mode d’initialisation ou authentification explicitement ignorée, le serveur refuse de démarrer.

Préférez un secret d’environnement/de service protégé plutôt qu’un mot de passe dans les arguments de commande ou l’historique shell. Toute personne pouvant inspecter votre environnement de processus ou répertoire de configuration peut malgré tout compromettre le déploiement.

## Initialiser un mot de passe permanent {#bootstrap}

1. Démarrez localement sans remplacement de mot de passe d’exécution. Pour initialiser en boucle locale avant de configurer un certificat, utilisez `codenomad --host 127.0.0.1 --https=false --http=true --generate-token --launch`.
2. Sur la machine du backend, ouvrez `/auth/token` à la **Local Connection URL** affichée et soumettez la valeur après `CODENOMAD_BOOTSTRAP_TOKEN:`. Ne partagez pas cette sortie.
3. Ouvrez **Paramètres → Accès distant → Accès direct (réseau local, avancé) → Mot de passe du serveur**.
4. Choisissez **Définir le mot de passe**, remplissez **Nouveau mot de passe** et **Confirmer le mot de passe** avec au moins huit caractères, puis choisissez **Enregistrer le mot de passe**.
5. Au prochain lancement, omettez `--generate-token` et utilisez le mot de passe enregistré pour les connexions directes. Avant d’activer l’accès distant, configurez un [HTTPS de confiance](remote-access.md) ; la commande HTTP de configuration en boucle locale n’est pas une commande de déploiement distant.

L’initialisation n’est acceptée que depuis l’écoute de boucle locale de l’hôte, pas depuis un client LAN ou l’entrée du Contrôle à distance. Gardez l’adresse d’écoute de boucle locale par défaut pour la configuration. Un jeton expiré ou consommé nécessite un nouveau démarrage d’initialisation. Si un mot de passe permanent existe déjà, la session d’initialisation permet plutôt **Changer le mot de passe**.

`auth.json` est géré par l’application ; ne modifiez pas un hachage à la main et ne publiez pas le fichier. Si le mot de passe provient de la CLI/l’environnement, les paramètres refusent de le remplacer : redémarrez sans ce remplacement pour utiliser un mot de passe géré existant, ou utilisez l’initialisation locale pour en définir un. Un fichier d’authentification illisible ou non modifiable nécessite une réparation de permissions/chemin du système, pas la désactivation de l’authentification.

## Sessions navigateur et révocation {#sessions}

La connexion directe crée une session opaque en mémoire du backend et un cookie `codenomad_session` (ou le nom configuré). Les cookies sont `HttpOnly`, `SameSite=Lax`, limités à `/` et marqués `Secure` s’ils sont émis en HTTPS. Ce sont des cookies de session navigateur ; le redémarrage du backend invalide les sessions en mémoire. Réauthentifiez-vous sur place si demandé plutôt que de renvoyer les modifications échouées.

Changer un mot de passe change les vérifications futures ; cela n’invalide **pas** les sessions directes déjà émises ni les appareils de Contrôle à distance. En cas de compromission suspectée :

1. Restreignez l’exposition réseau et définissez un nouveau mot de passe sur l’hôte, ou changez votre secret d’exécution et redémarrez.
2. Redémarrez le backend pour invalider ses sessions directes existantes.
3. Sous **Contrôle à distance → Appareils appairés**, utilisez séparément **Révoquer** pour les appareils inconnus. Arrêtez le Contrôle à distance pour couper immédiatement tout ce chemin d’accès au besoin.
4. Vérifiez les fichiers, comptes fournisseurs et l’activité native OpenCode concernés. Couper l’accès n’annule pas le travail déjà admis.

Voir [Contrôle à distance](remote-control.md) pour son expiration distincte de 30 jours d’inactivité et ses liens d’appairage de cinq minutes. Changer le mot de passe ne révoque pas les appareils, et arrêter un tunnel ne supprime pas les appareils.

## Protéger le transport et l’exposition des écoutes {#transport}

Utilisez un HTTPS de confiance pour l’accès distant direct. HTTP en clair expose mots de passe, cookies de session et contenu de travail à quiconque peut observer ce saut réseau. Si TLS se termine sur un proxy inverse, gardez le saut backend en boucle locale ou sur un autre réseau protégé ; le TLS du proxy ne chiffre pas une connexion HTTP amont exposée.

`--dangerously-skip-auth` / `CODENOMAD_SKIP_AUTH` désactive la connexion de l’écoute directe CodeNomad et traite les requêtes comme authentifiées. Cela ne rend **pas** le serveur sûr à exposer. Une écoute accessible sans périmètre protecteur effectif donne accès à quiconque peut l’atteindre ; une connexion VPN seule ne distingue pas ses utilisateurs fiables des autres. Gardez l’authentification activée sauf si vous avez indépendamment conçu et vérifié tous les chemins d’accès. Le Contrôle à distance exige toujours un appareil appairé, même avec cette option.

Vérifiez la [matrice d’écoute et les procédures TLS](remote-access.md), en particulier le mode autonome HTTP seul : il respecte `--host` et peut exposer du texte clair au-delà de la boucle locale. Ne résolvez jamais des erreurs de certificat en désactivant la vérification.

**`CODENOMAD_SKIP_AUTH=false` maintient l’authentification activée, sauf si `--dangerously-skip-auth` est passé.** `1`, `true`, `yes` ou `on` activent le contournement de l’authentification, sans tenir compte de la casse ni des espaces autour ; `0`, `false`, `no`, `off`, une valeur vide ou composée uniquement d’espaces, ou une variable non définie le laissent désactivé. Toute autre valeur empêche le serveur de démarrer, même avec l’option CLI. L’option prévaut sur une valeur valide de désactivation ; voir la [référence CLI](server.md#cli-reference).

## Comprendre la limite de l’hôte {#host-boundary}

`--workspace-root` restreint les espaces de travail ouvrables et `--unrestricted-root` assouplit la navigation. Aucun n’est une prison système, un conteneur, un bac à sable de fichiers ou une restriction sur les actions d’un outil natif autorisé. Agents, commandes shell, plugins et outils MCP agissent avec les permissions de l’hôte d’exécution et leurs propres identifiants configurés.

Les [SideCars](browser-sidecars.md) sont des ajouts de confiance. CodeNomad ne transmet pas au service SideCar ses cookies de connexion ni ceux des appareils appairés, mais la page SideCar se charge dans la même origine que CodeNomad et ses scripts peuvent agir avec votre session connectée. N’enregistrez que des services auxquels vous faites autant confiance qu’à CodeNomad lui-même.

Utilisez des comptes système, conteneurs/VM et la configuration d’autorisations en amont si une réelle isolation est nécessaire. N’accordez pas l’accès à un appareil uniquement parce que vous vous attendez à ce qu’il voie un seul onglet. La configuration serveur et le service OpenCode partagé peuvent affecter d’autres conversations/projets ; voir [Configuration d’OpenCode](opencode.md), [Autorisations](permissions.md) et [Extensions](extensions.md) pour leurs limites distinctes.

## Garder identifiants et diagnostics privés {#privacy}

OpenCode possède les connexions fournisseurs et son stockage global de conversations. CodeNomad lit les métadonnées de connexion et les identifiants sélectionnés côté serveur pour les intégrations d’utilisation prises en charge ; les API navigateur ne renvoient pas les secrets fournisseurs. Le rafraîchissement d’une connexion OAuth externe appartient à son propriétaire ; CodeNomad n’échange pas ces jetons de rafraîchissement. Voir [Fournisseurs](providers.md).

| Élément | Traitement |
| --- | --- |
| Mots de passe, jetons d’initialisation, liens d’appairage, cookies | Ne jamais coller dans les tickets, captures, transcriptions shell ou journaux partagés. |
| `auth.json`, clés privées TLS, identité de tunnel, secrets de configuration | Protéger par les permissions système et des sauvegardes chiffrées ; ne pas envoyer de répertoires complets à l’assistance. |
| Texte des conversations, pièces jointes, chemins et adresses distantes | Relire/masquer avant partage ; ils peuvent identifier personnes, projets ou infrastructure. |
| Clés fournisseurs et identifiants vocaux | Saisir uniquement dans les paramètres/le propriétaire prévus ; vérifier quel fournisseur reçoit les données. Voir [Voix](voice.md). |
| Journaux debug/trace et captures réseau | Collecter seulement le nécessaire, inspecter localement et masquer avant signalement. Ne pas supposer que toute sortie d’outil en aval est exempte de secrets. |

**Paramètres → Info → Signaler un bug** prépare des diagnostics bornés sans préremplir les écoutes, adresses, chemins, identifiants ou contenu des conversations. Relisez ce que vous ajoutez avant soumission. Voir [Assistance](support.md).
