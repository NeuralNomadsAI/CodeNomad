# Issue 824 — revue des barrières d'événements

## Verdict

Revue indépendante, bornée au diff depuis `366830f6`, de
`packages/ui/src/lib/server-events.ts`,
`packages/server/src/workspaces/opencode-service.ts` et de leurs nouveaux tests.

La correction serveur est sûre pour le modèle de partage réel de
`@opencode/client` 2.0.21 : l'arrêt d'un abonné ne détruit plus la connexion
logique partagée, tandis qu'une vraie fin ou erreur amont invalide encore la
génération qui l'a produite. La correction UI isole correctement une exception
synchrone levée directement par un callback et conserve l'ordre FIFO. Aucun
blocage fonctionnel n'a été trouvé dans ces deux corrections.

Il reste toutefois une limite UI confirmée et une faiblesse de diagnostic à ne
pas présenter comme entièrement résolues.

## Constats

### M1 — une erreur Solid différée au flush échappe encore à l'isolation par abonné

`ServerEvents.notify()` entoure l'appel direct du callback, mais
`dispatchBatch()` entoure tous les callbacks d'un `solidBatch`. Une dérivation
Solid déclenchée par un setter peut donc lever seulement lors du flush final de
`solidBatch`, après le retour de `notify()`. Cette erreur sort à la ligne du
`solidBatch`, puis est capturée par le `catch` englobant de
`attachEventSourceHandlers`, qui la journalise à tort comme `Failed to parse
event`.

Reproduction isolée avec la distribution navigateur de Solid : un
`createMemo` qui lève après `setSignal()` imprime `after-set`, puis l'exception
est capturée autour de `batch()`, pas autour du setter. Le fixture navigateur
actuel ne couvre qu'un `throw` direct dans le callback et affirme justement
l'absence de `Failed to parse event`; il ne détecterait pas cette variante.

Impact borné : les callbacks natifs et typés du même lot sont invoqués avant le
flush, donc l'événement n'est pas supprimé pour ces abonnés. En revanche, le
flush réactif peut être interrompu et le diagnostic accuse le transport. Le
plus petit suivi utile est un test navigateur où un abonné écrit un signal dont
une dérivation lève, puis une décision explicite sur la frontière de batch
(isoler aussi le flush par abonné, ou au minimum séparer le diagnostic de
dispatch du parsing).

### L1 — le diagnostic ajouté est désactivé par défaut

`log.error()` utilise le logger `debug` de l'espace `sse`; les espaces sont
désactivés par défaut. Les tests remplacent directement `getLogger("sse").error`
et prouvent que la méthode est appelée, mais pas qu'un utilisateur ou un rapport
de diagnostic voit l'échec en configuration normale. De plus, `kind` distingue
le type d'événement mais pas le bucket wildcard/typé ni l'abonné fautif.

La capture est préférable à la rupture du flux et ne constitue pas un bug de
réactivité. Si ces exceptions doivent être exploitables sur le terrain, ajouter
un canal borné réellement collecté et un identifiant de catégorie d'abonné,
sans contenu d'événement ni rejeu.

### L2 — course abort local / panne amont non déterminisée

Le choix `if (!signal?.aborted) invalidateConnection(connection)` donne à
l'abort local la priorité lorsqu'il est simultané à une erreur de `next()`.
Avec `SharedEvents`, l'abort retire l'abonné local; une panne physique peut alors
être observée seulement par un autre abonné direct, sans invalider immédiatement
`OpenCodeSharedService`.

Le risque paraît faible et auto-récupérable : la tentative suivante du bridge
rouvre le flux partagé; son échec non annulé invalide alors la connexion, et les
mutations ordinaires invalident également sur erreur. Ne pas modifier la logique
sans reproduction. Ajouter au besoin un test à barrières contrôlées où abort et
rejet amont concourent, puis vérifier qu'une reconnexion échouée renouvelle bien
le client.

## Propriétés vérifiées

- Le SDK 2.0.21 partage un seul flux physique et maintient des files par abonné;
  `return()`/abort suppriment seulement l'abonné et arrêtent la source uniquement
  quand il ne reste aucun abonné.
- `invalidateAfterStream()` distingue correctement :
  - erreur/EOF de `iterator.next()` non annulé : invalidation;
  - `return`, `throw` consommateur ou abort local : nettoyage par
    `iterator.return()` sans invalidation;
  - événement d'une ancienne génération : `assertCurrent()` rejette avant le
    `yield`, et l'invalidation conditionnelle ne peut pas évincer le remplacement.
- Le `finally` appelle toujours `iterator.return()`; avec le SDK réel cet appel
  est résolu sans rejet.
- Le dispatch UI continue après un `throw` direct, sans rejeu, pour les abonnés
  wildcard, typés, open et status; le test FIFO/unsubscribe traverse le vrai
  EventSource, les routes SSE et le réducteur natif.
- Les callbacks enregistrés dans le produit sont synchrones; aucun abonné
  `async` actuel ne crée de rejet de promesse non capturé à cette frontière.

## Validation exécutée

- `node --import tsx --test --test-concurrency=1 packages/ui/tests/browser/event-subscriber-isolation.test.ts` — **4/4 vert**.
- `npm exec --yes tsx -- --test packages/server/src/workspaces/subscriber-lifetime.test.ts packages/server/src/workspaces/opencode-connection-generation.test.ts` — **10/10 vert**.
- `node --import tsx --test packages/server/src/workspaces/opencode-service.test.ts` — **14/14 vert**.
- `node --import tsx --test packages/server/src/workspaces/instance-events.test.ts packages/server/src/workspaces/instance-event-routing.test.ts` — **31/31 vert**.
- `npm run typecheck --workspace @neuralnomads/codenomad` — vert.
- `npm run typecheck --workspace @codenomad/ui` — vert.
- `git diff --check` sur les fichiers revus — vert (seuls avertissements de
  conversion LF/CRLF du worktree).

Le lancement global `test:browser` avec un filtre placé après le glob a été
interrompu à 120 s car le runner a commencé d'autres fixtures; il ne constitue
pas un échec de test. Le fichier navigateur ciblé a ensuite été exécuté seul et
est vert.

## Taille des fichiers touchés

Aucun fichier produit revu ne dépasse le seuil d'avertissement :
`server-events.ts` ~219 lignes et `opencode-service.ts` ~360 lignes. Les nouveaux
tests font respectivement ~123 et ~116 lignes.
