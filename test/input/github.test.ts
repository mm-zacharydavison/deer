import { test, expect, describe } from "bun:test";
import { parseGitHubIssueUrl, formatGitHubIssue } from "../../src/input/github";

describe("parseGitHubIssueUrl", () => {
  test("parses standard issue URL", () => {
    const result = parseGitHubIssueUrl("https://github.com/org/repo/issues/42");
    expect(result).toEqual({ owner: "org", repo: "repo", number: 42 });
  });

  test("parses issue URL with trailing slash", () => {
    const result = parseGitHubIssueUrl("https://github.com/org/repo/issues/42/");
    expect(result).toEqual({ owner: "org", repo: "repo", number: 42 });
  });

  test("returns null for non-issue GitHub URL", () => {
    const result = parseGitHubIssueUrl("https://github.com/org/repo/pull/42");
    expect(result).toBeNull();
  });

  test("returns null for non-GitHub URL", () => {
    const result = parseGitHubIssueUrl("https://notion.so/page/abc");
    expect(result).toBeNull();
  });
});

describe("formatGitHubIssue", () => {
  test("formats issue with title and body", () => {
    const result = formatGitHubIssue({
      title: "Login timeout on mobile",
      body: "Users report timeout after 30s on iOS Safari.",
      comments: [],
    });

    expect(result).toContain("## Login timeout on mobile");
    expect(result).toContain("Users report timeout after 30s on iOS Safari.");
  });

  test("formats issue with comments", () => {
    const result = formatGitHubIssue({
      title: "Bug report",
      body: "Something is broken.",
      comments: [
        { author: "alice", body: "I can reproduce this." },
        { author: "bob", body: "Same here, on Chrome too." },
      ],
    });

    expect(result).toContain("### Comments");
    expect(result).toContain("**alice:**");
    expect(result).toContain("I can reproduce this.");
    expect(result).toContain("**bob:**");
    expect(result).toContain("Same here, on Chrome too.");
  });

  test("formats issue with empty body", () => {
    const result = formatGitHubIssue({
      title: "Blank issue",
      body: "",
      comments: [],
    });

    expect(result).toContain("## Blank issue");
    expect(result).not.toContain("undefined");
  });

  test("formats issue with no comments section when empty", () => {
    const result = formatGitHubIssue({
      title: "No comments",
      body: "Just the body.",
      comments: [],
    });

    expect(result).not.toContain("### Comments");
  });
});
