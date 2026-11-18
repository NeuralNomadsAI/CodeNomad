# Intégrations natives

CodeNomad expose les connexions MCP natives, l’activation des plugins, les compétences et commandes personnalisées d’OpenCode. Elles s’exécutent sur l’hôte d’exécution. Elles sont distinctes des [Extensions de panneau](extensions.md) en bac à sable et des [SideCars](browser-sidecars.md).

## Choisir la bonne commande {#integration-scopes}

| Intégration | Où agir | Ce que la commande change |
| --- | --- | --- |
| Serveur MCP | **Statut → Serveurs MCP** | Connexion native à la Location affichée ; n’installe pas de serveur. |
| Plugin natif | **Statut → Plugins** | Ajoute ou retire la déclaration d’un paquet, et fixe une règle d’activation persistante **Global** ou **Projet** ; pour un plugin issu d’un paquet, vérification ou mise à jour explicite de ce paquet. |
| Compétence | Menu `@` de saisie | Pièce jointe explicite au prochain prompt dans la Location de la conversation. |
| Commande personnalisée | Menu `/` de saisie | Exécute une commande exposée par OpenCode pour cette Location. |

Les intégrations natives ont les privilèges de leur processus hôte, soumis aux autorisations OpenCode ; ce ne sont pas des panneaux HTML en bac à sable.

## Connecter ou déconnecter MCP {#mcp}

