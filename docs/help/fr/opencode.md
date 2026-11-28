# Configuration d’OpenCode

## Sélectionner ou installer la CLI {#select-cli}

1. Ouvrez **Paramètres → OpenCode** et utilisez la carte **Binaire OpenCode**, sous **Version d’OpenCode**, pour sélectionner l’exécutable.
2. Laissez l’entrée automatique sélectionnée, ou dépliez **Choisir un autre binaire…** pour utiliser **Parcourir le binaire…**, ou saisir un chemin et choisir **Ajouter**.
3. Utilisez **Vérifier l’état et les mises à jour**. Si OpenCode manque, choisissez **Installer et démarrer OpenCode** ; vérifiez d’abord l’hôte et la portée d’installation.
4. Si la configuration propose **Connecter et continuer**, utilisez-le après résolution du problème signalé.

**Installer pour l’utilisateur et configurer le PATH** change la configuration du terminal de cet utilisateur ; ouvrez ensuite un nouveau terminal. Un navigateur se connecte au serveur CodeNomad : son sélecteur de fichiers et son choix d’exécutable concernent ce serveur, pas l’appareil de navigation.

Lorsqu’un OpenCode plus ancien apparaît en premier dans le PATH, l’action proposée dépend de son mode d’installation. Pour OpenCode 1.x installé avec npm, **Remplacer OpenCode {version} par OpenCode 2** demande une confirmation, retire ce paquet npm et installe OpenCode 2 dans le même dossier npm ; le dossier de données d’OpenCode est conservé, et OpenCode 2 importe lui-même les conversations 1.x. Un OpenCode plus ancien ou inutilisable installé autrement (winget, Homebrew, manuellement) n’est jamais modifié : **Installer OpenCode 2 pour CodeNomad** installe OpenCode 2 dans le dossier npm de l’utilisateur à côté de lui, et CodeNomad utilise ensuite cette copie. Si cette ancienne commande se trouve elle-même dans le dossier npm de l’utilisateur (par exemple un lien dans `~/.local/bin`), ou si ce dossier n’est pas accessible en écriture, la configuration en indique la raison au lieu de proposer l’action : déplacez ou renommez la commande, ou corrigez les droits du dossier, puis choisissez **Vérifier l’état et les mises à jour**. La commande `opencode` d’un terminal peut encore lancer l’ancienne version. Un exécutable personnalisé explicitement sélectionné n’est jamais remplacé.

La carte **Version d’OpenCode** affiche **Service en cours** séparément quand sa version diffère de **Version installée** ou est inconnue. **Détails des versions** indique la version minimale et, si elle diffère, la version recommandée.

## Versions requises, recommandées et non vérifiées {#versions}

| Classification | Exigence actuelle | Signification |
| --- | --- | --- |
| Minimum | OpenCode **2.4.0** | Requis pour cette version de CodeNomad. Les conversations enregistrées par les versions antérieures restent lisibles après la mise à jour. |
| Recommandée | OpenCode **2.4.1** | Pour CodeNomad **1.2.0**. |
| Non vérifiée | Version plus récente ou personnalisée non entièrement validée | Non rejetée simplement parce que non testée ; les contrats API réels du service connecté sont vérifiés. |

## Hôte, WSL et portée du service partagé {#execution-host}

Sous Windows, un exécutable WSL sélectionné s’exécute dans la distribution choisie. Installez/mettez-le à jour là-bas et utilisez des chemins valides dans cette distribution. La connectivité WSL dépend du transfert localhost de Windows. Une CLI Windows et une CLI WSL ne sont pas des environnements d’exécution interchangeables.

Fermer un onglet de projet ferme ce projet dans CodeNomad ; les sessions continuent dans OpenCode et réapparaissent quand vous rouvrez le projet. Fermer une fenêtre entière, quitter ou recharger conserve les connexions de projet pour la restauration ; ni ces actions ni l’arrêt du backend n’arrêtent le démon partagé. Voir [Projets](projects.md).

## Lancer au démarrage {#login-start}

Dans **Paramètres → OpenCode**, **Lancer au démarrage** demande au système de lancer le service OpenCode en arrière-plan quand vous ouvrez votre session, même CodeNomad fermé. Le réglage reste désactivé tant que vous ne l'activez pas, prend effet à la prochaine ouverture de session et concerne votre compte sur l'ordinateur qui exécute le serveur CodeNomad. Il lance l'exécutable choisi dans la carte **Binaire OpenCode** ; choisir un autre exécutable natif le met à jour, sinon il continue de lancer le précédent.

| Système | Ce qui lance OpenCode | Après un plantage |
| --- | --- | --- |
| Windows | Une tâche planifiée masquée pour votre compte, sans mot de passe ni droits administrateur. Un exécutable WSL démarre dans sa distribution. | Pas de relance. |
| macOS | Un LaunchAgent. | Relancé par macOS. |
| Linux | Un service utilisateur systemd démarré à l'ouverture de session, sans activer linger. | Relancé par systemd. |

