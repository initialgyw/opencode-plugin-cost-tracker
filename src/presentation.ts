import type { CostEstimate, ModelUsage } from "./metrics"

export type MetricRow = {
  label: "IN" | "CACHE-R" | "CACHE-W" | "OUT" | "REASON"
  tokens: number
  cost?: number
}

function formatScaledTokens(value: number, divisor: number, suffix: string): string {
  const rounded = Math.round((value / divisor) * 10) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}${suffix}`
}

export function formatTokenCount(value: number): string {
  if (value >= 999_950) return formatScaledTokens(value, 1_000_000, "M")
  if (value >= 1_000) return formatScaledTokens(value, 1_000, "K")
  return value.toLocaleString("en-US")
}

export function formatMoney(value: number): string {
  if (value === 0) return "$0.00"

  const magnitude = Math.abs(value)
  const digits = magnitude >= 0.99995 ? 2 : magnitude >= 0.0099995 ? 4 : 6
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value)
}

export function formatTotal(estimate: CostEstimate): string {
  if (estimate.complete) return formatMoney(estimate.amount)
  if (estimate.amount > 0) return `${formatMoney(estimate.amount)}+`
  return "N/A"
}

export function formatEstimate(estimate: CostEstimate): string {
  const total = formatTotal(estimate)
  return total === "N/A" ? total : `~${total}`
}

export function compactModelName(modelID: string, name?: string): string {
  const source = `${name ?? ""} ${modelID}`
    .toLowerCase()
    .replaceAll("_", "-")
    .replace(/[^a-z0-9.]+/g, "-")
  for (const tier of ["luna", "terra", "sol"] as const) {
    const hasTier = new RegExp(`(^|-)${tier}(-|$)`).test(source)
    if (hasTier && (source.includes("5.6") || source.includes("5-6"))) return `${tier}-5.6`
  }

  const fallback = name?.trim() || modelID.split("/").at(-1) || modelID
  return fallback
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-")
}

export function disambiguateModelLabels(
  models: ReadonlyArray<{ providerID: string; modelID: string; name?: string }>,
): string[] {
  const bases = models.map((model) => compactModelName(model.modelID, model.name))
  const baseCounts = new Map<string, number>()
  for (const base of bases) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1)

  const candidates = models.map((model, index) =>
    baseCounts.get(bases[index]!)! > 1 ? `${bases[index]}@${model.providerID}` : bases[index]!,
  )
  const candidateCounts = new Map<string, number>()
  for (const candidate of candidates) candidateCounts.set(candidate, (candidateCounts.get(candidate) ?? 0) + 1)

  const ordinals = new Map<string, number>()
  return candidates.map((candidate) => {
    if (candidateCounts.get(candidate)! <= 1) return candidate
    const ordinal = (ordinals.get(candidate) ?? 0) + 1
    ordinals.set(candidate, ordinal)
    return `${candidate}#${ordinal}`
  })
}

export function modelMetricRows(group: ModelUsage): MetricRow[] {
  const costs = group.estimate.breakdown
  const rows: MetricRow[] = [
    { label: "IN", tokens: group.usage.input, cost: costs?.input },
    { label: "CACHE-R", tokens: group.usage.cacheRead, cost: costs?.cacheRead },
    { label: "CACHE-W", tokens: group.usage.cacheWrite, cost: costs?.cacheWrite },
    { label: "OUT", tokens: group.usage.output, cost: costs?.output },
  ]
  if (group.usage.reasoning > 0) {
    rows.push({ label: "REASON", tokens: group.usage.reasoning, cost: costs?.reasoning })
  }
  return rows
}
