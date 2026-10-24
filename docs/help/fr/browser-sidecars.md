# Aperçus navigateur et SideCars

## Ouvrir un navigateur de session {#session-browser}

1. Dans la barre d’outils d’une conversation, choisissez **Ouvrir l'aperçu web**.
2. Saisissez une **URL de l'aperçu** `http://` ou `https://` sans identifiants, puis choisissez **Ouvrir l'aperçu**. Utilisez la barre d’outils pour naviguer, actualiser et aller en arrière/en avant.
3. Utilisez le bouton de fermeture de l’aperçu pour revenir au chat. Rouvrez-le dans cette conversation pour poursuivre.

Cliquer sur un lien `localhost` ou `127.0.0.1` dans une conversation l’ouvre automatiquement dans l’aperçu de cette session, sur tout client : le serveur sert de proxy aux aperçus loopback, ils fonctionnent donc aussi depuis un navigateur simple sur une autre machine. Les aperçus loopback passés par le proxy suivent **Paramètres → Aperçu** ; le mode opaque par défaut les isole de CodeNomad. Les liens externes continuent de s’ouvrir dans un nouvel onglet du navigateur.

Chaque aperçu appartient à son dossier de projet et sa session. Changer de conversation, projet, Info ou chat masque un invité natif explicitement ouvert sans abandonner son document/historique actif. Les invités masqués ne sont pas des cibles d’automatisation. Fermer le projet/la fenêtre ou redémarrer le moteur de rendu termine le document actif.

L’historique enregistré se restaure seulement à la réouverture explicite du navigateur de cette session, pas au démarrage/à la sélection de session. Il stocke des URL et un curseur, pas les formulaires non envoyés, le DOM, les corps POST ou la mémoire JavaScript. L’historique est borné à 32 URL par session et à un budget de disposition partagé ; les anciennes entrées peuvent être retirées. Restaurer une URL peut recharger la page ; ce n’est pas un rejeu de transaction.

## Origines et autorisations des aperçus {#preview-origins}

Les aperçus restent dans la conversation ; CodeNomad n’ouvre pas de fenêtre d’aperçu séparée. **Paramètres → Aperçu** définit une politique pour l’ensemble du serveur CodeNomad. Elle s’applique aux aperçus des vues navigateur et distante. Les aperçus de bureau affichés dans une iframe conservent à la place une origine isolée par jeton ; les vues web natives Electron et Tauri sous Windows conservent leur propre comportement d’autorisation, de téléchargement et de fenêtres surgissantes, et Tauri sous Linux utilise cette iframe et suit ces interrupteurs.

| Mode d’origine | Effet |
| --- | --- |
| Opaque (recommandé) | Aucun aperçu ne partage d’origine avec CodeNomad ou un autre aperçu. Le stockage, les cookies, les service workers et les API de navigateur liées à l’origine sont indisponibles ; certaines applications web peuvent donc ne pas fonctionner. |
| Même origine que CodeNomad | Les aperçus loopback s’exécutent sur l’origine CodeNomad ; les aperçus externes restent opaques. |
| Origine d’aperçu dédiée | Les aperçus loopback s’exécutent sur l’origine que vous configurez ; les aperçus externes restent opaques. |

**Même origine que CodeNomad signifie une confiance totale.** Le code de l’aperçu peut lire et modifier le stockage, la transcription et le DOM de CodeNomad, appeler des API de l’application avec votre session et enregistrer des service workers qui persistent après la fermeture de l’aperçu. Ne l’utilisez que sur un serveur que vous contrôlez et auquel vous faites confiance, jamais sur un serveur partagé ou distant. CodeNomad demande une confirmation avant de l’activer.

Pour **Origine d’aperçu dédiée**, utilisez un nom d’hôte distinct de toutes les origines servant CodeNomad et acheminez `/previews/*`, y compris les mises à niveau WebSocket, vers le même serveur. Conservez l’en-tête `Host`, les en-têtes de réponse et la politique de sécurité du contenu injectée, et servez l’origine en TLS pour les API de contexte sécurisé. CodeNomad ne peut pas vérifier que l’origine est joignable ; une route défaillante fait échouer les aperçus. Les Workers et service workers relatifs à la racine qui contournent l’espace de noms réécrit `/previews/<token>/...` ne sont pas pris en charge sur une origine dédiée. C’est un autre nom d’hôte, et non un autre port, qui sépare les cookies.

