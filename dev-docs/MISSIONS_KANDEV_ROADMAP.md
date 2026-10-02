# Centre de mission — conclusions et feuille de route

## Décision d’ensemble

Améliorer #673 autour de **l’intention, du plan courant, des résultats et de la
capacité à réorienter le travail**. Kandev apporte de bonnes idées de présentation
et de suivi ; son moteur de workflows ne doit pas devenir celui de CodeNomad.

Étude de cinq tâches, menée par Astra avec Muse Spark, Space Bunny et Luna.
Références : CodeNomad `fa8925a6`, Kandev checkout `359b5ffdb` ; inspection des sources,
pas une validation fonctionnelle complète de Kandev. Les rapports durables et leurs
limites sont conservés dans la mission `msn_7ed15b53060e65b09cf5f3fd`.
Voir aussi [les preuves et arbitrages techniques](MISSIONS_KANDEV_RESEARCH.md).

Choix utilisateur confirmés : **autonomie large** et ajout de **`mission.revise`**.
CodeNomad reste un client OpenCode V2. Les lots ci-dessous conservent les critères de
l’étude ; l’état d’implémentation du checkout est précisé en fin de document.

## Ce que la comparaison change

| Sujet | Conclusion pour CodeNomad |
| --- | --- |
| Workflows YAML / machine à états Kandev | Ne pas importer : une mission doit découvrir ses prochaines tâches, sans parcours complet prédéfini. |
| Plans versionnés et attribution des changements | Retenir l’intention : expliquer qui a changé quoi et pourquoi, à l’échelle de la mission. Pas de nouvel éditeur de plan par tâche au premier palier. |
| Dépendances et boîte « Needs you » | Retenir les deux sens des dépendances et une surface regroupant les demandes humaines pertinentes. |
| Profils de modèles par étape | L’exécution est déjà couverte par `delegate.execution`. Améliorer visibilité et préférences, pas reconstruire le routage. |
| Signaux de fin, gates, quorum | `mission.report` fournit déjà le signal durable. Pas d’approbation systématique ; les revues indépendantes restent des tâches explicites. |
| Délégation par les assistants | Les assistants peuvent proposer une suite dans leur rapport ; le coordinateur décide et reste seul écrivain du plan. |
| Docker / SSH / Sprite | Utiles pour certains environnements, sans être un prérequis au Centre de mission. Étude d’intégration distincte. |

## Parcours cible

### Délégation hybride native

Précision utilisateur pendant l’implémentation : les sous-agents OpenCode V2 peuvent
eux aussi sélectionner un fournisseur/modèle/variant différent et ramènent déjà leur
résultat au parent. Le multi-modèles n’est donc pas un motif pour imposer des racines.

- Employer un sous-agent natif pour une recherche ou vérification bornée.
- Employer une session racine pour un chantier autonome à piloter/réutiliser séparément.
- Le participant responsable intègre les résultats de ses sous-agents dans son rapport
  de mission ; ne pas reconstruire la livraison native des résultats.
- Le protocole actuel de carte n’admet que des participants racines. Rendre visibles
  les sous-sessions d’une conversation ne prouve pas leur rattachement à une tâche,
  notamment lorsque cette conversation a servi à plusieurs affectations.

Référence V2 : `https://opencode.ai/v2/docs/agents` (modes, contexte frais, modèles et
permissions des sous-agents). L’usage des racines pendant l’étude servait aussi à
tester le protocole Missions ; ce n’est pas une recommandation universelle.

### Du lancement à la conclusion

1. **Demander** en langage naturel. Le Centre explique comment démarrer ; un éventuel
   raccourci prépare une demande au coordinateur, sans créer un second chemin d’orchestration.
2. **Comprendre l’objectif et le plan courant** : ce qui est décidé, ce qui reste à
   explorer, les prochains travaux. Pas de questionnaire obligatoire avant de commencer.
