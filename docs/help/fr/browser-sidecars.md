# Aperçus navigateur et SideCars

## Ouvrir un navigateur de session {#session-browser}

1. Dans la barre d’outils d’une conversation, ouvrez son aperçu web/navigateur.
2. Saisissez une URL `http://` ou `https://` sans identifiants. Utilisez la barre d’outils pour naviguer, actualiser et aller en arrière/en avant.
3. Utilisez le bouton de fermeture de l’aperçu pour revenir au chat. Rouvrez-le dans cette conversation pour poursuivre.

Chaque aperçu appartient à son dossier de projet et sa session. Changer de conversation, projet, Info ou chat masque un invité natif explicitement ouvert sans abandonner son document/historique actif. Les invités masqués ne sont pas des cibles d’automatisation. Fermer le projet/la fenêtre ou redémarrer le moteur de rendu termine le document actif.

L’historique enregistré se restaure seulement à la réouverture explicite du navigateur de cette session, pas au démarrage/à la sélection de session. Il stocke des URL et un curseur, pas les formulaires non envoyés, le DOM, les corps POST ou la mémoire JavaScript. L’historique est borné à 32 URL par session et à un budget de disposition partagé ; les anciennes entrées peuvent être retirées. Restaurer une URL peut recharger la page ; ce n’est pas un rejeu de transaction.

## Connexions partagées et limites d’automatisation {#signins-automation}

Les aperçus natifs partagent cookies, connexions et stockage de site entre projets/sessions dans le même moteur de bureau et périmètre profil/configuration, séparément du moteur de rendu de confiance CodeNomad. Se déconnecter d’un site dans un aperçu affecte les autres qui utilisent ce stockage. Documents, formulaires, stockage de session, historiques de navigation et rattachements d’automatisation restent propres à la session. Les aperçus iframe ne sont pas un profil de navigateur natif partagé complet.

| Client | Implémentation de l’aperçu | Automatisation navigateur par agent | Modèles mobiles |
| --- | --- | --- | --- |
| Electron sur les plateformes de bureau prises en charge | Invité Chromium natif | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri Windows | Enfant WebView2 natif | Prise en charge pour l’aperçu de session détenu visible | Émulation d’identité Android/Chromium, tactile et densité |
| Tauri macOS/Linux | Iframe en bac à sable | Pas d’automatisation navigateur native | Dimensions seules |
| Navigateur ordinaire/vue distante | Iframe de repli | Aucune cible locale d’aperçu natif | Dimensions seules |

Il n’y a pas de commutateur Mode développeur ni de redémarrage d’activation supplémentaire. L’automatisation native est préparée au démarrage du bureau et utilise l’outil `codenomad.browser` lié à la session pour ouvrir, naviguer, capturer l’état, cliquer, saisir et prendre une capture. La disponibilité d’un outil n’autorise pas toutes les fenêtres : l’exécution vérifie le backend propriétaire, les capacités natives, la session et la cible visible. Le contenu des pages reste non fiable. Une iframe peut échouer si la cible interdit l’intégration ; utilisez un navigateur externe plutôt que d’affaiblir ses protections.

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
4. Choisissez **Ajouter un SideCar**, puis **Ouvrir SideCar** depuis l’accueil ou le lanceur de nouvelle instance pour ouvrir son onglet.

| Choix | Effet exact |
| --- | --- |
| HTTPS (défaut du formulaire) | CodeNomad se connecte à l’amont via `https://127.0.0.1:<port>`. |
| HTTP | CodeNomad se connecte à l’amont via `http://127.0.0.1:<port>`. Cela ne change pas le TLS de la connexion publique CodeNomad. |
| Retirer le préfixe (défaut) | `/sidecars/<id>/path` est transmis à l’amont comme `/path`. |
| Conserver le préfixe | `/sidecars/<id>/path` est transmis à l’amont inchangé. Configurez le chemin de base du service pour correspondre. |

L’enregistrement est une configuration serveur partagée par ses clients ; il n’installe ni ne démarre le service. Le port est sur l’hôte du backend, pas votre portable ou téléphone. **En cours d'exécution** indique l’accessibilité, pas le bon état de l’application/authentification de l’outil. Retirer l’enregistrement n’arrête pas le processus lancé séparément. Fermer son onglet ne l’arrête pas non plus.

Si le service est inaccessible, vérifiez le processus et le port sur le backend. Si HTML charge mais pas les ressources/WebSockets, vérifiez le chemin de base et le mode de préfixe. Recréez un enregistrement erroné avec les paramètres voulus ; n’exposez pas l’amont publiquement pour contourner une erreur de proxy. Les applications SideCar peuvent exposer un terminal ou des fichiers avec l’autorité du compte serveur ; faites confiance à leurs utilisateurs et configuration. Le Contrôle à distance n’expose pas le trafic proxy des applications SideCar ; utilisez le chemin direct approprié décrit dans [Accès distant](remote-access.md) et [Contrôle à distance](remote-control.md).

## Recette OpenVSCode Server {#openvscode}

1. Sur l’hôte backend, lancez Docker avec le service lié à la boucle locale :

```sh
docker run -it --init -p 127.0.0.1:8000:3000 -v "${HOME}:${HOME}:cached" -e HOME=${HOME} gitpod/openvscode-server --server-base-path /sidecars/vscode
```

2. Enregistrez **Nom** `VSCode`, **Port** `8000`, **Protocole** `HTTP`, **Mode de préfixe** `Preserve prefix`.
3. Vérifiez que le chemin de base affiché est `/sidecars/vscode`, puis ouvrez le SideCar.

Cette recette shell monte votre dossier personnel dans le conteneur ; utilisez un montage plus restreint si l’éditeur ne doit accéder qu’à cela. Le `--server-base-path` du service doit correspondre exactement à l’enregistrement. Arrêtez le conteneur séparément une fois terminé ; supprimer le SideCar ne le retire pas, ni ses fichiers.

## Recette de terminal ttyd {#ttyd}

1. Sur l’hôte backend, démarrez un terminal shell modifiable lié à la boucle locale :

```sh
ttyd --interface 127.0.0.1 --writable zsh
```

2. Enregistrez **Nom** `Terminal`, **Port** `7681`, **Protocole** `HTTP`, **Mode de préfixe** `Strip prefix`.
3. Ouvrez le SideCar au chemin de base `/sidecars/terminal` affiché.

Le terminal utilise les privilèges du compte qui a démarré ttyd. Choisissez un autre shell si `zsh` est indisponible. Utilisez le port réel si vous avez changé celui par défaut de ttyd, et arrêtez ttyd séparément une fois terminé. Authentifiez et protégez l’accès à CodeNomad ; un terminal modifiable n’est pas un bac à sable.
