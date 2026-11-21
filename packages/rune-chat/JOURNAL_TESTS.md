# Journal des tests du prototype Rune

## Périmètre et lecture des résultats

Ce journal rassemble les résultats effectivement observés sous Windows et les commandes permettant de les reproduire. Chaque ligne précise l'environnement testé. Les essais interactifs et les essais en arrière-plan sont séparés.

Worktree isolé :

```text
D:\CodeNomad\.codenomad\worktrees\rune-native-chat
```

Le prototype est dans `packages/rune-chat`. Les sources du serveur de production et le dépôt principal restent inchangés. Les fixtures possèdent leurs profils, projets synthétiques, ports éphémères et processus enfants. Les traces sont dans `packages/rune-chat/evidence/` et les profils dans `packages/rune-chat/fixture-profile/`.

Le binaire `codenomad-rune-recovery.exe` sert aux vérifications en arrière-plan. Sa commande de sonde quitte avant la création d'une fenêtre. Le runtime Rune utilisé par ces tests est celui du prototype : ses composants, son moteur de disposition et sa liste virtualisée exécutent les vérifications géométriques.

## Environnements distingués

| Environnement | Serveur Code Nomad | OpenCode | Réponse du modèle | Interface |
|---|---|---|---|---|
| Charge locale | Mémoire du processus | Données synthétiques | Code déterministe | Runtime sans fenêtre ; ouverture Windows également vérifiée lors du passage interactif |
| Contrat HTTP direct | Fixture HTTP/SSE | Données synthétiques | Code déterministe lié au prompt et au tour | Sonde CLI |
| Serveur Rust et fixture | Véritable exécutable Rust du worktree | Service HTTP synthétique | Code déterministe | Sonde CLI |
| Pagination et reprise | Véritable exécutable Rust, avec proxy de panne local | Service et stockage synthétiques de 600 lignes initiales | Données contrôlées | Runtime Rune sans fenêtre |
| Session vide bornée | Véritable exécutable Rust | Service HTTP synthétique | Deux réponses distinctes | Sonde CLI |
| Échanges réels interactifs | Véritable exécutable Rust | Service OpenCode V2 installé, version observée : 2.3.2 | Réponses réelles du service | Fenêtre Windows du prototype |
| Historique et reprise réels en arrière-plan | Véritable exécutable Rust, proxy de coupure propre au test | Véritable stockage et service OpenCode V2 | 600 archives de test importées par l'API native, puis une réponse réelle | Runtime Rune sans fenêtre |

## Résultats vérifiés

### Serveur séparé et comparaison avec TypeScript

