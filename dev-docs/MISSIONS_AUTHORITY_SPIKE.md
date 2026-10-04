# Missions : prototype privé d'autorité de continuité

Date : 2026-10-02. Assignment `continuity-authority-spike`, décision révision 21 :
backend existant unique/persistant par profil + plugin durable, sans fallback
plugin-only. **Prototype privé, aucun câblage produit, commit/push ou changement
du desktop/daemon utilisateur.** Ne pas fusionner PR #673.

## Objet et statut

Le fixture `scripts/test-missions-authority-spike.mjs` utilise exclusivement
`C:/Users/Admin/AppData/Roaming/npm/node_modules/@opencode/cli/bin/opencode.exe`
comme enfant `serve --port 0`, avec HOME/config/DB/provider/Git privés sous
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-authority-*`.
Il ne découvre pas le service partagé, ne charge pas automation et ne démarre
aucune fenêtre. Le lifecycle persistant Electron/Tauri appartient à une autre
tâche : ce fixture prouve les admissions d'un backend sans fenêtre, pas encore
la survie de ce backend à la fermeture d'un host desktop réel.

Le registre natif `ctx.tool.list()` contient des définitions `browser_*` même
sans desktop ; inscription de catalogue n'est pas une capacité UI connectée.
Le profil privé déclare `browser: deny`, ne charge aucune automation CodeNomad,
et les requêtes provider ne reçoivent aucun tool `browser_*`/`codenomad_*`.
Aucun outil navigateur n'est appelé pour tester l'absence de capacité utilisateur.

L'exécution et les preuves finales sont consignées en bas de ce document. Les
résultats du prototype ne qualifient pas la migration des anciennes installations.

## Construction : réutilisation, pas moteur Mission

Le bundle privé expose `codenomad.missions`, appelle le vrai
`setupMissionsPlugin`, utilise son journal, ses builders d'inputs, locks projet,
tools, contexte et outbox de rapports. Il ne suit aucune lease desktop.

Le transport ne fait que POST vers un broker loopback privé authentifié. Celui-ci
utilise **le vrai `admitMissionInput`**, `WorkspaceManager`, `session-environment.ts`
et un seul `WorktreeDeletionFence`. Il ajoute un contrôle de grant/namespace/root
avant admission et immédiatement avant prompt/synthetic ; aucune politique
d'environnement n'est recopiée dans le plugin. Pause/Stop passent par la vraie
implémentation `applyMissionLifecycle` avec les vrais receipts du journal natif.

Les helpers sont confinés à `scripts/missions-authority-spike/` :

| Helper | Responsabilité |
| --- | --- |
| `protocol.mjs` | Canonicalisation JSON, signature Ed25519, enveloppe et contrat RPC privé |
| `plugin.mjs` | Bundle durable privé, namespace natif, gate des mutateurs humains, grant miroir |
| `broker.mjs` | Registre host, reader de settings frais fail-closed, admission backend réelle |
| `family-ownership.mjs` | Claim atomique de famille Git, PID diagnostique, release étroit |
| `ownership-child.mjs` | Processus adversarial privé pour conflit/crash du claim |
| `provider.mjs` | Provider déterministe, captures des inputs réellement consommés et hold de contrôle |

Le test driver signé `invoke/capture/invoke-captured` appelle les vrais tools
avec un ToolContext de fixture, comme le fixture natif existant. **Ce n'est pas
une interface produit proposée et ce n'est pas une preuve que le modèle a choisi
une délégation ou émis lui-même le report.** Le provider reçoit réellement les
prompts/synthetics natifs et sa requête contenant le report prouve la consommation,
pas seulement un ACK HTTP ou l'absence d'activité.

Des inputs directs privés sont injectés pour tenir une session occupée et tester
la sélection des items inbox au Stop ; leur environnement est aussi écrit
fraîchement. Les shells `probe.cjs` lisent volontairement la valeur native déjà
appliquée sans réappliquer le profil, afin de mesurer l'admission précédente.

## Protocole de confiance privilégié

Le caller RPC natif n'expose pas d'identité d'utilisateur au handler. Le champ
`profileID` ou un input `approved:true` ne peut donc pas autoriser Play/adoption.

Le backend/runner autorisé possède une clé privée Ed25519 **en mémoire**, jamais
envoyée à OpenCode, à un modèle ou au plugin. Le bundle managed privé pinne une
clé publique de confiance, authorityID, profil, execution-host et transport
loopback ; il n'accepte pas une clé publique dans l'input RPC. Provisioning de
cette clé et authentification humaine des actions dans le produit restent à faire.

Signature : `missions-authority-spike/signed-v1` + JSON canonicalisé (clés triées),
contenant version, authorityID, profil, host, namespace durable natif, projectID,
canonical root, racines exactes, missionID, époque, méthode, requestID, révision et
payload entier. Vérifier signature **et** bindings tirés de `ctx.location`/journal,
puis les préconditions de mission. Les receipts requestID stockent le digest :
payload différent = conflit, retry exact = receipt sans réexécution. Rejouer une
ancienne adoption retourne l'état courant du grant, pas son ancien état active.

Le wrapper garde `codenomad.missions.snapshot` en read-only et rejette tous les
anciens RPC create/update/delete/lifecycle non signés. Le driver privé et les
actions privilégiées utilisent un RPC étroit distinct. Les outils agents restent
natifs et leur mutation/admission doit être liée au grant autoritaire.
La règle est une allowlist de reads (`snapshot`, `cleanupTarget`), pas une denylist
de mutations : une nouvelle méthode produit telle que `recover` reste refusée
par défaut tant qu'un intent signé dédié n'a pas été ajouté et qualifié.

**Limite de confiance :** un administrateur local ou un plugin arbitraire ayant
déjà exécution de code dans le daemon peut lire/modifier des ressources locales.
Cette signature protège l'interface d'admission contre des inputs non autorisés,
pas contre ce principal déjà privilégié. Ne pas mettre la clé privée dans le
storage natif, une variable shell, un prompt ou un fichier projet.
Ce n'est pas non plus un sandbox d'un shell agent auquel les permissions natives
donnent déjà l'autorité de l'utilisateur OS sur les fichiers/processus locaux.

## Grant, namespace et migration de writers

Le grant host et son miroir natif sont liés à la mission/coordinator, profil,
execution-host, projectID/canonical, une racine exacte et une époque. Initialement
un registre pending ou absent n'admet rien. Adoption est metadata-only et CAS,
séparée de Play ; une création préparée n'est jamais promptée implicitement.
Révocation conserve preuves/conversations et bloque nouvelles admissions/reprises.
Réadoption explicite crée une nouvelle époque ; stopped ne s'adopte pas pour
exécution. Pas de changement silencieux de profil ou de racine.

Un UUID créé une seule fois dans le storage du plugin est le namespace natif.
Le read challenge authentifié echo une nonce aléatoire et retourne ce namespace,
la policy actuelle, les identités natives et les grants. Le backend vérifie aussi
son registre protégé ; une réponse read seule n'autorise aucun input. Une autre DB
au même projet reçoit un autre namespace et refuse les signatures de la première.
Pas d'accès direct à SQLite, ni emprunt des secrets de session-pruning.

Le claim ne garantit pas qu'un ancien bundle **non participant** respecte le
nouveau grant. Deux preuves distinctes sont nécessaires : les anciennes surfaces
RPC sont refusées par le nouveau wrapper ; le lifecycle natif dispose l'ancien
plugin et les exécuteurs capturés refusent ensuite l'exécution. La migration
produit doit exiger policy/challenge valide avant adoption et empêcher la
coexistence de vieux backends/bundles writers. Ne pas considérer leur silence,
leur vieux snapshot ou une lease desktop comme cette preuve. La mise à jour
managed sans `location.reload` implicite reste une gate produit non qualifiée.

## Exclusion interprocessus pragmatique

Le prototype choisit un **claim atomique `mkdir` exclusif et durable**, par
famille Git physique (`realpath(git rev-parse --git-common-dir)`, case-fold Windows).
La clé n'inclut ni profil ni DB : deux profils/daemons sur le même checkout ne
peuvent pas justifier deux autorités/fences indépendants. Le root du store de
claims est un chemin commun de confiance, pas un argument contrôlé par le caller.

Le marker propriétaire contient famille, profil, PID et token aléatoire.
Toute présence refuse une deuxième acquisition. `kill(pid,0)` ne sert qu'au
diagnostic ; PID réutilisé/permission inconnue reste conservateur. Il n'y a **pas**
de heartbeat, TTL, background takeover ou « nettoyer toutes les leases périmées ».
Après crash, même un PID mort ne libère pas le claim : réparation offline explicite
du marker exact, ou véritable lock OS libéré par le kernel, doit être décidée
pour le produit. La release normale ne supprime que son owner.json exact et son
répertoire vide après vérification du token ; pas de recursive delete.

Ce choix sacrifie disponibilité après crash plutôt que sécurité. Il fonctionne
pour des brokers **coopérants** utilisant le même store host. Il ne fence pas un
processus Git externe, un ancien backend non modifié ou un autre chemin de store.
Le produit doit refuser l'ouverture/mutation concurrente de la famille aux autres
profils, pas uniquement leurs sends Mission, et faire rattacher le desktop du
même profil à l'autorité existante. Le fixture n'est pas un remplacement de ces
adapters desktop/workspace.

## Environnement frais et ordonnancement

Le reader privé relit un JSON du profil fixé **à chaque demande** et refuse
fichier manquant, JSON cassé, forme invalide ou valeurs non-string. Aucun `{}` de
secours et aucun cache de version « déjà appliqué ». C'est une seam de preuve,
pas une migration des settings YAML du produit. Le full snapshot est construit
par le vrai module host : base process.env + overrides, casing Windows, exclusion
auth/storage. Les variables ne traversent ni plugin, ni UI, ni journal/trace.

Le broker sérialise les admissions et réutilise le manager/fence unique ; le
plugin utilise l'exclusion native projet pour ses mutations métier. Révocation
du miroir prend aussi cette exclusion. Les controllers ne doivent pas conserver
un verrou backend en rappelant une mutation RPC qui attend le même projet :
mutation native → transport backend → read snapshot, pas callback de mutation.
Après les awaits environment, le wrapper de send relit namespace/grant/root.
Le fixture injecte une révocation pendant cet await : un environment déjà écrit
n'autorise pas le prompt suivant.

**Limite conservée :** environment est session-scoped. Les queued inputs n'ont
pas des snapshots séparées et des clients externes peuvent changer environment /
model. Ce prototype n'ajoute pas une transaction native environment+prompt.
WSL est couvert par l'implementation réutilisée mais n'est pas qualifié ici.

## Lifecycle et no scheduler

Play explicite utilise les synthetics natifs déterministes de la lifecycle
existante. Pause publie désir et cibles avant interrupt, garde les receipts
partiels, parque l'outbox et les dispatchs ; exact retry seulement des pending.
Stop révoque l'autorité de nouveaux sends, reste terminal, interrupt et cancel
uniquement les items inbox corrélés à la mission. Des receipts ACK ne garantissent
pas l'arrêt précis des subprocessus ou descendants natifs.

L'outbox existante ne livre que des rapports écrits, avec IDs stables et bounded
backoff. Aucun timer n'identifie un stall, ne crée une tâche, ne relance un acteur
sans report ou ne réessaie une control action. Activation/adoption/challenge/
reconnection sont read/metadata-only, distincts de reprise ciblée humaine.

## Interfaces stables recommandées pour l'implémentation produit

1. **Authority** : `adopt(authenticatedIntent)` / `revoke(authenticatedIntent)` →
   receipt époque/état. AuthenticatedIntent construit exclusivement après auth
   host, CAS et vérification des racines ; aucune clé/profil libre en tool input.
2. **Admission** : `execute({missionID,intentID,grantEpoch,kind,targetSessionID},signal)`
   → saved/pending/admitted/rejected corrélé. Reconstruire payload depuis le journal,
   ne pas exposer arbitrary prompt/HTTP/RPC/environment au caller.
3. **NativeTrust** : challenge read authentifié + typed signed intent à méthodes
   allowlistées. Vérification commune canonical/signature/domain/binding/receipt ;
   pas d'API produit `invoke` de tools ni de sélection d'un caller sessionID.
4. **FamilyOwnership adapter** : acquire/assertCurrent/release, identité physique
   authoritative, politique explicite de crash recovery. Même instance manager /
   fence pour desktop et headless ; claims/locks communs entre profils.
5. **ProfileExecutionHost adapter** : read validé frais fail-closed + full snapshot
   host/WSL dans le backend, jamais secrets dans plugin ou snapshot public.

Conserver journal/outbox native existants, pas un deuxième journal de tâches dans
le registre host. L'extraction des routes en petit module d'admission commun peut
réutiliser la validation produit mesurée ici plutôt que la recopier dans le plugin.

## Validation et gates non couvertes

Commande reproductible :

```text
node scripts/test-missions-authority-spike.mjs
```

Cette commande ne doit jamais recevoir un autre CLI, ni être convertie en appel
`service start/status/stop` du service utilisateur. Les artifacts privés incluent
native-capabilities.json, evidence.json ou failure.json ; aucun secret d'environnement.

Exécution complète réussie, sortie naturelle 0 : OpenCode 2.0.21, Node 25.2.1,
Windows, 11 gates privés. Artifacts de la première exécution complète :
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-authority-0MM6lc/evidence.json`.

