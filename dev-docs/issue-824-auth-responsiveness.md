# #824 — coopération du serveur pendant les calculs de mot de passe

## Périmètre et résultat

Tâche initiale `auth-loop-responsiveness`, branche `fix/issue-824-auth`, worktree
`D:\CodeNomad\.codenomad\worktrees\issue-824-auth`, baseline `366830f6`.
Intégration `integrate-auth` dans
`D:\CodeNomad\.codenomad\worktrees\issue-824-performance` : sept fichiers
autorisés seulement, via patch tool, sans réinstallation des dépendances.

Défaut confirmé puis corrigé : les routes de login et de changement de mot de
passe exécutent une dérivation scrypt coûteuse sur le thread HTTP partagé.
Les dérivations HTTP utilisent maintenant `crypto.scrypt`, sur le pool libuv,
et leurs callers attendent le résultat. Aucun changement logout, compaction,
transport SSE, daemon OpenCode ou configuration utilisateur par ces tâches.

## Reproduction comportementale rouge

`packages/server/src/server/routes/auth-responsiveness.test.ts` utilise le vrai
Fastify, les vraies routes et un vrai AuthManager. Chaque fixture crée un
`auth.json` v1 privé sous `%TEMP%/opencode/codenomad-auth-responsive-*`, avec un
hachage produit indépendamment par l'ancienne API synchrone. Elle ferme Fastify
et supprime uniquement son propre répertoire à la fin.

Deux rafales bornées : 8 logins invalides, puis 4 changements authentifiés de
mot de passe. À l'entrée du premier calcul, un `setImmediate` programme un GET
sur un endpoint témoin, qui observe le nombre d'opérations encore en cours.
L'assertion exige que le témoin s'exécute **avant la fin de tous les calculs**.
Les durées ne sont que des diagnostics, sans assertion de seuil en ms.
Le corps des méthodes, le calcul cryptographique et les handlers ne sont pas
remplacés ; les wrappers ne font que compter et chronométrer.

Avant modification produit, les deux tests ont échoué : témoin après les
8/8 logins (~169 ms), et après les 4/4 changements (~84 ms). Réponses correctes
mais aucun travail témoin pendant la rafale. Chaque appel bloquait ~21 ms.

Après modification, l'ancien code a été recopié par `git show 366830f6:<path>`
dans une fixture privée sous le `node_modules/.cache` du worktree **source**,
avec les tests courants. Les deux mêmes assertions échouent dans chacune des
5 exécutions rouges. Aucun checkout ni fichier produit n'a été inversé pour
ce contrôle.

Fixture baseline retenue localement (non versionnée, dans `issue-824-auth`,
non recopiée dans le worktree mission) :
`node_modules/.cache/auth-baseline-4193325c8f9a4bcd973718259e94c2f6`.
Elle contient `auth/{auth-store,manager,password-hash,http-auth,token-manager,session-manager}.ts`,
`server/routes/auth.ts` de la baseline et le test de réactivité courant ; les
imports de dépendances utilisent seulement le node_modules du worktree source.

## Mesures exécutées rouge / vert (tâche initiale)

Windows x64, Node `v25.2.1`, pool libuv par défaut (4), mêmes paramètres scrypt.
Cinq processus Node distincts par variante, tests témoins seuls ; pas de seuil
de performance ni de conclusion statistique au-delà de ces échantillons.

| Mesure (médiane des 5 runs) | Baseline | Correctif initial |
| --- | ---: | ---: |
| Témoin pendant les 8 logins | 168,63 ms | 3,37 ms |
| Durée totale des 8 logins | 179,23 ms | 67,33 ms |
| Témoin pendant les 4 changements | 82,43 ms | 0,80 ms |
| Durée totale des 4 changements | 84,23 ms | 93,57 ms |
| État au témoin : logins encore en cours | 0/8 | 8/8 |
| État au témoin : changements encore en cours | 0/4 | 4/4 |

Échantillons témoin, en ms, dans l'ordre des runs :

- Rouge login : 187,0279 ; 163,5008 ; 161,1307 ; 168,6303 ; 173,3027.
- Vert login : 4,6347 ; 3,3659 ; 2,9695 ; 3,1687 ; 3,7206.
- Rouge password : 91,9619 ; 82,9719 ; 82,2616 ; 82,4302 ; 82,1526.
- Vert password : 1,1573 ; 0,6115 ; 0,6394 ; 0,7956 ; 1,6040.

La sérialisation des changements vise la cohérence, pas leur débit. Leur temps
total n'est pas amélioré ; le témoin et donc la coopération du thread HTTP le
sont. Le coût CPU scrypt n'est pas supprimé.

## Correction et garanties

- Format v1, sel aléatoire 16 octets, clé 64 octets, paramètres par défaut
  `N=16384, r=8, p=1, maxmem=32 MiB` inchangés.
- Vérification avec les paramètres enregistrés et comparaison
  `crypto.timingSafeEqual` conservées ; longueur incompatible et algorithme
  inconnu restent des refus. Les erreurs crypto deviennent des rejets attendus.
- Login attend le booléen, sinon une Promise truthy aurait autorisé les mauvais
  mots de passe. Password attend le calcul **et la persistence** avant succès,
  et attrape les rejets pour conserver la réponse 409 text/plain.
- AuthStore sérialise uniquement les changements de mot de passe par ordre
  d'admission. Un échec ne bloque pas les suivants ; le bootstrap ne perd pas
  son identité entre deux calculs ; le dernier changement admis gagne.
- Lors de l'intégration, une fence d'identité du record d'autorité a été ajoutée
  après la dérivation : `valid && this.load() === auth`. Un changement réussi
  remplace le record cached ; un échec ne le remplace pas. Une dérivation sur
  un ancien record ne peut plus accorder de session après son remplacement.
  Aucun nouveau calcul ni replay automatique du login.
