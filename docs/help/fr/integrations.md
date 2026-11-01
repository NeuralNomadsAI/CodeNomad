# Intégrations natives

CodeNomad expose les connexions MCP natives, l’activation des plugins, les compétences et commandes personnalisées d’OpenCode. Elles s’exécutent sur l’hôte d’exécution. Elles sont distinctes des [Extensions de panneau](extensions.md) en bac à sable et des [SideCars](browser-sidecars.md).

## Choisir la bonne commande {#integration-scopes}

| Intégration | Où agir | Ce que la commande change |
| --- | --- | --- |
| Serveur MCP | **Statut → Serveurs MCP** | Connexion native à la Location affichée ; n’installe pas de serveur. |
| Plugin natif | **Statut → Plugins** | Ajoute ou retire la déclaration d’un paquet, et fixe une règle d’activation persistante **Global** ou **Projet** ; pour un plugin issu d’un paquet, vérification ou mise à jour explicite de ce paquet. |
| Compétence | Menu `@` de saisie | Pièce jointe explicite au prochain prompt dans la Location de la conversation. |
| Commande personnalisée | Menu `/` de saisie | Exécute une commande exposée par OpenCode pour cette Location. |

Configurez/installez d’abord l’intégration avec la configuration et la CLI prises en charge par OpenCode. Installer un paquet, déclarer sa source, activer sa règle, connecter un service et rendre ses outils disponibles sont des étapes distinctes. Les intégrations natives ont les privilèges de leur processus hôte, soumis aux autorisations OpenCode ; ce ne sont pas des panneaux HTML en bac à sable.

## Connecter ou déconnecter MCP {#mcp}

