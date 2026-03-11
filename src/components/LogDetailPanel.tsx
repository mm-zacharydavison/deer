import { Box, Text } from "ink";
import React from "react";
import { truncate, prStateColor } from "../dashboard-utils";
import { MAX_VISIBLE_LOGS } from "../constants";
import type { AgentState } from "../agent-state";

interface LogDetailPanelProps {
  agent: AgentState;
  height: number;
  termWidth: number;
  verboseMode: boolean;
}

export function LogDetailPanel({ agent, height, termWidth, verboseMode }: LogDetailPanelProps) {
  const extraLines = (agent.result?.prUrl ? 1 : 0) + (agent.error ? 1 : 0);
  const visibleLogs = Math.max(MAX_VISIBLE_LOGS - extraLines, 1);
  const detailLogs = verboseMode ? agent.logs : agent.logs.filter((l) => !l.verbose);

  return (
    <Box flexDirection="column" paddingX={1} height={height} overflowY="hidden">
      <Text dimColor>{"╌".repeat(termWidth - 2)}</Text>
      {detailLogs.slice(-visibleLogs).map((entry, i) => (
        <Text key={i} dimColor wrap="truncate">
          {truncate(entry.text, termWidth - 4)}
        </Text>
      ))}
      {agent.result?.prUrl && (
        <Text color={prStateColor(agent.prState)} bold>
          PR ({agent.prState ?? "checking…"}): {agent.result.prUrl}
        </Text>
      )}
      {agent.error && (
        <Text color="red">{truncate(agent.error, termWidth - 4)}</Text>
      )}
    </Box>
  );
}
