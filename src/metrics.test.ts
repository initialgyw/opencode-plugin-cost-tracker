import { describe, expect, test } from "bun:test"
import {
  contextPercent,
  costBreakdownForMessage,
  costForMessage,
  estimateCost,
  latestAssistantMessage,
  parseProviderPricing,
  pricingForMessage,
  pricingForModel,
  usageByModel,
  usageTotals,
  type UsageMessage,
} from "./metrics"

const terra = {
  id: "gpt-5.6-terra",
  name: "GPT-5.6 Terra",
  family: "gpt-terra",
}

function assistant(id: string, input: number, output: number, read = 0, write = 0, reasoning = 0): UsageMessage {
  return {
    id,
    role: "assistant",
    providerID: "openai",
    modelID: terra.id,
    tokens: { input, output, reasoning, cache: { read, write } },
  }
}

describe("usageTotals", () => {
  test("sums assistant usage and ignores non-assistant messages", () => {
    const messages: UsageMessage[] = [
      { id: "user", role: "user", tokens: { input: 999 } },
      assistant("one", 100, 20, 30, 4, 6),
      assistant("two", 50, 10, 5, 2, 3),
    ]

    expect(usageTotals(messages)).toEqual({
      input: 150,
      output: 30,
      reasoning: 9,
      cacheRead: 35,
      cacheWrite: 6,
    })
  })

  test("uses the newest record when a streaming update repeats a message id", () => {
    expect(usageTotals([assistant("one", 100, 2), assistant("one", 100, 20)])).toEqual({
      input: 100,
      output: 20,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })
  })

  test("counts step records instead of the latest context snapshot", () => {
    const snapshot = assistant("assistant", 300, 4, 20, 2, 1)
    snapshot.isContextSnapshot = true
    snapshot.isUsageRecord = false
    const stepOne = { ...assistant("assistant:one", 100, 2, 10, 1, 1), isContextSnapshot: false }
    const stepTwo = { ...assistant("assistant:two", 200, 2, 10, 1), isContextSnapshot: false }

    expect(usageTotals([snapshot, stepOne, stepTwo])).toEqual({
      input: 300,
      output: 4,
      reasoning: 1,
      cacheRead: 20,
      cacheWrite: 2,
    })
  })

  test("groups usage by provider and model", () => {
    const gemini: UsageMessage = {
      ...assistant("gemini", 300, 40, 20),
      providerID: "google",
      modelID: "gemini-3.5-flash",
    }
    const groups = usageByModel(
      [assistant("terra", 100, 10), gemini],
      (message) => (message.modelID === terra.id ? pricingForModel(terra) : undefined),
    )

    expect(groups.map((group) => `${group.providerID}/${group.modelID}`)).toEqual([
      "openai/gpt-5.6-terra",
      "google/gemini-3.5-flash",
    ])
    expect(groups[0]?.usage.input).toBe(100)
    expect(groups[1]?.usage.cacheRead).toBe(20)
    expect(groups[1]?.estimate.complete).toBe(false)
  })
})

describe("context helpers", () => {
  test("finds the newest assistant message with usage", () => {
    expect(latestAssistantMessage([assistant("one", 100, 2), assistant("two", 200, 3)])?.id).toBe("two")
  })

  test("calculates context percentage without producing NaN", () => {
    expect(contextPercent(50_000, 1_000_000)).toBe(5)
    expect(contextPercent(50_000, undefined)).toBeUndefined()
    expect(contextPercent(50_000, 0)).toBeUndefined()
  })
})

