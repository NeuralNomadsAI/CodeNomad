# Issue #824 — revue indépendante auth et admission HTTP

## Verdict

**Gates auth et admission HTTP : acceptés, sans finding bloquant.**

La revue porte sur le diff intégré non commité de
`D:\CodeNomad\.codenomad\worktrees\issue-824-performance` depuis `366830f6`,
et non sur les worktrees sources. Les trois fichiers produit transport intégrés
ont exactement les mêmes blobs Git que `d9598e42`. Les changements UI, relais
d'événements, outline et rendu présents simultanément dans le worktree sont hors
périmètre.

Ces corrections ont une causalité plus étroite que l'intitulé général #824 :

- l'auth retire les dérivations scrypt HTTP du thread principal Node ;
- l'admission HTTP retire un observateur local abandonné pendant ses préflights
  et empêche ses continuations tardives ;
- elles ne démontrent ni la cause du blocage natif pendant une vraie compaction,
  ni une saturation HTTP/1 Electron Linux → backend Windows, ni l'élimination du
  freeze global rapporté.

Les deux rapports d'intégration conservent correctement cette limite et ne
promettent pas une correction universelle.

## Findings prioritaires

### Aucun finding P0/P1/P2

Je n'ai trouvé ni autorisation accordée sur un ancien mot de passe, ni replay de
mutation, ni invalidation de connexion partagée sur abandon local, ni forwarding
après annulation de préflight dans le périmètre revu.

### Risques résiduels non bloquants

1. **Saturation du pool libuv non qualifiée.**
   `packages/server/src/auth/password-hash.ts:58-64` rend le thread HTTP
   coopératif via `crypto.scrypt`, mais ne supprime pas le coût CPU/mémoire et ne
   borne pas une rafale de logins. Il n'existait pas de rate limiter sur ces
   routes dans la baseline et le patch n'en retire aucun. Une politique
   d'admission serait un changement séparé, non requis pour accepter ce patch.
2. **Persistance auth toujours synchrone.**
   `packages/server/src/auth/auth-store.ts:176-184` conserve les petites
   écritures synchrones existantes. Les mesures et le correctif concernent la
   dérivation scrypt, pas une garantie d'absence totale de pause filesystem.
3. **Qualification réseau/OS encore absente.**
   Les tests transport utilisent de vrais sockets loopback et le client SDK,
   mais pas Electron Linux vers Windows, suspension/relogin, proxy intermédiaire
   ou limite de connexions Chromium. Le correctif prouve la fuite d'observateur
   et ses fences, pas le scénario utilisateur complet.

## Revue auth

- `packages/server/src/auth/password-hash.ts:23-55` conserve le record v1, le
  sel 16 octets, la clé 64 octets, les paramètres enregistrés et
  `crypto.timingSafeEqual`. Le seul chemin synchrone restant est explicitement
  `hashPasswordSync`, appelé pendant l'initialisation CLI/env avant service.
- `packages/server/src/server/routes/auth.ts:101,150` attend les résultats login
  et password ; la recherche dépôt ne trouve pas d'autre caller produit oublié
  de `validateLogin`, `validateCredentials`, `setPassword` ou `hashPassword`.
- `packages/server/src/auth/auth-store.ts:117-160` sérialise les changements par
  ordre d'admission. La queue absorbe un rejet uniquement pour permettre le
  changement suivant, tandis que le caller original reçoit bien l'erreur. Une
  persistence bootstrap échouée ne supprime pas `bootstrapUsername` et ne publie
  pas de nouveau cache.
- `packages/server/src/auth/auth-store.ts:101-115` relit l'identité du record
  cached après l'await scrypt. Un login dérivé sur l'ancien record est refusé si
  une mutation a persisté entre-temps, sans recalcul ni replay.
- Les réponses 401/409, le cookie, le statut bootstrap, l'override CLI/env et
  l'auth désactivée sont couverts. Aucun mécanisme de rate-limit existant n'est
  modifié.

## Revue admission HTTP

