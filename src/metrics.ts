export type TokenUsage = {
  input?: number
  output?: number
  reasoning?: number
  cache?: {
    read?: number
    write?: number
  }
}

export type UsageMessage = {
  id?: string
  sessionID?: string
  role?: string
  providerID?: string
  modelID?: string
  time?: {
    created?: number
    completed?: number
  }
  tokens?: TokenUsage
  isContextSnapshot?: boolean
  isUsageRecord?: boolean
}

export type ModelIdentity = {
  id?: string
  name?: string
  family?: string
  limit?: {
    context?: number
  }
  cost?: {
    input?: number
    output?: number
    cache_read?: number
    cache_write?: number
    cache?: {
      read?: number
      write?: number
    }
    context_over_200k?: {
      input?: number
      output?: number
      cache_read?: number
      cache_write?: number
      cache?: {
        read?: number
        write?: number
      }
    }
    experimentalOver200K?: {
      input?: number
      output?: number
      cache?: {
        read?: number
        write?: number
      }
    }
    tiers?: Array<{
      input?: number
      output?: number
      cache?: {
        read?: number
        write?: number
      }
      tier?: {
        type?: string
        size?: number
      }
    }>
  }
}

export type UsageTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

// USD per million tokens. An undefined cache rate means that category has no known price.
export type PriceRates = {
  input: number
  cacheRead?: number
  cacheWrite?: number
  output: number
}

export type Pricing = {
  source: "public" | "metadata" | "custom"
  reference?: string
  verifiedOn?: string
  expiresOn?: string
  afterExpiry?: {
    short: PriceRates
    long: PriceRates
  }
  longContextThreshold: number
  short: PriceRates
  long: PriceRates
  tiers?: Array<{
    threshold: number
    rates: PriceRates
  }>
}

export type EstimateSource = Pricing["source"] | "mixed" | "unknown"

// Parsed `provider_pricing.models`, keyed by `providerID/modelID` or by a bare model ID.
export type CustomPricing = ReadonlyMap<string, Pricing>

export type ParsedProviderPricing = {
  pricing: CustomPricing
  issues: string[]
}

export type CostBreakdown = {
  input: number | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
  output: number | undefined
  reasoning: number | undefined
}

export type CostEstimate = {
  amount: number
  breakdown: CostBreakdown
  complete: boolean
  hasUsage: boolean
  source: EstimateSource
}

export type ModelUsage = {
  providerID: string
  modelID: string
  usage: UsageTotals
  estimate: CostEstimate
}

const MILLION = 1_000_000
const LONG_CONTEXT_THRESHOLD = 272_000
const OPENAI_PRICING_SOURCE = "https://developers.openai.com/api/docs/pricing"
const PRICING_VERIFIED_ON = "2026-09-24"