Les interrupteurs **Bac à sable** autorisent les formulaires, les boîtes de dialogue modales, les fenêtres surgissantes et les téléchargements dans les aperçus iframe ; les scripts sont toujours requis. Ceux des **Fonctionnalités du navigateur** permettent seulement à un aperçu de demander la caméra, le microphone, la lecture/écriture du presse-papiers, la géolocalisation, les notifications ou le plein écran. Le navigateur demande toujours l’autorisation, et les paramètres de site du navigateur restent l’autorité finale : un interrupteur CodeNomad ne peut pas contourner un blocage du navigateur, et une autorisation du navigateur ne peut pas rétablir une fonctionnalité désactivée. Les vues web natives Electron et Tauri sous Windows ne suivent pas ces interrupteurs iframe.

Modifier le mode d’origine, l’origine dédiée, le bac à sable ou la politique de fonctionnalités recharge un aperçu ouvert, afin qu’un document plus fiable ne reste pas actif après une réduction de confiance.

## Connexions partagées et limites d’automatisation {#signins-automation}

Les aperçus natifs partagent cookies, connexions et stockage de site entre projets/sessions dans le même moteur de bureau et périmètre profil/configuration, séparément du moteur de rendu de confiance CodeNomad. Se déconnecter d’un site dans un aperçu affecte les autres qui utilisent ce stockage. Documents, formulaires, stockage de session, historiques de navigation et rattachements d’automatisation restent propres à la session. Les aperçus iframe ne sont pas un profil de navigateur natif partagé complet.

| Client | Implémentation de l’aperçu | Automatisation navigateur par agent | Modèles mobiles |
| --- | --- | --- | --- |
| Electron sur les plateformes de bureau prises en charge | Invité Chromium natif | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri Windows | Enfant WebView2 natif | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri macOS/Linux | Iframe en bac à sable | Pas d’automatisation navigateur native | Dimensions seules |
| Navigateur ordinaire/vue distante | Iframe de repli | Aucune cible locale d’aperçu natif | Dimensions seules |

L’automatisation native est préparée au démarrage du bureau et utilise l’outil `codenomad.browser` lié à la session pour ouvrir, naviguer, capturer l’état, prendre une capture d’écran et agir sur la page : cliquer, saisir, sélectionner, survoler, glisser, faire défiler, appuyer sur des touches et attendre un texte. La disponibilité d’un outil n’autorise pas toutes les fenêtres : l’exécution vérifie le backend propriétaire, les capacités natives, la session et la cible visible. Une action dont la page a été masquée, remplacée ou a changé d’adresse entre-temps est refusée plutôt qu’envoyée à une autre page, et une action n’est jamais répétée automatiquement. Le contenu des pages reste non fiable. Une iframe peut échouer si la cible interdit l’intégration ; utilisez un navigateur externe plutôt que d’affaiblir ses protections.

## Choisir parmi six modèles de zone d’affichage {#templates}

1. Ouvrez le menu de zone d’affichage de l’aperçu.
2. Sélectionnez un modèle ci-dessous. Utilisez directement les entrées portrait/paysage ; aucune commande de rotation séparée.
3. Attendez-vous à un rechargement natif en entrant/changeant l’émulation mobile ou en revenant à un modèle de dimensions seules.

| Modèle | Zone d’affichage CSS |
| --- | --- |
| Zone adaptative | Espace d’aperçu disponible |
| Zone de bureau | 1440 × 900 |
| Zone de tablette | 768 × 1024 |
| Tablette paysage | 1024 × 768 |
| Zone mobile | 390 × 844 |
| Mobile paysage | 844 × 390 |

Les modèles mobiles natifs définissent identité Android/Chromium, orientation, tactile et DPR 2.75 sur l’invité détenu seulement. Revenir à adaptatif/bureau/tablette efface ces remplacements et recharge. L’iframe de repli change seulement de taille. Ce sont des références de disposition reproductibles, pas une émulation Safari/Firefox ou des simulations de clavier téléphonique, barres navigateur/système ou réglages de texte mobile. Enregistrez le travail de page avant de changer de modèle, car le rechargement peut perdre l’état non envoyé.

