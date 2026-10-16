/**
 * Default model IDs, one per provider, in a single place so a model bump is a
 * one-line change and never goes stale in scattered constructors. A user's own
 * `model:` in `config.yaml` always wins; these apply only when none is set.
 *
 * `anthropic` is pinned to the current Sonnet — balanced cost/quality, and a
 * faithful successor to the tool's original (now-retired) `claude-sonnet-4-6`
 * default. Bump to `claude-opus-5` for higher quality at higher cost if you
 * prefer; that is a maintainer cost decision, so it is not the silent default.
 * Refresh these when Anthropic ships a new generation (see plan_ahead.md risk:
 * "provider drift").
 */
export const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
  ollama: "llama3.2",
} as const;

/**
 * Cheap-tier models for the always-on observer (plan_v3 §3.3 warm path), which
 * runs often over small inputs. `observer_model` in config overrides; for an
 * openai-compatible endpoint (unknown tiers) the configured model is reused.
 */
export const CHEAP_MODELS = {
  anthropic: "claude-haiku-5-5",
  openai: "gpt-4o-mini",
  ollama: "llama3.2",
} as const;
