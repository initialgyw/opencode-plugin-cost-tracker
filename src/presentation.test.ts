import { describe, expect, test } from "bun:test"
import {
  compactModelName,
  disambiguateModelLabels,
  formatEstimate,
  formatMoney,
  formatTokenCount,
  formatTotal,
  modelMetricRows,
} from "./presentation"
import type { ModelUsage } from "./metrics"

function modelUsage(reasoning = 0, complete = true): ModelUsage {
  const reasoningCost = reasoning > 0 ? 0.0504 : 0
  return {
    providerID: "openai",
    modelID: "gpt-5.6-luna",
    usage: {
      input: 123_000,
      cacheRead: 320_500,
      cacheWrite: 32_000,
      output: 500_000,
      reasoning,
    },
    estimate: {
      amount: 0.6169 + reasoningCost,
      breakdown: {
        input: 0.0025,
        cacheRead: 0.0064,
        cacheWrite: 0.008,
        output: 0.6,
        reasoning: reasoningCost,
      },
      complete,
      hasUsage: true,
      source: "public",
    },
  }
}

describe("compact presentation", () => {
  test("formats token counts without unnecessary decimals", () => {
    expect(formatTokenCount(999)).toBe("999")
    expect(formatTokenCount(123_000)).toBe("123K")
    expect(formatTokenCount(320_500)).toBe("320.5K")
    expect(formatTokenCount(10_001)).toBe("10K")
    expect(formatTokenCount(999_999)).toBe("1M")
    expect(formatTokenCount(1_000_001)).toBe("1M")
    expect(formatTokenCount(1_200_000)).toBe("1.2M")
  })

  test("uses adaptive currency precision", () => {
    expect(formatMoney(25)).toBe("$25.00")
    expect(formatMoney(0.99999)).toBe("$1.00")
    expect(formatMoney(0.25)).toBe("$0.2500")
    expect(formatMoney(0.0025)).toBe("$0.002500")
    expect(formatMoney(0)).toBe("$0.00")
  })

  test("normalizes model display names", () => {
    expect(compactModelName("gpt-5.6-luna", "GPT-5.6 Luna")).toBe("luna-5.6")
    expect(compactModelName("gemini-3.8-flash", "Gemini 3.8 Flash")).toBe("gemini-3.8-flash")
    expect(compactModelName("consolidated-5.6", "Consolidated 5.6")).toBe("consolidated-5.6")
  })

  test("disambiguates same-name models from the same provider", () => {
    expect(
      disambiguateModelLabels([
        { providerID: "openai", modelID: "gpt-5.6-a", name: "GPT 5.6" },
        { providerID: "openai", modelID: "gpt-5.6-b", name: "GPT 5.6" },
      ]),
    ).toEqual(["gpt-5.6@openai#1", "gpt-5.6@openai#2"])
  })

  test("shows reasoning only when it is nonzero", () => {
    expect(modelMetricRows(modelUsage()).map((row) => row.label)).toEqual(["IN", "CACHE-R", "CACHE-W", "OUT"])
    expect(modelMetricRows(modelUsage(42_000)).map((row) => row.label)).toEqual([
      "IN",
      "CACHE-R",
      "CACHE-W",
      "OUT",
      "REASON",
    ])
  })

  test("marks partial totals without inventing missing cost", () => {
    expect(formatTotal(modelUsage(0, true).estimate)).toBe("$0.6169")
    expect(formatEstimate(modelUsage(0, true).estimate)).toBe("~$0.6169")
    expect(formatTotal(modelUsage(0, false).estimate)).toBe("$0.6169+")
    expect(formatTotal({ ...modelUsage(0, false).estimate, amount: 0 })).toBe("N/A")
    expect(modelMetricRows(modelUsage(0, false)).every((row) => row.cost !== undefined)).toBe(true)
  })
})