3. **Suivre le travail** : chaque tâche explique son but, son responsable, son modèle,
   ses dépendances et son état. Les tâches parallèles ne ressemblent pas à une chaîne.
4. **Voir les demandes humaines**, même venant d’un assistant en arrière-plan.
   Répondre à un Form natif ou ouvrir sa session ; distinguer question, permission et blocage.
5. **Comprendre les changements** : une courte explication relie découverte et révision.
   Le coordinateur peut explorer et réorganiser sans validation systématique.
6. **Lire les résultats à leur place** : résumé et preuves associés à la tâche,
   avec accès à la conversation et aux détails techniques si nécessaire.
7. **Réorienter et conclure** : parler au coordinateur ; il révise le plan, conserve
   les anciennes pistes et explique ce qui a été livré, abandonné ou reste en suspens.

## Ordre de réalisation proposé pour #673

### Lot 1 — Comprendre et intervenir (P0, première tranche)

Réutiliser la carte, les sessions et les Forms existants.

- Remplacer le vocabulaire « maillage/frontière/claims » par travail prêt, en cours,
  bloqué et résultats. Montrer les titres ; réserver les identifiants aux détails.
- Afficher objectif, notes de cadrage et brief des tâches ; regrouper selon leur état.
  Montrer « dépend de » et « bloque », avec navigation vers les tâches concernées.
- Associer les rapports à leurs tâches, avec preuves dépliables.
- Ajouter « Votre réponse est attendue » à partir des demandes natives des acteurs.
  Une tâche ayant signalé un blocage n’est pas automatiquement une question ouverte.
- Afficher séparément sélection demandée et sélection actuelle : agent, modèle,
  variante. Chaque champ omis reste « choix natif », chaque donnée absente « inconnue ».
- Distinguer mission, tâche et session : une session au repos ne prouve pas la réussite.

**Acceptation :** depuis une mission réelle, retrouver sans lire le chat le but d’une
tâche, son résultat, son blocage et son assistant ; voir et ouvrir/répondre à un Form
d’un acteur non actif ; sa disparition après réponse/reconnexion est correcte ;
aucune écriture topologique depuis l’UI ; aucun changement automatique de modèle.

**Validation :** fixtures navigateur des vrais composants, demandes déjà résolues,
reconnexion, acteur absent du catalogue, sélection partielle, dix locales et panneau étroit.
Point d’entrée : `MissionControl.tsx`, stores `missions`, `sessions`, `forms` et autorités
natives de réponse existantes. Effort relatif : moyen.

### Lot 2 — Réviser et reprendre honnêtement (P0, cœur dynamique)

Dépend du contrat de révision et peut être développé en parallèle de la présentation
du lot 1, puis intégré avant de promettre une reprise complète.

- Ajouter `mission.revise`, réservé au coordinateur : raison, version attendue,
  changements bornés du cadrage, retraits/remplacements et dépendances.
- Garder les contrats et résultats historiques immuables. Une nouvelle exécution
  intentionnelle utilise une nouvelle tâche/admission liée à la précédente ; un
  retry réseau reprend la même admission. Ne pas ajouter une entité « tentative » séparée au début.
- Distinguer « retirée/remplacée » de « réussie ». Un retrait ne satisfait jamais
  implicitement une dépendance ; valider atomiquement les changements et les cycles.
- Conserver les rapports tardifs sans réactiver les tâches retirées.
- Une révision n’annule pas l’exécution native. Montrer le travail retiré mais encore
  admis. Recommandation de clôture : régler ces admissions par rapport terminal ou
  annulation native vérifiée avant clôture verte ; ne pas attendre des travaux sans
  rapport lancés ensuite dans une session réutilisée, ni confondre idle et achèvement.
- Préserver les exigences de preuve des playbooks : retirer une revue obligatoire
  ne doit pas permettre de contourner un critère de réussite.

