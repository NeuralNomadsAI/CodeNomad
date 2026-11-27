# Dépannage

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

Si un worktree détenu ou l’emplacement d’une conversation ne peut être vérifié, ouvrez explicitement son dossier physique au lieu d’essayer des chemins arbitraires ou modifier le stockage natif. Retirer de force un worktree peut détruire des fichiers non validés ; ne l’utilisez pas comme réparation de connexion.

## Environnement OpenCode et WSL {#opencode-runtime}

Dans le dialogue d’erreur de lancement, choisissez **Ouvrir les paramètres OpenCode** pour vérifier l’exécutable et la version ; pour les variables d’environnement personnalisées, passez à **Avancé → Variables d'environnement**.

1. Ouvrez **Préférences → OpenCode** et vérifiez la carte **Version d’OpenCode** (version installée et état du service actif), puis l’exécutable sélectionné sous **Binaire OpenCode**.
2. Utilisez l’action d’installation/mise à jour prise en charge si l’environnement requis manque. Minimum actuel : **2.4.0** ; version recommandée/qualifiée : **2.4.1**.
3. Si la CLI installée diffère du service actif, décidez explicitement s’il faut redémarrer le service partagé.

**Redémarrer le service OpenCode** est disponible sous **Dépannage** et exige confirmation. Cela interrompt le travail actif de tous les clients connectés mais conserve l’historique. Le rechargement de configuration est distinct : il garde le processus mais reconstruit les Locations chargées et annule les questions/autorisations en attente. Aucun n’est une actualisation anodine.

Pour un exécutable WSL, confirmez la distribution voulue et le transfert localhost Windows. Le cycle de vie du service s’exécute dans Linux ; CodeNomad doit encore atteindre son point d’accès de boucle locale depuis Windows. Ne modifiez jamais l’enregistrement/la base du service et n’envoyez pas de signaux depuis Windows à des PID Linux supposés.

## Connexion, TLS et connectivité directe {#login-and-tls}

| Symptôme | Vérification et récupération sûres |
| --- | --- |
| **Se reconnecter à CodeNomad** | Gardez la page ouverte, saisissez le nom d’utilisateur/mot de passe serveur et sélectionnez **Se connecter**. La récupération reconnecte sur place pour conserver les brouillons ; elle ne rejoue pas l’action échouée. |
| Serveur inaccessible | Vérifiez que le backend tourne et utilisez l’adresse affichée/le port réel. |
| Erreur de nom/confiance du certificat | Vérifiez le nom d’hôte/l’IP réel face aux SAN et installez la confiance d’AC voulue ou un certificat serveur valide. Ne désactivez pas la vérification TLS. |
| Connexion directe refusée | Vérifiez les écoutes HTTP/HTTPS effectives, le pare-feu et le routage. |

Les mots de passe d’exécution doivent être fournis à chaque démarrage backend ; un mot de passe enregistré par les paramètres persiste. Voir [Sécurité](security.md), [Règles TLS/d’écoute](remote-access.md) et [Référence serveur](server.md).

## Appairage du Contrôle à distance {#pairing}

1. Sur l’hôte, ouvrez **Paramètres → Accès distant** et vérifiez que le Contrôle à distance est actif.
2. Créez un lien d’appairage récent et ouvrez-le sur l’appareil voulu avant expiration.
3. Si le client affiche **Appairer à nouveau cet appareil**, appairez depuis l’hôte puis sélectionnez **Vérifier la connexion** sur le client.

Les liens d’appairage sont à usage unique et de courte durée ; le mot de passe d’accès direct ne les remplace pas. Les identifiants d’appareil révoqués ou expirés par inactivité nécessitent un réappairage. Fermer la dernière fenêtre de bureau arrête son backend et donc le Contrôle à distance ; un service activé reprend au prochain lancement de l’application. Voir [Contrôle à distance](remote-control.md) pour les surfaces réservées à l’hôte indisponibles et la révocation.

## État des fournisseurs, plugins et extensions {#providers-and-addons}

- Un plugin ajouté a échoué ou affiche **Non confirmé** — Vérifiez le nom du paquet, sa version et l’accès au registre depuis l’hôte OpenCode. Cherchez dans le journal d’OpenCode la référence d’erreur de l’infobulle du plugin. **Non confirmé** apparaît aussi pour un plugin désactivé.
- Extension installée manquante — Activez-la dans la personnalisation du panneau. Installation/remplacement la laisse désactivée jusqu’à votre activation explicite et approbation du consentement requis.
- **Timeline complète indisponible** — Lisez l’erreur de chargement de `codenomad-session-pruning` dans le journal OpenCode.

Voir [Fournisseurs](providers.md), [Intégrations](integrations.md) et [Extensions](extensions.md).

## Historique, demandes en attente et nettoyage {#history-and-requests}

La recherche dans tout l’historique ne se limite pas aux lignes de transcription chargées. Un filtre d’affichage masque sans supprimer ; utilisez [Historique](history.md) pour distinguer recherche, compactage, nettoyage technique et suppression.

Pour un nettoyage annulé ou partiel, lisez sa progression/ses reçus avant une autre suppression. Annuler ne défait pas un lot déjà envoyé. Ne réparez pas l’historique en modifiant la base native.

## Journaux et diagnostics sûrs {#diagnostics}

1. Ouvrez **Paramètres → OpenCode → Afficher les journaux OpenCode**. Le fichier global `opencode.log` de l’hôte d’exécution sélectionné est localisé par `opencode debug paths log`. Elle affiche au maximum les derniers 128 Kio ; **Actualiser** relit le fichier.
2. Dans **Préférences → OpenCode**, choisissez la **Verbosite des logs** voulue seulement si davantage de détail est nécessaire. Pour les journaux CodeNomad autonome, utilisez les [options CLI serveur de journalisation](server.md). Le serveur CodeNomad tient aussi son propre journal dans `logs/server.log`, à côté de son fichier de configuration (`~/.config/codenomad` par défaut) ; le fichier plein précédent est `server.previous.log`.
3. Ouvrez **Paramètres → Info → Diagnostics** et utilisez **Signaler un bug**, **Copier dans le presse-papiers** ou **Télécharger .txt**.

Les détails de journalisation peuvent exposer chemins, sorties et données applicatives. Masquez identifiants, liens d’appairage, adresses réseau, chemins privés et contenu des conversations avant de partager journaux/captures. Le rapport complet inclut chemins/adresses ; le formulaire de bug prérempli les exclut volontairement. Voir [Signaler un bug](support.md#report-a-bug).