La désactivation retire seulement cette tâche, ce LaunchAgent ou ce service ; un OpenCode en cours continue de fonctionner. **Indisponible sur ce système** apparaît quand le serveur CodeNomad s'exécute dans WSL ou sur un autre système sans démarrage à l'ouverture de session.

## Mettre à jour, redémarrer ou recharger {#maintenance}

1. Dans **Paramètres → OpenCode**, choisissez **Vérifier l’état et les mises à jour**.
2. Pour remplacer les fichiers CLI installés, choisissez **Mettre à jour vers OpenCode {version}** si proposé. Attendez la fin.
3. Vérifiez l’état du service actif. Utilisez **Redémarrer le service partagé** seulement pour activer volontairement l’installation sélectionnée pour tous les clients connectés.
4. Pour redémarrer le processus sans rien installer, développez **Dépannage** et choisissez **Redémarrer le service OpenCode**, puis confirmez.

| Action | Portée et effet |
| --- | --- |
| Mettre à jour la CLI | Change l’exécutable installé pris en charge ; ne redémarre pas implicitement le démon actif. |
| Redémarrer le service | Remplace le processus partagé et interrompt le travail actif de tous les clients OpenCode connectés ; l’historique reste. |
| Recharger la configuration OpenCode | Conserve le processus. Pour tous les clients connectés, annule les permissions/Forms en attente, ferme terminaux/commandes en arrière-plan et peut interrompre le travail actif. |

Utilisez **Recharger la configuration OpenCode**, sous **Dépannage** lorsque le service actif le prend en charge, lorsqu’une configuration enregistrée ou un plugin installé reste indisponible. Lisez puis confirmez l’avertissement : le rechargement peut interrompre le travail actif de tous les clients connectés. CodeNomad n’utilisera pas une CLI sélectionnée plus ancienne pour rétrograder un démon actif plus récent.

## Environnement de session {#session-environment}

1. Ouvrez **Paramètres → Avancé** et développez **Variables d'environnement**.
2. Ajoutez, modifiez ou retirez des valeurs. Les noms enregistrés sont en lecture seule. Dans Rune, sélectionnez une variable, modifiez sa valeur, puis choisissez **Enregistrer**.
3. Envoyez le prochain prompt, commande personnalisée ou demande shell de session via CodeNomad pour appliquer l’environnement courant à cette conversation.

C’est un réglage de profil de configuration. Simplement ouvrir/lire une conversation ou enregistrer les paramètres ne modifie pas une session native. Retirer un remplacement restaure la valeur héritée de l’hôte d’exécution, ou la supprime si elle y est absente.

L’environnement contrôle les lancements shell locaux suivants de cette session native. Les processus déjà actifs gardent leur environnement. Il ne reconfigure **pas** les fournisseurs, serveurs MCP/LSP, terminaux indépendants ni shells en arrière-plan propres à une Location. Les prompts en file ne capturent pas chacun leur environnement, et un autre client OpenCode peut remplacer celui de la même session. Ne supposez pas que les sessions enfants créées entièrement dans OpenCode reçoivent une mise à jour CodeNomad au moment de l’envoi.

Les variables autorisées sont aussi transmises au démarrage d’un service arrêté ; se connecter à un démon existant ne change pas son environnement de processus. Dans WSL, les valeurs sont combinées avec l’environnement d’exécution Linux, pas le PATH/HOME Windows.

## Modifier les fichiers de configuration natifs {#configuration-files}

1. Ouvrez **Paramètres → Fichiers de configuration** et sélectionnez **Fichier**.
2. Vérifiez le chemin affiché, modifiez, puis choisissez **Enregistrer**.
3. Utilisez **Recharger** pour relire le fichier ; ce n’est pas **Recharger la configuration OpenCode**.

Cet éditeur expose uniquement les fichiers globaux `opencode.json` et `opencode.jsonc` listés dans le répertoire `.config/opencode` de l’**utilisateur du serveur CodeNomad**. Ce n’est ni un éditeur arbitraire de fichiers, ni un sélecteur de configuration Projet, ni une garantie qu’un démon WSL/à découverte personnalisée lit ce fichier. Vérifiez la cible avec le chemin affiché ; utilisez les outils du démon pour les autres racines.

Enregistrer écrit le fichier comme texte ; cela ne valide pas toute la configuration native et ne redémarre/recharge pas OpenCode. Coordonnez vos modifications avec les autres clients : cette interface ne propose pas de fusion des changements externes. Gardez une copie avant de remplacer une configuration importante. Changer de fichier ou recharger un brouillon modifié demande s’il faut l’abandonner.

Consultez [Intégrations](integrations.md), [Fournisseurs](providers.md), [Missions](missions.md) et la [documentation OpenCode](https://opencode.ai/v2/docs/) pour les procédures propres à la configuration.
