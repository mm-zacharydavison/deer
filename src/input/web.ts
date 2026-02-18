/**
 * Extract readable text content from HTML, stripping tags, scripts, and styles.
 */
export function extractReadableContent(html: string): string {
  let text = html;

  // Remove script tags and their content
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");

  // Remove style tags and their content
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  // Remove all HTML tags
  text = text.replace(/<[^>]+>/g, " ");

  // Decode common HTML entities
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&nbsp;/g, " ");

  // Collapse whitespace: multiple spaces → single space per line
  text = text.replace(/[ \t]+/g, " ");

  // Collapse multiple blank lines into at most two newlines
  text = text.replace(/\n{3,}/g, "\n\n");

  // Trim each line
  text = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line, i, arr) => {
      // Remove leading empty lines
      if (i === 0 && line === "") return false;
      // Remove trailing empty lines
      if (i === arr.length - 1 && line === "") return false;
      // Collapse consecutive empty lines
      if (line === "" && i > 0 && arr[i - 1].trim() === "") return false;
      return true;
    })
    .join("\n");

  return text.trim();
}

/**
 * Fetch a web page and extract readable content as plain text.
 */
export async function fetchWebPage(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return extractReadableContent(html);
}
