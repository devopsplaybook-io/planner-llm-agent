// Parsing helpers for CLI JSON output. Adapters use them to extract the
// reply and the usage metric from the JSON envelopes or JSONL streams
// printed by the coding-agent CLIs.

import type { AgentSessionTokens } from "../AgentSessionMetrics";

// Parses a JSON object from the CLI output. The CLI may print extra lines
// around the JSON envelope, so also try the slice between the outermost
// braces. For JSONL output only the whole trimmed text is tried.
export function parseJsonEnvelope(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed.includes("{")) {
    return null;
  }
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(trimmed.slice(start, end + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// First non-empty string field among the given names, also looking one
// level into a nested 'data' object (used by JSONL event shapes).
export function extractEnvelopeString(
  stdout: string,
  fields: string[],
): string | null {
  for (const envelope of jsonEnvelopeCandidates(stdout)) {
    for (const field of fields) {
      const value = envelope[field];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    const data = envelope.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data)) {
      for (const field of fields) {
        const value = (data as Record<string, unknown>)[field];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
    }
  }
  return null;
}

// Numeric field of the JSON envelope (usage metrics like total_credits or
// total_cost_usd).
export function extractEnvelopeNumber(
  stdout: string,
  field: string,
): number | null {
  const envelope = parseJsonEnvelope(stdout);
  if (envelope === null) {
    return null;
  }
  const value = envelope[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Object field of the JSON envelope (nested structures like the per-run
// token usage object).
export function extractEnvelopeObject(
  stdout: string,
  field: string,
): Record<string, unknown> | null {
  const envelope = parseJsonEnvelope(stdout);
  if (envelope === null) {
    return null;
  }
  const value = envelope[field];
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// Finite numeric token count, or undefined when the value is not one.
export function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Token usage of a run as reported by the Claude-style top-level 'usage'
// object (Claude Code and the Claude-compatible Qoder envelope); null when
// no token count is reported. Only the token types present in the object
// are returned.
export function extractClaudeStyleTokenUsage(
  stdout: string,
): AgentSessionTokens | null {
  const usage = extractEnvelopeObject(stdout, "usage");
  if (usage === null) {
    return null;
  }
  const tokens: AgentSessionTokens = {};
  addTokenCount(tokens, "input", usage["input_tokens"]);
  addTokenCount(tokens, "output", usage["output_tokens"]);
  addTokenCount(tokens, "cacheWrite", usage["cache_creation_input_tokens"]);
  addTokenCount(tokens, "cacheRead", usage["cache_read_input_tokens"]);
  return Object.keys(tokens).length > 0 ? tokens : null;
}

function addTokenCount(
  tokens: AgentSessionTokens,
  type: keyof AgentSessionTokens,
  value: unknown,
): void {
  const count = tokenCount(value);
  if (count !== undefined) {
    tokens[type] = count;
  }
}

// JSON envelopes of the output: the whole text for a single envelope, or
// every line for a JSONL stream (the lines are returned in order).
function jsonEnvelopeCandidates(stdout: string): Record<string, unknown>[] {
  const envelope = parseJsonEnvelope(stdout);
  if (envelope !== null) {
    return [envelope];
  }
  const envelopes: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed !== null && typeof parsed === "object") {
        envelopes.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Skip lines that are not JSON objects.
    }
  }
  return envelopes;
}