1. Configurez le serveur MCP sur l’hôte d’exécution OpenCode avec la [documentation MCP OpenCode](https://opencode.ai/v2/docs/mcp-servers/).
2. Ouvrez **Statut → Serveurs MCP** pour le projet.
3. Utilisez le commutateur à côté du serveur pour le connecter ou déconnecter. Attendez que l’indicateur de connexion se stabilise.

Les autres clients de cette Location peuvent observer le changement. Déconnecter ne retire pas la déclaration du serveur et ne désinstalle pas son exécutable.

Si la connexion échoue, vérifiez la configuration du serveur, l’environnement requis et l’authentification ; le commutateur n’effectue pas OAuth.

## Activer les plugins à la portée Global ou Projet {#plugins}

Les plugins gérés par CodeNomad restent hors de la liste ordinaire et de ses contrôles d’activation, de mise à jour et de retrait.

Pour **Les plugins CodeNomad nécessitent votre attention**, ouvrez **i**. Un plugin désactivé propose **Réactiver** ; vérifiez la portée de configuration affichée avant de l’utiliser.

1. [Ajoutez le plugin](#plugin-sources) ou déclarez-le dans la configuration d’OpenCode ; puis ouvrez **Statut → Plugins**.
2. Survolez ou focalisez son nom pour inspecter source, échec d’exécution et détails de cible de configuration.
3. Basculez délibérément **Global** ou **Projet**. Attendez l’écriture et utilisez **Actualiser les contrôles des plugins** si l’état est incertain.
4. Pour un plugin installé depuis un paquet, utilisez l’icône à côté de son nom. Son menu nomme l’opération exacte : **Vérifier les mises à jour de** ce paquet, ou le **Mettre à jour** une fois une version plus récente trouvée.

Global cible la configuration globale découverte du démon connecté. Projet cible la configuration dans la Location active, pas un fichier ancêtre hérité. Une règle Projet ultérieure peut remplacer Global ; le commutateur Global montre toujours la règle Global, sans prétendre être l’état Projet final. Sans règle Projet, Projet hérite de l’état Global résolu.

Les plugins intégrés d’OpenCode ne sont pas proposés comme commutateurs utilisateur. Projet est désactivé si sa cible ne peut pas être séparée de Global sans risque ou sort de la Location active.

Une mise à jour de paquet modifie ce paquet dans le cache partagé d’OpenCode pour toutes les Locations qui l’utilisent, comme l’indique son infobulle ; elle ne change pas les règles d’activation, ne redémarre pas OpenCode et ne recharge pas la configuration. Les plugins locaux, intégrés et fournis par le SDK n’ont pas d’action de paquet.

## Ajouter ou retirer un plugin {#plugin-sources}

1. Dans **Statut → Plugins**, ouvrez **+** et choisissez **Ajouter un plugin…**.
2. Saisissez un paquet du registre npm (`nom`, `nom@1.2.3`, `@scope/nom@^1`) ou un dépôt Git (`github:propriétaire/dépôt`, `git+https://…`).
3. Gardez **Global**, sauf si le plugin ne doit s’exécuter que pour ce projet, puis choisissez **Ajouter**.
4. La nouvelle ligne affiche **Installation** jusqu’à ce qu’OpenCode la signale.

Pour retirer un plugin, ouvrez le menu à côté de son nom et choisissez **Retirer de Global** ou **Retirer de Projet**. Sa déclaration et ses règles d’activation dans le fichier de configuration de cette portée sont supprimées, sauf une règle de désactivation tant qu’une autre déclaration du plugin subsiste et une règle d’activation qu’une déclaration antérieure définit encore. Une règle d’activation qui perdrait sa définition est aussi supprimée de la configuration de ce projet, car OpenCode téléchargerait sinon un paquet du registre portant ce nom ; si elle se trouve dans un fichier que CodeNomad ne modifie pas, le retrait est refusé. Le cache de paquets d’OpenCode reste en place. Les règles d’un plugin qu’OpenCode n’a pas pu identifier (désactivé, ou en échec avant chargement) restent sur une ligne à part, dont le menu propose le même retrait.

Le code du plugin s’exécute avec vos droits dans OpenCode. Une entrée **Projet** s’exécute chaque fois que ce dossier est ouvert dans OpenCode, et les paquets qui ont des parties pour l’application de bureau d’OpenCode ne les chargent que depuis **Global** ; l’infobulle le signale quand un tel paquet est déclaré ailleurs. Les chemins locaux, les variables de configuration et les ID de plugin sont refusés ici : déclarez les plugins locaux dans le fichier de configuration. Un paquet déjà déclaré dans une configuration qui s’applique à cette Location est refusé, quelle que soit sa version, sa plage ou sa forme.

La version du paquet installé apparaît à côté du nom du plugin. Pour les plugins Git, les détails indiquent le commit ; si la version est indisponible, le commit sur sept caractères apparaît à côté du nom. Survolez ou ciblez le nom pour voir les détails, **Mise à jour disponible** et, pour une installation en échec, l’erreur avec sa référence dans le journal d’OpenCode.

## Joindre des compétences {#skills}

1. Tapez `@` dans la zone de saisie, recherchez les compétences disponibles de la Location et sélectionnez-en une.
2. Vérifiez sa pièce jointe retirable à côté des fichiers/agents ; retirez-la avant l’envoi si elle n’est pas voulue.
3. Envoyez le prompt. Les étiquettes de compétences restent avec le message envoyé.

Retirer une pièce jointe ne peut pas annuler un envoi antérieur.

Les compétences disponibles viennent de la Location de la conversation, pas d’un catalogue global CodeNomad. Voir la [documentation des compétences OpenCode](https://opencode.ai/v2/docs/skills/) et [Conversations](conversations.md).

## Exécuter des commandes personnalisées {#commands}

1. Tapez `/` dans la zone de saisie et choisissez une commande native disponible.
2. Fournissez ses arguments et vérifiez **Agent**, **Modèle** et **Réflexion** avant l’envoi selon la commande.
3. Inspectez la conversation résultante au lieu de soumettre à répétition si l’accusé de réception est flou.

Les commandes sont découvertes depuis OpenCode pour la Location active. `/btw` est le parcours distinct de question éphémère de CodeNomad, pas une commande personnalisée ordinaire.

Pour les définitions de commandes et l’héritage de configuration natif, utilisez la [documentation des commandes OpenCode](https://opencode.ai/v2/docs/commands/). Après des changements de configuration, actualisez/rouvrez d’abord la surface concernée ; ne rechargez explicitement la configuration que si l’environnement d’exécution en a encore besoin. Ne rejouez jamais une commande peut-être admise uniquement pour rafraîchir son affichage.
## Intégrations dans Plugins {#integration-rows}

Dans **Statut → Plugins**, **+** propose **Ajouter une intégration…** ou **Ajouter un plugin…**. Le sélecteur d’intégrations liste les entrées non installées du catalogue revu. Choisissez la portée puis **Installer** : CodeNomad installe l’ID du catalogue choisi. Les intégrations natives sont **Global uniquement**. **Catalogue indisponible** propose **Actualiser** ; **Catalogue du {date}** indique le dernier catalogue valide s’il est périmé.

La ligne d’état en couleur d’accent propose **Installer dans Blender**, **Mettre à jour Blender** ou **Rattacher** la conversation affichée à un document ouvert (**Rattacher…** pour choisir entre plusieurs). Un chaînon et le document indiquent un rattachement ; activez-les pour détacher. Une conversation se rattache aussi d’elle-même la première fois que son agent utilise l’intégration.

Le menu **…** de la ligne commence par l’état de la connexion, par exemple **Blender : 1 document ouvert** ou **Blender fermé**. Il propose ensuite **Documentation**, **Installer dans l'application…**, **Mettre à jour l'application…** ou **Réinstaller dans l'application…** ([voir plus bas](#application-installation)), la vérification des mises à jour du package, **Retirer de Global** ou **Retirer de Projet**, et **Actualiser les contrôles des plugins**. Détacher se fait en un clic, sans confirmation, et ne concerne que cette conversation : l’application reste ouverte, sa partie reste installée et les autres conversations gardent leur rattachement.

L’installation depuis le catalogue, l’installation ou la mise à jour de la partie dans l’application et le retrait demandent une confirmation. **Annuler** reçoit d’abord le focus ; l’action de confirmation devient disponible après 600 ms. L’activation, les mises à jour de plugins, le rattachement et le détachement s’exécutent directement.

Retirer un plugin ouvre un avertissement nommant le plugin et sa portée exacte. **Annuler** reçoit le focus ; **Retirer de Global/Projet** devient disponible après 600 ms et exige une action explicite. Le retrait peut interrompre la disponibilité et les connexions des conversations utilisant le plugin ; Global peut aussi affecter d’autres projets. Seules la déclaration confirmée et les règles d’activation décrites plus haut sont retirées : cache, fichiers d’application et indications d’attachement sont conservés. Une configuration modifiée exige une nouvelle sélection et confirmation.

## Installer ou mettre à jour l’intégration de l’application {#application-installation}

Dans **Statut → Plugins**, choisissez **Installer dans Blender** ou **Mettre à jour Blender** sur la ligne d’état de l’intégration quand son état à jour propose l’action, ou **Installer dans l'application…**, **Mettre à jour l'application…** ou **Réinstaller dans l'application…** dans son menu **…**. Réinstaller réécrit la partie dans l’application, qu’elle soit ouverte ou fermée. L’action est disponible sans conversation ni document ouvert.

La confirmation indique l’application et la **version du paquet d’intégration** qui fournit l’installateur. Vérifiez ces informations et l’avertissement sur la machine : l’installation a lieu sur la machine où tourne OpenCode, qui peut être distante. **Annuler** reçoit le focus initial. Confirmez explicitement pour continuer.

WSL refuse toujours l’installation dans l’application, même si une application ouverte semble compatible. Ouvrez l’application sur une machine compatible.

Après une installation ou une mise à jour, ouvrez l’application et vérifiez son intégration.

Si une erreur rend le résultat incertain, ne répétez jamais cette requête : examinez d’abord l’application, puis lancez une nouvelle action avec confirmation si nécessaire.
