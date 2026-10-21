# Serveur autonome

Exécutez CodeNomad là où se trouvent vos projets et outils, puis utilisez son interface navigateur localement ou à distance. Le backend fournit l’accès aux fichiers, les opérations Git, l’authentification et la livraison des événements. Le service partagé d’OpenCode possède les conversations et l’exécution ; ce n’est pas un serveur enfant à arrêter quand un navigateur se déconnecte.

La même interface prend en charge [plusieurs onglets de projet et worktrees](projects.md), les [familles de conversations et l’activité en arrière-plan](conversations.md), le [chargement borné de l’historique, la recherche et la navigation chronologique](history.md), ainsi qu’une [palette de commandes et des raccourcis](shortcuts.md). L’accès par navigateur ou tablette ne déplace pas l’exécution hors de l’hôte.

## Préparer l’hôte {#prerequisites}

1. Installez Node.js 24 LTS et npm ; la version d’exécution épinglée du dépôt pour la compilation est 24.20.0. Les paquets de bureau incluent Node/npm.
2. Placez Git dans le **PATH du processus backend**. Git dans WSL seul ne suffit pas pour un backend Windows.
3. Installez ou sélectionnez OpenCode : le minimum requis est **2.1.2**, avec **2.1.2** comme cible de qualification recommandée. Les versions plus récentes ou personnalisées passent des contrôles de compatibilité, pas une liste de versions testées autorisées. Consultez la [configuration d’OpenCode](opencode.md).
4. Choisissez le dossier depuis lequel démarrer le serveur, ou passez explicitement `--workspace-root`.

Sans Git, les conversations restent disponibles uniquement dans le dossier physique explicitement ouvert ; les opérations Git et worktree échouent. Installez Git et redémarrez le backend après une modification de PATH. Une racine d’espace de travail limite l’ouverture/la navigation, pas l’exécution de l’agent : voir [Sécurité](security.md).

## Exécuter ou installer {#run}

Choisissez une méthode d’installation. Ces exemples de premier lancement utilisent une initialisation locale plutôt que d’inscrire un mot de passe dans l’historique du shell :

### Exécuter avec npx {#npx}

```sh
npx @neuralnomads/codenomad --generate-token --launch
```

### Installer globalement {#global-install}

```sh
npm install -g @neuralnomads/codenomad
codenomad --generate-token --launch
```

### Installer dans un projet {#local-install}

```sh
npm install @neuralnomads/codenomad
npx codenomad --generate-token --launch
```

`npx codenomad` utilise le binaire installé dans le projet s’il existe. Cela installe le paquet dans ce projet ; cela ne rend **pas** la configuration ni le stockage OpenCode locaux au projet.

1. Ouvrez la **Local Connection URL** affichée sur l’hôte. Effectuez l’[initialisation locale](security.md), puis enregistrez un mot de passe serveur permanent. Cette procédure inclut une option de configuration HTTP limitée à la boucle locale si vous n’avez pas encore établi la confiance HTTPS.
2. Aux démarrages suivants, omettez `--generate-token` ; sinon, fournissez `CODENOMAD_SERVER_PASSWORD` à chaque démarrage.
3. Utilisez `codenomad --help` pour consulter les options de la CLI installée.

Les commandes s’exécutent au premier plan. Fermer le terminal ou envoyer Ctrl+C arrête ce backend et sa connexion de Contrôle à distance. `--launch` ouvre seulement un navigateur ; il ne transforme pas le serveur en démon. Pour une disponibilité sans surveillance, exécutez la même commande sous le gestionnaire de processus/services de votre système, avec une configuration, un répertoire de travail, un environnement et une politique de redémarrage explicites. Ne mettez pas de secrets dans les journaux du service ou un fichier d’unité public.

Fermer un navigateur n’arrête pas un backend autonome exécuté séparément. Fermer un onglet de projet ferme le projet dans CodeNomad, qui cesse de le suivre ; les sessions continuent dans OpenCode et se retrouvent en rouvrant le projet. La Location native n’est pas déchargée et le démon partagé n’est pas arrêté. L’arrêt du backend laisse également le service OpenCode actif. Les fonctionnalités dépendant du backend restent indisponibles jusqu’au retour de CodeNomad ; consultez [Missions](missions.md) pour la durée de vie distincte de la planification native.

