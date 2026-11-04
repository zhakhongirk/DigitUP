import { describe, expect, it } from "vitest";
import { extractJsonObject, parseJsonModeReply, toJsonModeMessages } from "@/server/llm/json-mode";
import type { LlmTool } from "@/server/llm/types";

const tools: LlmTool[] = [
  {
    name: "search_offers",
    description: "Search offers",
    parameters: { type: "object", properties: { query: { type: "string" } } },
  },
];

const newId = () => "id_1";

describe("extractJsonObject", () => {
  it("finds an object inside code fences and prose", () => {
    const text = 'Sure!\n```json\n{"type":"message","content":"a {b} c"}\n```';
    expect(extractJsonObject(text)).toBe('{"type":"message","content":"a {b} c"}');
  });

  it("handles escaped quotes and nested objects", () => {
    const text = '{"a":{"b":"say \\"}\\""}} trailing';
    expect(extractJsonObject(text)).toBe('{"a":{"b":"say \\"}\\""}}');
  });

  it("returns null when there is no complete object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"open": true')).toBeNull();
  });
});

describe("parseJsonModeReply", () => {
  it("parses tool calls and assigns ids", () => {
    const result = parseJsonModeReply(
      '{"type":"tool_calls","tool_calls":[{"name":"search_offers","arguments":{"query":"x"}}]}',
      tools,
      newId,
    );
    expect(result).toEqual({
      content: null,
      toolCalls: [{ id: "id_1", name: "search_offers", arguments: { query: "x" } }],
    });
  });

  it("defaults missing arguments to an empty object", () => {
    const result = parseJsonModeReply(
      '{"type":"tool_calls","tool_calls":[{"name":"search_offers"}]}',
      tools,
      newId,
    );
    expect(result.toolCalls[0]?.arguments).toEqual({});
  });

  it("treats plain text without JSON as a final answer", () => {
    expect(parseJsonModeReply("  Just text.  ", tools, newId)).toEqual({
      content: "Just text.",
      toolCalls: [],
    });
  });

  it("rejects unknown tools", () => {
    expect(() =>
      parseJsonModeReply(
        '{"type":"tool_calls","tool_calls":[{"name":"drop_database","arguments":{}}]}',
        tools,
        newId,
      ),
    ).toThrow(expect.objectContaining({ kind: "unknown_tool" }));
  });

  it("rejects JSON that breaks the protocol", () => {
    expect(() => parseJsonModeReply('{"type":"other"}', tools, newId)).toThrow(
      expect.objectContaining({ kind: "invalid_json_response" }),
    );
  });
});

describe("toJsonModeMessages", () => {
  it("injects the protocol into the first system message and converts tool turns", () => {
    const messages = toJsonModeMessages(
      [
        { role: "system", content: "Base prompt." },
        { role: "user", content: "boots?" },
        {
          role: "assistant",
          content: null,
          toolCalls: [{ id: "c1", name: "search_offers", arguments: { query: "boots" } }],
        },
        { role: "tool", toolCallId: "c1", name: "search_offers", content: "[]" },
      ],
      tools,
    );

    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toMatch(/^Base prompt\.\n\nYou can call tools/);
    expect(JSON.parse(messages[2]?.content as string)).toEqual({
      type: "tool_calls",
      tool_calls: [{ name: "search_offers", arguments: { query: "boots" } }],
    });
    expect(messages[3]).toEqual({
      role: "user",
      content: "TOOL_RESULT search_offers (c1):\n[]",
    });
  });

  it("adds a system message when the conversation has none", () => {
    const messages = toJsonModeMessages([{ role: "user", content: "hi" }], tools);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });
});

describe("toJsonModeMessages with images", () => {
  it("keeps image parts of user messages", () => {
    const content = [
      { type: "text" as const, text: "read" },
      { type: "image" as const, url: "data:image/png;base64,AAAA" },
    ];
    const out = toJsonModeMessages([{ role: "user", content }], []);
    expect(out.find((m) => m.role === "user")).toEqual({ role: "user", content });
  });
});
