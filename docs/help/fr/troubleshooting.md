# Dépannage

Pour récupérer, vérifiez d’abord le propriétaire de l’opération défaillante : navigateur, backend CodeNomad, service OpenCode ou fournisseur. Une réponse perdue ne prouve pas l’échec d’une modification ; relisez l’état actuel avant de la répéter.

## Problèmes de lancement sur ordinateur {#desktop-launch}

### Quarantaine macOS {#macos-quarantine}

Les versions macOS de CodeNomad ne sont pas notarisées par Apple : macOS peut donc bloquer le premier lancement d’une copie téléchargée, même vérifiée depuis le dépôt officiel, en affichant **"CodeNomad" Not Opened** (Apple n’a pas pu vérifier l’absence de logiciel malveillant) ou en indiquant que l’application est endommagée.

1. Vérifiez l’origine du téléchargement et le chemin de l’application installée.
2. Si l’application est installée au chemin suivant, retirez son attribut de quarantaine :

```sh
xattr -dr com.apple.quarantine /Applications/CodeNomad.app
```

3. Relancez. Pour le message **Not Opened**, vous pouvez aussi, après le lancement bloqué, choisir **Open Anyway** pour CodeNomad dans **System Settings → Privacy & Security**, puis confirmer avec votre mot de passe administrateur.

Cela change l’attribut de quarantaine macOS de cette application. Cela ne répare pas un téléchargement corrompu et ne rend pas fiable un binaire inconnu.

### Graphismes Linux et FUSE {#linux-graphics}

Une AppImage Tauri qui quitte immédiatement sous Wayland/NVIDIA peut être affectée par le moteur DMA-BUF/GBM de WebKitGTK. Lancez l’AppImage téléchargée avec le remplacement d’environnement ciblé :