## Adresses et ports {#addresses}

Le démarrage affiche **Local Connection URL**, et **Remote Connection URL** si disponible, ainsi que **Other Accessible URLs** le cas échéant. Utilisez le protocole et le port affichés, pas une adresse supposée. Une URL de boucle locale n’est accessible que sur cette machine ; une adresse LAN affichée nécessite encore un routage et un accès autorisé par le pare-feu.

HTTPS privilégie le port **9898** et HTTP le port **9899**. Sans remplacement du port, si le port préféré est occupé, un port attribué par le système est utilisé. Un port explicite non nul n’a pas de solution de repli ; `0` demande un port attribué par le système. Les ports acceptent les entiers de 0 à 65535.

Pour l’exposition de l’écoute, les certificats, VPN/SSH et les proxys inverses, consultez [Accès distant direct](remote-access.md). Pour un accès sans port entrant, consultez [Contrôle à distance](remote-control.md).

## Référence CLI publique {#cli-reference}

Les options remplacent leurs équivalents d’environnement. Les options à valeur utilisent l’argument indiqué ; les commutateurs n’en prennent pas. Les valeurs HTTPS/HTTP reconnaissent `1`, `true`, `yes`, `y` et `on` comme activées, sans distinction de casse ; utilisez explicitement `true`/`false` pour plus de clarté. La mise à jour automatique de l’interface reconnaît `1`, `true` et `yes`.

**Les variables d’environnement booléennes strictes** (`CLI_UNRESTRICTED_ROOT`, `CLI_UI_NO_UPDATE`, `CLI_LAUNCH`, `CODENOMAD_GENERATE_TOKEN` et `CODENOMAD_SKIP_AUTH`) activent leur commutateur avec `1`, `true`, `yes` ou `on`, sans tenir compte de la casse ni des espaces autour. `0`, `false`, `no`, `off`, une valeur vide ou composée uniquement d’espaces, ou une variable non définie laissent le commutateur désactivé. Toute autre valeur empêche le serveur de démarrer, même avec l’option CLI correspondante. L’option CLI active le commutateur malgré une valeur valide de désactivation ; sinon, les valeurs par défaut `false` ci-dessous s’appliquent.

