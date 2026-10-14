# Installer CodeNomad

Choisissez un hôte de bureau local ou lancez le [serveur autonome](server.md). Dans les deux cas, OpenCode possède le service natif partagé et l’historique.

## Téléchargements pour ordinateur {#desktop-downloads}

1. Ouvrez [la dernière version](https://github.com/NeuralNomadsAI/CodeNomad/releases/latest).
2. Choisissez la distribution correspondant à votre système d’exploitation et à votre processeur.
3. Extrayez le ZIP ou installez/exécutez le paquet de la plateforme, puis lancez CodeNomad.

| Plateforme | Version Electron | Version Tauri | Notes de plateforme |
| --- | --- | --- | --- |
| macOS | ZIP, Intel ou Apple Silicon | ZIP, Intel ou Apple Silicon | macOS 13.5 ou ultérieur requis par l’environnement d’exécution fourni. |
| Windows | ZIP, x64 | Installateur, x64 | Windows 10 ou ultérieur ; Tauri utilise WebView2. |
| Linux | Paquet Debian, x64 | AppImage, x64 | Compilé et testé sur Ubuntu 24.04 ; la compatibilité avec des distributions plus anciennes n’est pas garantie. |

Les versions de bureau incluent les ressources d’exécution nécessaires au backend et à l’installateur OpenCode ; aucune installation séparée de Node.js/npm n’est donc nécessaire. Git n’est pas fourni. L’automatisation native du navigateur est prise en charge dans Electron et Tauri Windows ; les autres plateformes Tauri utilisent des aperçus iframe.

Pour un téléchargement vérifié bloqué au lancement, consultez le [dépannage de plateforme](troubleshooting.md#desktop-launch). N’exécutez jamais une archive non fiable simplement pour contourner un avertissement.

## Installer sous Linux {#linux-install}

Depuis le dossier contenant la version téléchargée, remplacez la version et le nom de fichier par leurs valeurs réelles :

```sh
sudo apt install ./CodeNomad-Electron-linux-x64-<version>.deb
```

Pour l’AppImage Tauri :

```sh
chmod +x CodeNomad-Tauri-linux-x64-<version>.AppImage
./CodeNomad-Tauri-linux-x64-<version>.AppImage
```

Si FUSE est indisponible, utilisez le mode extraction et exécution de l’AppImage :

```sh
./CodeNomad-Tauri-linux-x64-<version>.AppImage --appimage-extract-and-run
```

L’installation Debian d’Electron configure le bac à sable Chromium. Ne désactivez pas le bac à sable pour contourner un problème d’installation. Les problèmes graphiques de Tauri Linux disposent d’un [contournement WebKit ciblé](troubleshooting.md#desktop-launch).

## Prérequis {#requirements}

| Prérequis | Où il doit être disponible | Exigence actuelle |
| --- | --- | --- |
| CLI OpenCode | Hôte d’exécution sélectionné, y compris la distribution WSL choisie le cas échéant | Minimum **2.0.27** ; **2.0.29** est la cible recommandée/qualifiée. Les versions plus récentes ou personnalisées passent une validation des contrats plutôt qu’une interdiction des versions non testées. |
| Git | `PATH` du compte du backend CodeNomad | Requis pour l’identité des dépôts, les opérations Git et les worktrees. |
| Node.js/npm | Hôte du serveur autonome et de compilation depuis les sources | Node.js 24 LTS ; les compilations reproductibles utilisent `.node-version` (**24.20.0**). Fourni avec les ressources d’exécution/d’installation de bureau. |
| Dossier de travail | Disque accessible au backend | Dossier physique explicitement ouvert, pas un dossier local à l’appareil déduit par un navigateur distant. |

Sous Windows, installez [Git for Windows](https://gitforwindows.org/) avec l’accès en ligne de commande/par les logiciels tiers activé. Une installation par utilisateur, modifiable par celui-ci, suffit. Sous macOS/Linux, suivez les [instructions Git pour votre plateforme](https://git-scm.com/downloads).

Après modification de `PATH`, quittez complètement puis relancez l’application de bureau, ou redémarrez le backend autonome sous le compte voulu. Recharger un navigateur ne met pas à jour l’environnement du backend. Un Git disponible uniquement dans WSL ne satisfait pas le besoin Git d’un backend Windows.

Sans Git, vous pouvez toujours ouvrir un dossier physique et utiliser des conversations limitées à ce répertoire, notamment pour demander de l’aide d’installation à l’agent. Les opérations de dépôt/worktree restent indisponibles ; l’accès aux sessions se limite à ce dossier exact. CodeNomad informe l’agent de la disponibilité de Git côté backend avant les prompts/commandes personnalisées et retire cet avis après rétablissement. L’hôte d’exécution de l’agent peut différer de celui du backend : installez donc Git pour le backend, pas seulement pour le shell de l’agent.

## Sélectionner OpenCode au premier lancement {#first-launch}

1. Pendant la configuration, choisissez un exécutable existant compatible ou utilisez l’action d’installation OpenCode proposée.
2. Vérifiez l’état de l’environnement d’exécution avant d’ouvrir un projet.
3. Revenez à **Préférences → OpenCode** pour gérer séparément l’exécutable, l’installation et le service partagé.

CodeNomad privilégie les exécutables compatibles dans `PATH` et accepte un exécutable explicitement sélectionné. Installer/mettre à jour une CLI ne redémarre pas silencieusement un service partagé déjà lancé. Consultez la [configuration d’OpenCode](opencode.md) pour les conséquences d’un redémarrage/rechargement, WSL et l’environnement des sessions.

## Utiliser plutôt un navigateur {#browser-install}

Installez Node.js/npm, Git et OpenCode sur l’hôte du serveur, puis suivez les [procédures de lancement du serveur](server.md). Connectez-vous à l’adresse affichée avec l’authentification configurée et un certificat de confiance. Un navigateur/une PWA nécessite un backend actif ; ce n’est pas une copie hors ligne de vos projets.

Pour les ports, les adresses d’écoute et TLS, consultez l’[accès direct](remote-access.md). Pour appairer un appareil sans ouvrir de ports entrants, utilisez le [Contrôle à distance](remote-control.md). Pour les commandes de développement et de création des paquets, consultez la [compilation depuis les sources](support.md#build-from-source).