Les modifications du serveur et le contrôle ciblé du dossier racine sont isolés dans `D:\CodeNomad\.codenomad\worktrees\rs-agent-controls-20261122`, branche `codex/rs-agent-controls`, [PR serveur dédiée](https://github.com/NeuralNomadsAI/CodeNomad/pull/1667) vers `feat/rust-server`. Le contenu `packages/server-rs` de la branche Rune correspond à la branche serveur de base ; les fonctionnalités de contrôle utilisent l’exécutable du worktree serveur séparé.

Le banc officiel lance deux véritables daemons OpenCode 2.3.2 avec profils et bases propres. Le fournisseur est synthétique et local : aucun compte, daemon, projet ou fenêtre utilisateur n’est utilisé.

| Comparaison | Résultat et preuve dans le worktree serveur |
|---|---|
| `agent-controls` | Observations TypeScript et Rust strictement égales : décisions `once`/`always`/`reject`, reçus et motifs, invalides HTTP 400, périmés HTTP 409, session étrangère HTTP 403, réponse typée à une Form, annulation, interruption active puis inactive. `packages/server-rs/bench/out/agent-controls.json`. |
| `contract` | Placement racine et worktree, refus des sessions étrangères, lecture des demandes en attente : observations identiques. `packages/server-rs/bench/out/contract.json`. |
| Tests TypeScript ciblés | 99 réussis, compilation réussie. `packages/server-rs/bench-control-ts-tests.log`. |
| Tests Rust | 251 tests unitaires et 4 tests de lancement réussis, 1 test ignoré. `packages/server-rs/bench-control-rust-tests.log`. |
| Rune contre ce serveur séparé | Parcours complet de contrôle réussi avec service OpenCode simulé, vingt événements de question coalescés, lecture après reprise, trois reçus avec motifs. `evidence/controls-separated-server.log`, profil `fixture-profile/launcher-66c81205-e402-4235-a804-9bdef7e27177`. |

Écarts traités : les routes Rust reprennent le contrat natif déjà relayé par TypeScript ; la confirmation des reçus reprend sa sémantique existante. La validation stricte, la vérification de demande encore en attente et la revalidation finale d’identité sont ajoutées aussi à TypeScript. Le contrôle ciblé de racine conserve les preuves physiques Git et correspond au chemin direct de propriété déjà utilisé par TypeScript. La PR détaille ces choix.

Commandes du banc, depuis le worktree serveur :

```powershell
$env:CODENOMAD_RS_BINARY = (Resolve-Path packages/server-rs/target/debug/codenomad-rs.exe).Path
$runeOpenCodeExe = 'C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe'
node packages/server-rs/bench/compare.mjs agent-controls $runeOpenCodeExe
node packages/server-rs/bench/compare.mjs contract $runeOpenCodeExe
```

### Piloter l’agent : modèle, permissions, questions et arrêt

Ces essais s’exécutent entièrement en arrière-plan : runtime Rune réel sans fenêtre, sans entrée globale ni presse-papiers. Les fenêtres de démonstration existantes restent ouvertes. Les profils et projets de test sont propres à chaque exécution.

| Cas | Environnement et résultat vérifié |
|---|---|
| Catalogue et variante | Vrai Rune + vrai Rust + OpenCode simulé : deux choix affichés pour un modèle et sa variante ; modèle désactivé exclu, configuration et en-têtes exclus du modèle d’affichage ; sélection persistée puis relue. |
| Question typée | Même banc : texte, entier borné, booléen, multisélection, champ conditionnel actif et valeur cachée par défaut transmis avec leurs types natifs. Une deuxième question est annulée explicitement. |
| Brouillon et navigation | Même banc : sélection de question conservée après remplacement des objets natifs, réponse partielle conservée et navigation Sessions bloquée tant que ce brouillon reste édité. |
| Permissions | Même banc : réponses `once`, `always`, `reject`, avec motif. La première tentative de refus reçoit HTTP 503 ; demande et motif restent présents. Un nouvel essai explicite réussit. |
| Propriété et demandes périmées | Même banc : HTTP 409 pour une permission absente et pour une permission appartenant à l’autre session ; ces mutations atteignent seulement le contrôle du serveur, jamais le relais natif de mutation. |
| Reçus durables | Même banc : trois reçus relus via le vrai serveur ; provenance `codenomad` et motif exact. L’événement natif de règlement et la confirmation HTTP conservent le motif. |
| Question arrivée en direct | Même banc : `form.created` avec `data.form.sessionID` recharge la file de la session ; vingt notifications successives sont coalescées. Le scénario complet effectue cinq lectures de catalogue. |
| Arrêt indépendant | Même banc : fragments intermédiaires observés, puis bouton Arrêter utilisé pendant une lecture de catalogue retardée de 1,5 s. La requête d’arrêt se termine en moins de 1,2 s ; relecture autoritative terminée en moins de 5 s, texte partiel conservé, un seul prompt et une seule interruption. |
| Modèle et arrêt réels | Vrai Rune + vrai Rust + vrai service OpenCode : 355 choix de modèle/variante lus ; changement vers le modèle déjà configuré avec variante confirmé ; deux événements de texte et 1 141 octets visibles avant l’arrêt ; événement natif `session.execution.interrupted`, quatre lignes natives uniques et retour Prêt. Zéro appel d’outil. Session jetable supprimée après vérification du dossier, du titre et des permissions interdisant tous les outils. |

Preuve du banc complet : `evidence/controls-fixture.log` et `fixture-profile/launcher-2f27080c-a689-4217-8089-2a26e336fd04/proof.json`. Preuve réelle initiale : `fixture-profile/controls-live-2e53761f-1dd1-443b-b51a-db47bb1b31f8/proof.json`, dont `cleaned: true`. Les sorties ne contiennent aucun secret du service installé.

Une répétition réelle supplémentaire atteint le délai de 120 s avant le premier texte. La lecture native indépendante confirme alors le modèle et la variante choisis, l’état occupé et un assistant sans texte ; la sonde échoue à l’étape `real streamed text`. Cette répétition figure dans `evidence/controls-real.log` et `fixture-profile/controls-live-7f66c368-5f4a-46df-8966-f7c210236fd0/proof.json`. La session est supprimée (`cleaned: true`). Le premier essai qualifie l’arrêt pendant du texte réel ; cette répétition établit une limite de disponibilité de réponse du service pendant la campagne.

Limites de cette tranche : permissions et questions qualifiées avec OpenCode simulé ; décision et réponse à une demande émise par un vrai outil restent à qualifier dans un projet jetable. Les formulaires d’authentification externes et globaux restent à traiter dans les hôtes existants. Le rendu natif de ces nouvelles commandes dans une fenêtre visible demande une qualification interactive distincte. Le délai de 1,2 s vérifié concerne l’arrêt concurrent d’une lecture de catalogue, sous la charge du banc.

Les treize tests du client réussissent, avec le cas presse-papiers exclu de cette campagne. Les 251 tests unitaires du serveur réussissent, avec un test ignoré. Les quatre tests de lancement du serveur réussissent avec `TEMP` et `TMP` dans le profil du banc sur D. Une première exécution utilisant le répertoire temporaire utilisateur est refusée par trois de ces tests avant le lancement : leur assertion impose une racine hors du profil utilisateur. Aucun changement des tests n’est nécessaire. Traces : `evidence/controls-client-tests.log`, `evidence/controls-server-tests-all.log`, `evidence/controls-server-serve-tests.log`.

La non-régression du parcours dossier/sessions, de deux envois distincts et des outils en cours/terminés réussit : `evidence/controls-launcher-regression.log`. Les sept injections de pagination et reconnexion réussissent encore : 606 lignes natives finales, déplacement maximal de l’ancre de 0 point ; `evidence/controls-recovery-regression.log`.

Commandes depuis le worktree :

```powershell
$runeServerWorktree = 'D:/CodeNomad/.codenomad/worktrees/rs-agent-controls-20261122'
cargo +1.99.1 build --locked --manifest-path "$runeServerWorktree/packages/server-rs/Cargo.toml"
cargo +1.99.1 build --locked --manifest-path packages/rune-chat/Cargo.toml --bin codenomad-rune-recovery
cargo +1.99.1 test --locked --manifest-path packages/rune-chat/Cargo.toml --bin codenomad-rune-recovery -- --skip selects_code_and_routes_copy_to_memory_clipboard
$env:RUNE_SERVER_EXE = "$runeServerWorktree/packages/server-rs/target/debug/codenomad-rs.exe"
node packages/rune-chat/launcher-fixture.mjs --controls
node packages/rune-chat/launcher-fixture.mjs --with-tools
node packages/rune-chat/recovery-fixture.mjs
# Test explicite utilisant l’accès modèle existant, avec création puis suppression de sa session :
node packages/rune-chat/controls-live.mjs
# Les tests de lancement imposent un dossier temporaire hors du profil utilisateur :
$runeTestTemp = Join-Path (Get-Location) 'packages/rune-chat/fixture-profile/server-suite-temp'
New-Item -ItemType Directory -Force -Path $runeTestTemp | Out-Null
$env:TEMP = $runeTestTemp
$env:TMP = $runeTestTemp
cargo +1.99.1 test --locked --manifest-path packages/server-rs/Cargo.toml --target-dir packages/server-rs/target/controls
```

Limites de cette tranche : décisions de permission et réponses aux questions testées avec OpenCode simulé ; échanges réels limités au modèle, au streaming et à l’arrêt, avec tous les outils interdits. Les formulaires d’authentification externes et sans session restent hors du client Rune. Les formats et expressions régulières des chaînes sont validés par le service. Le parcours de plusieurs demandes sur une petite fenêtre Windows, les clics manuels et les courses entre plusieurs clients réels restent à qualifier. L’arrêt contourne les lectures du client ; les mutations du relais Rust conservent leur verrou d’appartenance. Le binaire de test est distinct de celui de la fenêtre ouverte.

### Vérification de l’intégration du serveur Rust

La branche Rune intègre `origin/feat/rust-server`, dont `4861695bc` pour la lecture de toutes les inscriptions de worktrees sous des bornes de réponse de 4 Mio. La borne concurrente de nombre d’entrées du prototype est retirée. Le contrôle physique ciblé du dossier racine est conservé pour les mutations de session ; le banc à 143 inscriptions vérifie que ces envois évitent l’énumération des autres checkouts.

La fusion est sans conflit. `cargo +1.99.1 check --locked --manifest-path packages/server-rs/Cargo.toml` réussit sur les sources fusionnées ; trace : `evidence/merged-server-check.log`. Le formatage du client et `git diff --check` réussissent également. Les onze tests du client, le parcours d’outils simulés et les sept injections de reprise à 606 lignes sont consignés dans la campagne ci-dessous.

### Blocs d’outils et qualification interactive du projet réel

Campagne dans `D:\CodeNomad\.codenomad\worktrees\rune-native-chat`. Le projet ouvert depuis Rune est le vrai dossier `D:\CodeNomad`. La conversation longue est une copie créée par le fork natif d’une conversation de travail réelle ; la source conserve ses messages. La première page native de la copie contient 200 messages avec continuation. Les messages de test sont envoyés uniquement dans cette copie et dans une session neuve créée depuis l’interface. Les deux sessions de test interdisent explicitement tous les outils avant les envois.

| Cas | Résultat et preuve |
|---|---|
| Sélecteur Windows | Ouvert depuis Parcourir ; sélection du dossier effectuée par l’utilisateur après difficulté de ciblage de l’automatisation. Catalogue réel ensuite affiché. |
| Grand inventaire Git | Le service expose 143 worktrees. Le premier envoi rencontre le refus du serveur à 64 entrées, puis la vérification globale dépasse le délai du client. Les lectures natives confirment que ces deux tentatives ont laissé le prompt absent. |
| Envoi dans la copie longue | Après la vérification ciblée du dossier racine : réponse `RUNE-HISTORIQUE-OK` affichée dans Rune ; service terminé avec succès, un fragment de texte, zéro outil appelé. Preuve : `evidence/interactive-final.log`, entrée `INTERACTIVE_TURN` de la session longue. |
| Session neuve créée depuis Rune | Réponse de 20 lignes et marqueur `RUNE-NEUF-OK` affichés ; service terminé avec succès, neuf fragments, trois messages natifs, zéro outil appelé. Le client rencontre ensuite le traitement erroné d’un curseur natif présent. Preuve : même journal, seconde entrée `INTERACTIVE_TURN`. |
| Correction de relecture | Lecture explicite ascendante et contrôle de la dernière identité via une lecture native récente. Le banc fournit désormais un curseur d’ancrage futur même sous la limite ; les deux envois et la réconciliation passent. L’essai interactif complet d’une nouvelle session après ce dernier correctif reste à reproduire. |
| Historique d’outils réels | L’arbre d’accessibilité Windows du client reconstruit les cartes de plusieurs appels historiques avec leur état « Terminé » et leur bouton « Détails ». La conversation longue est à l’état « Prêt ». Les appels historiques sont lus passivement. |
| Rendu des détails et bornes | Tests du vrai runtime : ordre texte/outil/texte conservé, détails masqués puis entrées/sorties affichées au clic, erreur native, identités dupliquées refusées, longue sortie Unicode bornée. `evidence/tools-tests.log` : onze tests réussis, test du presse-papiers filtré. |
| État vivant des outils | Serveur Rust réel + OpenCode simulé : états en cours puis terminés observés et deux réponses distinctes en streaming, une création et deux prompts. `evidence/tools-stream.log` ; aucune exécution d’outil réelle dans ce banc. |
| Régression de reprise | `evidence/recovery.log` : 606 lignes canoniques, sept injections, ancre de lecture conservée à 0 point. |

Commandes complémentaires :

```powershell
node packages/rune-chat/launcher-fixture.mjs --with-tools
$env:RUNE_TEST_GIT_COUNT = '143'
node packages/rune-chat/launcher-fixture.mjs
Remove-Item Env:RUNE_TEST_GIT_COUNT
# Commande avec fenêtre, à réserver à une campagne interactive autorisée :
node packages/rune-chat/interactive-live.mjs D:/CodeNomad '<titre-exact-de-la-session-longue>'
```

Le rendu initial des champs d’outil est borné à 10 000 caractères avec révélation à la demande. Les champs conservés ont une borne de 256 Kio et portent un indicateur de limitation. Les images et fichiers de sortie d’outil, les contrôles de modèle, les permissions/questions et l’interruption restent à qualifier et implémenter selon leur périmètre. La reprise après rupture du SSE avec cette conversation de travail est une qualification distincte de son ouverture ; l’essai réel de coupure sur les 600 archives natives est documenté plus bas.

La copie de préparation en tête détachée `...\work\rune-native-chat` a été retirée après vérification de la couverture des sources par la branche poussée. Le worktree du prototype de départ `...\work\rune-prototype-b970ca97` conserve les preuves du socle.

### Ouverture d’un projet et choix d’une session depuis Rune

Les preuves de cette campagne sont dans le worktree de reprise :

```text
D:\CodeNomad\.codenomad\worktrees\rune-native-chat
```

Le parcours utilise les vrais composants et actions Rune, le serveur Rust compilé dans ce worktree et un OpenCode HTTP/SSE **simulé**. Chaque exécution possède un dossier projet vide, un profil privé, des ports éphémères et ses propres processus. Les identifiants projet/session sont obtenus par les appels d’ouverture et de catalogue ; la sonde reçoit seulement l’adresse, le mot de passe de fixture et le dossier à ouvrir.

| Cas | Résultat vérifié | Preuve dans le worktree de reprise |
|---|---|---|
| Démarrage du parcours standard | Sans identifiants de projet/session, le setup affiche l’ouverture | `evidence/launcher.log`, sonde `launcher_probe.rs` |
| Connexion refusée puis corrigée | Un mauvais mot de passe garde l’écran de connexion ; la correction ouvre le parcours et efface le champ secret après succès | `evidence/launcher.log` |
| Dossier invalide et sélecteur | Chemin relatif refusé ; annulation du sélecteur conserve l’état ; réponse scriptée du sélecteur ouvre le dossier | `evidence/launcher.log` |
| Catalogue natif | Deux pages, continuation par curseur seul, deux sessions distinctes sélectionnables par titre | `evidence/launcher.log`, `fixture-profile/launcher-*/proof.json` |
| Reprise d’une session | Les deux messages existants sont chargés dans le transcript | `evidence/launcher.log` |
| Brouillon saisi | Le retour aux sessions garde le chat et son brouillon tant que le champ contient du texte | `evidence/launcher.log` |
| Création et deux envois | Exactement une session créée, deux prompts et quatre lignes natives distinctes ; réponses liées aux deux messages et texte intermédiaire observé pendant le streaming | `evidence/launcher.log`, `proof.json` : `created=1`, `prompts=2` |
| Retour à la session initiale | Les deux lignes initiales sont retrouvées après les échanges de l’autre session | `evidence/launcher.log` |
| Réponse perdue après création | Le service simule une création réussie suivie d’une erreur HTTP ; nouvelle création bloquée, actualisation puis sélection de la session créée, deux envois réussis ; total d’une seule création | `evidence/launcher-uncertain.log`, `proof.json` : `created=1`, `prompts=2` |
| Régression du chat | Huit tests réussis, dont charge de 10 000 messages, saisie multiligne, Unicode, deux échanges et bornes d’historique ; test de presse-papiers filtré | `evidence/background-tests.log` |
| Régression pagination/reprise | 606 lignes canoniques, sept injections vérifiées, déplacement maximal de l’ancre de lecture de 0 point | `evidence/recovery.log` |

Commandes depuis ce worktree, après les compilations décrites plus bas :

```powershell
node packages/rune-chat/launcher-fixture.mjs
node packages/rune-chat/launcher-fixture.mjs --uncertain-create
```

Les sondes exécutent les clics et réponses de sélecteur dans le runtime sans fenêtre. La présentation du sélecteur Windows et le nouveau parcours complet avec OpenCode installé restent à vérifier en interactif. Les essais réels de streaming/reprise du socle sont documentés séparément ci-dessous. Cette campagne laisse la démonstration existante ouverte et préserve le focus ainsi que le presse-papiers Windows.

### Charge, saisie et affichage

| Cas | Résultat observé | Preuve |
|---|---|---|
| Ouverture de la charge locale | 10 000 messages Unicode chargés et fenêtre Windows ouverte à l'état « Prêt » lors du passage interactif | Capture `evidence/synthetic.png`, arbre `evidence/tree.json`, vérification native de la fenêtre dans la conversation |
| Virtualisation | Test réussi : moins de 250 éléments montés pour les 10 000 messages | `opens_ten_thousand_rows_with_bounded_mounts_and_scrolls` |
| Défilement et retour en bas | Test réussi ; une modification en streaming conserve la lecture hors du bas | Même test, runtime Rune réel |
| Champ multiligne | Texte Unicode multiligne transmis une fois ; un second clic pendant l'envoi reste sans nouvel envoi | `multiline_input_submits_once_and_stream_preserves_unicode` |
| Deux envois successifs | Deux questions, deux réponses distinctes conservées ; retour à l'état prêt à chaque tour | `consecutive_sends_keep_distinct_responses_and_reenable_send` |
| Isolation des événements | Un événement d'un autre espace de travail ou d'une autre session est ignoré | `v2_events_are_scoped_to_workspace_and_session` |

Les vérifications de charge établissent la borne de montage et le comportement du défilement. La cadence d'affichage, le temps au premier pixel en version optimisée et la consommation GPU restent à mesurer dans un protocole de performance dédié.

### Contrats HTTP/SSE et envois successifs

| Cas | Résultat observé | Preuve |
|---|---|---|
| Fixture HTTP directe | 200 messages initiaux, deux prompts distincts, identifiants de réponse uniques, réponses distinctes ; 67 puis 72 fragments Unicode | Sorties des sondes `fixture.mjs --probe-contract` dans la conversation |
| Passage par le vrai serveur Rust | Même scénario réussi avec lectures d'historique, synchronisation de l'environnement de session et envoi relayés par le vrai serveur | Sorties de `rust-fixture.mjs` dans la conversation |
| Maintien SSE | Ping nommé reçu et réponse `pong` envoyée | Requête `POST /api/client-connections/pong` dans la trace de la fixture directe |
| Session créée vide | Deux envois réussis, quatre lignes natives autoritatives uniques, lecture bornée de la session exacte | `evidence/fresh.log`, marqueur `fresh-session probe` |

Les fixtures attribuent un identifiant d'assistant et d'inbox propre à chaque tour. Le corps de la réponse dépend du prompt et du numéro du tour. Les sondes contrôlent les identifiants et le contenu de chaque réponse, puis la présence de deux réponses distinctes.

### Pagination et reprise après interruption

Résultat terminal observé : **`recovery-probe-ok`**. Les **606 lignes finales** ont été comparées dans l'ordre avec le stockage synthétique, identifiant et texte compris. Le déplacement maximal mesuré de l'ancre de lecture est de **0,0 point**.

| Cas injecté | Vérification réussie |
|---|---|
| Pages précédentes avec recouvrement de 16 lignes | Progression de 200 à 384, puis 568 et 600 lignes ; ordre natif conservé et identifiants uniques |
| Refus d'une page précédente | Liste et ancre conservées ; reprise par demande explicite de la même page |
| Coupure pendant une lecture d'ancienne page | Réponse devenue obsolète rejetée ; changement de contenu relu après reconnexion |
| Coupure du SSE client pendant une réponse | Texte manquant et messages créés pendant l'interruption retrouvés par lectures autoritatives ; 604 lignes exactes après reprise |
| Fragments retardés et répétés après reprise | Le texte installé par la lecture autoritative conserve son contenu exact, sans ajout répété |
| Coupure du flux entre OpenCode et le serveur Rust | Nouvelle génération amont reconnue ; message ancien modifié et deux messages supplémentaires réconciliés ; 606 lignes exactes |
| Disparition de l'ancre résidente | État d'échec, dernier affichage conservé, envoi désactivé ; poursuite vers une fenêtre « latest » automatique absente de la trace |

Compteurs du parcours réussi : **23 fenêtres demandées**, **une seule lecture `latest`** pour l'ouverture initiale, **un seul prompt POST**, **quatre connexions SSE client**, **deux connexions du flux natif**, **un refus de page** et **une réponse de page volontairement obsolète**. Les lectures suivantes de reprise utilisent l'ancre résidente et les curseurs `after`.

Preuve reproductible : `evidence/recovery.log`, avec les marqueurs `recovery-probe-ok` et `real-rust-recovery-synthetic-opencode`. Les erreurs de flux et d'ancre présentes dans cette trace correspondent aux pannes injectées et au refus final attendu.

### Contrôles unitaires exécutés en arrière-plan

**Huit tests réussis, zéro échec, un test filtré**, preuve `evidence/background-tests.log` :

- Charge de 10 000 lignes et maintien du défilement.
- Saisie multiligne et transmission Unicode.
- Deux envois successifs.
- Filtrage des événements par espace de travail et session.
- Fusion des recouvrements dans l'ordre natif et priorité du contenu autoritatif.
- Refus d'un recouvrement rompu, d'identifiants dupliqués et des dépassements de budget.
- Refus d'une fenêtre bloquée ou mal formée.
- Rejet d'une lecture commencée avant un changement de génération de connexion.

Le test de presse-papiers mémoire est filtré pendant ce passage afin de respecter la contrainte intégralement en arrière-plan. Aucun outil de contrôle de bureau, événement de souris ou clavier global, ni accès au presse-papiers Windows n'est utilisé par ce passage.

### Échanges réels OpenCode et vérifications Windows interactives

Ces observations proviennent du passage interactif autorisé, distinct de la campagne en arrière-plan :

| Cas | Résultat effectivement observé |
|---|---|
| Nouvelle session réelle | Projet Git jetable créé sous le worktree ; règle native `action: *, resource: *, effect: deny` vérifiée |
| Premier prompt réel | Réponse « RUNE-LIVE-1 : Bonjour ! », un fragment texte, terminaison native réussie |
| Second prompt réel | Bloc Rust contenant « RUNE-LIVE-2 », onze fragments texte, réponse et identifiant distincts, terminaison native réussie |
| Effets d'outils | Zéro événement d'outil observé pour les deux tours ; contenu du projet jetable limité à `.git` lors du contrôle |
| Navigation | Retour à la première réponse effectué dans la fenêtre Windows |
| Sélection et copie du code réel | Sélection multiligne visible, copie exacte vérifiée, presse-papiers initial sauvegardé en mémoire puis restauré |

Preuves : deux résumés `RUNE_LIVE_TURN` des tours 1 et 2 dans `packages/rune-chat/live.stdout.log`, état natif « Prêt » observé dans la conversation, et sortie de vérification `EXACT_CODE_COPY_VERIFIED_AND_CLIPBOARD_RESTORED`. Le test séparé de sélection/copie dans le presse-papiers mémoire de Rune avait également réussi dans la série interactive de cinq tests.

Le plugin de fenêtre d'historique était absent du projet jetable lors de ces deux échanges interactifs. Le lancement explicite sur session neuve vérifie donc une liste initialement vide et utilise une lecture native bornée. Le parcours paginé est qualifié séparément dans le projet décrit ci-dessous.

### Historique et coupure avec OpenCode réel, intégralement en arrière-plan

Résultat observé : **`real-opencode-history-recovery-ok`**.

- Le plugin d'historique existant de Code Nomad a été compilé depuis les sources du worktree et installé uniquement dans le répertoire `.opencode/plugins` d'un nouveau projet jetable. Le catalogue OpenCode a confirmé son état actif. Les dépendances de compilation présentes dans le dépôt principal ont été lues ; les écritures de compilation sont restées dans le projet jetable du worktree.
- L'API native d'import OpenCode a créé un historique de **600 archives de test** dans le véritable stockage du service. Le contenu de ces archives est synthétique. Les pages testées sont servies par OpenCode réel et traversent le véritable serveur Rust.
- Le runtime Rune sans fenêtre a chargé les pages précédentes, puis comparé les 600 lignes avec l'export natif. L'ancre de lecture est restée au même emplacement.
- Un seul prompt a demandé une réponse réelle sous forme de code Rust, avec les outils interdits. Le proxy a interrompu uniquement le SSE de ce client de test après **deux fragments livrés**, alors qu'aucun événement de fin n'avait été observé.
- OpenCode a produit **68 fragments texte**, avec **zéro événement d'outil**, un seul événement terminal de réussite et **un seul prompt POST**. Rune a ouvert **deux connexions SSE** et réconcilié **603 lignes natives finales** avec l'export du service, identifiants, ordre et texte compris.
- Le déplacement maximal mesuré de l'ancre est de **0,0 point**. Le service OpenCode partagé et les autres sessions ont poursuivi leur fonctionnement ; seul le serveur Rust propre à cet essai a été arrêté en fin de parcours.
- Les permissions natives ont été revérifiées après l'exécution. Les deux sessions propres à ce parcours — la session vide de préparation et la session d'historique importé — ont été supprimées après contrôle de leur emplacement, titre et contenu. Les profils, manifestes et traces de test restent dans le worktree.

Preuves : `evidence/real-history.log`, marqueurs `REAL_HISTORY_CLIENT_SSE_CUT`, `REAL_HISTORY_TERMINAL`, `real-opencode-history-recovery-ok` et `real-rust-real-opencode-history` ; nettoyage dans `evidence/real-history-cleanup.log` avec le marqueur `owned-real-history-sessions-cleaned`.

L'essai qualifie une interruption du flux client pendant la livraison d'une réponse réelle. Les coupures du flux amont et les fragments répétés restent couverts par l'environnement à OpenCode simulé pour préserver le service partagé utilisé en parallèle.

## Commandes reproductibles en arrière-plan

Toutes les commandes ci-dessous partent de la racine du worktree isolé. Le serveur Rust doit déjà être compilé dans ce worktree ; sa compilation utilise également ce worktree.

```powershell
cargo +1.99.1 build --locked --manifest-path packages/server-rs/Cargo.toml
cargo +1.99.1 build --locked --bin codenomad-rune-recovery --manifest-path packages/rune-chat/Cargo.toml
cargo +1.99.1 test --locked --bin codenomad-rune-recovery --manifest-path packages/rune-chat/Cargo.toml -- --skip selects_code_and_routes_copy_to_memory_clipboard
```

Contrats et scénario de coupures, avec profils synthétiques distincts :

```powershell
$env:RUNE_CLIENT_EXE = (Resolve-Path packages/rune-chat/target/debug/codenomad-rune-recovery.exe).Path
node packages/rune-chat/fixture.mjs --probe-contract
node packages/rune-chat/rust-fixture.mjs
node packages/rune-chat/rust-fixture.mjs --fresh-probe
node packages/rune-chat/recovery-fixture.mjs
cargo +1.99.1 fmt --check --manifest-path packages/rune-chat/Cargo.toml
git diff --check
```

`fixture.mjs` reçoit explicitement `--probe-contract`. `rust-fixture.mjs` choisit sa sonde CLI par défaut. `recovery-fixture.mjs` choisit explicitement `--probe-recovery`. Chaque fixture arrête ses propres processus enfants à la fin. La fenêtre de démonstration déjà ouverte conserve son processus et son exécutable.

Pour reproduire ultérieurement l'essai réel interactif, `node packages/rune-chat/live.mjs` crée une nouvelle session jetable et ouvre sa fenêtre dédiée ; cette commande relève d'une campagne avec interface autorisée. Elle n'est pas exécutée pendant la campagne en arrière-plan.

### Reproduire l'historique réel sans fenêtre

Prérequis : service OpenCode V2 installé et actif, authentification existante utilisable, modèle fonctionnel, `esbuild` et les dépendances déjà présents en lecture dans `D:/CodeNomad/node_modules`. Le test crée sa propre localisation et ses propres sessions. Il émet un prompt réel, donc utilise le fournisseur déjà configuré.

```powershell
node packages/rune-chat/real-history-prepare.mjs --prepare
# Reprendre le chemin du fichier session.json situé dans le profil imprimé par la préparation.
node packages/rune-chat/real-history-seed.mjs --seed <profil-imprime>/session.json
# Reprendre ensuite le chemin seeded.json imprimé par l'import.
node packages/rune-chat/real-history-fixture.mjs <profil-imprime>/seeded.json
node packages/rune-chat/real-history-cleanup.mjs --cleanup <profil-imprime>/seeded.json
```

Le nettoyage est volontairement conditionné au contenu exact du parcours qualifié : 600 archives, une question, deux lignes de résultat, aucune permission d'outil. Un contenu différent exige une inspection du profil de test avant toute suppression.

## Budgets et limites de qualification

- Fenêtre connectée : 200 lignes et 2 Mio de réponse au maximum. Résidence du prototype connecté : 2 048 lignes et 8 Mio de texte. Reprise : au plus 16 continuations. Texte vivant et événement SSE : 256 Kio. Dépassement ou ancre absente : affichage conservé et échec explicite.
- La charge locale de 10 000 messages est une fixture mémoire indépendante de la borne de résidence connectée.
- Le mode explicitement neuf conserve au plus 200 lignes natives et exige que sa première ancre reste dans la réponse. La pagination générale utilise le contrat du plugin d'historique.
- La reprise testée couvre les ruptures effectives du SSE client, les changements de génération amont et les fragments retardés injectés. Les coupures réseau silencieuses sans fermeture TCP, l'expiration des cookies, la rotation de l'authentification et le redémarrage complet du serveur avec une nouvelle identité d'espace de travail restent à qualifier.
- La cohérence observée est celle du texte et des identifiants des fixtures. Le rendu complet des outils, les pièces jointes, toutes les séquences de fragments de raisonnement/texte et les écritures concurrentes soutenues restent à qualifier.
- Un message installé pendant une reprise peut attendre une lecture autoritative avant d'afficher de nouveaux fragments ambigus. Les prompts sont envoyés une fois ; leur réémission automatique après une erreur réseau reste exclue du parcours.
- Les essais réels interactifs établissent les deux échanges et la copie Windows. Les essais avec OpenCode simulé couvrent les sept injections de panne détaillées plus haut. L'essai réel supplémentaire établit la pagination du stockage natif et la reprise après coupure du SSE client ; l'interruption du service OpenCode partagé reste exclue de ce protocole.
- Les nouvelles sources et le binaire de sonde sont vérifiés en arrière-plan. L'intégration de ces nouvelles commandes dans la fenêtre de démonstration existante demandera un lancement ultérieur autorisé.

## Mise à jour du journal

Pour chaque nouveau cas, conserver l'environnement précis, les assertions exécutées, le résultat de la commande et ses limites. Mettre à jour les preuves sous `evidence/`, puis copier ce document vers le fichier de livraison demandé :

```text
C:\Users\Admin\Documents\Codex\2026-11-21\realtime-voice-chat\outputs\Journal-des-tests-Rune.md
```