**Acceptation :** échec puis remplacement réussi, changement de périmètre, rapport
tardif, double envoi et conflit de version conservent un historique exact ; aucune
mutation du modèle d’un acteur occupé ; les dépendants ne partent pas prématurément.
**Validation :** reducer/journal/admission, redémarrage entre étapes et fixture native
isolée. Aucun test sur la base utilisateur. Effort relatif : moyen à élevé.

### Lot 3 — Expliquer l’évolution (P1)

Projeter un historique borné et typé depuis le journal : qui, quoi, quand, raison et
liens vers les tâches. Le snapshot reste l’autorité ; aucun nouveau bus d’exécution.
Afficher une limite de lecture comme telle, pas comme une disparition des preuves.

**Acceptation :** mêmes changements après reconnexion/rejeu, ordre déterministe,
pas de doublon, historique ancien accessible selon le périmètre annoncé. Les nouvelles
révisions du lot 2 s’y intègrent. Effort relatif : moyen.

### Lot 4 — Préférences réutilisables (P2)

Préférences de modèles par type de travail et explication du choix du coordinateur,
adossées au catalogue natif. Conserver le choix explicite de chaque affectation.
Les appliquer aux futures tâches, sans reconfigurer un acteur occupé. Indisponibilité
visible, aucune substitution silencieuse ni promesse de modèle « meilleur » ou gratuit.

**Arbitrage pour cette tranche :** conserver les préférences natives d’agents/modèles
et les choix explicites par affectation. Aucun nouveau registre de « types de travail »
ni écran de routage Missions : les rôles sont libres, et une taxonomie imposée ferait
double emploi avec les agents natifs. Des préférences propres à Missions restent une
piste de produit à définir séparément ; elles ne sont pas présentées comme livrées.

## Suites possibles de Missions, après #673

Clarification utilisateur : l’ancien tableau « Backlog secondaire, séparé de #673 »
mélangeait des suites de Missions et des améliorations générales. Les deux ensembles
restent hors de l’implémentation actuelle, mais ont désormais des documents distincts.

| Piste | Intérêt | Décision nécessaire avant un suivi de #673 |
| --- | --- | --- |
| Coordination multi-dépôts | Piloter un changement transversal dans une mission | Le périmètre actuel est un projet ; définir l’identité et l’autorité inter-projets, pas seulement ouvrir plusieurs worktrees. |
| Partage de gabarits et synthèses de mission | Réutiliser une démarche et transmettre ses résultats | Séparer export documentaire et protocole exécutable. Ne pas importer le YAML Kandev par défaut. |

Les pistes générales issues de Kandev (revue des diffs, actions utilitaires, inbox
globale, environnements et secrets) sont regroupées dans
`D:\CodeNomad-worktrees\missions-v2\dev-docs\KANDEV_GENERAL_OPPORTUNITIES.md`.
Elles seront étudiées dans d’autres sessions et ne sont pas des dépendances de #673.

## Écartés de cette feuille de route

Clone de moteur YAML, réécriture Go, Kanban imposé, approbation à chaque étape,
questionnaire initial obligatoire, routage de modèles opaque et infrastructure
cloud ajoutée sans besoin. Les fonctions Office derrière un flag ne sont pas une
preuve de maturité ; elles peuvent inspirer une idée sans justifier son adoption.
La voix existe déjà côté CodeNomad (`server/routes/speech.ts`) : ne pas la présenter
comme une capacité entièrement manquante sur la base de cette comparaison.

## État de l’implémentation #673

L’utilisateur a demandé l’implémentation actuelle des conclusions pertinentes pour
#673, en plus des chevrons, de la restauration de l’état, de la lecture au-dessus du
chat et de la création/modification/suppression des missions. Dans le checkout :

- Centre : sections, groupes de tâches et rapports repliables avec les chevrons
  partagés ; sélection, ouvertures et identité du lecteur restaurées par le layout
  natif **par fenêtre**. Suppression locale des préférences de la carte supprimée
  pour libérer les entrées du layout borné.
