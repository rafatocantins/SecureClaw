/**
 * FTS5 Query Sanitizer
 * Escapes/removes FTS5 special syntax from user-supplied search queries
 * to prevent query injection via FTS5 operators.
 */
const FTS5_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/gi;

export function sanitizeFts5Query(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    throw new Error("FTS5 query cannot be empty after sanitization");
  }

  // Escape double quotes by doubling them (FTS5 convention)
  let sanitized = trimmed.replace(/"/g, '""');

  // Strip wildcard prefix/suffix operators that could cause performance issues
  sanitized = sanitized.replace(/^\*+/, "").replace(/\*+$/, "");

  // Remove standalone asterisks
  sanitized = sanitized.replace(/\*/g, "");

  // If the query contains spaces or FTS5 operator keywords, wrap in double quotes
  // to treat it as a literal phrase rather than FTS5 syntax
  if (/\s/.test(sanitized) || FTS5_OPERATORS.test(sanitized)) {
    sanitized = `"${sanitized}"`;
  }

  if (sanitized.trim().length === 0) {
    throw new Error("FTS5 query cannot be empty after sanitization");
  }

  return sanitized;
}
