import { describe, it, expect } from "vitest";
import { sanitizeFts5Query } from "./fts5-sanitizer.js";

describe("sanitizeFts5Query", () => {
  it("passes through a basic single-word query unchanged", () => {
    expect(sanitizeFts5Query("hello")).toBe("hello");
  });

  it("wraps multi-word queries in double quotes", () => {
    expect(sanitizeFts5Query("hello world")).toBe('"hello world"');
  });

  it("escapes double quotes by doubling them (FTS5 convention)", () => {
    expect(sanitizeFts5Query('say "hello"')).toBe('"say ""hello"""');
  });

  it("strips leading asterisks", () => {
    expect(sanitizeFts5Query("**hello")).toBe("hello");
  });

  it("strips trailing asterisks", () => {
    expect(sanitizeFts5Query("hello***")).toBe("hello");
  });

  it("strips both leading and trailing asterisks", () => {
    expect(sanitizeFts5Query("*hello*")).toBe("hello");
  });

  it("wraps query containing AND operator in quotes (case-insensitive)", () => {
    expect(sanitizeFts5Query("cats and dogs")).toBe('"cats and dogs"');
  });

  it("wraps query containing OR operator in quotes (lowercase)", () => {
    expect(sanitizeFts5Query("cats or dogs")).toBe('"cats or dogs"');
  });

  it("wraps query containing NOT operator in quotes", () => {
    expect(sanitizeFts5Query("cats not dogs")).toBe('"cats not dogs"');
  });

  it("wraps query containing NEAR operator in quotes (case-insensitive)", () => {
    expect(sanitizeFts5Query("cats NEAR dogs")).toBe('"cats NEAR dogs"');
  });

  it("throws when input is only asterisks (becomes empty after stripping)", () => {
    expect(() => sanitizeFts5Query("*")).toThrow(
      "FTS5 query cannot be empty after sanitization"
    );
  });

  it("prevents FTS5 operator injection by wrapping query in quotes", () => {
    // Input with FTS5 boolean operators AND/OR/NOT — gets wrapped in double quotes
    const result = sanitizeFts5Query("search AND destroy OR NOT found");
    // Should be wrapped in quotes since it contains FTS5 operator keywords
    expect(result.startsWith('"')).toBe(true);
    expect(result.endsWith('"')).toBe(true);
    // The content is preserved as a literal phrase
    expect(result).toContain("search");
  });

  it("handles unicode characters correctly", () => {
    expect(sanitizeFts5Query("café")).toBe("café");
  });

  it("handles multi-word unicode queries", () => {
    const result = sanitizeFts5Query("こんにちは 世界");
    expect(result).toBe('"こんにちは 世界"');
  });

  it("throws on empty input", () => {
    expect(() => sanitizeFts5Query("")).toThrow(
      "FTS5 query cannot be empty after sanitization"
    );
  });

  it("throws on whitespace-only input", () => {
    expect(() => sanitizeFts5Query("   ")).toThrow(
      "FTS5 query cannot be empty after sanitization"
    );
  });

  it("throws when input becomes empty after stripping asterisks", () => {
    expect(() => sanitizeFts5Query("***")).toThrow(
      "FTS5 query cannot be empty after sanitization"
    );
  });

  it("trims surrounding whitespace from input", () => {
    expect(sanitizeFts5Query("  hello  ")).toBe("hello");
  });

  it("wraps single FTS5 operator keyword in quotes", () => {
    // "AND" alone is an FTS5 operator keyword, so it gets wrapped in quotes
    // to be treated as a literal search for the word "and"
    expect(sanitizeFts5Query("AND")).toBe('"AND"');
  });

  it("handles queries with special characters but no spaces or keywords", () => {
    expect(sanitizeFts5Query("hello-world")).toBe("hello-world");
  });
});
