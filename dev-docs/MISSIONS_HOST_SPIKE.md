# Missions : spike d’hôte backend persistant

Date : 2026-10-02. Prototype privé, non câblé au produit. Ne pas fusionner PR #673.

## Décision

La continuité Missions est faisable en conservant **un seul backend CodeNomad par
profil**, à condition de déplacer sa propriété du processus de fenêtre vers un petit
manager persistant par profil. Le desktop devient un client attachable. Il ne faut
pas ajouter un broker Missions ou un second `WorkspaceManager` : le backend complet
existant reste l’unique détenteur des settings, connexions, fences et admissions.

Le fixture `scripts/test-missions-host-spike.mjs` qualifie le protocole de processus
avec un backend HTTP mock strictement privé. Il n’ouvre ni Electron/Tauri, ni daemon
OpenCode, ni profil/config/session utilisateur. Ses helpers sont limités à
`scripts/missions-host-spike/`.

## Preuves produit actuelles

- Electron : `multiwindow-lifecycle.ts` transforme la dernière fermeture en
  `app.quit()`, puis appelle `cliManager.shutdown()`. `process-manager.ts` possède
  le child, son stdin, le cookie et le bridge natif ; il force l’arbre au shutdown.
- Tauri : la dernière fenêtre appelle `shutdown::request`, qui finit par
  `state.manager.stop()`. Sous Windows, `cli_manager.rs` place launcher + Node dans
  un Job Object `KILL_ON_JOB_CLOSE`. Le détachement est donc impossible sans sortir
  le backend de ce Job et transférer explicitement sa propriété au manager persistant.
- Serveur Node : `CODENOMAD_NATIVE_PARENT=1` active plugins desktop, listener
  loopback et bridge d’automatisation. Les réponses natives et `codenomad:shutdown`
  partagent stdin (`index.ts`, `native-parent.ts`). Fermer simplement stdin tuerait
  le contrôle ou demanderait le shutdown ; le manager doit devenir le parent natif
  stable, pas conserver un pipe vers une fenêtre disparue.
- Auth UI : Electron et Tauri créent aujourd’hui un nom de cookie par incarnation,
  échangent le bootstrap token puis injectent le cookie dans leurs stores de
  webview. Au rattachement, le manager doit retourner la même origine backend et
  une nouvelle preuve bootstrap bornée ; ne jamais sérialiser/réutiliser un cookie
  de renderer dans le registre.
- Les singletons desktop actuels sont par channel + config identity, mais leurs
  locks ne survivent pas au process desktop. L’autorité backend exige son propre
  singleton avec la même identité canonique de profil.

## Contrat minimal concret

```ts
interface PersistentHost {
  attach(input: { profileIdentity: string; clientNonce: string }): Promise<{
    generation: string; managerPid: number; backendPid: number;
    loopbackOrigin: string; bootstrapProof: string;
  }>
  status(): Promise<{ generation: string; automationAvailable: false | "attached-window" }>
  stopAuthority(input: { authenticatedIntent: string }): Promise<{ stopped: true }>
}
```

Le registre privé par profil contient version, identité canonique, génération,
PID + identité de démarrage du manager, origine loopback et référence au secret —
jamais le cookie UI, le grant Mission ou des variables d’environnement. Publication
atomique après readiness. Le manager détient : backend child, pipe natif, auth
bootstrap, fence unique et arrêt explicite. Les hôtes détiennent : fenêtres,
cookies/webviews et capacités automation attachées. Zéro fenêtre implique refus
structuré de `browser.*`, screenshot et actions UI, mais pas arrêt backend.

L’ordre au lancement est : lire registre → authentifier/attacher → sinon verrou
exclusif → relire → démarrer une seule génération. Registre injoignable avec PID et
identité de démarrage encore valides = **fail closed**, jamais remplacement. Owner
mort = quarantaine du registre, nouvelle génération atomique. En produit, PID seul
est insuffisant : réutiliser les primitives d’identité de démarrage déjà présentes
côté Electron et fournir l’équivalent Rust.

`stopAuthority` est distinct de fermeture de fenêtre, Pause/Stop Mission et arrêt
du daemon OpenCode partagé. Il arrête seulement le backend CodeNomad de ce profil.
Un arrêt/restart OS reste un arrêt réel ; la continuité n’est pas promise machine
éteinte.