- `packages/server/src/server/request-admission.ts:8-14` observe dès l'entrée
  l'upload `aborted` et le `close` d'une réponse incomplète. Il n'interprète pas
  le `close` normal de l'IncomingMessage comme une déconnexion.
- `packages/server/src/server/request-admission.ts:16-36` fait courir uniquement
  l'attente locale contre l'abandon. La Promise partagée reste observée ; sa
  génération n'est ni annulée ni invalidée et un rejet tardif ne devient pas une
  unhandled rejection.
- `packages/server/src/server/http-server.ts:699-975` transmet le signal aux
  lectures natives qui le supportent (`profile`, session/project, PTY/Shell,
  ownership/location) et entoure les acquisitions/inventaires non annulables par
  `wait()`. Chaque frontière résolue revérifie l'abandon avant de poursuivre.
- Les guards précédant la fence de mutation, l'environnement et le forwarding
  sont présents à `http-server.ts:975`, `989-1015` et `1022-1024`. Le `finally`
  de l'entrée dispose les listeners sur toutes les sorties.
- `packages/server/src/opencode/compatibility/proxy.ts:27-40` installe le listener
  de forwarding avant le fetch puis refuse immédiatement un downstream déjà
  fermé. Après admission native, la sémantique antérieure demeure : abandon de
  la réponse HTTP sans replay ni invalidation de la connexion partagée.
- `packages/server/src/workspaces/manager.ts:270-286` propage le signal à la
  validation native de location. Une annulation éventuellement convertie en
  `false` par son `catch` est réémise par le `wait()` appelant, dont le signal est
  alors aborté ; elle ne devient donc pas une autorisation ou un 403 tardif.

## Validation fraîche

Exécutée depuis le worktree intégré, Windows, Node 25.2.1, sans daemon/profil/base
utilisateur, restart ou déploiement :

```powershell
node --unhandled-rejections=strict --import tsx --test packages/server/src/auth/password-hash.test.ts packages/server/src/server/routes/auth-responsiveness.test.ts packages/server/src/server/routes/auth.test.ts
node --unhandled-rejections=strict --import tsx --test packages/server/src/server/__tests__/instance-proxy-disconnect-diagnostic.test.ts packages/server/src/server/request-admission.test.ts packages/server/src/server/__tests__/instance-proxy.test.ts packages/server/src/server/__tests__/instance-proxy-legacy.test.ts packages/server/src/opencode/compatibility/proxy.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
$env:TEMP='C:\Users\Admin\AppData\Local\Temp\opencode'
$env:TMP=$env:TEMP
node --unhandled-rejections=strict --import tsx --test "packages/server/src/**/*.test.ts"
```

Résultats :

- auth ciblé : **9/9 pass**, sortie naturelle ;
- transport ciblé : **65/65 pass**, sortie naturelle ;
- typecheck serveur : **pass** ;
- gate serveur complet intégré : **799 tests, 793 pass, 0 fail, 6 skips
  déclarés**, sortie naturelle en environ 35,7 s ;
- `git diff --check` ciblé : aucune erreur whitespace (les commandes
  `--no-index` retournent normalement 1 parce que les nouveaux fichiers
  diffèrent de `NUL`; seulement les avertissements LF/CRLF habituels).

Le gate complet contient aussi les autres changements concurrents déjà intégrés ;
il confirme leur composition actuelle avec ces patches, sans attribuer leurs
tests aux deux corrections revues.

## Taille et suite minimale

Les fichiers touchés déjà surdimensionnés restent
`packages/server/src/server/http-server.ts` (~2346 lignes) et
`packages/server/src/workspaces/manager.ts` (~1240 lignes). Aucun refactor de
taille n'est justifié dans cette correction bornée.

Suite minimale recommandée : conserver les patches tels quels et poursuivre
séparément la qualification avec runtime privé d'une vraie compaction et le
scénario Electron Linux → Windows. Ne pas présenter ces deux corrections comme
preuve que la cause native ou le freeze global #824 est résolu.
