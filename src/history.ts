import type { TokenUsage, UsageMessage } from "./metrics"

export type SessionMessageClient = {
  messages: (
    input: { sessionID: string },
    options?: { throwOnError?: boolean },
  ) => Promise<{ data?: unknown }>
}

export type SessionTreeClient = SessionMessageClient & {
  children: (
    input: { sessionID: string },
    options?: { throwOnError?: boolean },
  ) => Promise<{ data?: unknown }>
}

export type SessionTreeResult = {
  sessionIDs: string[]
  treeComplete: boolean
}

export type SessionTreeHistory = SessionTreeResult & {
  complete: boolean
  messages: UsageMessage[]
  loadedSessionIDs: string[]
}

export type ReconciledSessionHistory = {
  sessionIDs: string[]
  messages: UsageMessage[]
}

type SessionRecord = {
  id: string
  parentID?: string
}

type StepFinishPart = {
  id?: unknown
  type?: unknown
  tokens?: TokenUsage
}

function extractInfoMessages(value: unknown): UsageMessage[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((record) => {
    if (!record || typeof record !== "object") return []
    const raw = record as { info?: unknown; parts?: unknown }
    if (!raw.info || typeof raw.info !== "object") return []

    const info = raw.info as UsageMessage
    const parts = Array.isArray(raw.parts)
      ? raw.parts.filter((part): part is StepFinishPart => {
          if (!part || typeof part !== "object") return false
          const candidate = part as StepFinishPart
          return candidate.type === "step-finish" && Boolean(candidate.tokens)
        })
      : []
    const snapshot: UsageMessage = {
      ...info,
      isContextSnapshot: true,
      isUsageRecord: parts.length === 0,
    }
    const steps = parts.map((part, index): UsageMessage => ({
      ...info,
      id: info.id ? `${info.id}:${typeof part.id === "string" ? part.id : index}` : undefined,
      tokens: part.tokens,
      isContextSnapshot: false,
      isUsageRecord: true,
    }))

    return [snapshot, ...steps]
  })
}

function extractSessionRecords(value: unknown): SessionRecord[] {
  if (!Array.isArray(value)) return []

  return value.flatMap((record) => {
    if (!record || typeof record !== "object") return []
    const session = record as { id?: unknown; parentID?: unknown }
    if (typeof session.id !== "string") return []
    return [
      {
        id: session.id,
        parentID: typeof session.parentID === "string" ? session.parentID : undefined,
      },
    ]
  })
}

function mergeMessages(history: readonly UsageMessage[], live: readonly UsageMessage[]): UsageMessage[] {
  const keyed = new Map<string, UsageMessage>()
  const unkeyed: UsageMessage[] = []

  for (const message of [...history, ...live]) {
    if (message.id) keyed.set(message.id, message)
    else unkeyed.push(message)
  }

  return [...keyed.values(), ...unkeyed]
}

export function reconcileSessionHistory(
  current: readonly UsageMessage[],
  previousSessionIDs: readonly string[],
  result: SessionTreeHistory,
): ReconciledSessionHistory {
  const activeSessions = new Set(
    result.treeComplete ? result.sessionIDs : [...previousSessionIDs, ...result.sessionIDs],
  )
  if (result.complete) return { sessionIDs: [...activeSessions], messages: result.messages }

  const loadedSessions = new Set(result.loadedSessionIDs)
  const retained = current.filter(
    (message) => !message.sessionID || (activeSessions.has(message.sessionID) && !loadedSessions.has(message.sessionID)),
  )
  return { sessionIDs: [...activeSessions], messages: mergeMessages(result.messages, retained) }
}

export async function fetchSessionHistory(client: SessionMessageClient, sessionID: string): Promise<UsageMessage[]> {
  const response = await client.messages.call(client, { sessionID }, { throwOnError: true })
  if (!Array.isArray(response.data)) throw new Error("OpenCode returned no session message history")
  return extractInfoMessages(response.data)
}

export async function fetchSessionChildren(client: SessionTreeClient, sessionID: string): Promise<SessionRecord[]> {
  const response = await client.children.call(client, { sessionID }, { throwOnError: true })
  if (!Array.isArray(response.data)) throw new Error("OpenCode returned no child session list")
  return extractSessionRecords(response.data)
}

export async function collectSessionTree(client: SessionTreeClient, rootID: string): Promise<SessionTreeResult> {
  const visited = new Set<string>([rootID])
  const queue = [rootID]
  let complete = true

  while (queue.length > 0) {
    const sessionID = queue.shift()!
    let children: SessionRecord[]
    try {
      children = await fetchSessionChildren(client, sessionID)
    } catch {
      complete = false
      continue
    }

    for (const child of children) {
      if (visited.has(child.id)) continue
      visited.add(child.id)
      queue.push(child.id)
    }
  }

  return { sessionIDs: [...visited], treeComplete: complete }
}

export async function fetchSessionTreeHistory(
  client: SessionTreeClient,
  rootID: string,
): Promise<SessionTreeHistory> {
  const tree = await collectSessionTree(client, rootID)
  const messages: UsageMessage[] = []
  const loadedSessionIDs: string[] = []
  let complete = tree.treeComplete

  for (const sessionID of tree.sessionIDs) {
    try {
      messages.push(...(await fetchSessionHistory(client, sessionID)))
      loadedSessionIDs.push(sessionID)
    } catch {
      complete = false
    }
  }

  return { ...tree, complete, messages, loadedSessionIDs }
}
