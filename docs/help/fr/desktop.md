# Fenêtres de bureau et données

## Fenêtres, onglets et service partagé {#windows-tabs}

1. Utilisez **Nouvelle instance** pour ouvrir un autre onglet projet/accueil dans la fenêtre actuelle.
2. Utilisez le menu natif **Fenêtre → Nouvelle fenêtre** (`Ctrl+Shift+N` ou `Cmd+Shift+N`) pour une fenêtre d’application séparée.
3. Dans **Paramètres → Avancé**, activez **Focaliser la fenêtre existante au second lancement** si un autre lancement doit focaliser la dernière fenêtre utilisée au lieu d’en ouvrir une nouvelle.

Les onglets de projet, conversations sélectionnées et dispositions appartiennent à une fenêtre. Les sessions/messages OpenCode appartiennent au service natif OpenCode partagé : une autre fenêtre peut voir la même conversation. Fermer un onglet de projet ferme ce projet dans CodeNomad, pas ses sessions OpenCode ; rouvrez-le pour les retrouver. Une autre fenêtre qui affiche la même connexion de projet ferme aussi son onglet et affiche une notification ; les onglets ouverts séparément sur le même dossier ne sont pas concernés. Fermer une fenêtre entière, quitter ou recharger conserve les connexions de projet pour la restauration ; voir [Projets](projects.md). Ne considérez pas la fermeture des fenêtres comme une preuve qu’un agent ou une Mission planifiée s’est arrêté.

Les menus natifs de l’application utilisent la langue de l’interface de CodeNomad dès qu’une fenêtre est chargée ; ils restent en anglais jusque-là. **Aide → À propos de CodeNomad** (aussi dans le menu de l’application sur macOS) ouvre **Paramètres → Info** avec la version, les mises à jour et les diagnostics.

## Préférences et restauration au démarrage {#preferences-startup}

1. Ouvrez les paramètres depuis la fenêtre à configurer. Les points d’entrée du bureau local focalisent l’unique fenêtre native Preferences avec le projet/la Location de cette fenêtre d’origine.
2. Dans **Général**, activez ou désactivez **Restaurer l’état précédent**.
3. Pour oublier la disposition enregistrée de cette fenêtre, utilisez **Effacer l’état de démarrage enregistré**. L’action s’applique immédiatement, sans confirmation.

La restauration peut rouvrir onglets d’espace de travail/SideCar et sessions actives, texte non envoyé, positions de défilement, panneaux, placement et zoom de fenêtre. C’est un état client par fenêtre, pas une copie de la base de conversations natives. L’effacer retire onglets, brouillons et disposition enregistrés ; cela ne supprime ni configuration CodeNomad ni conversations OpenCode. Enregistrez d’abord ailleurs tout brouillon non envoyé important.

La fenêtre Preferences ne possède pas d’état de restauration séparé : ces commandes ciblent la fenêtre qui l’a ouverte. Si cette fenêtre est fermée, ou inconnue parce que Preferences a été rouvert au lancement, elles suivent la dernière fenêtre utilisée ; une modification préparée pour une autre fenêtre n’est jamais appliquée, les commandes affichent d’abord la valeur de la nouvelle fenêtre. Pour régler une fenêtre précise, ouvrez Preferences depuis celle-ci. Les paramètres propres au projet utilisent aussi la Location d’origine ; ils restent indisponibles sans elle. Quand Preferences se rouvre au lancement, ils se reconnectent une fois ce projet ouvert ; tant que le dossier démarre encore, ou s’il est ouvert dans plusieurs onglets, ils restent indisponibles jusqu’à ce que vous ouvriez Preferences depuis la fenêtre voulue.

Les paramètres navigateur et distants sont intégrés, plutôt qu’un second propriétaire natif de Preferences. Une erreur d’ouverture des préférences natives est signalée ; elle ne permet pas de supposer qu’un écran intégré caché s’est ouvert à la place.

## Profils de données de bureau explicites {#data-profiles}

Sans profil explicite, les lancements empaquetés réutilisent le profil mémorisé pour cette configuration. Si aucun choix n’est mémorisé, l’application examine les profils par défaut, `dev` et `dev-v2` pour du travail restaurable : elle sélectionne le seul candidat, demande s’il y en a plusieurs, ou utilise le défaut s’il n’y en a aucun. La sélection ne déplace, fusionne ni supprime les données de profil. Utilisez `CODENOMAD_PROFILE` pour ouvrir explicitement un autre profil.

