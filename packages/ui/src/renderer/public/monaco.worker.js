// Monaco web worker bootstrap.
//
// `workerMain.js` expects `MonacoEnvironment.baseUrl` to be the directory that
// contains the `vs/` folder (so `/monaco/`, not `/monaco/vs`).
self.MonacoEnvironment = { baseUrl: "/monaco/" }

importScripts("/monaco/vs/base/worker/workerMain.js")
