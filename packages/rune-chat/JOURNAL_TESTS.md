# Journal des tests du prototype Rune

## Périmètre et lecture des résultats

Ce journal rassemble les résultats effectivement observés sous Windows et les commandes permettant de les reproduire. Chaque ligne précise l'environnement testé. Les essais interactifs et les essais en arrière-plan sont séparés.

Worktree isolé :

```text
C:\Users\Admin\Documents\Codex\2026-11-21\realtime-voice-chat\work\rune-prototype-b970ca97
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
