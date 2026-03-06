/**
 * Handles Kitty keyboard protocol escape sequences that Ink's useInput doesn't
 * understand, returning the updated value/cursor state, or null if unrecognised.
 *
 * When the Kitty protocol is active (\x1b[>1u), terminals that support it send
 * enhanced CSI sequences for certain keys. Ink only knows the classic sequences,
 * so we intercept the raw stdin data and apply the edit ourselves.
 */
export function applyKittyData(
  seq: string,
  value: string,
  cursor: number,
): { value: string; cursor: number } | null {
  // Shift+Enter
  if (seq === "\x1b[13;2u") {
    return {
      value: value.slice(0, cursor) + "\n" + value.slice(cursor),
      cursor: cursor + 1,
    };
  }

  // Backspace — \x1b[127;1u (with explicit no-modifier) or \x1b[127u (short form)
  if (seq === "\x1b[127;1u" || seq === "\x1b[127u") {
    if (cursor === 0) return null;
    return {
      value: value.slice(0, cursor - 1) + value.slice(cursor),
      cursor: cursor - 1,
    };
  }

  return null;
}
