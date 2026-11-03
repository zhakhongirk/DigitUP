import { describe, expect, it } from "vitest";
import { stripPolicyLabel } from "@/app/s/[slug]/policy";

describe("stripPolicyLabel", () => {
  it("drops a repeated leading label", () => {
    expect(stripPolicyLabel("delivery", "Delivery", "Delivery: free courier")).toBe("free courier");
    expect(stripPolicyLabel("working_hours", "Working hours", "Opening hours: 9-18")).toBe("9-18");
  });

  it("keeps other text", () => {
    expect(stripPolicyLabel("payment", "Payment", "Cash or card")).toBe("Cash or card");
    expect(stripPolicyLabel("returns", "Returns", "Note: within 14 days")).toBe(
      "Note: within 14 days",
    );
  });
});
