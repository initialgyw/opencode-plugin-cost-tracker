# opencode-plugin-cost-tracker

An [OpenCode](https://opencode.ai) TUI plugin that replaces the sidebar's **Context** section with a
per-model breakdown of token usage and estimated cost. Usage is totaled across the session you are
viewing and all of its subagent (child) sessions.

```text
Context
63.5K / 1.1M
6% used
claude-opus-5.5 (~$0.1400)
  IN           20K ($0.0800)
  CACHE-R        0 ($0.00)
  CACHE-W        0 ($0.00)
  OUT           3K ($0.0600)

example-model (N/A)
  IN            1K (N/A)
  CACHE-R        0 (N/A)
  CACHE-W        0 (N/A)
  OUT          100 (N/A)

luna-5.6 (~$0.006250)
  IN           10K ($0.002000)
  CACHE-R      50K ($0.001000)
  CACHE-W       1K ($0.000250)
  OUT           2K ($0.002400)
  REASON       500 ($0.000600)

Total: ~$0.1463+
```

- **Context** is the size of the latest assistant response in the current session, compared with the
  model's context limit.
- Each model block lists input (`IN`), cache reads (`CACHE-R`), cache writes (`CACHE-W`), output
  (`OUT`), and reasoning (`REASON`, shown only when nonzero and priced at the output rate).
- `~` marks an estimate. A trailing `+` means the value is a lower bound, because history is still
  loading or some usage has no known rate. `N/A` means no rate is known for that model.

## Requirements

- OpenCode with TUI plugin support. The plugin is built against the OpenCode 1.18.29 TUI plugin API.
- Nothing to install at runtime: OpenCode provides `solid-js` and `@opentui/solid` to TUI plugins.

## Install

The plugin is not published to npm. Load it from a local checkout:

1. Clone the repository:

   ```sh
   git clone https://github.com/initialgyw/opencode-plugin-cost-tracker.git
   ```

2. Add the entry file to the `plugin` list of a TUI config file: `~/.config/opencode/tui.json` for
   every project, or `.opencode/tui.json` inside one project.

   ```json
   {
     "$schema": "https://opencode.ai/tui.json",
     "plugin": ["/absolute/path/to/opencode-plugin-cost-tracker/src/index.tsx"]
   }
   ```

   Relative paths are resolved from the directory that contains `tui.json`.

3. Restart OpenCode. While the plugin is loaded it hides the built-in sidebar Context section, and it
   restores that section when it is unloaded. To uninstall, remove the entry from `plugin`.

## How costs are estimated

Each assistant message is priced with the first rate source that applies:

1. **Your `provider_pricing` rates** from the plugin options (see [Custom pricing](#custom-pricing)).
2. **Built-in list prices** for these exact public model IDs (standard processing tier, USD):

   | Provider  | Model IDs                                                                 |
   | --------- | ------------------------------------------------------------------------- |
   | OpenAI    | `gpt-5.6-luna`, `gpt-5.6-terra`, `gpt-5.6-sol`                            |
   | Anthropic | `claude-opus-5-5`, `claude-fable-5-1`, `claude-sonnet-5`, `claude-opus-5` |
   | Google    | `gemini-3.1-pro-preview`, `gemini-3.8-flash`                              |

   These include GPT-5.6 long-context rates above 272K prompt tokens, Gemini 3.1 Pro rates above 200K
   prompt tokens, and Gemini 3.8 Flash introductory pricing through 2026-12-31 (standard pricing
   applies to messages after that date). GPT-5.6 Sol uses OpenAI's current promotional price, which
   OpenAI lists as available through at least 2026-11-21. Rates and their source pages are in
   `src/metrics.ts`; they were last verified on 2026-09-24.
3. **OpenCode model metadata**: the model's `cost` from OpenCode's model catalog or from your config.
4. Otherwise the model shows `N/A` and the total is marked with `+`.

Built-in prices match model IDs exactly (letter case, `.`, and `_` are normalized). A model reached
through a gateway, proxy, or router under a different ID is not guessed; it is priced from
`provider_pricing` or its metadata.

Estimates use per-token list prices. They do not account for batch, flex, or priority processing,
regional surcharges, negotiated discounts, or gateway and reseller billing, so they can differ from
your invoice.

### Custom pricing

To price a custom or gateway model, or to override any other rate, pass a `provider_pricing.models`
map in the plugin's options. Rates are USD per million tokens. Options go in `tui.json`, where the
plugin entry from [Install](#install) becomes a `[path, options]` pair. The path, model IDs, and
rates below are placeholders; replace them with your own:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    [
      "/absolute/path/to/opencode-plugin-cost-tracker/src/index.tsx",
      {
        "provider_pricing": {
          "models": {
            "my_model": { "input": 1.25, "output": 10, "cache_read": 0.125, "cache_write": 1.5 },
            "my-gateway/gpt-5.6-luna": { "input": 0.25, "output": 1.5, "cache_read": 0.025 }
          }
        }
      }
    ]
  ]
}
```

- **Keys** must match the IDs OpenCode reports for your models. `opencode models` lists them as
  `provider/model`; the sidebar shows a shortened label that can differ. Use the model part
  (`my_model`) to price that model from any provider, or the full `provider/model` ID to price it for
  one provider only; the full ID takes precedence. Keys are compared exactly, including letter case,
  `.`, `-`, and `_`.
- **Rates**: `input` and `output` are required. `cache_read` and `cache_write` are optional; if a
  model uses a cache category that has no rate, that row shows `N/A` and the total is marked with
  `+`. Rates are flat (no long-context tiers), and reasoning tokens are priced at the `output` rate.
- **Invalid entries**: an entry that is not an object, lacks `input` or `output`, or has a negative,
  non-numeric, or unrecognized field is ignored and listed in a warning toast when the plugin loads.
  That model is priced from the next source.

`provider_pricing` does not work as a top-level key in `opencode.json`. OpenCode's config schema
does not allow it, and OpenCode 1.18.29 drops unknown top-level keys instead of passing them to
plugins, so the plugin never receives them.

### Model `cost` metadata

You can also add OpenCode's standard `cost` field (USD per million tokens) to a model in your
`opencode.json`. `provider_pricing` takes precedence over it. Replace the provider, URL, model ID,
limits, and rates with your own values:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://llm-gateway.example.com/v1" },
      "models": {
        "my_model": {
          "name": "My Model",
          "limit": { "context": 200000, "output": 32000 },
          "cost": { "input": 1.25, "output": 10, "cache_read": 0.125, "cache_write": 1.5 }
        }
      }
    }
  }
}
```

OpenCode treats a custom model without `cost` as free, so the plugin shows `~$0.00` for it unless
`provider_pricing` prices it. `limit.context` enables the context percentage.

## Development

Requires [Bun](https://bun.sh).

```sh
bun install
bun run test
bun run typecheck
```

Development dependencies are pinned to the OpenCode 1.18.29 plugin API and OpenTUI 0.4.5.

| File                  | Purpose                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `src/index.tsx`       | Plugin entry: registers the sidebar slot and renders the panel   |
| `src/history.ts`      | Loads message history for the session and its subagent sessions |
| `src/metrics.ts`      | Usage totals and pricing                                         |
| `src/presentation.ts` | Token, currency, and model label formatting                      |