const PUBLIC_GPT_5_6_PRICING: Record<string, Pricing> = {
  luna: {
    source: "public",
    reference: OPENAI_PRICING_SOURCE,
    verifiedOn: PRICING_VERIFIED_ON,
    longContextThreshold: LONG_CONTEXT_THRESHOLD,
    short: { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
    long: { input: 0.4, cacheRead: 0.04, cacheWrite: 0.5, output: 1.8 },
  },
  terra: {
    source: "public",
    reference: OPENAI_PRICING_SOURCE,
    verifiedOn: PRICING_VERIFIED_ON,
    longContextThreshold: LONG_CONTEXT_THRESHOLD,
    short: { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
    long: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 18 },
  },
  sol: {
    source: "public",
    reference: OPENAI_PRICING_SOURCE,
    verifiedOn: PRICING_VERIFIED_ON,
    longContextThreshold: LONG_CONTEXT_THRESHOLD,
    short: { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
    long: { input: 8, cacheRead: 0.8, cacheWrite: 10, output: 30 },
  },
}

const NO_LONG_CONTEXT_TIER = Number.POSITIVE_INFINITY
const ANTHROPIC_PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing#model-pricing"
const GOOGLE_PRICING_SOURCE = "https://cloud.google.com/vertex-ai/generative-ai/pricing"

function publicPricing(
  reference: string,
  short: PriceRates,
  long = short,
  longContextThreshold = NO_LONG_CONTEXT_TIER,
  options?: { expiresOn?: string; afterExpiry?: { short: PriceRates; long: PriceRates } },
): Pricing {
  return {
    source: "public",
    reference,
    verifiedOn: PRICING_VERIFIED_ON,
    ...options,
    longContextThreshold,
    short,
    long,
  }
}

const PUBLIC_OTHER_PRICING: Array<{ aliases: string[]; pricing: Pricing }> = [
  {
    aliases: ["claude-opus-5-5"],
    pricing: publicPricing(ANTHROPIC_PRICING_SOURCE, { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }),
  },
  {
    aliases: ["claude-fable-5-1"],
    pricing: publicPricing(ANTHROPIC_PRICING_SOURCE, { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 }),
  },
  {
    aliases: ["claude-sonnet-5"],
    pricing: publicPricing(ANTHROPIC_PRICING_SOURCE, { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }),
  },
  {
    aliases: ["claude-opus-5"],
    pricing: publicPricing(ANTHROPIC_PRICING_SOURCE, { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 }),
  },
  {
    aliases: ["gemini-3.1-pro-preview"],
    pricing: publicPricing(
      GOOGLE_PRICING_SOURCE,
      { input: 2, cacheRead: 0.2, cacheWrite: undefined, output: 12 },
      { input: 4, cacheRead: 0.4, cacheWrite: undefined, output: 18 },
      200_000,
    ),
  },
  {
    aliases: ["gemini-3.8-flash"],
    pricing: publicPricing(
      GOOGLE_PRICING_SOURCE,
      { input: 0.75, cacheRead: 0.075, cacheWrite: undefined, output: 3.75 },
      { input: 0.75, cacheRead: 0.075, cacheWrite: undefined, output: 3.75 },
      NO_LONG_CONTEXT_TIER,
      {
        expiresOn: "2026-12-31",
        afterExpiry: {
          short: { input: 1.5, cacheRead: 0.15, cacheWrite: undefined, output: 7.5 },
          long: { input: 1.5, cacheRead: 0.15, cacheWrite: undefined, output: 7.5 },
        },
      },
    ),
  },
]

const ZERO_TOTALS: UsageTotals = {
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

const ZERO_COSTS: CostBreakdown = {
  input: 0,
  cacheRead: 0,
  cacheWrite: 0,
  output: 0,
  reasoning: 0,
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function normalizeModelText(value: string | undefined): string {
  return value?.toLowerCase().replaceAll("_", "-").replaceAll(".", "-") ?? ""
}

// Built-in rates apply only to exact public model IDs. Gateway-specific or renamed
// IDs are not guessed; they fall back to the model's configured `cost` metadata.
function matchesModelAlias(model: ModelIdentity, aliases: readonly string[]): boolean {
  const field = model.id
    ? normalizeModelText(model.id)
    : model.name
      ? normalizeModelText(model.name)
      : normalizeModelText(model.family)

  return aliases.some((alias) => field === normalizeModelText(alias))
}

function uniqueMessages(messages: readonly UsageMessage[]): UsageMessage[] {
  const keyed = new Map<string, UsageMessage>()
  const unkeyed: UsageMessage[] = []

  for (const message of messages) {
    if (message.id) {
      keyed.set(message.id, message)
    } else {
      unkeyed.push(message)
    }
  }

  return [...keyed.values(), ...unkeyed]
}

export function usageTotals(messages: readonly UsageMessage[]): UsageTotals {
  const totals = { ...ZERO_TOTALS }

  for (const message of uniqueMessages(messages)) {
    if (message.role !== "assistant" || message.isUsageRecord === false || !message.tokens) continue

    totals.input += finiteNonNegative(message.tokens.input)
    totals.output += finiteNonNegative(message.tokens.output)
    totals.reasoning += finiteNonNegative(message.tokens.reasoning)
    totals.cacheRead += finiteNonNegative(message.tokens.cache?.read)
    totals.cacheWrite += finiteNonNegative(message.tokens.cache?.write)
  }

  return totals
}

export function usageByModel(
  messages: readonly UsageMessage[],
  resolvePricing: (message: UsageMessage) => Pricing | undefined,
): ModelUsage[] {
  const groups = new Map<string, { providerID: string; modelID: string; messages: UsageMessage[] }>()

  for (const message of uniqueMessages(messages)) {
    if (
      message.role !== "assistant" ||
      message.isUsageRecord === false ||
      !message.tokens ||
      contextTokens(message.tokens) === 0
    ) continue

    const providerID = message.providerID ?? "unknown"
    const modelID = message.modelID ?? "unknown"
    const key = `${providerID}/${modelID}`
    const group = groups.get(key) ?? { providerID, modelID, messages: [] }
    group.messages.push(message)
    groups.set(key, group)
  }

  return [...groups.values()].map((group) => ({
    providerID: group.providerID,
    modelID: group.modelID,
    usage: usageTotals(group.messages),
    estimate: estimateCost(group.messages, resolvePricing),
  }))
}

export function latestAssistantMessage(
  messages: readonly UsageMessage[],
  sessionID?: string,
): UsageMessage | undefined {
  const unique = uniqueMessages(messages)

  return unique.findLast((message) => {
    if (message.role !== "assistant" || message.isContextSnapshot === false || !message.tokens) return false
    if (sessionID && message.sessionID && message.sessionID !== sessionID) return false
    return contextTokens(message.tokens) > 0
  })
}

export function contextTokens(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0

  return (
    finiteNonNegative(tokens.input) +
    finiteNonNegative(tokens.output) +
    finiteNonNegative(tokens.reasoning) +
    finiteNonNegative(tokens.cache?.read) +
    finiteNonNegative(tokens.cache?.write)
  )
}

export function promptTokens(tokens: TokenUsage | undefined): number {
  if (!tokens) return 0

  return (
    finiteNonNegative(tokens.input) +
    finiteNonNegative(tokens.cache?.read) +
    finiteNonNegative(tokens.cache?.write)
  )
}

export function contextPercent(tokens: number, limit: number | undefined): number | undefined {
  if (!Number.isFinite(limit) || !limit || limit < 0) return undefined
  return Math.round((tokens / limit) * 100)
}

export function pricingForModel(model: ModelIdentity | undefined): Pricing | undefined {
  if (!model) return undefined

  const modelText = [model.id, model.name, model.family]
    .map(normalizeModelText)
    .filter(Boolean)
    .join(" ")
  const publicPricing = PUBLIC_OTHER_PRICING.find((entry) => matchesModelAlias(model, entry.aliases))
  if (publicPricing) return publicPricing.pricing

  if (modelText.includes("gpt-5-6")) {
    const tiers = {
      luna: ["gpt-5.6-luna"],
      terra: ["gpt-5.6-terra"],
      sol: ["gpt-5.6-sol"],
    } as const
    for (const tier of ["luna", "terra", "sol"] as const) {
      if (matchesModelAlias(model, tiers[tier])) return PUBLIC_GPT_5_6_PRICING[tier]
    }
  }

  return modelCostPricing(model)
}

function modelCostPricing(model: ModelIdentity): Pricing | undefined {
  const base = model.cost
  if (base?.input === undefined || base.output === undefined) return undefined

  const baseRates = toPriceRates(base)
  const long = base.experimentalOver200K ?? base.context_over_200k
  const tiers = (base.tiers ?? [])
    .filter((tier) => tier.tier?.type === "context" && tier.tier.size !== undefined)
    .map((tier) => ({
      threshold: tier.tier!.size!,
      rates: toPriceRates(tier),
    }))
    .sort((left, right) => left.threshold - right.threshold)

  const longRates = long ? toPriceRates(long) : tiers.at(-1)?.rates ?? baseRates
  const longContextThreshold = long
    ? 200_000
    : tiers[0]?.threshold ?? LONG_CONTEXT_THRESHOLD

  return {
    source: "metadata",
    longContextThreshold,
    short: baseRates,
    long: longRates,
    tiers,
  }
}

function toPriceRates(cost: {
  input?: number
  output?: number
  cache_read?: number
  cache_write?: number
  cache?: { read?: number; write?: number }
}): PriceRates {
  const cacheWrite = cost.cache?.write ?? cost.cache_write
  return {
    input: finiteNonNegative(cost.input),
    cacheRead: finiteNonNegative(cost.cache?.read ?? cost.cache_read),
    cacheWrite: cacheWrite === undefined ? undefined : finiteNonNegative(cacheWrite),
    output: finiteNonNegative(cost.output),
  }
}

const CUSTOM_RATE_FIELDS = ["input", "output", "cache_read", "cache_write"] as const
type CustomRateField = (typeof CUSTOM_RATE_FIELDS)[number]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCustomRateField(field: string): field is CustomRateField {
  return CUSTOM_RATE_FIELDS.some((known) => known === field)
}

function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function parseCustomRates(entry: unknown): { rates: PriceRates } | { problem: string } {
  if (!isRecord(entry)) return { problem: "expected an object of rates" }

  const rates: Partial<Record<CustomRateField, number>> = {}
  for (const [field, value] of Object.entries(entry)) {
    if (!isCustomRateField(field)) return { problem: `unknown field "${field}"` }
    if (!isRate(value)) return { problem: `${field} must be a finite number >= 0` }
    rates[field] = value
  }
  if (rates.input === undefined || rates.output === undefined) return { problem: "input and output are required" }

  return {
    rates: { input: rates.input, cacheRead: rates.cache_read, cacheWrite: rates.cache_write, output: rates.output },
  }
}

// Parses the plugin option `{ provider_pricing: { models: { [key]: { input, output, cache_read?,
// cache_write? } } } }`, with rates in USD per million tokens. An invalid entry is left out of the
// result, so it never produces a cost, and is described in `issues` instead.
export function parseProviderPricing(options: unknown): ParsedProviderPricing {
  const pricing = new Map<string, Pricing>()
  const issues: string[] = []
  const section = isRecord(options) ? options.provider_pricing : undefined
  if (section === undefined) return { pricing, issues }

  const models = isRecord(section) ? section.models : undefined
  if (!isRecord(models)) {
    issues.push("provider_pricing.models must be an object that maps model IDs to rates")
    return { pricing, issues }
  }

  for (const [key, entry] of Object.entries(models)) {
    const parsed = parseCustomRates(entry)
    if ("problem" in parsed) {
      issues.push(`provider_pricing.models["${key}"] ignored: ${parsed.problem}`)
      continue
    }
    // Configured rates are flat: they apply at every prompt size.
    pricing.set(key, {
      source: "custom",
      longContextThreshold: NO_LONG_CONTEXT_TIER,
      short: parsed.rates,
      long: parsed.rates,
    })
  }

  return { pricing, issues }
}

// Keys are matched exactly. A `providerID/modelID` key is more specific than a bare model ID.
function customPricingFor(
  customPricing: CustomPricing,
  providerID: string | undefined,
  modelID: string | undefined,
): Pricing | undefined {
  if (!modelID) return undefined
  const qualified = providerID ? customPricing.get(`${providerID}/${modelID}`) : undefined
  return qualified ?? customPricing.get(modelID)
}

// Rate precedence: configured `provider_pricing`, then built-in public prices, then the model's
// OpenCode `cost` metadata.
export function pricingForMessage(
  message: Pick<UsageMessage, "providerID" | "modelID">,
  model: ModelIdentity | undefined,
  customPricing: CustomPricing,
): Pricing | undefined {
  return customPricingFor(customPricing, message.providerID, message.modelID) ?? pricingForModel(model)
}

function ratesForPrompt(pricing: Pricing, prompt: number, at = Date.now()): PriceRates {
  const today = new Date(at).toISOString().slice(0, 10)
  const active = pricing.expiresOn && pricing.afterExpiry && today > pricing.expiresOn
    ? { ...pricing, ...pricing.afterExpiry }
    : pricing

  if (active.tiers?.length) {
    let rates = active.short
    for (const tier of active.tiers) {
      if (prompt <= tier.threshold) break
      rates = tier.rates
    }
    return rates
  }

  return prompt > active.longContextThreshold ? active.long : active.short
}

// Tokens in a category without a known rate are unpriced, not free.
function cacheCost(tokens: number, rate: number | undefined): number | undefined {
  if (tokens === 0) return 0
  return rate === undefined ? undefined : (tokens * rate) / MILLION
}

export function costBreakdownForMessage(
  tokens: TokenUsage | undefined,
  pricing: Pricing | undefined,
  at?: number,
): CostBreakdown | undefined {
  if (!tokens || !pricing) return undefined

  const rates = ratesForPrompt(pricing, promptTokens(tokens), at)
  return {
    input: (finiteNonNegative(tokens.input) * rates.input) / MILLION,
    cacheRead: cacheCost(finiteNonNegative(tokens.cache?.read), rates.cacheRead),
    cacheWrite: cacheCost(finiteNonNegative(tokens.cache?.write), rates.cacheWrite),
    output: (finiteNonNegative(tokens.output) * rates.output) / MILLION,
    // Reasoning is hidden from the visible response but billed at the output rate.
    reasoning: (finiteNonNegative(tokens.reasoning) * rates.output) / MILLION,
  }
}

export function costForMessage(tokens: TokenUsage | undefined, pricing: Pricing | undefined): number | undefined {
  const breakdown = costBreakdownForMessage(tokens, pricing)
  if (!breakdown || Object.values(breakdown).some((amount) => amount === undefined)) return undefined
  return Object.values(breakdown).reduce<number>((total, amount) => total + (amount ?? 0), 0)
}

export function estimateCost(
  messages: readonly UsageMessage[],
  resolvePricing: (message: UsageMessage) => Pricing | undefined,
): CostEstimate {
  let amount = 0
  const breakdown = { ...ZERO_COSTS }
  let complete = true
  let hasUsage = false
  const sources = new Set<Pricing["source"]>()

  for (const message of uniqueMessages(messages)) {
    if (
      message.role !== "assistant" ||
      message.isUsageRecord === false ||
      !message.tokens ||
      contextTokens(message.tokens) === 0
    ) continue
    hasUsage = true

    const pricing = resolvePricing(message)
    const messageCosts = costBreakdownForMessage(
      message.tokens,
      pricing,
      message.time?.completed ?? message.time?.created,
    )
    if (!pricing || !messageCosts) {
      complete = false
      for (const category of Object.keys(breakdown) as Array<keyof CostBreakdown>) {
        breakdown[category] = undefined
      }
      continue
    }
    if (Object.values(messageCosts).some((categoryCost) => categoryCost === undefined)) complete = false

    sources.add(pricing.source)
    for (const category of Object.keys(breakdown) as Array<keyof CostBreakdown>) {
      const categoryCost = messageCosts[category]
      if (categoryCost === undefined) {
        breakdown[category] = undefined
        continue
      }
      if (breakdown[category] !== undefined) breakdown[category] += categoryCost
    }
    amount += Object.values(messageCosts).reduce<number>((total, categoryCost) => total + (categoryCost ?? 0), 0)
  }

  const source: EstimateSource = sources.size > 1 ? "mixed" : sources.values().next().value ?? "unknown"
  return { amount, breakdown, complete, hasUsage, source }
}