| Gate privé | Résultat observé |
| --- | --- |
| Famille Git interprocessus | Duplicate même profil/autre profil refusés ; PID crashé diagnostiqué mort, aucun takeover |
| Catalogue/lifetime privé | Plugin durable sans automation/UI, session.environment/inbox absents du contexte plugin mesuré |
| Auth/explicit adoption | Fausse signature, mauvais signer/bindings/révision et requestID conflict refusés ; anciens mutateurs refusés ; adoption seule sans prompt |
| Assignment/report/Play | Requêtes provider contenant le report ; replay report sans second wake ; writes environment avant tous les sends Mission |
| Settings/env/payload | Corruption et faute environment refusées avant send, contenu forgé refusé, erreurs redacted ; native shell first → changed → base après suppression |
| Worktree | Fence réel de manager unique bloque admission ; acteur déplacé hors root ne peut pas admettre |
| Pause | Intent durable paused, seule cible en erreur pending ; exact retry finit les receipts ; report sauvegardé sans wake puis livré après Play |
| Ancienne incarnation | Namespace/journal inchangés après unload/reload natif privé ; exécuteur capturé disposé refuse |
| Revoke/Stop | Révocation pendant await environment empêche prompt ; ancien Play/adoption ne réactive pas ; Stop terminal annule seulement inbox Mission |
| Autre DB | Nouveau namespace ; signature de première DB refusée sans mutation |
| Restart daemon privé | Namespace, journal stopped et grant revoked conservés ; aucune requête provider causée par startup/read |

