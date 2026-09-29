import { describe, expect, test } from "bun:test"
import {
  collectSessionTree,
  fetchSessionHistory,
  fetchSessionTreeHistory,
  reconcileSessionHistory,
  type SessionMessageClient,
  type SessionTreeClient,
} from "./history"

describe("fetchSessionHistory", () => {
  test("preserves the SDK session receiver", async () => {
    const client = {
      marker: "session-client",
      async messages(this: { marker: string }, input: { sessionID: string }, options?: { throwOnError?: boolean }) {
        expect(this.marker).toBe("session-client")
        expect(input).toEqual({ sessionID: "session-1" })
        expect(options).toEqual({ throwOnError: true })
        return { data: [{ info: { id: "message-1", sessionID: "session-1" } }] }
      },
    } as unknown as SessionMessageClient

    await expect(fetchSessionHistory(client, "session-1")).resolves.toEqual([
      { id: "message-1", sessionID: "session-1", isContextSnapshot: true, isUsageRecord: true },
    ])
  })

  test("preserves every step-finish usage record for a multi-step message", async () => {
    const client: SessionMessageClient = {
      messages: async () => ({
        data: [
          {
            info: {
              id: "assistant-1",
              sessionID: "session-1",
              role: "assistant",
              providerID: "openai",
              modelID: "gpt-5.6-terra",
              tokens: { input: 300, output: 4, reasoning: 1, cache: { read: 20, write: 2 } },
            },
            parts: [
              {
                id: "step-1",
                type: "step-finish",
                tokens: { input: 100, output: 2, reasoning: 1, cache: { read: 10, write: 1 } },
              },
              {
                id: "step-2",
                type: "step-finish",
                tokens: { input: 200, output: 2, reasoning: 0, cache: { read: 10, write: 1 } },
              },
            ],
          },
        ],
      }),
    }

    await expect(fetchSessionHistory(client, "session-1")).resolves.toEqual([
      {
        id: "assistant-1",
        sessionID: "session-1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-terra",
        tokens: { input: 300, output: 4, reasoning: 1, cache: { read: 20, write: 2 } },
        isContextSnapshot: true,
        isUsageRecord: false,
      },
      {
        id: "assistant-1:step-1",
        sessionID: "session-1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-terra",
        tokens: { input: 100, output: 2, reasoning: 1, cache: { read: 10, write: 1 } },
        isContextSnapshot: false,
        isUsageRecord: true,
      },
      {
        id: "assistant-1:step-2",
        sessionID: "session-1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.6-terra",
        tokens: { input: 200, output: 2, reasoning: 0, cache: { read: 10, write: 1 } },
        isContextSnapshot: false,
        isUsageRecord: true,
      },
    ])
  })

  test("rejects responses without a message array", async () => {
    const client: SessionMessageClient = {
      messages: async () => ({ data: undefined }),
    }

    await expect(fetchSessionHistory(client, "session-1")).rejects.toThrow("no session message history")
  })
})

describe("collectSessionTree", () => {
  test("walks recursive children and protects against cycles", async () => {
    const children = new Map([
      ["root", [{ id: "child", parentID: "root" }]],
      ["child", [{ id: "grandchild", parentID: "child" }]],
      ["grandchild", [{ id: "root", parentID: "grandchild" }]],
    ])
    const client: SessionTreeClient = {
      children: async ({ sessionID }) => ({ data: children.get(sessionID) ?? [] }),
      messages: async () => ({ data: [] }),
    }

    await expect(collectSessionTree(client, "root")).resolves.toEqual({
      sessionIDs: ["root", "child", "grandchild"],
      treeComplete: true,
    })
  })

  test("returns a partial result when a child list cannot be loaded", async () => {
    const client: SessionTreeClient = {
      children: async ({ sessionID }) => {
        if (sessionID === "root") return { data: [{ id: "child", parentID: "root" }] }
        throw new Error("unavailable")
      },
      messages: async () => ({ data: [] }),
    }

    await expect(collectSessionTree(client, "root")).resolves.toEqual({
      sessionIDs: ["root", "child"],
      treeComplete: false,
    })
  })

  test("replaces complete history authoritatively", () => {
    const result = reconcileSessionHistory(
      [
        { id: "stale-root", sessionID: "root" },
        { id: "stale-child", sessionID: "child" },
      ],
      ["root", "child"],
      {
        sessionIDs: ["root", "child"],
        treeComplete: true,
        complete: true,
        loadedSessionIDs: ["root", "child"],
        messages: [{ id: "fresh-root", sessionID: "root" }],
      },
    )

    expect(result.messages).toEqual([{ id: "fresh-root", sessionID: "root" }])
  })

  test("preserves only sessions whose histories failed during a partial load", () => {
    const result = reconcileSessionHistory(
      [
        { id: "stale-root", sessionID: "root" },
        { id: "stale-child", sessionID: "child" },
      ],
      ["root", "child"],
      {
        sessionIDs: ["root", "child"],
        treeComplete: true,
        complete: false,
        loadedSessionIDs: ["root"],
        messages: [{ id: "fresh-root", sessionID: "root" }],
      },
    )

    expect(result.messages).toEqual([
      { id: "fresh-root", sessionID: "root" },
      { id: "stale-child", sessionID: "child" },
    ])
  })

  test("loads messages for every discovered session", async () => {
    const client: SessionTreeClient = {
      children: async ({ sessionID }) => ({
        data: sessionID === "root" ? [{ id: "child", parentID: "root" }] : [],
      }),
      messages: async ({ sessionID }) => ({
        data: [{ info: { id: `${sessionID}-message`, sessionID } }],
      }),
    }

    await expect(fetchSessionTreeHistory(client, "root")).resolves.toEqual({
      sessionIDs: ["root", "child"],
      treeComplete: true,
      complete: true,
      loadedSessionIDs: ["root", "child"],
      messages: [
        { id: "root-message", sessionID: "root", isContextSnapshot: true, isUsageRecord: true },
        { id: "child-message", sessionID: "child", isContextSnapshot: true, isUsageRecord: true },
      ],
    })
  })
})
