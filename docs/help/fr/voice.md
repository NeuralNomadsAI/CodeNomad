# Saisie et lecture vocales

## Configurer la voix {#configure}

1. Ouvrez **Paramètres → Voix**. La carte **Voix** utilise un adaptateur côté serveur compatible OpenAI, indépendamment du fournisseur de modèles de la conversation.
2. Saisissez **Clé API**, et éventuellement **URL de base**, **Modèle de transcription**, **Modèle vocal** et **Voix par défaut**.
3. Si l’entrée et la sortie nécessitent des services différents, activez **Fournisseurs séparés pour l'entrée et la sortie**, puis remplissez les clés, URL de base et modèles d’entrée/sortie.
4. Choisissez **Mode de lecture** et **Format de sortie**, puis **Enregistrer** (disponible tant que des changements ne sont pas enregistrés). Vérifiez l’état affiché à côté des boutons de test, **Configuré**, **Partiellement configuré** ou **Clé API manquante**, avant les tests ; un enregistrement échoué affiche **Échec de l'enregistrement**.

Les paramètres et clés vocaux appartiennent à la configuration du serveur CodeNomad connecté, pas au projet sélectionné ni à la connexion fournisseur OpenCode. Les autres clients qui la partagent les utilisent. Les clés enregistrées sont masquées : un champ vide conserve la valeur ; **Effacer la clé enregistrée** prévoit sa suppression à l’enregistrement. Une direction sans point d’accès ni clé propres peut utiliser les paramètres partagés ; un point d’accès séparé nécessite sa clé et une clé séparée nécessite son point d’accès. Lors d’un changement de point d’accès, fournissez explicitement la clé voulue et vérifiez la configuration enregistrée ; ce changement efface la clé enregistrée de cet emplacement plutôt que de l’envoyer à un autre hôte.

Le backend peut aussi utiliser `OPENAI_API_KEY` et `OPENAI_BASE_URL` comme valeurs partagées par défaut. Effacer une clé enregistrée ne retire pas un identifiant fourni par l’environnement ; changez cet environnement côté backend et redémarrez-le pour supprimer ce repli.

| Réglage | Sens / valeur par défaut |
| --- | --- |
| URL de base | Racine API compatible OpenAI, par défaut `https://api.openai.com/v1`. L’entrée utilise `audio/transcriptions` ; la sortie utilise `audio/speech`. |
| Modèle de transcription / Modèle d’entrée | Modèle accepté par le point d’accès STT ; par défaut `gpt-4o-mini-transcribe`. |
| Modèle vocal / Modèle de sortie | Modèle accepté par le point d’accès TTS ; par défaut `gpt-4o-mini-tts`. |
| Voix par défaut | Identifiant de voix fournisseur ; par défaut `alloy`. Ce n’est pas un sélecteur de voix système. |
| Flux continu | Valeur par défaut. Commence la lecture à l’arrivée de l’audio, si le fournisseur et le navigateur prennent en charge le format sélectionné. |
| Mis en mémoire tampon | Attend la réponse audio complète avant lecture. |
| Format de sortie | `mp3`, `wav`, `opus` ou `aac` ; par défaut `mp3`. La compatibilité varie selon le navigateur/fournisseur. |

Ce sont des demandes au service configuré, pas une garantie que chaque point d’accès compatible implémente chaque modèle, voix ou format. Un échec d’enregistrement laisse une erreur ; inspectez la configuration avant un autre changement.

## Tester l’entrée et la sortie {#test}

1. Enregistrez d’abord les changements de point d’accès, clé, modèle et voix.
2. Choisissez **Tester l'entrée**, accordez l’accès au microphone, parlez, puis **Arrêter l'enregistrement**. Vérifiez la transcription reçue.
3. Choisissez **Tester la lecture** pour entendre l’extrait ; **Arreter l'extrait** l’arrête.

Le test de lecture utilise immédiatement le mode/format sélectionné, mais le point d’accès, la clé, le modèle et la voix viennent des paramètres enregistrés. Tester l’entrée n’envoie pas de prompt de conversation. Les tests envoient malgré tout de l’audio/du texte au fournisseur vocal configuré et peuvent être facturés.