## Ce que le fixture prouve

Exécuter :

```text
node scripts/test-missions-host-spike.mjs
```

Le test, avec deadline bornée, vérifie : huit launches concurrents convergent vers
les mêmes PID/génération ; les clients disparaissent sans tuer manager/backend ; un
rattachement retrouve ces PID ; token et origine profil sont obligatoires ; les
admissions concurrentes passent par un seul fence ; automation headless est refusée ;
un owner live mais injoignable refuse le split-brain ; un owner mort est récupéré
avec nouvelle génération et l’enfant sort si le canal manager casse ; l’arrêt
explicite ne touche pas le sentinel du daemon partagé.

## Hypothèses et gaps non couverts

- Le mock prouve le protocole process, pas la survie graphique réelle. Il faut un
  fixture packagé privé Electron **et** Tauri vérifiant fermeture finale, second
  launch, logout/session-end, update/relaunch et restauration des fenêtres.
- Windows doit lancer le manager hors du Job Object Tauri avant d’y placer le
  backend. Une simple suppression de `KILL_ON_JOB_CLOSE` est interdite : elle perd
  le cleanup fail-safe. Electron doit cesser de capturer/forcer l’arbre appartenant
  au manager, tout en gardant le cleanup de ses processus UI.
- Le bridge natif actuel suppose un parent unique et toutes les méthodes. Il faut
  router `opencode.service.start` via une capacité host persistante, et `browser.*` /
  `developer.*` vers un attachement fenêtre éphémère. Sans fenêtre, celles-ci
  échouent immédiatement. Aucun daemon partagé ne doit hériter du Job/cleanup.
- Les origines/cookies Electron/Tauri doivent être rebootstrapées après attach ;
  rotation de token, permissions du registre, symlinks/ACL, PID reuse et downgrade
  demandent des tests natifs. Le fixture ne prétend pas qualifier ces ACL.
- Ce spike ne traite pas les grants, settings frais, per-send, cross-profile ou
  preuve RPC : ils appartiennent au contrat de continuité et à l’étude architecture.

## Plus petit scope produit

1. Extraire un `HostLifetime` commun (messages/version/états, aucune logique Mission)
   et un launcher Node packagé caché ; registre/lock par identité channel + config.
2. Déplacer **le backend complet existant** derrière ce manager, avec backend secret
   et origine loopback stables par génération. Ne pas démarrer deux copies.
3. Adapter Electron et Tauri ensemble : attach/detach, bootstrap cookie neuf,
   capacité native fenêtre enregistrée/révoquée, arrêt explicite séparé.
4. Ajouter fixtures packagés lifecycle/Job Object, puis seulement brancher
   l’autorité de continuité Missions. En cas d’échec de ce gate, livrer journal et
   rapports durables mais marquer les admissions headless indisponibles.

## Fondation bootstrap ajoutée après le spike

Le backend dispose désormais d'un canal de renouvellement des preuves sur son
pipe natif de confiance : `CODENOMAD_BOOTSTRAP_REQUEST:{"v":1,"id":"<nonce>"}`
répond par `CODENOMAD_BOOTSTRAP_REPLY:{"v":1,"id":"<nonce>","ok":true,"token":"<proof>"}`.
Il est désactivé hors `NativeParent`, valide une enveloppe bornée et ne retourne
que des erreurs fixes. Aucun endpoint HTTP, cookie durable ou capacité de modèle
n'est ajouté. Le futur manager doit intercepter/expurger ces lignes de ses logs et
ne jamais conserver la preuve dans son registre.

`auth/token-manager.ts` conserve au plus 32 preuves indépendantes, chacune à usage
unique et TTL existant de 60 secondes ; un attach concurrent n'invalide plus la
preuve d'un autre attach. La saturation refuse une nouvelle émission sans révoquer
les précédentes. Tests dédiés et pipeline stdin/shutdown : 10 pass, typecheck serveur
vert. Cette fondation ne prouve pas encore le rattachement d'Electron/Tauri, les
ACL du manager ou la survie à la fermeture de leurs fenêtres.