describe("pricing", () => {
  test("covers every supported public model ID", () => {
    const models = [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-opus-5",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gemini-3.1-pro-preview",
      "gemini-3.8-flash",
    ]

    for (const id of models) {
      expect(pricingForModel({ id })?.source, id).toBe("public")
    }
  })

  test("maps the public GPT-5.6 Terra ID to published pricing", () => {
    expect(pricingForModel(terra)?.short).toEqual({ input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 })
  })

  test("uses the published short-context rates", () => {
    const expected = [
      ["gpt-5.6-luna", { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 }],
      ["gpt-5.6-sol", { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 }],
      ["gpt-5.6-terra", { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 }],
      ["claude-opus-5-5", { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 }],
      ["claude-fable-5-1", { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 }],
      ["claude-sonnet-5", { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 }],
      ["claude-opus-5", { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 }],
      ["gemini-3.1-pro-preview", { input: 2, cacheRead: 0.2, cacheWrite: undefined, output: 12 }],
      ["gemini-3.8-flash", { input: 0.75, cacheRead: 0.075, cacheWrite: undefined, output: 3.75 }],
    ] as const

    for (const [id, rates] of expected) {
      expect(pricingForModel({ id })?.short, id).toEqual(rates)
    }
  })

  test("uses long-context rates only above each threshold", () => {
    const terraPricing = pricingForModel(terra)
    const proPricing = pricingForModel({ id: "gemini-3.1-pro-preview" })

    expect(costBreakdownForMessage({ input: 272_000 }, terraPricing)?.input).toBeCloseTo(0.544)
    expect(costBreakdownForMessage({ input: 272_001 }, terraPricing)?.input).toBeCloseTo(1.088004)
    expect(costBreakdownForMessage({ input: 200_000 }, proPricing)?.input).toBeCloseTo(0.4)
    expect(costBreakdownForMessage({ input: 200_001 }, proPricing)?.input).toBeCloseTo(0.800004)
    expect(pricingForModel({ id: "gpt-5.6-luna" })?.long).toEqual({
      input: 0.4,
      cacheRead: 0.04,
      cacheWrite: 0.5,
      output: 1.8,
    })
    expect(pricingForModel({ id: "gpt-5.6-sol" })?.long).toEqual({
      input: 8,
      cacheRead: 0.8,
      cacheWrite: 10,
      output: 30,
    })
    expect(proPricing?.long).toEqual({ input: 4, cacheRead: 0.4, cacheWrite: undefined, output: 18 })
  })

  test("does not map removed models or tier-name substrings to public pricing", () => {
    expect(pricingForModel({ id: "consolidated-5.6", family: "gpt-5.6" })).toBeUndefined()
    expect(pricingForModel({ id: "lunar-5.6", family: "gpt-5.6" })).toBeUndefined()
    expect(pricingForModel({ id: "terrain-5.6", family: "gpt-5.6" })).toBeUndefined()
    expect(pricingForModel({ id: "gpt-5.5" })).toBeUndefined()
    expect(pricingForModel({ id: "gemini-3.6-flash" })).toBeUndefined()
    expect(
      pricingForModel({
        id: "private-gpt-5.4",
        name: "GPT-5.4",
        family: "gpt-5.4",
        cost: { input: 7, output: 20 },
      })?.source,
    ).toBe("metadata")
    expect(pricingForModel({ id: "custom-gemini-3-flash" })).toBeUndefined()
  })

  test("prices gateway-specific model IDs only from configured metadata", () => {
    const gatewayModel = { id: "example-gateway.openai.gpt-5.6-luna", name: "GPT-5.6 Luna" }

    expect(pricingForModel(gatewayModel)).toBeUndefined()
    expect(pricingForModel({ ...gatewayModel, cost: { input: 0.2, output: 1.2 } })?.source).toBe("metadata")
  })

  test("uses Standard Gemini 3.8 Flash promotional pricing", () => {
    const pricing = pricingForModel({ id: "gemini-3.8-flash" })
    expect(pricing?.short).toEqual({ input: 0.75, cacheRead: 0.075, cacheWrite: undefined, output: 3.75 })
  })

  test("updates time-limited Gemini 3.8 Flash pricing after promotion expiry", () => {
    const pricing = pricingForModel({ id: "gemini-3-8-flash" })
    const promotional = costBreakdownForMessage(
      { input: 1_000_000, output: 1_000_000 },
      pricing,
      Date.parse("2026-12-31T23:59:59Z"),
    )
    const standard = costBreakdownForMessage(
      { input: 1_000_000, output: 1_000_000 },
      pricing,
      Date.parse("2027-01-01T00:00:00Z"),
    )

    expect(promotional).toMatchObject({ input: 0.75, output: 3.75 })
    expect(standard).toMatchObject({ input: 1.5, output: 7.5 })
  })

  test("uses long-context Terra pricing above 272K prompt tokens", () => {
    const pricing = pricingForModel(terra)
    expect(pricing).toBeDefined()
    expect(costForMessage({ input: 272_001 }, pricing)).toBeCloseTo(272_001 * 4 / 1_000_000)
  })

  test("prices every token category independently", () => {
    const pricing = pricingForModel(terra)
    const breakdown = costBreakdownForMessage(
      {
        input: 100_000,
        output: 100_000,
        reasoning: 50_000,
        cache: { read: 100_000, write: 100_000 },
      },
      pricing,
    )

    expect(breakdown).toEqual({
      input: 0.4,
      cacheRead: 0.04,
      cacheWrite: 0.5,
      output: 1.8,
      reasoning: 0.9,
    })
    expect(costForMessage({ input: 100_000, output: 1_000_000, reasoning: 500_000 }, pricing)).toBeCloseTo(18.2)
  })

  test("reconciles category costs with the estimate total", () => {
    const estimate = estimateCost([assistant("one", 100_000, 100_000, 100_000, 100_000, 50_000)], () =>
      pricingForModel(terra),
    )
    const categoryTotal = Object.values(estimate.breakdown).reduce<number>((total, cost) => total + (cost ?? 0), 0)

    expect(estimate.amount).toBeCloseTo(categoryTotal)
    expect(estimate.breakdown).toEqual({
      input: 0.4,
      cacheRead: 0.04,
      cacheWrite: 0.5,
      output: 1.8,
      reasoning: 0.9,
    })
  })

  test("marks unpublished cache-write rates as incomplete", () => {
    const estimate = estimateCost(
      [{ ...assistant("gemini-3.8-flash", 100, 20, 10, 100), modelID: "gemini-3.8-flash" }],
      (message) => pricingForModel({ id: message.modelID }),
    )

    expect(estimate.complete).toBe(false)
    expect(estimate.breakdown.cacheWrite).toBeUndefined()
    expect(estimate.amount).toBeGreaterThan(0)
  })

  test("uses OpenCode's nested long-context metadata for fallback pricing", () => {
    const pricing = pricingForModel({
      id: "custom-model",
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 1.25 },
        experimentalOver200K: { input: 2, output: 3, cache: { read: 0.2, write: 2.5 } },
      },
    })

    expect(costForMessage({ input: 200_001, cache: { read: 10 } }, pricing)).toBeCloseTo(0.400004)
  })

  test("keeps known pricing provenance when another model is unknown", () => {
    const unknown = { ...assistant("unknown", 100, 20), modelID: "unknown-model" }
    const estimate = estimateCost([assistant("terra", 100, 20), unknown], (message) =>
      message.modelID === terra.id ? pricingForModel(terra) : undefined,
    )

    expect(estimate.complete).toBe(false)
    expect(estimate.source).toBe("public")
  })

  test("returns an incomplete estimate for an unknown model", () => {
    const estimate = estimateCost([assistant("one", 100, 20)], () => undefined)
    expect(estimate).toEqual({
      amount: 0,
      breakdown: {
        input: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
        output: undefined,
        reasoning: undefined,
      },
      complete: false,
      hasUsage: true,
      source: "unknown",
    })
  })
})

