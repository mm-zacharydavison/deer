import React from "react";
import { Box, Text } from "ink";
import type { ContextChip } from "../context/types";

/**
 * Renders the row of resolved context chips above the prompt input.
 * The last chip is dismissed by pressing Backspace on an empty prompt.
 * Returns null when there are no chips (renders nothing).
 */
export function ContextChipBar({ chips }: { chips: ContextChip[] }) {
  if (chips.length === 0) return null;

  return (
    <Box paddingX={1} gap={1}>
      {chips.map((chip, i) => (
        <Text key={i} color="cyan">[{chip.label} ×]</Text>
      ))}
    </Box>
  );
}
