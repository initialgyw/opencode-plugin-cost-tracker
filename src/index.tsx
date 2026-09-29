/** @jsxImportSource @opentui/solid */

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  contextPercent,
  contextTokens,
  estimateCost,
  latestAssistantMessage,
  parseProviderPricing,
  pricingForMessage,
  usageByModel,
  type CustomPricing,
  type ModelIdentity,
  type ModelUsage,
  type UsageMessage,
} from "./metrics"
import {
  compactModelName,
  disambiguateModelLabels,
  formatEstimate,
  formatMoney,
  formatTokenCount,
  modelMetricRows,
  type MetricRow,
} from "./presentation"
import {
  fetchSessionTreeHistory,
  reconcileSessionHistory,
  type SessionTreeClient,
} from "./history"

const PLUGIN_ID = "opencode-plugin-cost-tracker"
const BUILTIN_CONTEXT_PLUGIN_ID = "internal:sidebar-context"

type ProviderModel = ModelIdentity & { id?: string }
type HistoryStatus = "loading" | "complete" | "partial" | "unavailable"

type TokenMetricsProps = {
  api: TuiPluginApi
  sessionID: string
  customPricing: CustomPricing
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${value}% used`
}

function findModel(api: TuiPluginApi, message: UsageMessage | undefined): ProviderModel | undefined {
  if (!message?.providerID || !message.modelID) return undefined

  const provider = api.state.provider.find((item) => item.id === message.providerID)
  const model = provider?.models[message.modelID] as ProviderModel | undefined
  if (!model) return undefined

  return { ...model, id: message.modelID }
}

function modelKey(group: ModelUsage): string {
  return `${group.providerID}/${group.modelID}`
}

function baseModelLabel(api: TuiPluginApi, group: ModelUsage): string {
  const model = findModel(api, { providerID: group.providerID, modelID: group.modelID })
  return compactModelName(group.modelID, model?.name)
}

function metricLine(row: MetricRow, historyComplete: boolean): string {
  const tokens = formatTokenCount(row.tokens)
  const cost = row.cost === undefined ? "N/A" : `${formatMoney(row.cost)}${historyComplete ? "" : "+"}`
  return `  ${row.label.padEnd(8)} ${tokens.padStart(7)} (${cost})`
}

function mergeMessages(history: readonly UsageMessage[], live: readonly UsageMessage[]): UsageMessage[] {
  const keyed = new Map<string, UsageMessage>()
  const unkeyed: UsageMessage[] = []

  for (const message of [...history, ...live]) {
    if (message.id) {
      keyed.set(message.id, message)
    } else {
      unkeyed.push(message)
    }
  }

  return [...keyed.values(), ...unkeyed]
}

function mergeLiveMessages(history: readonly UsageMessage[], live: readonly UsageMessage[]): UsageMessage[] {
  const normalized = live.map((message) => {
    if (!message.id) return message
    const hasStepUsage = history.some(
      (item) => item.id?.startsWith(`${message.id}:`) && item.isUsageRecord !== false,
    )
    return {
      ...message,
      isContextSnapshot: true,
      isUsageRecord: !hasStepUsage,
    }
  })
  return mergeMessages(history, normalized)
}

function TokenMetrics(props: TokenMetricsProps) {
  const theme = () => props.api.theme.current
  const [history, setHistory] = createSignal<readonly UsageMessage[]>([])
  const [sessionIDs, setSessionIDs] = createSignal<readonly string[]>([props.sessionID])
  const [historyStatus, setHistoryStatus] = createSignal<HistoryStatus>("loading")

  onMount(() => {
    let disposed = false
    let loadVersion = 0
    const isTrackedSession = (sessionID: string) => sessionIDs().includes(sessionID)
    const upsertHistoryMessage = (message: UsageMessage) => {
      setHistory((current) => {
        const hasStepUsage = current.some(
          (item) => item.id?.startsWith(`${message.id}:`) && item.isUsageRecord !== false,
        )
        const updated = mergeMessages(current, [
          {
            ...message,
            isContextSnapshot: true,
            isUsageRecord: !hasStepUsage,
          },
        ])
        return updated.map((item) =>
          item.id?.startsWith(`${message.id}:`)
            ? { ...item, providerID: message.providerID ?? item.providerID, modelID: message.modelID ?? item.modelID }
            : item,
        )
      })
    }
    const removeHistoryMessage = (messageID: string) => {
      setHistory((current) =>
        current.filter((message) => message.id !== messageID && !message.id?.startsWith(`${messageID}:`)),
      )
    }
    const upsertHistoryStep = (sessionID: string, part: unknown) => {
      if (!part || typeof part !== "object") return
      const step = part as { id?: unknown; messageID?: unknown; type?: unknown; tokens?: unknown }
      if (
        step.type !== "step-finish" ||
        typeof step.id !== "string" ||
        typeof step.messageID !== "string" ||
        !step.tokens ||
        typeof step.tokens !== "object"
      ) return

      const parent = [...history(), ...props.api.state.session.messages(sessionID)].find(
        (message) => message.id === step.messageID,
      ) as UsageMessage | undefined
      const stepMessage: UsageMessage = {
        ...parent,
        id: `${step.messageID}:${step.id}`,
        sessionID,
        role: "assistant",
        providerID: parent?.providerID,
        modelID: parent?.modelID,
        tokens: step.tokens as UsageMessage["tokens"],
        isContextSnapshot: false,
        isUsageRecord: true,
      }
      setHistory((current) => {
        const withSnapshot = current.map((message) =>
          message.id === step.messageID ? { ...message, isContextSnapshot: true, isUsageRecord: false } : message,
        )
        return mergeMessages(withSnapshot, [stepMessage])
      })
    }
    const removeHistoryStep = (messageID: string, partID: string) => {
      setHistory((current) => {
        const filtered = current.filter((message) => message.id !== `${messageID}:${partID}`)
        const hasSteps = filtered.some(
          (message) => message.id?.startsWith(`${messageID}:`) && message.isUsageRecord !== false,
        )
        if (hasSteps) return filtered
        return filtered.map((message) =>
          message.id === messageID ? { ...message, isUsageRecord: true } : message,
        )
      })
    }
    let reloadInFlight = false
    let reloadQueued = false
    let reloadTimer: ReturnType<typeof setTimeout> | undefined
    let partialRetryTimer: ReturnType<typeof setTimeout> | undefined
    let partialRetryCount = 0
    const reloadTree = async () => {
      if (reloadInFlight) {
        reloadQueued = true
        return
      }

      reloadInFlight = true
      do {
        reloadQueued = false
        const version = ++loadVersion
        setHistoryStatus("loading")

        try {
          const result = await fetchSessionTreeHistory(
            props.api.client.session as unknown as SessionTreeClient,
            props.sessionID,
          )
          if (disposed) break
          if (version !== loadVersion) continue

          const reconciled = reconcileSessionHistory(history(), sessionIDs(), result)
          setSessionIDs(reconciled.sessionIDs)
          setHistory(reconciled.messages)
          if (result.complete) {
            setHistoryStatus("complete")
            partialRetryCount = 0
            if (partialRetryTimer) clearTimeout(partialRetryTimer)
            partialRetryTimer = undefined
          } else {
            setHistoryStatus("partial")
            if (partialRetryCount < 3) {
              const delay = 500 * 2 ** partialRetryCount
              partialRetryCount += 1
              if (partialRetryTimer) clearTimeout(partialRetryTimer)
              partialRetryTimer = setTimeout(() => {
                partialRetryTimer = undefined
                void reloadTree()
              }, delay)
            }
          }
        } catch {
          if (!disposed && version === loadVersion) setHistoryStatus("unavailable")
        }
      } while (reloadQueued && !disposed)

      reloadInFlight = false
    }
    const scheduleReload = (delay = 250) => {
      if (reloadInFlight) {
        reloadQueued = true
        return
      }
      if (reloadTimer) clearTimeout(reloadTimer)
      if (partialRetryTimer) clearTimeout(partialRetryTimer)
      partialRetryTimer = undefined
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined
        void reloadTree()
      }, delay)
    }
    const stopMessageUpdates = props.api.event.on("message.updated", (event) => {
      if (!isTrackedSession(event.properties.sessionID)) {
        if (reloadInFlight) reloadQueued = true
        return
      }
      if (reloadInFlight) reloadQueued = true
      upsertHistoryMessage(event.properties.info as UsageMessage)
      if (historyStatus() === "partial") scheduleReload()
    })
    const stopMessageRemovals = props.api.event.on("message.removed", (event) => {
      if (!isTrackedSession(event.properties.sessionID)) {
        if (reloadInFlight) reloadQueued = true
        return
      }
      if (reloadInFlight) reloadQueued = true
      removeHistoryMessage(event.properties.messageID)
      if (historyStatus() === "partial") scheduleReload()
    })
    const stopPartUpdates = props.api.event.on("message.part.updated", (event) => {
      if (!isTrackedSession(event.properties.sessionID)) {
        if (reloadInFlight) reloadQueued = true
        return
      }
      if (reloadInFlight) reloadQueued = true
      upsertHistoryStep(event.properties.sessionID, event.properties.part)
      if (historyStatus() === "partial") scheduleReload()
    })
    const stopPartRemovals = props.api.event.on("message.part.removed", (event) => {
      if (!isTrackedSession(event.properties.sessionID)) {
        if (reloadInFlight) reloadQueued = true
        return
      }
      if (reloadInFlight) reloadQueued = true
      removeHistoryStep(event.properties.messageID, event.properties.partID)
      if (historyStatus() === "partial") scheduleReload()
    })
    const stopSessionCreates = props.api.event.on("session.created", (event) => {
      const parentID = event.properties.info.parentID
      if ((parentID && isTrackedSession(parentID)) || reloadInFlight) scheduleReload()
    })
    const stopSessionDeletes = props.api.event.on("session.deleted", (event) => {
      if (isTrackedSession(event.properties.info.id) || reloadInFlight) scheduleReload()
    })

    void reloadTree()

    onCleanup(() => {
      disposed = true
      if (reloadTimer) clearTimeout(reloadTimer)
      if (partialRetryTimer) clearTimeout(partialRetryTimer)
      stopMessageUpdates()
      stopMessageRemovals()
      stopPartUpdates()
      stopPartRemovals()
      stopSessionCreates()
      stopSessionDeletes()
    })
  })

  const messages = createMemo(() =>
    mergeLiveMessages(history(), props.api.state.session.messages(props.sessionID) as readonly UsageMessage[]),
  )
  const latest = createMemo(() => latestAssistantMessage(messages(), props.sessionID))
  const latestModel = createMemo(() => findModel(props.api, latest()))
  const latestContext = createMemo(() => contextTokens(latest()?.tokens))
  const latestPercent = createMemo(() => contextPercent(latestContext(), latestModel()?.limit?.context))
  const resolvePricing = (message: UsageMessage) =>
    pricingForMessage(message, findModel(props.api, message), props.customPricing)
  const modelGroups = createMemo(() =>
    usageByModel(messages(), resolvePricing).toSorted((left, right) =>
      baseModelLabel(props.api, left).localeCompare(baseModelLabel(props.api, right)),
    ),
  )
  const modelLabels = createMemo(() => {
    const groups = modelGroups()
    const labels = disambiguateModelLabels(
      groups.map((group) => ({
        providerID: group.providerID,
        modelID: group.modelID,
        name: findModel(props.api, { providerID: group.providerID, modelID: group.modelID })?.name,
      })),
    )
    return new Map(groups.map((group, index) => [modelKey(group), labels[index]!]))
  })
  const treeEstimate = createMemo(() => estimateCost(messages(), resolvePricing))
  const displayedTotal = createMemo(() => ({
    ...treeEstimate(),
    complete: treeEstimate().complete && historyStatus() === "complete",
  }))

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {formatTokenCount(latestContext())}
        {latestModel()?.limit?.context ? ` / ${formatTokenCount(latestModel()!.limit!.context!)}` : " tokens"}
      </text>
      <text fg={theme().textMuted}>{formatPercent(latestPercent())}</text>
      <For each={modelGroups()}>
        {(group) => {
          const historyComplete = () => historyStatus() === "complete"
          const displayedEstimate = () => ({ ...group.estimate, complete: group.estimate.complete && historyComplete() })
          return (
            <box paddingBottom={1}>
              <text fg={theme().text} wrapMode="word">
                <b>{modelLabels().get(modelKey(group))}</b> ({formatEstimate(displayedEstimate())})
              </text>
              <For each={modelMetricRows(group)}>
                {(row) => <text fg={theme().textMuted}>{metricLine(row, historyComplete())}</text>}
              </For>
            </box>
          )
        }}
      </For>
      <text fg={theme().text}>
        <b>Total: {formatEstimate(displayedTotal())}</b>
      </text>
    </box>
  )
}

// `options` is the object paired with this plugin in the `plugin` list of `tui.json`. OpenCode
// 1.18.29 drops unknown top-level keys from `opencode.json`, so `api.state.config` never carries
// `provider_pricing`; plugin options are the supported way to pass it.
const tui: TuiPlugin = async (api, options) => {
  const providerPricing = parseProviderPricing(options)
  if (providerPricing.issues.length > 0) {
    api.ui.toast({
      variant: "warning",
      title: "Cost tracker: invalid provider_pricing",
      message: providerPricing.issues.join("\n"),
      duration: 10_000,
    })
  }

  const builtin = api.plugins.list().find((plugin) => plugin.id === BUILTIN_CONTEXT_PLUGIN_ID)
  const restoreBuiltin = builtin?.active ?? false

  if (restoreBuiltin) await api.plugins.deactivate(BUILTIN_CONTEXT_PLUGIN_ID)

  api.lifecycle.onDispose(async () => {
    if (restoreBuiltin) await api.plugins.activate(BUILTIN_CONTEXT_PLUGIN_ID)
  })

  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_context, props) {
        return (
          <Show when={props.session_id} keyed>
            {(sessionID: string) => (
              <TokenMetrics api={api} sessionID={sessionID} customPricing={providerPricing.pricing} />
            )}
          </Show>
        )
      },
    },
  })
}

const plugin: TuiPluginModule = {
  id: PLUGIN_ID,
  tui,
}

export default plugin
