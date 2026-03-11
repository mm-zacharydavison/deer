import { Box, Text } from "ink";
import React from "react";
import { availableActions, ACTION_BINDINGS } from "../state-machine";
import type { AgentAction } from "../state-machine";
import type { PreflightResult } from "../preflight";
import type { AgentState } from "../agent-state";

interface ShortcutsBarProps {
  selected: AgentState | null;
  inputFocused: boolean;
  searchMode: boolean;
  verboseMode: boolean;
  logExpanded: boolean;
  preflight: PreflightResult | null;
}

export function ShortcutsBar({
  selected,
  inputFocused,
  searchMode,
  verboseMode,
  logExpanded,
  preflight,
}: ShortcutsBarProps) {
  let mainActions: AgentAction[] = [];
  let logSubActions: AgentAction[] = [];
  if (selected && !inputFocused && !searchMode) {
    const actions = availableActions({
      status: selected.status,
      hasPrUrl: !!selected.result?.prUrl,
      hasFinalBranch: !!selected.result?.finalBranch || !!selected.branch,
      hasHandle: selected.status === "running",
      isIdle: selected.idle,
      prState: selected.prState,
      hasWorktreePath: !!selected.taskId,
      logExpanded,
    });
    logSubActions = actions.filter((a) => a === "copy_logs" || a === "toggle_verbose");
    mainActions = actions.filter((a) => a !== "copy_logs" && a !== "toggle_verbose");
  }

  // Calculate character offset of "l logs" on line 1 so sub-actions align beneath it.
  // Layout: paddingX(1) + items joined by gap(2). Each item = "key label".
  const gap = 2;
  const fixedItems = ["Tab focus", "j/k ↑↓", "/ search"];
  const itemWidth = (s: string) => s.length;
  let logOffset = 1; // paddingX left
  if (!inputFocused && !searchMode) {
    for (const s of fixedItems) {
      logOffset += itemWidth(s) + gap;
    }
    for (const action of mainActions) {
      if (action === "toggle_logs") break;
      const b = ACTION_BINDINGS[action];
      logOffset += itemWidth(b.keyDisplay + " " + b.label) + gap;
    }
  }

  return (
    <Box flexDirection="column" height={3}>
      {/* Line 1: main keybindings */}
      <Box paddingX={1} gap={2}>
        {searchMode ? (
          <>
            <Text><Text bold color="white">j/k</Text><Text dimColor> ↑↓</Text></Text>
            <Text><Text bold color="white">⏎</Text><Text dimColor> select</Text></Text>
            <Text><Text bold color="white">Esc</Text><Text dimColor> cancel</Text></Text>
          </>
        ) : (
          <>
            <Text><Text bold color="white">Tab</Text><Text dimColor> focus</Text></Text>
            {!inputFocused && (
              <>
                <Text><Text bold color="white">j/k</Text><Text dimColor> ↑↓</Text></Text>
                <Text><Text bold color="white">/</Text><Text dimColor> search</Text></Text>
                {mainActions.map((action) => (
                  <Text key={action}>
                    <Text bold color="white">{ACTION_BINDINGS[action].keyDisplay}</Text>
                    <Text dimColor> {ACTION_BINDINGS[action].label}</Text>
                  </Text>
                ))}
                <Text><Text bold color="white">q</Text><Text dimColor> quit</Text></Text>
              </>
            )}
          </>
        )}
      </Box>
      {/* Line 2: "c copy" under "l logs" | "agent" label right-aligned */}
      <Box paddingX={1} justifyContent="space-between">
        <Box paddingLeft={logOffset - 1}>
          {logSubActions.includes("copy_logs") ? (
            <Text>
              <Text bold color="white">{ACTION_BINDINGS.copy_logs.keyDisplay}</Text>
              <Text dimColor> {ACTION_BINDINGS.copy_logs.label}</Text>
            </Text>
          ) : <Text>{" "}</Text>}
        </Box>
        {preflight && (
          <Text color="blue">agent</Text>
        )}
      </Box>
      {/* Line 3: "v verbose" under "c copy" | credential type right-aligned */}
      <Box paddingX={1} justifyContent="space-between">
        <Box paddingLeft={logOffset - 1}>
          {logSubActions.includes("toggle_verbose") ? (
            <Text>
              <Text bold color="white">{ACTION_BINDINGS.toggle_verbose.keyDisplay}</Text>
              <Text dimColor> {ACTION_BINDINGS.toggle_verbose.label}</Text>
              {verboseMode && <Text dimColor italic> (on)</Text>}
            </Text>
          ) : <Text>{" "}</Text>}
        </Box>
        {preflight && (
          <Text dimColor={preflight.credentialType !== "none"} color={preflight.credentialType === "none" ? "red" : undefined}>
            {preflight.credentialType === "subscription" ? "subscription" : preflight.credentialType === "api-token" ? "api-token" : "no credentials"}
          </Text>
        )}
      </Box>
    </Box>
  );
}