1. Configurez le serveur MCP sur l’hôte d’exécution OpenCode avec la [documentation MCP OpenCode](https://opencode.ai/v2/docs/mcp-servers/).
2. Ouvrez **Statut → Serveurs MCP** pour le projet.
3. Utilisez le commutateur à côté du serveur pour le connecter ou déconnecter. Attendez que l’indicateur de connexion se stabilise.

Le commutateur appelle l’API de connexion native pour la Location indiquée, pas un installateur local à l’appareil ni une préférence de visibilité par fenêtre. Les autres clients de cette Location peuvent observer le changement. Déconnecter ne retire pas la déclaration du serveur et ne désinstalle pas son exécutable.

Si aucun serveur n’apparaît, vérifiez la Location active et sa configuration native. Si la connexion échoue, inspectez la configuration du serveur, l’environnement requis et le parcours d’authentification natif ; ne supposez pas que le commutateur effectue OAuth. Revérifiez l’état après reconnexion. N’utilisez le rechargement explicite de configuration que si nécessaire, avec les interruptions décrites dans [Configuration d’OpenCode](opencode.md).

## Activer les plugins à la portée Global ou Projet {#plugins}

1. [Ajoutez le plugin](#plugin-sources) ou déclarez-le dans la configuration d’OpenCode ; puis ouvrez **Statut → Plugins**.
2. Survolez ou focalisez son nom pour inspecter source, échec d’exécution et détails de cible de configuration.
3. Basculez délibérément **Global** ou **Projet**. Attendez l’écriture et utilisez **Actualiser les contrôles des plugins** si l’état est incertain.
4. Pour un plugin installé depuis un paquet, utilisez l’icône à côté de son nom. Son menu nomme l’opération exacte : **Vérifier les mises à jour de** ce paquet, ou le **Mettre à jour** une fois une version plus récente trouvée.

Global cible la configuration globale découverte du démon connecté. Projet cible la configuration dans la Location active, pas un fichier ancêtre hérité. Une règle Projet ultérieure peut remplacer Global ; le commutateur Global montre toujours la règle Global, sans prétendre être l’état Projet final. Sans règle Projet, Projet hérite de l’état Global résolu.

Ces commutateurs ajoutent des règles d’activation exactes en préservant les déclarations de sources et la configuration sans rapport. Ils ne modifient pas les options des plugins, n’installent pas de paquets et ne retirent pas de fichiers. Les plugins intégrés d’OpenCode ne sont pas proposés comme commutateurs utilisateur. Projet est désactivé si sa cible ne peut pas être séparée de Global sans risque ou sort de la Location active.

Une mise à jour de paquet modifie ce paquet dans le cache partagé d’OpenCode pour toutes les Locations qui l’utilisent, comme l’indique son infobulle ; elle ne change pas les règles d’activation, ne redémarre pas OpenCode et ne recharge pas la configuration. Les plugins locaux, intégrés et fournis par le SDK n’ont pas d’action de paquet. Un paquet qui échoue avant de communiquer l’ID de son plugin est listé sous son nom de paquet, avec l’échec dans son infobulle et les actions de vérification/mise à jour, mais sans commutateurs d’activation. Une vérification ou mise à jour échouée est signalée et jamais réessayée automatiquement.

La surface conserve son dernier instantané quand elle est masquée et le revalide à l’affichage, aux changements natifs/reconnexions et à l’actualisation explicite. Une règle enregistrée et la disponibilité réelle peuvent brièvement différer. Si un plugin reste indisponible, inspectez son infobulle et sa configuration native avant **Recharger la configuration OpenCode** ; cette action affecte toutes les Locations chargées, pas seulement ce plugin. Une configuration mal formée ou une modification concurrente n’est pas écrasée silencieusement : résolvez-la, actualisez et réessayez explicitement.

## Ajouter ou retirer un plugin {#plugin-sources}

1. Dans **Statut → Plugins**, choisissez **Ajouter un plugin** (l’icône plus à côté de **Actualiser les contrôles des plugins**).
2. Saisissez un paquet du registre npm (`nom`, `nom@1.2.3`, `@scope/nom@^1`) ou un dépôt Git (`github:propriétaire/dépôt`, `git+https://…`).
3. Gardez **Global**, sauf si le plugin ne doit s’exécuter que pour ce projet, puis choisissez **Ajouter**.
4. La nouvelle ligne affiche **Installation** jusqu’à ce qu’OpenCode la signale. Elle devient alors une ligne de plugin ordinaire avec ses commutateurs, ou une ligne en échec.

Pour retirer un plugin, ouvrez le menu à côté de son nom et choisissez **Retirer de Global** ou **Retirer de Projet**. Seule la déclaration du fichier de configuration de cette portée est supprimée ; ses règles d’activation **Global**/**Projet** restent des règles, et le cache de paquets d’OpenCode reste en place.

Le code du plugin s’exécute avec vos droits dans OpenCode. Une entrée **Projet** s’exécute chaque fois que ce dossier est ouvert dans OpenCode, et les paquets qui ont des parties pour l’application de bureau d’OpenCode ne les chargent que depuis **Global** ; l’infobulle le signale quand un tel paquet est déclaré ailleurs. Les chemins locaux, les variables de configuration et les ID de plugin sont refusés ici : déclarez les plugins locaux dans le fichier de configuration. Un paquet déjà déclaré dans une configuration qui s’applique à cette Location est refusé, quelle que soit sa version, sa plage ou sa forme.

Une intégration OpenCode du catalogue revu (par exemple l’intégration Blender) est reconnue avant son installation. Celle qui a une partie dans une application s’ajoute en **Global** seulement : **Projet** est refusé pour elle. Son paquet du registre et ses builds Git comptent comme un seul paquet : ajouter une seconde forme d’une intégration déjà déclarée ou chargée est refusé.

Survolez ou ciblez le nom d’un plugin pour voir sa version, **Mise à jour disponible** et, pour une installation en échec, l’erreur avec sa référence dans le journal d’OpenCode. Une ligne qu’OpenCode n’a pas signalée au bout de deux minutes affiche **Non confirmé** avec l’action **Actualiser les contrôles des plugins** : le plugin est peut-être désactivé, ou son installation n’a jamais abouti (voir [Dépannage](troubleshooting.md#providers-and-addons)).

## Joindre des compétences {#skills}

1. Tapez `@` dans la zone de saisie, recherchez les compétences disponibles de la Location et sélectionnez-en une.
2. Vérifiez sa pièce jointe retirable à côté des fichiers/agents ; retirez-la avant l’envoi si elle n’est pas voulue.
3. Envoyez le prompt. Les étiquettes de compétences restent avec le message envoyé.

La sélection joint l’ID de compétence natif et retire le jeton `@query` ; elle ne colle pas les instructions dans le brouillon visible. L’envoi efface la sélection de saisie, pas les instructions déjà enregistrées par OpenCode avec ce message. Retirer une pièce jointe ne peut pas annuler un envoi antérieur.

Les compétences disponibles viennent de la Location de la conversation, pas d’un catalogue global CodeNomad. Si la liste ne charge pas, fermez et rouvrez le sélecteur pour réessayer ; si elle est vide, vérifiez la découverte/configuration native. Voir la [documentation des compétences OpenCode](https://opencode.ai/v2/docs/skills/) et [Conversations](conversations.md).

## Exécuter des commandes personnalisées {#commands}

1. Tapez `/` dans la zone de saisie et choisissez une commande native disponible.
2. Fournissez ses arguments et vérifiez **Agent**, **Modèle** et **Réflexion** avant l’envoi selon la commande.
3. Inspectez la conversation résultante au lieu de soumettre à répétition si l’accusé de réception est flou.

Les commandes sont découvertes depuis OpenCode pour la Location active. Leur définition native peut choisir le comportement d’exécution ; le menu n’est ni un installateur de paquets ni un éditeur de configuration sans restriction. CodeNomad applique l’environnement de session du profil avant la soumission native ; un échec de mise à jour d’environnement bloque l’envoi. `/btw` est le parcours distinct de question éphémère de CodeNomad, pas une commande personnalisée ordinaire.

Pour les définitions de commandes et l’héritage de configuration natif, utilisez la [documentation des commandes OpenCode](https://opencode.ai/v2/docs/commands/). Après des changements de configuration, actualisez/rouvrez d’abord la surface concernée ; ne rechargez explicitement la configuration que si l’environnement d’exécution en a encore besoin. Ne rejouez jamais une commande peut-être admise uniquement pour rafraîchir son affichage.
## Attacher une application ouverte {#application-attachment}

Proposez un document depuis l’intégration de l’application, puis choisissez **Attacher une application ouverte…** dans l’en-tête de conversation (ou son menu de débordement) ou le menu de la ligne Plugins. L’action apparaît seulement pour une intégration native active signalant des offres. Sélectionnez l’application et le document, vérifiez la conversation cible et l’avertissement de modification, puis choisissez **Confirmer l’attachement**. Annuler reçoit le focus initial. L’application tourne sur la machine d’OpenCode, y compris à distance. Un hôte incompatible, notamment WSL non pris en charge, affiche une aide à la place de l’action.

Une action admise conserve son résultat ou son erreur malgré les changements natifs et les reconnexions tant que la conversation cible reste affichée. La réussite est un reçu d’action local proposant **Détacher cette conversation**, utilisable même si elle est déjà détachée. Le détachement affiche aussi un reçu local. La navigation ferme ces reçus. Ce contrat ne permet pas de lire les liaisons actuelles par conversation. La métadonnée sauvegardée sert seulement d’indice : **Rattacher** apparaît dans le sélecteur uniquement pour une offre de même intégration et de même étiquette, avec une nouvelle confirmation. D’autres clients peuvent modifier les liaisons. Après réouverture, utilisez les commandes de l’application pour détacher une liaison existante.

Plugins affiche **Catalogue d’intégrations indisponible** si aucun catalogue n’est lisible, ou le dernier catalogue valide avec son heure de récupération s’il est périmé. Actualisez Plugins pour réessayer. Le retrait est refusé si des conversations sont attachées ou si les liaisons sont invérifiables ; détachez-les dans l’application, activez l’intégration si nécessaire, puis actualisez et réessayez.
