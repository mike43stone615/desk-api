import { describe, it, expect } from "vitest";
import {
  parseFilters,
  escapeLikeValue,
  buildFilterClause,
  validateEditableValue,
} from "../api/routes/admin.js";

describe("parseFilters", () => {
  it("keeps only whitelisted columns with non-empty trimmed values", () => {
    const raw = JSON.stringify({
      email: "  test@example.com  ",
      not_a_column: "x",
      status: "",
    });
    expect(parseFilters(raw, ["email", "status"])).toEqual({
      email: "test@example.com",
    });
  });

  it("returns an empty object for missing or malformed input", () => {
    expect(parseFilters(undefined, ["email"])).toEqual({});
    expect(parseFilters("not json", ["email"])).toEqual({});
    expect(parseFilters("[]", ["email"])).toEqual({});
    expect(parseFilters("null", ["email"])).toEqual({});
  });
});

describe("validateEditableValue", () => {
  it("allows businesses.industry values from the Desk industry list", () => {
    expect(validateEditableValue("businesses", "industry", "Bakery")).toBe(
      "Bakery",
    );
  });

  it("rejects businesses.industry values outside the Desk industry list", () => {
    expect(() =>
      validateEditableValue("businesses", "industry", "Made Up Industry"),
    ).toThrow(/supported Desk industry/);
  });
});

describe("escapeLikeValue", () => {
  it("escapes LIKE wildcard characters", () => {
    expect(escapeLikeValue("50% off_all")).toBe("50\\% off\\_all");
    expect(escapeLikeValue("back\\slash")).toBe("back\\\\slash");
  });
});

describe("buildFilterClause", () => {
  it("returns an empty clause for no filters", () => {
    expect(buildFilterClause({})).toEqual({ sql: "", params: [] });
  });

  it("ANDs multiple filters together with wildcarded, escaped params", () => {
    const { sql, params } = buildFilterClause({ email: "test", status: "50%" });
    expect(sql).toBe(
      "WHERE CAST(email AS TEXT) LIKE ? ESCAPE '\\' AND CAST(status AS TEXT) LIKE ? ESCAPE '\\'",
    );
    expect(params).toEqual(["%test%", "%50\\%%"]);
  });
});
