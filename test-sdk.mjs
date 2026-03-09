import { Client } from "@opencode-ai/sdk"
import { Session } from "@opencode-ai/sdk/dist/v2/index.js"

// mock client creation just to see if the param is passed as query
const client = new Client({ baseUrl: "http://127.0.0.1:8080" })
const sessionClient = new Session({ client })

console.log(sessionClient.messages.toString())
