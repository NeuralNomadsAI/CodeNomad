# Configuration d’OpenCode

CodeNomad se connecte à un service OpenCode partagé sur l’hôte d’exécution. Sélectionner une CLI, mettre à jour ses fichiers, redémarrer ce service et recharger la configuration sont des opérations différentes ; aucune ne remplace les autres.

## Sélectionner ou installer la CLI {#select-cli}

1. Ouvrez **Paramètres → OpenCode** et utilisez **Binaire OpenCode** pour sélectionner l’exécutable.
2. Laissez la sélection automatique activée pour privilégier le PATH du serveur, puis son installation npm utilisateur ; ou utilisez **Parcourir le binaire…**, ou saisissez un chemin et choisissez **Ajouter**.
3. Utilisez **Vérifier l’état et les mises à jour**. Si OpenCode manque, choisissez **Installer et démarrer OpenCode** ; vérifiez d’abord l’hôte et la portée d’installation.
4. Si la configuration propose **Connecter et continuer**, utilisez-le après résolution du problème signalé.

L’installation utilise Node/npm fournis pour une installation utilisateur standard partagée avec d’autres clients. **Installer pour l’utilisateur et configurer le PATH** change la configuration du terminal de cet utilisateur ; ouvrez ensuite un nouveau terminal. Un navigateur se connecte au serveur CodeNomad : son sélecteur de fichiers et son choix d’exécutable concernent ce serveur, pas l’appareil de navigation.

L’exécutable installé et le service actif peuvent avoir des versions différentes. Vérifiez **Détails des versions** au lieu de supposer que sélectionner un autre exécutable a remplacé le démon actif. Si l’installation est occupée ou l’exécutable verrouillé, attendez sa libération par l’installateur ou le processus et vérifiez l’état avant de réessayer ; ne lancez pas des installateurs concurrents.

## Versions requises, recommandées et non vérifiées {#versions}

| Classification | Exigence actuelle | Signification |
| --- | --- | --- |
| Minimum | OpenCode **2.1.0** | Format natif de transcription, de rejeu et de compaction requis ; les conversations enregistrées par les versions antérieures restent lisibles après la mise à jour. |
| Recommandée | OpenCode **2.1.1** | Cible qualifiée, distincte du minimum technique. |
| Non vérifiée | Version plus récente ou personnalisée non entièrement validée | Non rejetée simplement parce que non testée ; les contrats API réels du service connecté sont vérifiés. |

Les contrats requis de session, permission, Form, boîte de réception et environnement de session doivent aussi être disponibles. Une version d’exécutable seule ne prouve pas que le service connecté les prend en charge. Si la configuration signale un service actif non pris en charge, sélectionnez/installez une CLI prise en charge et utilisez le redémarrage explicite du service partagé lorsque vous êtes prêt.

## Hôte, WSL et portée du service partagé {#execution-host}

Sous Windows, un exécutable WSL sélectionné s’exécute dans la distribution choisie. Installez/mettez-le à jour là-bas et utilisez des chemins valides dans cette distribution. La connectivité WSL dépend du transfert localhost de Windows. Une CLI Windows et une CLI WSL ne sont pas des environnements d’exécution interchangeables.

OpenCode possède l’enregistrement global de son service, ses sessions, messages et base de données. CodeNomad ne crée pas une base OpenCode privée par fenêtre ou projet. Fermer un onglet/une fenêtre ou arrêter le backend CodeNomad n’arrête pas le démon partagé. Fermer un onglet de projet ferme uniquement le projet dans CodeNomad, sans décharger la Location native. Les sessions continuent dans OpenCode et se retrouvent en rouvrant le projet ; voir [Projets](projects.md).

## Mettre à jour, redémarrer ou recharger {#maintenance}

1. Dans **Paramètres → OpenCode**, choisissez **Vérifier l’état et les mises à jour**.
2. Pour remplacer les fichiers CLI installés, choisissez **Mettre à jour vers OpenCode {version}** si proposé. Attendez la fin.
3. Vérifiez l’état du service actif. Utilisez **Redémarrer le service partagé** seulement pour activer volontairement l’installation sélectionnée pour tous les clients connectés.
4. Pour redémarrer le processus sans rien installer, développez **Dépannage** et choisissez **Redémarrer le service OpenCode**, puis confirmez.