- Lecture : rapports/briefs/cadrage/historique dans la surface au-dessus du transcript,
  composer conservé et transcript monté mais inerte. Le bouton « Retour au chat »
  revient explicitement au chat. L’aperçu navigateur conserve son URL et peut être
  rouvert par son contrôle habituel ; le dernier geste explicite choisit la surface,
  y compris face à une ouverture navigateur encore en attente.
- CRUD humain : création d’une conversation coordinatrice sans prompt automatique,
  édition objectif/notes avec contrôle de version, suppression durable de la carte
  sans suppression ni arrêt des conversations. Brouillons conservés lors d’un conflit,
  identités de requête réutilisées pour les reprises réseau du même formulaire.
- Lisibilité : regroupement par état, dépendances navigables dans les deux sens,
  résultats reliés aux tâches, distinction attente native/blocage rapporté ; demandes
  natives d’acteurs en arrière-plan visibles et renvoi à leur conversation pour répondre.
- Exécution : demandé/actuel/inconnu par champ, aucun changement automatique. Le
  modèle client actuel n’expose pas la variante courante : celle-ci reste **inconnue**,
  même si la tâche demandait une variante explicite.
- Révision : quatrième outil `mission.revise`, CAS/rejeu, retraits/remplacements liés,
  dépendances atomiques, rapports tardifs et admissions encore ouvertes. La clôture
  réussie ne confond pas retrait, repos de session et rapport terminal.
- Historique : les 50 derniers changements (révisions du coordinateur et éditions
  humaines des métadonnées) sont projetés depuis le journal,
  avec indication explicite si la projection est tronquée et lecture avant/après.
  Aucun accès paginé aux entrées plus anciennes n’est ajouté dans cette tranche.
- Traductions : dix locales alignées. Revue indépendante UI suivie de corrections
  d’attribution et de retour d’erreur à l’ouverture d’une conversation indisponible.

Les suites possibles ci-dessus et les opportunités générales restent hors de ce travail.
Les correctifs de lancement de l’étude sont déjà poussés (`258e20a2`, `fa8925a6`).
Publication autorisée par l’utilisateur : les changements et corrections de revue
sont portés par la branche `feat/session-native-missions-v2` de #673. La fusion et le
déploiement sont des étapes distinctes ; #673 n’est pas fusionnée.

### Vérifications de cette tranche

- `npm run typecheck --workspace @codenomad/ui` et build UI : réussis.
- Suite navigateur complète : 83 réussites initiales, un test fichier bloqué par
  l’absence locale du binaire Electron, une vérification zoom Electron opt-in ignorée.
  Après installation de la dépendance, les fixtures navigateur natif/tab chrome ont
  été relancées : 18 réussites, seule la même vérification zoom opt-in est ignorée.
- Cinq scénarios Centre/lecteur réels : invalidation/remontage/restauration, édition
  concurrente/rejeu/création/suppression, navigation des dépendances/historique,
  questions natives arrière-plan, transcript et brouillon conservés pendant la lecture.
  Les six scénarios de restauration projet Electron/Tauri sont également verts.
- Régressions unitaires : demandes/exécution, store Missions, budget et transactions
  du layout natif, exclusion lecteur/navigateur et course avec ouverture en attente ;
  parité des clés et paramètres des dix locales.
- Fixture native isolée `scripts/test-missions-native.mjs` : **PASS OpenCode 2.0.18**.
  CRUD/rejeu, suppression avec transcript conservé, outil `mission.revise`, historique,
  lignée et notification de rapport tardif réellement exercés. Le refus de notification
  tardive découvert à cette frontière a été corrigé et couvert par une régression.
- Captures des composants réels inspectées, dont le lecteur dans `SessionView` avec
  son composer. L’automatisation de l’application installée ne trouve aucune fenêtre
  visible pour cette session : aucun déploiement ni redémarrage n’est revendiqué.