describe("provider_pricing", () => {
  const options = {
    provider_pricing: {
      models: {
        my_model: { input: 1.25, output: 10, cache_read: 0.125, cache_write: 1.5 },
      },
    },
  }

  function gatewayMessage(modelID: string, tokens?: UsageMessage["tokens"]): UsageMessage {
    return { id: `${modelID}-message`, role: "assistant", providerID: "my-gateway", modelID, tokens }
  }

  test("prices every token category from configured USD-per-million rates", () => {
    const { pricing, issues } = parseProviderPricing(options)
    const custom = pricingForMessage(gatewayMessage("my_model"), undefined, pricing)

    expect(issues).toEqual([])
    expect(custom?.source).toBe("custom")
    expect(
      costBreakdownForMessage(
        { input: 1_000_000, output: 100_000, reasoning: 100_000, cache: { read: 2_000_000, write: 1_000_000 } },
        custom,
      ),
    ).toEqual({ input: 1.25, cacheRead: 0.25, cacheWrite: 1.5, output: 1, reasoning: 1 })
  })

  test("applies configured rates to matching messages in an estimate", () => {
    const { pricing } = parseProviderPricing(options)
    const message = gatewayMessage("my_model", { input: 1_000_000, output: 100_000 })
    const estimate = estimateCost([message], (item) => pricingForMessage(item, undefined, pricing))

    expect(estimate).toMatchObject({ amount: 2.25, complete: true, source: "custom" })
  })

  test("prefers a provider-qualified key over a bare model ID", () => {
    const { pricing } = parseProviderPricing({
      provider_pricing: {
        models: {
          "gpt-5.6-luna": { input: 1, output: 2 },
          "my-gateway/gpt-5.6-luna": { input: 3, output: 4 },
        },
      },
    })
    const inputRate = (providerID: string) =>
      pricingForMessage({ providerID, modelID: "gpt-5.6-luna" }, undefined, pricing)?.short.input

    expect(inputRate("my-gateway")).toBe(3)
    expect(inputRate("openai")).toBe(1)
  })

  test("takes precedence over built-in prices and model metadata", () => {
    const { pricing } = parseProviderPricing({
      provider_pricing: { models: { "gpt-5.6-terra": { input: 1, output: 2 }, my_model: { input: 5, output: 6 } } },
    })
    const metadataModel = { id: "my_model", cost: { input: 0, output: 0 } }

    expect(pricingForMessage({ providerID: "openai", modelID: terra.id }, terra, pricing)?.short.input).toBe(1)
    expect(pricingForMessage(gatewayMessage("my_model"), metadataModel, pricing)?.short).toEqual({
      input: 5,
      cacheRead: undefined,
      cacheWrite: undefined,
      output: 6,
    })
  })

  test("falls back to built-in prices and metadata for models without an exact entry", () => {
    const { pricing } = parseProviderPricing(options)
    const metadataModel = { id: "other-model", cost: { input: 1, output: 2 } }

    expect(pricingForMessage({ providerID: "openai", modelID: terra.id }, terra, pricing)?.source).toBe("public")
    expect(pricingForMessage(gatewayMessage("other-model"), metadataModel, pricing)?.source).toBe("metadata")
    expect(pricingForMessage(gatewayMessage("my-model"), undefined, pricing)).toBeUndefined()
    expect(pricingForMessage(gatewayMessage("My_Model"), undefined, pricing)).toBeUndefined()
  })

  test("leaves cache categories without a configured rate unpriced", () => {
    const { pricing } = parseProviderPricing({ provider_pricing: { models: { my_model: { input: 1, output: 2 } } } })
    const resolvePricing = (message: UsageMessage) => pricingForMessage(message, undefined, pricing)

    const withoutCache = estimateCost(
      [gatewayMessage("my_model", { input: 1_000_000, output: 1_000_000 })],
      resolvePricing,
    )
    const withCache = estimateCost(
      [gatewayMessage("my_model", { input: 1_000_000, output: 1_000_000, cache: { read: 10, write: 10 } })],
      resolvePricing,
    )

    expect(withoutCache).toMatchObject({ amount: 3, complete: true })
    expect(withCache.complete).toBe(false)
    expect(withCache.breakdown).toEqual({
      input: 1,
      cacheRead: undefined,
      cacheWrite: undefined,
      output: 2,
      reasoning: 0,
    })
  })

  test("ignores malformed entries so they never produce a cost", () => {
    const { pricing, issues } = parseProviderPricing({
      provider_pricing: {
        models: {
          negative: { input: -1, output: 2 },
          infinite: { input: 1, output: Number.POSITIVE_INFINITY },
          not_a_number: { input: Number.NaN, output: 2 },
          text: { input: "1.25", output: 10 },
          missing_output: { input: 1 },
          misspelled: { input: 1, output: 2, cache_raed: 0.1 },
          invalid_cache: { input: 1, output: 2, cache_write: -0.5 },
          not_an_object: 1.25,
          list: [1, 2],
          nothing: null,
          "gpt-5.6-terra": { input: -2, output: 12 },
        },
      },
    })

    expect(pricing.size).toBe(0)
    expect(issues).toHaveLength(11)
    expect(issues).toContain('provider_pricing.models["misspelled"] ignored: unknown field "cache_raed"')
    expect(issues).toContain('provider_pricing.models["negative"] ignored: input must be a finite number >= 0')
    expect(pricingForMessage({ providerID: "openai", modelID: terra.id }, terra, pricing)?.source).toBe("public")
  })

  test("reports a malformed provider_pricing section and accepts missing options", () => {
    expect(parseProviderPricing(undefined)).toEqual({ pricing: new Map(), issues: [] })
    expect(parseProviderPricing({})).toEqual({ pricing: new Map(), issues: [] })
    for (const section of [null, [], "rates", {}, { models: [] }, { models: null }]) {
      expect(parseProviderPricing({ provider_pricing: section }).issues, JSON.stringify(section)).toEqual([
        "provider_pricing.models must be an object that maps model IDs to rates",
      ])
    }
  })
})
