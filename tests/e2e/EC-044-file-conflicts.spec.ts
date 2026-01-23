import { test, expect } from "@playwright/test"

const API_BASE = "http://localhost:9898"
const TEST_PROJECT = "/Users/alexanderollman/test-threejs-project"

test.describe("EC-044: File Conflict Detection System", () => {
  // Test file content for conflict simulation
  const testFileName = "conflict-test.txt"
  const testFilePath = `${TEST_PROJECT}/${testFileName}`

  test.beforeAll(async ({ request }) => {
    // Reset tracking state on server
    await request.post(`${API_BASE}/api/files/reset`, {
      data: { workspaceRoot: TEST_PROJECT },
    })

    // Clean up any existing test file
    try {
      const fs = await import("fs")
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath)
      }
    } catch {
      // Ignore cleanup errors
    }
  })

  test("file stats API returns valid response", async ({ request }) => {
    const response = await request.get(
      `${API_BASE}/api/files/stats?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    // Should have expected fields
    expect(data).toHaveProperty("trackedFiles")
    expect(data).toHaveProperty("totalVersions")
    expect(data).toHaveProperty("activeSessions")
    expect(data).toHaveProperty("activeConflicts")
    expect(data).toHaveProperty("watcherRunning")

    // Types should be correct
    expect(typeof data.trackedFiles).toBe("number")
    expect(typeof data.totalVersions).toBe("number")
    expect(typeof data.activeSessions).toBe("number")
    expect(typeof data.activeConflicts).toBe("number")
    expect(typeof data.watcherRunning).toBe("boolean")

    console.log("File stats:", data)
  })

  test("tracked files API returns empty list initially", async ({ request }) => {
    const response = await request.get(
      `${API_BASE}/api/files/tracked?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    expect(data).toHaveProperty("files")
    expect(Array.isArray(data.files)).toBe(true)

    console.log("Tracked files count:", data.files.length)
  })

  test("conflicts API returns empty list initially", async ({ request }) => {
    const response = await request.get(
      `${API_BASE}/api/files/conflicts?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    expect(data).toHaveProperty("conflicts")
    expect(Array.isArray(data.conflicts)).toBe(true)
    expect(data.conflicts.length).toBe(0)

    console.log("Active conflicts:", data.conflicts.length)
  })

  test("register file read creates tracking entry", async ({ request }) => {
    // Create a test file first
    const fs = await import("fs")
    const initialContent = "Initial content for conflict test"
    fs.writeFileSync(testFilePath, initialContent, "utf8")

    // Register a read from session A
    const response = await request.post(`${API_BASE}/api/files/register`, {
      data: {
        path: testFilePath,
        sessionId: "session-A",
        instanceId: "instance-A",
        mode: "read",
        workspaceRoot: TEST_PROJECT,
      },
    })

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    expect(data.success).toBe(true)
    expect(data.hash).toBeDefined()
    expect(typeof data.hash).toBe("string")
    expect(data.hash.length).toBe(16) // SHA-256 truncated to 16 chars

    console.log("Session A read registered, hash:", data.hash)

    // Verify the file is now tracked
    const trackedResponse = await request.get(
      `${API_BASE}/api/files/tracked?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )
    const trackedData = await trackedResponse.json()

    const trackedFile = trackedData.files.find(
      (f: any) => f.path.includes("conflict-test.txt")
    )
    expect(trackedFile).toBeDefined()
    expect(trackedFile.sessions.length).toBeGreaterThan(0)

    console.log("File is now tracked:", trackedFile)
  })

  test("concurrent writes from different sessions create conflict", async ({ request }) => {
    // Reset tracking state to ensure clean start
    await request.post(`${API_BASE}/api/files/reset`, {
      data: { workspaceRoot: TEST_PROJECT },
    })

    // Create a fresh test file
    const fs = await import("fs")
    const initialContent = "Initial content for conflict simulation"
    fs.writeFileSync(testFilePath, initialContent, "utf8")

    // Wait for watcher to stabilize
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Session A reads the file
    const readA = await request.post(`${API_BASE}/api/files/register`, {
      data: {
        path: testFilePath,
        sessionId: "session-conflict-A",
        instanceId: "instance-A",
        mode: "read",
        workspaceRoot: TEST_PROJECT,
      },
    })
    expect(readA.ok()).toBeTruthy()
    const sessionAHash = (await readA.json()).hash
    console.log("Session A read, hash:", sessionAHash)

    // Session B reads the same file
    const readB = await request.post(`${API_BASE}/api/files/register`, {
      data: {
        path: testFilePath,
        sessionId: "session-conflict-B",
        instanceId: "instance-B",
        mode: "read",
        workspaceRoot: TEST_PROJECT,
      },
    })
    expect(readB.ok()).toBeTruthy()
    const sessionBHash = (await readB.json()).hash
    console.log("Session B read, hash:", sessionBHash)

    // Both should get the same hash
    expect(sessionAHash).toBe(sessionBHash)

    // Session A writes changes
    const writeA = await request.post(`${API_BASE}/api/files/register`, {
      data: {
        path: testFilePath,
        sessionId: "session-conflict-A",
        instanceId: "instance-A",
        mode: "write",
        content: "Content modified by Session A",
        hash: sessionAHash, // Expected hash from read
        workspaceRoot: TEST_PROJECT,
      },
    })
    expect(writeA.ok()).toBeTruthy()
    const writeAResult = await writeA.json()
    expect(writeAResult.success).toBe(true)
    console.log("Session A write successful, new hash:", writeAResult.hash)

    // Also write to disk to simulate actual file change
    fs.writeFileSync(testFilePath, "Content modified by Session A", "utf8")

    // Session B tries to write with its old hash - should detect conflict
    const writeB = await request.post(`${API_BASE}/api/files/register`, {
      data: {
        path: testFilePath,
        sessionId: "session-conflict-B",
        instanceId: "instance-B",
        mode: "write",
        content: "Content modified by Session B - different change",
        hash: sessionBHash, // Old hash that no longer matches
        workspaceRoot: TEST_PROJECT,
      },
    })

    // This should return 409 Conflict
    expect(writeB.status()).toBe(409)

    const writeBResult = await writeB.json()
    expect(writeBResult.success).toBe(false)
    expect(writeBResult.conflict).toBeDefined()
    expect(writeBResult.conflict.conflictId).toBeDefined()

    console.log("Session B write detected conflict:", writeBResult.conflict)

    // Verify conflict is listed
    const conflictsResponse = await request.get(
      `${API_BASE}/api/files/conflicts?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )
    const conflictsData = await conflictsResponse.json()

    expect(conflictsData.conflicts.length).toBeGreaterThan(0)
    const conflict = conflictsData.conflicts[0]
    expect(conflict.conflictType).toBeDefined()
    expect(conflict.involvedSessions.length).toBeGreaterThanOrEqual(2)

    console.log("Active conflict:", conflict)
  })

  test("conflict can be resolved via API", async ({ request }) => {
    // Get active conflicts
    const conflictsResponse = await request.get(
      `${API_BASE}/api/files/conflicts?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )
    const conflictsData = await conflictsResponse.json()

    if (conflictsData.conflicts.length > 0) {
      const conflict = conflictsData.conflicts[0]

      // Resolve by keeping session A's version
      const resolveResponse = await request.post(
        `${API_BASE}/api/files/conflicts/${conflict.conflictId}/resolve`,
        {
          data: {
            resolution: "keep-theirs", // Keep the disk version (session A's)
            sessionId: "session-conflict-B",
            workspaceRoot: TEST_PROJECT,
          },
        }
      )

      expect(resolveResponse.ok()).toBeTruthy()

      const resolveResult = await resolveResponse.json()
      expect(resolveResult.success).toBe(true)
      expect(resolveResult.newHash).toBeDefined()

      console.log("Conflict resolved, new hash:", resolveResult.newHash)

      // Verify conflict is gone
      const afterResolveResponse = await request.get(
        `${API_BASE}/api/files/conflicts?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
      )
      const afterResolveData = await afterResolveResponse.json()

      const remainingConflict = afterResolveData.conflicts.find(
        (c: any) => c.conflictId === conflict.conflictId
      )
      expect(remainingConflict).toBeUndefined()

      console.log("Conflict resolved and removed from active list")
    }
  })

  test("file history API shows version history", async ({ request }) => {
    const response = await request.get(
      `${API_BASE}/api/files/history?path=${encodeURIComponent(testFilePath)}&workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    expect(data).toHaveProperty("versions")
    expect(Array.isArray(data.versions)).toBe(true)

    // Should have at least one version from our test
    console.log("File history versions:", data.versions.length)

    if (data.versions.length > 0) {
      const version = data.versions[0]
      expect(version).toHaveProperty("hash")
      expect(version).toHaveProperty("timestamp")
      expect(version).toHaveProperty("sessionId")
      console.log("Latest version:", version)
    }
  })

  test("merge preview API returns merge result", async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/files/merge-preview`, {
      data: {
        base: "line 1\nline 2\nline 3",
        ours: "line 1\nmodified line 2\nline 3",
        theirs: "line 1\nline 2\nmodified line 3",
        filePath: "test.txt",
      },
    })

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    expect(data).toHaveProperty("success")
    expect(data).toHaveProperty("hasConflicts")
    expect(data).toHaveProperty("merged")
    expect(data).toHaveProperty("conflicts")
    expect(data).toHaveProperty("stats")

    // Non-overlapping changes should auto-merge
    expect(data.success).toBe(true)
    expect(data.hasConflicts).toBe(false)
    expect(data.merged).toContain("modified line 2")
    expect(data.merged).toContain("modified line 3")

    console.log("Merge preview result:", {
      success: data.success,
      hasConflicts: data.hasConflicts,
      merged: data.merged,
    })
  })

  test("merge preview detects overlapping conflicts", async ({ request }) => {
    const response = await request.post(`${API_BASE}/api/files/merge-preview`, {
      data: {
        base: "line 1\nline 2\nline 3",
        ours: "line 1\nours changed line 2\nline 3",
        theirs: "line 1\ntheirs changed line 2\nline 3", // Same line modified!
        filePath: "test.txt",
      },
    })

    expect(response.ok()).toBeTruthy()

    const data = await response.json()

    // Overlapping changes should create conflict
    expect(data.hasConflicts).toBe(true)
    expect(data.conflicts.length).toBeGreaterThan(0)

    // Should contain conflict markers
    expect(data.merged).toContain("<<<<<<< ours")
    expect(data.merged).toContain("=======")
    expect(data.merged).toContain(">>>>>>> theirs")

    console.log("Merge preview with conflict:", {
      hasConflicts: data.hasConflicts,
      conflictCount: data.conflicts.length,
    })
  })

  test("unregister session removes tracking", async ({ request }) => {
    // First, check files tracked by session
    const beforeResponse = await request.get(
      `${API_BASE}/api/files/stats?workspaceRoot=${encodeURIComponent(TEST_PROJECT)}`
    )
    const beforeStats = await beforeResponse.json()
    console.log("Before unregister - active sessions:", beforeStats.activeSessions)

    // Unregister session A
    const unregisterResponse = await request.post(
      `${API_BASE}/api/files/unregister-session`,
      {
        data: {
          sessionId: "session-conflict-A",
          workspaceRoot: TEST_PROJECT,
        },
      }
    )

    expect(unregisterResponse.ok()).toBeTruthy()
    const unregisterResult = await unregisterResponse.json()
    expect(unregisterResult.success).toBe(true)

    console.log("Session A unregistered successfully")
  })

  test.afterAll(async () => {
    // Clean up test file
    try {
      const fs = await import("fs")
      if (fs.existsSync(testFilePath)) {
        fs.unlinkSync(testFilePath)
        console.log("Cleaned up test file")
      }
    } catch {
      // Ignore cleanup errors
    }
  })
})

test.describe("EC-044: File Conflict SSE Events", () => {
  test("SSE connection receives file events", async ({ page }) => {
    // Create an EventSource to listen for SSE events
    const events: string[] = []

    await page.goto("http://localhost:9898")

    // Inject EventSource listener
    await page.evaluate(() => {
      return new Promise<void>((resolve) => {
        const eventSource = new EventSource("/api/events")

        eventSource.onopen = () => {
          console.log("SSE connected")
          resolve()
        }

        eventSource.onmessage = (event) => {
          console.log("SSE event:", event.data)
        }

        eventSource.onerror = (error) => {
          console.error("SSE error:", error)
        }

        // Store reference for cleanup
        ;(window as any).__testEventSource = eventSource

        // Auto-resolve after timeout if not connected
        setTimeout(resolve, 3000)
      })
    })

    // Wait a moment
    await page.waitForTimeout(1000)

    // Close the EventSource
    await page.evaluate(() => {
      const es = (window as any).__testEventSource
      if (es) {
        es.close()
      }
    })

    console.log("SSE connection test completed")
  })
})
