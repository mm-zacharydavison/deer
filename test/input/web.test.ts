import { test, expect, describe } from "bun:test";
import { extractReadableContent } from "../../src/input/web";

describe("extractReadableContent", () => {
  test("extracts text from simple HTML", () => {
    const html = `
      <html>
        <head><title>Test Page</title></head>
        <body>
          <h1>Hello World</h1>
          <p>This is a paragraph.</p>
        </body>
      </html>
    `;
    const result = extractReadableContent(html);
    expect(result).toContain("Hello World");
    expect(result).toContain("This is a paragraph.");
  });

  test("strips script and style tags", () => {
    const html = `
      <html>
        <body>
          <script>alert('xss')</script>
          <style>.foo { color: red; }</style>
          <p>Visible content</p>
        </body>
      </html>
    `;
    const result = extractReadableContent(html);
    expect(result).toContain("Visible content");
    expect(result).not.toContain("alert");
    expect(result).not.toContain("color: red");
  });

  test("strips HTML tags but keeps text content", () => {
    const html = "<p>Hello <strong>bold</strong> and <em>italic</em></p>";
    const result = extractReadableContent(html);
    expect(result).toContain("Hello");
    expect(result).toContain("bold");
    expect(result).toContain("italic");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("<em>");
  });

  test("collapses excessive whitespace", () => {
    const html = "<p>Hello     \n\n\n\n    World</p>";
    const result = extractReadableContent(html);
    // Should not have more than 2 consecutive newlines
    expect(result).not.toMatch(/\n{3,}/);
  });
});