## Enregistrer un SideCar {#register-sidecar}

1. Démarrez l’outil web séparément sur l’hôte backend CodeNomad, en écoute sur `127.0.0.1:<port>`.
2. Ouvrez **Paramètres → SideCars**. Saisissez **Nom** et **Port** ; vérifiez le **Chemin de base** dérivé (`/sidecars/<id>`).
3. Réglez **Protocole** selon le service amont et choisissez **Mode de préfixe**.
4. Choisissez **Ajouter un SideCar**, puis **Ouvrir SideCar** depuis l’accueil pour ouvrir son onglet.

| Choix | Effet exact |
| --- | --- |
| HTTPS (défaut du formulaire) | CodeNomad se connecte à l’amont via `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad se connecte à l’amont via `http://127.0.0.1:<port>`. Cela ne change pas le TLS de la connexion publique CodeNomad. |
| Retirer le préfixe (défaut) | `/sidecars/<id>/path` est transmis à l’amont comme `/path`. |
| Conserver le préfixe | `/sidecars/<id>/path` est transmis à l’amont inchangé. Configurez le chemin de base du service pour correspondre. |

L’enregistrement est une configuration serveur partagée par ses clients ; il n’installe ni ne démarre le service. Le port est sur l’hôte du backend, pas votre portable ou téléphone. **En cours d'exécution** indique l’accessibilité, pas le bon état de l’application/authentification de l’outil. Retirer l’enregistrement n’arrête pas le processus lancé séparément. Fermer son onglet ne l’arrête pas non plus.

Si le service est inaccessible, vérifiez le processus et le port sur le backend. Si HTML charge mais pas les ressources/WebSockets, vérifiez le chemin de base et le mode de préfixe. Recréez un enregistrement erroné avec les paramètres voulus ; n’exposez pas l’amont publiquement pour contourner une erreur de proxy. Les applications SideCar peuvent exposer un terminal ou des fichiers avec l’autorité du compte serveur ; faites confiance à leurs utilisateurs et configuration.

Un SideCar est une extension de confiance de CodeNomad, pas un aperçu en bac à sable : sa page s’exécute avec l’origine même de CodeNomad, si bien que ses scripts peuvent utiliser CodeNomad avec votre accès connecté. N’enregistrez que des services dont vous jugez le code fiable. CodeNomad ne transmet pas ses propres cookies de connexion au service, tandis que les cookies propres au service sont conservés. Le Contrôle à distance n’expose pas le trafic proxy des applications SideCar ; utilisez le chemin direct approprié décrit dans [Accès distant](remote-access.md) et [Contrôle à distance](remote-control.md).

## Recette OpenVSCode Server {#openvscode}

1. Sur l’hôte backend, lancez Docker avec le service lié à la boucle locale :

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Enregistrez **Nom** `VSCode`, **Port** `8000`, **Protocole** `HTTP`, **Mode de préfixe** **Conserver le préfixe**.
3. Vérifiez que le chemin de base affiché est `/sidecars/vscode`, puis ouvrez le SideCar.

Cette recette shell monte votre dossier personnel dans le conteneur ; utilisez un montage plus restreint si l’éditeur ne doit accéder qu’à cela. Le `--server-base-path` du service doit correspondre exactement à l’enregistrement. Arrêtez le conteneur séparément une fois terminé ; supprimer le SideCar ne le retire pas, ni ses fichiers.

## Recette de terminal ttyd {#ttyd}

1. Sur l’hôte backend, démarrez un terminal shell modifiable lié à la boucle locale :

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Enregistrez **Nom** `Terminal`, **Port** `7681`, **Protocole** `HTTP`, **Mode de préfixe** **Retirer le préfixe**.
3. Ouvrez le SideCar au chemin de base `/sidecars/terminal` affiché.

Le terminal utilise les privilèges du compte qui a démarré ttyd. Choisissez un autre shell si `zsh` est indisponible. Utilisez le port réel si vous avez changé celui par défaut de ttyd, et arrêtez ttyd séparément une fois terminé. Authentifiez et protégez l’accès à CodeNomad ; un terminal modifiable n’est pas un bac à sable.