| Option | Environnement | Valeur par défaut et effet |
| --- | --- | --- |
| `-h, --help` | - | Affiche l’aide et quitte. |
| `-v, --version` | - | Affiche la version du paquet installé et quitte. |
| `--host <host>` | `CLI_HOST` | `127.0.0.1` ; `localhost` est normalisé en boucle locale IPv4. Les identifiants de zone IPv6 sont refusés. Voir la [matrice d’écoute](remote-access.md). |
| `--https <enabled>` | `CLI_HTTPS` | `true` ; écoute HTTPS. |
| `--http <enabled>` | `CLI_HTTP` | `false` ; écoute HTTP. Au moins une écoute doit être activée. |
| `--https-port <number>` | `CLI_HTTPS_PORT` | `9898` préféré ; `0` automatique. |
| `--http-port <number>` | `CLI_HTTP_PORT` | `9899` préféré ; `0` automatique. |
| `--tls-key <path>` | `CLI_TLS_KEY` | Non défini ; clé privée PEM, nécessite `--tls-cert`. |
| `--tls-cert <path>` | `CLI_TLS_CERT` | Non défini ; certificat PEM, nécessite `--tls-key`. |
| `--tls-ca <path>` | `CLI_TLS_CA` | Non défini ; chaîne d’AC PEM facultative pour les certificats fournis. |
| `--tlsSANs <list>` | `CLI_TLS_SANS` | Non défini ; noms DNS/IP supplémentaires séparés par des virgules pour les certificats générés. |
| `--workspace-root <path>` | `CLI_WORKSPACE_ROOT` | Répertoire de travail du processus ; racine pour ouvrir les espaces de travail. |
| `--unrestricted-root` | `CLI_UNRESTRICTED_ROOT` | `false` ; autorise la navigation sur tout le système de fichiers. Ce n’est pas un réglage de bac à sable pour l’agent. |
| `--config <path>` | `CLI_CONFIG` | Valeur active résolue par défaut : `~/.config/codenomad/config.yaml`. Accepte un répertoire ou un fichier YAML pour un emplacement explicite. |
| `--log-level <level>` | `CLI_LOG_LEVEL` | `info` ; niveaux documentés : `trace`, `debug`, `info`, `warn`, `error`. |
| `--log-destination <path>` | `CLI_LOG_DESTINATION` | `stdout` ; sinon écrit dans le fichier choisi. |
| `--username <username>` | `CODENOMAD_SERVER_USERNAME` | `codenomad` ; nom d’utilisateur d’authentification à l’exécution. Un fichier d’authentification conserve son nom enregistré quand aucun mot de passe d’exécution ne le remplace. |
| `--password <password>` | `CODENOMAD_SERVER_PASSWORD` | Non défini ; mot de passe limité à l’exécution, prioritaire sur le fichier d’authentification géré. |
| `--auth-cookie-name <name>` | `CODENOMAD_AUTH_COOKIE_NAME` | `codenomad_session` ; les caractères autres que lettres, chiffres, `_` et `-` deviennent `_`. |
| `--generate-token` | `CODENOMAD_GENERATE_TOKEN` | `false` ; affiche un jeton d’initialisation locale à usage unique valable 60 secondes. |
| `--dangerously-skip-auth` | `CODENOMAD_SKIP_AUTH` | `false` ; désactive l’authentification de l’écoute directe. Dangereux : voir [Sécurité](security.md). Le Contrôle à distance exige toujours l’appairage de l’appareil. |
| `--ui-dir <path>` | `CLI_UI_DIR` | Répertoire `public` du paquet ; un remplacement explicite sert cette interface plutôt que de résoudre une interface distante. |
| `--ui-dev-server <url>` | `CLI_UI_DEV_SERVER` | Non défini ; transmet l’interface via l’écoute HTTP. Pour le développement, utilisez `--https=false --http=true` ; l’écoute HTTPS ne relaie pas l’interface de développement. |
| `--ui-no-update` | `CLI_UI_NO_UPDATE` | `false` ; remplace la mise à jour automatique et utilise l’interface disponible en cache/fournie. |
| `--ui-auto-update <enabled>` | `CLI_UI_AUTO_UPDATE` | `true` ; recherche une interface distante compatible au démarrage. |
| `--ui-manifest-url <url>` | `CLI_UI_MANIFEST_URL` | `https://ui.codenomad.neuralnomads.ai/version.json` ; manifeste de l’interface distante. |
| `--launch` | `CLI_LAUNCH` | `false` ; ouvre l’interface locale dans un navigateur après le démarrage. |
| `--upgrade [version]` | - | Aucune mise à niveau par défaut. Sur demande, installe globalement `@neuralnomads/codenomad@latest`, ou la version fournie, puis quitte. |

La référence publique liste les options destinées aux utilisateurs ; les hôtes de bureau gèrent leur propre coordination de lancement privée.

### Environnement de déploiement supplémentaire {#deployment-environment}

| Variable | Valeur par défaut et portée |
| --- | --- |
| `CODENOMAD_GITHUB_REPO` | `NeuralNomadsAI/CodeNomad` ; dépôt interrogé pour les versions proposées. |
| `CODENOMAD_REMOTE_CONTROL_API` | Non défini : API OpenTunnel hébergée. Définissez une origine d’API pour un déploiement de relais auto-hébergé. |
| `NODE_EXTRA_CA_CERTS` | Fichier d’AC supplémentaire facultatif de Node ; transmis avec l’environnement de démarrage autorisé au lancement d’un démon OpenCode manquant. Ne modifie pas un démon déjà actif. |

Les identifiants d’utilisation propres aux fournisseurs sont décrits dans [Fournisseurs](providers.md). La sélection du profil de données de bureau est décrite dans [Bureau](desktop.md), et n’est pas contrôlée par le flux de versions.

## Propriété de la configuration et du stockage {#storage}

