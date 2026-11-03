import { describe, expect, it } from "vitest";
import { platformLlmsTxt, publicMcpUrl, storeLlmsTxt } from "@/server/storefront/llms";

const base = "https://shop.example.com";

describe("llms.txt", () => {
  it("describes the platform and the public MCP endpoint pattern", () => {
    const text = platformLlmsTxt(base);
    expect(text.startsWith("# Agentic Storefront")).toBe(true);
    expect(text).toContain(`${base}/mcp/public/<store-slug>`);
    expect(text).toContain("talk_to_store(message, session_id)");
    expect(text).toContain("No credentials are needed");
    expect(text).toContain(`${base}/sitemap.xml`);
    expect(text).not.toContain(String.fromCharCode(0x2014));
  });

  it("describes one store with its own endpoint", () => {
    const text = storeLlmsTxt({
      baseUrl: base,
      slug: "stride-shoes",
      name: "Stride Shoes",
      description: "Running shoes and sneakers",
    });
    expect(text.startsWith("# Stride Shoes\n")).toBe(true);
    expect(text).toContain("> Running shoes and sneakers");
    expect(text).toContain(`${base}/mcp/public/stride-shoes`);
    expect(text).toContain(`${base}/s/stride-shoes`);
    expect(text).toContain("talk_to_store");
    expect(text).toContain(`Platform: ${base}/llms.txt`);
  });

  it("falls back to a generic description", () => {
    const text = storeLlmsTxt({ baseUrl: base, slug: "a", name: "A", description: "  " });
    expect(text).toContain("> Online store on Agentic Storefront.");
  });

  it("builds the public endpoint url", () => {
    expect(publicMcpUrl(base, "x")).toBe(`${base}/mcp/public/x`);
  });
});
