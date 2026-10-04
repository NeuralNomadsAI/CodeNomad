// No daemon, service registration, user config, filesystem writes or descendants.
if (process.argv.slice(2).join(" ") !== "service start" || process.env.CNHL_MOCK_ENV !== "unchanged") process.exit(1)
process.stdout.write("mock-service-started:unchanged")
if (process.env.CNHL_MOCK_MODE === "fail") { process.stderr.write("private fixture failure"); process.exitCode = 7 }
if (process.env.CNHL_MOCK_MODE === "hang") { setTimeout(() => process.exit(1), 10000); setInterval(() => {},1000) }
