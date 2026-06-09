// Parse a GitHub Issue Forms body into { label -> value } pairs.
// Issue Forms format each field as `### <Label>\n\n<value>\n\n`.
// Empty optional fields render as `_No response_` which we map to null.
export function parseIssueBody(body) {
  if (!body) return {};
  const out = {};
  const re = /^###\s+(.+?)\s*$/gm;
  const parts = body.split(re);
  // parts[0] is preamble; then alternating [label, content, label, content, ...]
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const label = parts[i].trim();
    let content = parts[i + 1].trim();
    if (content === "_No response_" || content === "") content = null;
    out[label] = content;
  }
  return out;
}

// Trim, lowercase-compare common error messages, etc.
export function isHex64(s) {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

export function isValidBadgeId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.test(s);
}

export function isValidClientId(s) {
  return typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/.test(s);
}

export function isIsoDate(s) {
  if (typeof s !== "string") return false;
  const d = new Date(s);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(s);
}

export function csvList(s) {
  if (!s) return [];
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