1. Pour une isolation volontaire du bureau, définissez `CODENOMAD_PROFILE` avant de lancer l’exécutable.
2. Utilisez un nom de 1 à 64 lettres/chiffres ASCII, points, traits de soulignement ou d’union, commençant par une lettre ou un chiffre. Les noms sont normalisés en minuscules ; `default` ou `stable` sélectionne le profil par défaut.
3. Vérifiez **Paramètres → Info → Profil de données** pour un profil nommé. Un nom invalide empêche le lancement au lieu de sélectionner un autre profil.

Par exemple, dans PowerShell, avant de lancer l’exécutable de bureau voulu :

```powershell
$env:CODENOMAD_PROFILE = "review"
```

Pour une configuration serveur indépendante, définissez aussi `CLI_CONFIG` vers un fichier de configuration distinct avant le lancement. La valeur par défaut est `~/.config/codenomad/config.yaml`. Un nom de profil seul ne change ni ce fichier ni le service OpenCode partagé.

| Isolé par un profil de données de bureau | Non isolé automatiquement |
| --- | --- |
| État de restauration fenêtres/onglets, brouillons non envoyés et portée singleton/backend du bureau | Sessions, messages, identifiants fournisseurs et exécution OpenCode |
| Stockage natif Chromium/WebView associé au profil, sous les limites de plateforme | Configuration/préférences CodeNomad, clés vocales, SideCars et activation d’extensions si la configuration est partagée |
| Stockage d’aperçu natif dans son hôte/profil | Fichiers des projets ouverts ; données des serveurs distants |

Sur Tauri macOS, les profils délimités partagent le stockage WebKit système, les connexions et le cache ; n’utilisez pas les noms de profil comme isolation de sécurité des comptes. Electron stocke les données web dans son profil. La version installée et **Flux de mises à jour** ne sélectionnent jamais un autre profil. Les lancements de développement non empaquetés utilisent `dev` sauf sélection explicite.

## Supprimer les autres profils enregistrés {#delete-profiles}

1. Dans les paramètres natifs **Paramètres → Général**, trouvez **Autres profils enregistrés** sous **Restaurer l’état précédent**. Cette section apparaît seulement si d’autres profils existent sur la machine.
2. Actualisez la liste au besoin, choisissez **Supprimer…** et lisez les cibles listées et profils ignorés.
3. Confirmez seulement après préservation des brouillons/connexions nécessaires. Inspectez tout rapport de suppression incomplète avant de réessayer.

La suppression retire onglets, brouillons, disposition et stockage web/cache/connexions détenus des autres profils, y compris ceux listés depuis une autre configuration. Elle préserve le profil ouvert, les conversations OpenCode et les fichiers de projet. Les profils ouverts ou d’état inconnu sont ignorés ; fermez les fenêtres CodeNomad concernées avant d’actualiser explicitement et réessayer. Le contenu non reconnu est conservé et signalé plutôt que supprimé largement.

Le stockage WebKit partagé de Tauri macOS est conservé, car le supprimer affecterait les autres profils. Ce nettoyage n’est pas annulable : une conversation native survivante ne restaure pas un brouillon non envoyé supprimé. **Effacer l’état de démarrage enregistré** est l’action plus limitée pour seulement réinitialiser la fenêtre actuelle.

## Zoom et géométrie des panneaux {#zoom-panels}

1. Utilisez les commandes natives **Affichage → Zoom avant**, **Zoom arrière** ou **Taille réelle** ; clavier/molette suivent aussi la prise en charge de l’hôte.
2. Utilisez **Volet gauche** et **Volet droit** aux coins fixes extérieurs de l’en-tête pour basculer les panneaux. Épinglez/désépinglez les tiroirs si la disposition le permet.
3. Si les commandes ne tiennent plus, réduisez le zoom ou élargissez la fenêtre ; les dispositions étroites déplacent les commandes dans les menus et les panneaux en surimpression.

Les fenêtres principales locales et distantes réservent au moins 390 × 600 pixels CSS, mis à l’échelle par le zoom et bornés par la zone de travail du moniteur. Augmenter le zoom peut agrandir une fenêtre trop petite ; le diminuer ne réduit pas une fenêtre déjà plus grande. Preferences et les enfants d’aperçu navigateur ont leurs propres règles de taille.

Les panneaux laissent une largeur minimale de conversation avant de flotter. Sous 420 pixels CSS de largeur de conversation, la chronologie se masque et les actions d’en-tête utilisent leur menu de débordement ; la préférence de chronologie est conservée. Ces changements géométriques ne modifient ni le brouillon ni la session native. Voir [Paramètres et disposition](settings.md) et [Aperçus navigateur et SideCars](browser-sidecars.md).
