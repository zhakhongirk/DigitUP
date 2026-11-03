import { describe, expect, it } from "vitest";
import { parsePoliciesForm, parseProfileForm } from "@/server/owner/settings";

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("parseProfileForm", () => {
  it("trims values and drops empty contacts", () => {
    const result = parseProfileForm(
      form({
        name: "  Shoe Shop ",
        description: " Footwear ",
        category: "",
        "contact.phone": " +7 700 ",
        "contact.email": "  ",
      }),
    );
    expect(result).toEqual({
      name: "Shoe Shop",
      description: "Footwear",
      category: null,
      contacts: { phone: "+7 700" },
    });
  });

  it("keeps a category and every contact field", () => {
    const result = parseProfileForm(
      form({ name: "A", category: "Retail", "contact.address": "Main street 1" }),
    );
    expect(result.category).toBe("Retail");
    expect(result.contacts).toEqual({ address: "Main street 1" });
  });
});

describe("parsePoliciesForm", () => {
  it("maps blanks to null so the policy is cleared", () => {
    const result = parsePoliciesForm(form({ "policy.delivery": " Free ", "policy.other": "" }));
    expect(result).toEqual({
      delivery: "Free",
      payment: null,
      returns: null,
      working_hours: null,
      other: null,
    });
  });
});
