import { test, expect, describe } from "bun:test";
import { parseNdjsonLine, createAgentState, type AgentState } from "../src/dashboard";

function makeAgent(overrides: Partial<AgentState> = {}): AgentState {
  return createAgentState({
    id: 1,
    taskId: "deer_test",
    prompt: "test",
    status: "running",
    ...overrides,
  });
}

// ── existing parsing behavior ───────────────────────────────────────

describe("parseNdjsonLine - event parsing", () => {
  test("returns false for empty lines", () => {
    const agent = makeAgent();
    expect(parseNdjsonLine("", agent)).toBe(false);
    expect(parseNdjsonLine("   ", agent)).toBe(false);
  });

  test("parses assistant text content", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Working on it" }],
      },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.lastActivity).toContain("Working on it");
    expect(agent.transcript).toContain("Working on it");
  });

  test("parses tool_use blocks", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: "/tmp/test.ts" },
        }],
      },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.currentTool).toContain("Read");
  });

  test("parses content_block_delta", () => {
    const agent = makeAgent();
    const line = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "streaming chunk" },
    });

    const changed = parseNdjsonLine(line, agent);
    expect(changed).toBe(true);
    expect(agent.lastActivity).toContain("streaming chunk");
  });

  test("handles invalid JSON gracefully", () => {
    const agent = makeAgent();
    const changed = parseNdjsonLine("not valid json {{{", agent);
    expect(changed).toBe(true); // treated as plain text log
    expect(agent.logs.length).toBeGreaterThan(0);
  });
});