```sh
WEBKIT_DISABLE_DMABUF_RENDERER=1 ./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Electron utilise Chromium et offre une alternative sur le même hôte. Si l’AppImage ne peut plutôt pas être montée faute de FUSE, utilisez `--appimage-extract-and-run` ; voir [Installation Linux](install.md#linux-install). Ces corrections n’exigent pas de désactiver le bac à sable Electron.

## Git et disponibilité des espaces de travail {#git-and-workspaces}

1. Vérifiez Git dans le `PATH` du compte backend, pas seulement dans le shell de l’agent.
2. Installez Git sur cet hôte/compte s’il manque, puis redémarrez le backend CodeNomad pour hériter de l’environnement mis à jour.
3. Rouvrez/actualisez l’espace de travail et vérifiez l’état du dépôt.

Les conversations limitées au répertoire restent disponibles sans Git ; pas les commandes Git et worktree. Sous Windows, Git installé seulement dans WSL ne suffit pas au backend Windows. Un dossier connu sans dépôt peut exposer **Initialiser Git** ; un exécutable Git manquant est un autre cas et doit être corrigé d’abord. Voir [Prérequis](install.md#requirements) et [Fichiers](files.md).

Si un worktree détenu ou l’emplacement d’une conversation ne peut être vérifié, ouvrez explicitement son dossier physique au lieu d’essayer des chemins arbitraires ou modifier le stockage natif. Actualisez après un déplacement/une suppression incertain pour voir l’emplacement réel. Retirer de force un worktree peut détruire des fichiers non validés ; ne l’utilisez pas comme réparation de connexion.

## Environnement OpenCode et WSL {#opencode-runtime}

1. Ouvrez **Préférences → OpenCode** et vérifiez la carte **Version d’OpenCode** (version installée et état du service actif), puis l’exécutable sélectionné sous **Binaire OpenCode**.
2. Utilisez l’action d’installation/mise à jour prise en charge si l’environnement requis manque. Minimum actuel : **2.1.2** ; recommandé/qualifié : **2.1.4**.
3. Si la CLI installée diffère du service actif, décidez explicitement s’il faut redémarrer le service partagé.

**Redémarrer le service OpenCode** est disponible sous **Dépannage** et exige confirmation. Cela interrompt le travail actif de tous les clients connectés mais conserve l’historique. Le rechargement de configuration est distinct : il garde le processus mais reconstruit les Locations chargées et annule les questions/autorisations en attente. Aucun n’est une actualisation anodine.

Pour un exécutable WSL, confirmez la distribution voulue et le transfert localhost Windows. Le cycle de vie du service s’exécute dans Linux ; CodeNomad doit encore atteindre son point d’accès de boucle locale depuis Windows. Ne modifiez jamais l’enregistrement/la base du service et n’envoyez pas de signaux depuis Windows à des PID Linux supposés.

Une version personnalisée/plus récente peut être non vérifiée sans être incompatible. Lisez l’erreur réelle de contrat avant de changer de version. Si la synchronisation de l’environnement de session échoue, corrigez l’environnement/la connexion de l’hôte d’exécution : CodeNomad n’enverra pas de prompt sans cette synchronisation. Voir [OpenCode](opencode.md).

## Connexion, TLS et connectivité directe {#login-and-tls}

| Symptôme | Vérification et récupération sûres |
| --- | --- |
| **Se reconnecter à CodeNomad** | Gardez la page ouverte, saisissez le nom d’utilisateur/mot de passe serveur et sélectionnez **Se connecter**. La récupération reconnecte sur place pour conserver les brouillons ; elle ne rejoue pas l’action échouée. |
| Serveur inaccessible | Vérifiez que le backend tourne et utilisez l’adresse affichée/le port réel. Un contrôle d’inaccessibilité seul ne prouve pas l’expiration de connexion. |
| Le fournisseur refuse l’authentification | Réparez sa connexion via son propriétaire ; ne changez pas le mot de passe serveur CodeNomad pour réparer OAuth fournisseur. |
| Erreur de nom/confiance du certificat | Vérifiez le nom d’hôte/l’IP réel face aux SAN et installez la confiance d’AC voulue ou un certificat serveur valide. Ne désactivez pas la vérification TLS. |
| Connexion directe refusée | Vérifiez les écoutes HTTP/HTTPS effectives, le pare-feu et le routage. HTTP en mode bureau ou double écoute reste en boucle locale ; HTTP seul autonome suit d’autres règles. |

Après récupération de l’authentification, inspectez l’état avant de réessayer manuellement une modification au résultat incertain. Les mots de passe d’exécution doivent être fournis à chaque démarrage backend ; un mot de passe enregistré par les paramètres persiste. Voir [Sécurité](security.md), [Règles TLS/d’écoute](remote-access.md) et [Référence serveur](server.md).

## Appairage du Contrôle à distance {#pairing}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant** et vérifiez que le Contrôle à distance est actif.
2. Créez un lien d’appairage récent et ouvrez-le sur l’appareil voulu avant expiration.
3. Si le client affiche **Appairer à nouveau cet appareil**, appairez depuis l’hôte puis sélectionnez **Vérifier la connexion** sur le client.

Les liens d’appairage sont à usage unique et de courte durée ; le mot de passe d’accès direct ne les remplace pas. Les identifiants d’appareil révoqués ou expirés par inactivité nécessitent un réappairage. Fermer la dernière fenêtre de bureau arrête son backend et donc le Contrôle à distance ; un service activé reprend au prochain lancement de l’application. Voir [Contrôle à distance](remote-control.md) pour les surfaces réservées à l’hôte indisponibles et la révocation.

## État des fournisseurs, plugins et extensions {#providers-and-addons}

| Problème | Récupération |
| --- | --- |
| Mauvais compte/quota fournisseur | Vérifiez le compte natif sélectionné et **Utilisation**. Un quota affiché n’est pas un total de tokens/coût. Actualisez après un changement de compte incertain ; la sélection peut affecter d’autres clients du service. |
| OAuth externe expiré | Reconnectez-vous via OpenCode, Claude Code ou le propriétaire d’identifiants concerné. CodeNomad n’échange pas leurs jetons de rafraîchissement. |
| La rotation automatique ne bascule pas | Vérifiez l’activation volontaire, l’admissibilité et si le compte actuel est réellement saturé. C’est une politique avant admission, pas un basculement en cours de requête ni un rejeu de prompt. |
| État de plugin apparemment périmé | Utilisez **Actualiser les contrôles des plugins** et inspectez la portée/cible dans l’infobulle ; l’activation réelle peut attendre une actualisation native. Ne basculez pas à répétition une écriture incertaine. |
| **Le centre de mission est indisponible** | Suivez la cause indiquée. Si OpenCode n’a pas chargé le plugin Missions, actualisez, puis utilisez **Recharger la configuration OpenCode** si cela persiste ; si le plugin n’a pas pu se charger, lisez son erreur dans la liste des plugins ; si le serveur n’a pas pu ouvrir sa connexion locale pour les Missions, consultez le journal du serveur, car recharger OpenCode n’y changera rien. Les Missions fonctionnent aussi sur le serveur autonome. |
| Extension installée manquante | Vérifiez sa case d’activation unique dans la personnalisation. Installation/remplacement la laisse désactivée jusqu’à votre activation explicite et approbation du consentement requis. |
| Ressources d’extension refusées | Confirmez le consentement API 2 de lecture des ressources pour la session montée actuelle. Installer une extension n’autorise pas la lecture arbitraire de fichiers/historique. |

Voir [Fournisseurs](providers.md), [Intégrations](integrations.md) et [Extensions](extensions.md).

## Historique, demandes en attente et nettoyage {#history-and-requests}

La recherche dans tout l’historique ne se limite pas aux lignes de transcription chargées. Un filtre d’affichage masque sans supprimer ; utilisez [Historique](history.md) pour distinguer recherche, compactage, nettoyage technique et suppression.

Si la récupération des demandes est incomplète, CodeNomad conserve les files connues et brouillons de réponse au lieu de traiter une couverture manquante comme une file vide. Après deux récupérations incomplètes consécutives, il avertit une fois, en nommant le projet, la cause, les dossiers et les sessions concernés ; l’avertissement relève de la catégorie de notifications **Projets et onglets** (à l’écran et dans l’historique par défaut, voir **Paramètres → Notifications**). Les échecs transitoires sont réessayés par le contrôle de présence. Un report lié au compactage ne signifie pas que la demande a été annulée. Laissez le brouillon intact, vérifiez la connexion au service et consultez l’état actuel avant de répondre à nouveau.

Pour un nettoyage annulé ou partiel, lisez sa progression/ses reçus avant une autre suppression. Annuler ne défait pas un lot déjà envoyé. Ne réparez pas l’historique en modifiant la base native. Pour une Mission incertaine, utilisez **Vérifier l’état**/la récupération par actualisation plutôt que de créer une autre exécution ou rejouer automatiquement le travail ; [Missions](missions.md) explique les limites de redémarrage et durée de vie.

## Journaux et diagnostics sûrs {#diagnostics}

1. Ouvrez **Infos de l'instance** pour inspecter son état ; **Afficher les journaux du serveur** expose la sortie disponible.
2. Dans **Préférences → OpenCode**, choisissez la **Verbosite des logs** voulue seulement si davantage de détail est nécessaire. Pour les journaux CodeNomad autonome, utilisez les [options CLI serveur de journalisation](server.md).
3. Ouvrez **Paramètres → Info → Diagnostics** et utilisez **Signaler un bug**, **Copier dans le presse-papiers** ou **Télécharger .txt**.

Les détails de journalisation peuvent exposer chemins, sorties et données applicatives. Masquez identifiants, liens d’appairage, adresses réseau, chemins privés et contenu des conversations avant de partager journaux/captures. Le rapport complet inclut chemins/adresses ; le formulaire de bug prérempli les exclut volontairement. Voir [Assistance](support.md#report-a-bug).
