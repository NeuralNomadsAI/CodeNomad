# Intégrations natives

CodeNomad expose les connexions MCP natives, l’activation des plugins, les compétences et commandes personnalisées d’OpenCode. Elles s’exécutent sur l’hôte d’exécution. Elles sont distinctes des [Extensions de panneau](extensions.md) en bac à sable et des [SideCars](browser-sidecars.md).

## Choisir la bonne commande {#integration-scopes}

| Intégration | Où agir | Ce que la commande change |
| --- | --- | --- |
| Serveur MCP | **Statut → Serveurs MCP** | Connexion native à la Location affichée ; n’installe pas de serveur. |
| Plugin natif | **Statut → Plugins** | Règle d’activation persistante **Global** ou **Projet** ; n’installe/met à jour/retire pas le paquet. |
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

1. Installez/déclarez le plugin natif avec OpenCode ; puis ouvrez **Statut → Plugins**.
2. Survolez ou focalisez son nom pour inspecter source, échec d’exécution et détails de cible de configuration.
3. Basculez délibérément **Global** ou **Projet**. Attendez l’écriture et utilisez **Actualiser les contrôles des plugins** si l’état est incertain.

Global cible la configuration globale découverte du démon connecté. Projet cible la configuration dans la Location active, pas un fichier ancêtre hérité. Une règle Projet ultérieure peut remplacer Global ; le commutateur Global montre toujours la règle Global, sans prétendre être l’état Projet final. Sans règle Projet, Projet hérite de l’état Global résolu.

Ces commutateurs ajoutent des règles d’activation exactes en préservant les déclarations de sources et la configuration sans rapport. Ils ne modifient pas les options des plugins, n’installent pas de paquets et ne retirent pas de fichiers. Les plugins intégrés d’OpenCode ne sont pas proposés comme commutateurs utilisateur. Projet est désactivé si sa cible ne peut pas être séparée de Global sans risque ou sort de la Location active.

La surface conserve son dernier instantané quand elle est masquée et le revalide à l’affichage, aux changements natifs/reconnexions et à l’actualisation explicite. Une règle enregistrée et la disponibilité réelle peuvent brièvement différer. Si un plugin reste indisponible, inspectez son infobulle et sa configuration native avant **Recharger la configuration OpenCode** ; cette action affecte toutes les Locations chargées, pas seulement ce plugin. Une configuration mal formée ou une modification concurrente n’est pas écrasée silencieusement : résolvez-la, actualisez et réessayez explicitement.

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