Cette exécution a observé 16 lectures fraîches de settings, 10 tentatives de write
environment, 8 admissions Mission (3 prompt, 5 synthetic), 10 requêtes primary du
provider. Deux tentatives environment sans send correspondent à la faute injectée
et à la révocation après écriture ; les inputs de préparation et shells de mesure sont explicitement
séparés du transport Mission. Les trois probes natifs n'ont reçu ni variable DB,
ni mot de passe OpenCode/bridge et ont conservé PATH.

Les premiers runs rouges ont corrigé le fixture (confusion catalogue navigateur /
capacité et adapter de settings aligné sur `readEnvironmentForAdmission` en cours
d'introduction produit). Ils ne sont pas présentés comme des pannes Missions ni
des gates vertes. Répétition complète après renforcement du test payload sur une
vraie intention dispatching : également 11 gates, sortie 0, artifact
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-authority-vRZUDO/evidence.json`.
Dernier run sur l'état final du fixture : 11 gates, sortie 0, avec allowlist
read-only refusant aussi le nouveau RPC `recover` :
`C:/Users/Admin/AppData/Local/Temp/opencode/missions-authority-S9Rb7E/evidence.json`.
`node --check` réussit pour le runner et les six helpers ; aucune whitespace
finale dans les fichiers ajoutés. Aucun test n'a ciblé le daemon partagé.

Gates produit ouvertes indépendamment du succès du fixture :

- Lifetime Electron/Tauri réel, rendezvous et restauration de workspace sans
  fenêtre, singleton host et bridge capabilities réellement séparées.
- Provisioning/rotation/revocation de clé de confiance et auth humaine ; settings
  YAML frais fail-closed, path/symlink/profil host identity et sources WSL réelles.
- Le fixture pinne un profil, une clé et une racine. Le mapping de plusieurs
  autorités sur des familles disjointes d'un même daemon global reste à qualifier ;
  ne pas remplacer silencieusement la clé/propriété d'une autre mission active.
- Migration managed et exclusion des vieux writers non participants, alias/nested
  repos/Git dégradé/cross-host families ; quotas et durable receipt capacity.
- Crash pendant publication de grant/receipt et protocole de réparation du claim
  mort ; fsync/durabilité power loss non établie par un rename réussi.
- Native children : environment/permissions/interrupt/background ne sont pas
  couverts ; aucune promesse de pause récursive ni de consommation finale modèle.

Un gate privé vert ne doit pas être présenté comme une refonte produit validée.
