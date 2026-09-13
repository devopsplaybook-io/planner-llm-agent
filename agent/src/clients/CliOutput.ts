// Parsing helpers for CLI JSON output. Adapters use them to extract the
// reply and the usage metric from the JSON envelopes or JSONL streams
// printed by the coding-agent CLIs.

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

// Reply from a JSONL event stream: the last event carrying one of the
// given text fields wins (the final assistant reply is the last event).
export function extractJsonlString(
  stdout: string,
  fields: string[],
): string | null {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") {
      continue;
    }
    const envelope = event as Record<string, unknown>;
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