| Action | Portée et effet | Récupération sûre |
| --- | --- | --- |
| Mettre à jour la CLI | Change l’exécutable installé pris en charge ; ne redémarre pas implicitement le démon actif. | Vérifiez les versions installée et active après un échec ; réessayez explicitement après résolution de l’erreur seulement. |
| Redémarrer le service | Remplace le processus partagé et interrompt le travail actif de tous les clients OpenCode connectés ; l’historique reste. | Reconnectez-vous et inspectez conversations et Missions planifiées ; un redémarrage n’est pas une continuation automatique. |
| Recharger la configuration OpenCode | Conserve le processus mais reconstruit **chaque Location chargée** pour tous les clients. Annule les permissions/Forms en attente et ferme terminaux/commandes en arrière-plan ; le travail actif peut être interrompu. | Revérifiez ressources et travaux en attente après rechargement. Ne répétez pas un prompt ou une modification simplement parce que sa réponse a été perdue. |

Utilisez explicitement **Recharger la configuration OpenCode** lorsqu’une configuration enregistrée ou un plugin installé reste indisponible et que l’interruption est acceptable. Ce n’est pas une actualisation d’affichage anodine. CodeNomad n’utilisera pas une CLI sélectionnée plus ancienne pour rétrograder un démon actif plus récent.

## Environnement de session {#session-environment}

1. Ouvrez **Paramètres → Avancé → Variables d'environnement**.
2. Ajoutez, modifiez ou retirez les remplacements du profil.
3. Envoyez le prochain prompt, commande personnalisée ou demande shell de session via CodeNomad pour appliquer l’environnement courant à cette conversation.

C’est un réglage de profil de configuration, appliqué côté serveur avant chaque envoi. Simplement ouvrir/lire une conversation ou enregistrer les paramètres ne modifie pas une session native. Retirer un remplacement restaure la valeur héritée de l’hôte d’exécution, ou la supprime si elle y est absente. Un échec d’application bloque l’envoi au lieu d’utiliser des valeurs périmées.

L’environnement contrôle les lancements shell locaux suivants de cette session native. Les processus déjà actifs gardent leur environnement. Il ne reconfigure **pas** les fournisseurs, serveurs MCP/LSP, terminaux indépendants ni shells en arrière-plan propres à une Location. Les prompts en file ne capturent pas chacun leur environnement, et un autre client OpenCode peut remplacer celui de la même session. Ne supposez pas que les sessions enfants créées entièrement dans OpenCode reçoivent une mise à jour CodeNomad au moment de l’envoi.

Les variables autorisées sont aussi transmises au démarrage d’un service arrêté ; se connecter à un démon existant ne change pas son environnement de processus. Dans WSL, les valeurs sont combinées avec l’environnement d’exécution Linux, pas le PATH/HOME Windows. Changer ces remplacements ne déplace pas la base de données ni l’enregistrement du service OpenCode.

## Modifier les fichiers de configuration natifs {#configuration-files}

1. Ouvrez **Paramètres → Fichiers de configuration** et sélectionnez **Fichier**.
2. Vérifiez le chemin affiché, modifiez, puis choisissez **Enregistrer**.
3. Utilisez **Recharger** pour relire le fichier ; ce n’est pas **Recharger la configuration OpenCode**.

Cet éditeur expose uniquement les fichiers globaux `opencode.json` et `opencode.jsonc` listés dans le répertoire `.config/opencode` de l’**utilisateur du serveur CodeNomad**. Ce n’est ni un éditeur arbitraire de fichiers, ni un sélecteur de configuration Projet, ni une garantie qu’un démon WSL/à découverte personnalisée lit ce fichier. Vérifiez la cible avec le chemin affiché ; utilisez les outils du démon pour les autres racines.

Enregistrer écrit le fichier comme texte ; cela ne valide pas toute la configuration native et ne redémarre/recharge pas OpenCode. Coordonnez vos modifications avec les autres clients : cette interface ne propose pas de fusion des changements externes. Gardez une copie avant de remplacer une configuration importante. Changer de fichier ou recharger un brouillon modifié demande s’il faut l’abandonner.

Consultez [Intégrations](integrations.md), [Fournisseurs](providers.md), [Missions](missions.md) et la [documentation OpenCode](https://opencode.ai/v2/docs/) pour les procédures propres à la configuration.