- Désactivation d'auth, override CLI/env et cookies conservent leur sémantique.
- Le hachage synchrone de l'override CLI/env reste explicitement nommé
  `hashPasswordSync`, appelé seulement par `ensureInitialized` au constructeur,
  avant le service HTTP. Cela évite d'élargir cette correction au cycle de
  démarrage. Les lectures/petites écritures auth.json synchrones ne changent pas.
- Recherche des callers effectuée dans le dépôt : les deux handlers HTTP sont
  les seuls callers produit de validateLogin/setPassword ; les await ont été
  ajoutés. Le typecheck serveur valide cette propagation.
- Aucun rate limiter explicite n'a été trouvé dans les routes/auth courantes :
  aucun mécanisme existant n'est retiré, et aucun nouveau n'est introduit ici.

## Validation et commandes

```powershell
node --import tsx --test packages/server/src/auth/password-hash.test.ts packages/server/src/server/routes/auth-responsiveness.test.ts packages/server/src/server/routes/auth.test.ts
npm run typecheck --workspace @neuralnomads/codenomad
git diff --check
```

Tâche initiale : 8 tests verts, répétés cinq fois (40/40 exécutions de tests),
puis 5 runs verts supplémentaires des seuls tests témoins. Typecheck serveur
vert. Diff check sans erreur (avertissements Git habituels LF/CRLF seulement).

Intégration : les sept chemins cibles étaient sans modifications au départ.
Les quatre fichiers produit et les deux tests ont été repris via patch tool ;
seuls `auth-store.ts` et le test de réactivité ont été enrichis pour la course
de changement de mot de passe. Le rapport source est repris et actualisé ici.
Les changements voisins de mission ne sont pas touchés.

### Course login / changement de mot de passe : rouge puis vert déterministe

Le test `rejects a pending login verified against a password replaced before
verification returns` fait réellement dériver l'ancien mot de passe par
`crypto.scrypt`, mais retient son callback. Il enregistre ensuite un nouveau
mot de passe par la vraie route `/api/auth/password` et vérifie le nouveau
secret, avant de libérer l'ancien callback. Il ne suppose aucune durée ni
ordre implicite du scheduler. Le mock est restauré et les requêtes privées
sont drainées avant fermeture.

Sur le correctif initial intégré sans fence : échec attendu, **200 au lieu de
401**, après le succès de la mutation password. Après ajout de la fence :
**401 Invalid credentials sans Set-Cookie**, nouveau secret valide, ancien
secret refusé. L'authentification ne réutilise pas une autorité remplacée.

La suite intégrée passe **9/9 tests**, dont les 8 tests précédents et ce nouveau
cas ; elle a été rejouée trois fois supplémentaires (27/27 verts).
Typecheck serveur vert. Exemple de diagnostics au run intégré : témoin
login 3,29 ms avec 8 opérations encore en cours ; password 0,52 ms avec 4 en
cours. Ces mesures sont descriptives et séparées du tableau A/B initial.

```powershell
node --import tsx --test --test-name-pattern='rejects a pending login' packages/server/src/server/routes/auth-responsiveness.test.ts
```

Commande témoin courte, utilisable sur le correctif ou avec le chemin du test
dans la fixture baseline source ci-dessus :

```powershell
node --import tsx --test --test-name-pattern='services a witness' packages/server/src/server/routes/auth-responsiveness.test.ts
```

Couverture : ancien hachage v1, paramètres personnalisés, nouveau hachage lu
par scryptSync indépendant, mot de passe et utilisateur invalides, login valide
et cookie, refus de password non authentifié, erreurs override/désactivation,
bootstrap concurrent, ordre des changements, échec persistence puis reprise,
réactivité login/password, autorité remplacée pendant une vérification et
compatibilité du test login HTML existant.

Installation isolée initiale des dépendances par `npm ci --ignore-scripts`
(lockfile inchangé). npm signale 49 vulnérabilités préexistantes ; pas de
`npm audit fix` ni de mise à jour hors périmètre. Aucune réinstallation lors
de l'intégration ; dépendances de mission existantes uniquement.

## Limites et suite minimale

- Les requêtes passent par `Fastify.inject`/light-my-request, pas par un socket
  réseau ni Chromium. Ceci isole le défaut du thread HTTP, sans prétendre
  reproduire la saturation HTTP Linux→Windows, SSE ou compaction.
- Scrypt utilise toujours du CPU/de la mémoire et partage le pool libuv avec
  d'autres opérations. La saturation du pool et les rafales non bornées ne sont
  pas qualifiées ici ; une politique d'admission serait un travail séparé.
- La fence compare l'autorité cached/override de ce processus, comme le store
  existant. Elle ne crée pas de surveillance des changements externes du
  fichier auth.json ni de révocation des sessions déjà accordées.
- Aucun serveur utilisateur, daemon partagé, profil, desktop ou base native
  OpenCode utilisé ; aucun restart, déploiement, commit ou push.
- Intégration effectuée ; revue indépendante et validation finale de mission
  restent nécessaires. Aucune correction logout ou politique rate-limit.

## Fichiers du patch

1. `packages/server/src/auth/password-hash.ts`
2. `packages/server/src/auth/auth-store.ts`
3. `packages/server/src/auth/manager.ts`
4. `packages/server/src/server/routes/auth.ts`
5. `packages/server/src/auth/password-hash.test.ts` (nouveau)
6. `packages/server/src/server/routes/auth-responsiveness.test.ts` (nouveau)
7. `dev-docs/issue-824-auth-responsiveness.md` (ce rapport)

Tous les fichiers source/test modifiés restent sous les seuils AGENTS.