Si le flux continu échoue, sélectionnez **Mis en mémoire tampon**, essayez `mp3`, enregistrez et retestez. « Configuré » confirme les paramètres, pas la réussite de l’authentification fournisseur ou de la lecture du codec. Vérifiez l’accessibilité du point d’accès depuis l’hôte serveur, les noms de modèle/voix et le quota avant de réessayer.

## Dicter un prompt {#dictate}

1. Gardez **Saisie vocale du prompt** activée dans **Voix** (elle l’est par défaut).
2. Dans la zone de saisie, ouvrez **Plus d'actions**, choisissez **Démarrer la saisie vocale** et autorisez l’accès au microphone sur cet appareil.
3. Lorsque vous avez fini de parler, choisissez **Arrêter l'enregistrement et transcrire** dans le même menu ; **Transcription de l'audio** s’affiche pendant le traitement.
4. Relisez et modifiez le texte inséré avant d’envoyer normalement le prompt.

La transcription insère le texte à la sélection actuelle ; elle ne le soumet pas automatiquement à OpenCode. L’entrée de menu apparaît seulement si STT est configuré et que le client accepte l’enregistrement. Celui-ci utilise le microphone de l’appareil client, même si CodeNomad s’exécute sur un serveur distant.

Si l’entrée manque, vérifiez le commutateur et la configuration STT. Pour les erreurs de permission, autorisez le microphone dans les paramètres de confidentialité du navigateur et du système. L’enregistrement dans un navigateur distant nécessite un contexte sécurisé, normalement un HTTPS de confiance ; voir [Accès mobile](mobile.md) et [Accès distant direct](remote-access.md). Changer de vue ou fermer la zone de saisie termine son cycle d’enregistrement ; ne comptez pas récupérer de l’audio non envoyé. Votre brouillon tapé reste l’endroit où vérifier le résultat.

## Lire les messages à voix haute {#playback}

1. Utilisez **Lire le message** sur un message, ou la même action sur un appel d’outil, lorsque TTS est disponible.
2. Utilisez **Arreter la lecture** sur la même commande pour l’arrêter ; démarrer une autre lecture arrête celle en cours.
3. Changez la voix, le modèle, le mode ou le format enregistrés dans **Voix** pour les demandes suivantes.

La lecture utilise la projection textuelle CodeNomad, pas une capture d’écran racontée : les octets binaires/d’images et les reçus d’autorisation ne sont pas du contenu vocal. Elle n’exécute pas de prompt et ne change pas le modèle OpenCode sélectionné. La prise en charge audio du navigateur et les réponses fournisseur peuvent encore empêcher la lecture même si un format est sélectionnable.

Pour la voix automatique de conversation, utilisez **Activer le mode conversation** dans le menu **Plus d'actions** de la zone de saisie ; il s’applique à cet onglet de projet et n’est pas conservé après un rechargement. Tant qu’il est actif, CodeNomad demande à l’agent, avec chaque prompt que vous envoyez, de commencer sa réponse par un court résumé dans un bloc clôturé `spoken`. Seul ce bloc terminé est lu, dans la session principale active ; ce n’est pas une lecture automatique de chaque réponse ou sous-agent. **Desactiver le mode conversation** arrête sa file et ne demande plus le résumé. Démarrer le microphone arrête aussi la voix de conversation active. Le commutateur apparaît avec la saisie vocale, ou si le mode conversation est déjà actif, et exige un TTS fonctionnel pour l’activer.

## Flux de données et confidentialité {#privacy}

L’audio microphone va du client au backend CodeNomad, puis au point d’accès STT configuré. Le texte sélectionné pour synthèse passe par ce backend vers le point d’accès TTS configuré ; l’audio reçu est lu sur le client. Les clés API restent côté serveur et ne sont pas renvoyées comme valeurs enregistrées au formulaire.

Utilisez un point d’accès auquel vous confiez le contenu dicté ou lu. Ce n’est pas une garantie de transcription hors ligne, et les identifiants OpenCode n’autorisent pas automatiquement la voix. Arrêtez l’enregistrement/la lecture une fois terminé ; changer une clé ou un point d’accès affecte les demandes futures, pas les données déjà envoyées. Voir [Sécurité](security.md) avant d’exposer un serveur à d’autres utilisateurs.