Les chemins par défaut ci-dessous utilisent le dossier personnel de l’utilisateur du backend. Un répertoire `--config` explicite change la base de configuration ; un nom de fichier YAML sélectionne ce fichier avec l’état/le stockage à côté. Choisissez une identité de configuration intentionnelle pour un déploiement et protégez tout le répertoire par les permissions du système.

| Propriétaire/données | Emplacement ou règle par défaut |
| --- | --- |
| Préférences stables CodeNomad | `~/.config/codenomad/config.yaml` |
| État modifiable CodeNomad | `~/.config/codenomad/state.yaml` |
| Métadonnées d’instance CodeNomad | `~/.config/codenomad/instances/` |
| Hachage du mot de passe | `auth.json` à côté de la configuration YAML active ; géré par l’application. |
| Certificats TLS et clés privées générés | `tls/` sous la base de configuration. |
| Route du Contrôle à distance, choix d’activation et hachages d’appareil | `remote-control-devices.json` sous la base de configuration. |
| Registre et dossiers des espaces de travail temporaires | `temporary-workspaces.json` et `temporary-workspaces/` sous cette base. |
| Extensions de panneau installées et reçus d’autorisation | `panel-extensions/` et `permission-receipts/` sous cette base. |
| Cache d’interface téléchargée | `~/.config/codenomad/ui/` ; le résolveur d’interface CLI utilise ce cache du dossier personnel même avec un `--config` personnalisé. |
| Conversations, messages, enregistrement du service et connexions fournisseurs OpenCode | Stockage global propre à OpenCode sur l’hôte d’exécution, pas le répertoire d’instance CodeNomad. |
| État de restauration du bureau | Par défaut `~/.codenomad/client-state/v2/` ; voir [Bureau](desktop.md) pour la portée profil/fenêtre. |

CodeNomad se connecte au démon partagé existant ou le démarre s’il manque. L’environnement de démarrage n’affecte qu’un démon nouvellement lancé. Séparément, l’environnement complet configuré pour les sessions est appliqué avant chaque prompt, commande personnalisée ou demande shell de session, pas lors de la simple consultation ou modification des préférences. Voir [Configuration d’OpenCode](opencode.md).

## Événements et reconnexions {#events}

Le backend consomme un flux d’événements natifs OpenCode partagé et multiplexe les événements d’espace de travail et CodeNomad vers les clients navigateur avec Server-Sent Events. La livraison est en direct et volatile : **aucun rejeu des événements n’est garanti**.

Après reconnexion, l’interface relit l’état faisant autorité des sessions et demandes en attente ; les invalidations de fichiers/configuration déclenchent aussi de nouvelles lectures. Une reconnexion n’autorise pas à répéter un envoi, une suppression, une réponse ou une autre modification dont la réponse a été perdue. Vérifiez d’abord l’état résultant. Les demandes connues en attente et les brouillons sont conservés si la récupération est incomplète ; voir [Autorisations](permissions.md) et [Dépannage](troubleshooting.md).

## Paquets de préversion et maintenance {#maintenance}

Pour essayer explicitement le paquet CLI de préversion :

```sh
npx @neuralnomads/codenomad-dev --generate-token --launch
```

Utilisez une configuration délibérément distincte si vous souhaitez isoler les paramètres CodeNomad ; sélectionner un paquet n’isole pas le stockage OpenCode partagé. **Paramètres → Info → Mises à jour → Flux de mises à jour** contrôle les versions proposées, pas l’identité des données du backend ni le paquet installé.

`codenomad --upgrade` met à jour le paquet CLI stable global avec le gestionnaire npm/pnpm/bun détecté (npm si aucun n’est détecté). Il ne redémarre pas un serveur actif et ne met pas à jour OpenCode. Pour une installation locale à un projet ou une préversion, mettez à jour explicitement ce paquet npm précis. Redémarrez volontairement votre processus CodeNomad géré après la mise à jour ; vérifiez à nouveau les adresses affichées.

Consultez [Mises à jour](updates.md) pour la maintenance du bureau, [Assistance](support.md) pour les commandes de compilation depuis les sources, et [Fournisseurs](providers.md) pour l’utilisation des forfaits fournisseurs.
