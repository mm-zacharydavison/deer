import { useState, useEffect, useRef, useCallback } from "react";
import { loadHistory } from "../task";
import { isTmuxSessionDead } from "../sandbox/index";
import { detectRepo } from "../git/worktree";
import { type AgentState, historicalAgent, crossInstanceAgent } from "../agent-state";

export function useAgentSync(cwd: string) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const nextId = useRef(1);
  const agentsRef = useRef(agents);
  agentsRef.current = agents;
  const deletedTaskIdsRef = useRef(new Set<string>());
  const baseBranchRef = useRef("main");

  // ── Detect base branch on mount ────────────────────────────────────

  useEffect(() => {
    detectRepo(cwd).then((info) => {
      baseBranchRef.current = info.defaultBranch;
    }).catch(() => {});
  }, [cwd]);

  // ── Sync state from history file ──────────────────────────────────

  const syncWithHistory = useCallback(async () => {
    const allFileTasks = await loadHistory(cwd);
    const fileTasks = allFileTasks.filter(t => !deletedTaskIdsRef.current.has(t.taskId));
    const currentAgents = agentsRef.current;
    const agentByTaskId = new Map(currentAgents.map(a => [a.taskId, a]));
    const fileTaskIds = new Set(fileTasks.map(t => t.taskId));

    const newAgents: AgentState[] = await Promise.all(fileTasks.map(async task => {
      const existing = agentByTaskId.get(task.taskId);
      if (existing && !existing.historical) {
        return existing;
      }
      const id = existing?.id ?? nextId.current++;

      // For running tasks not managed by this instance, check if the tmux
      // session is still alive to distinguish cross-instance tasks from
      // truly interrupted ones.
      if (task.status === "running") {
        const isDead = await isTmuxSessionDead(`deer-${task.taskId}`);
        if (!isDead) {
          return crossInstanceAgent(task, id);
        }
        // Session is dead — fall through to historicalAgent (shows as interrupted)
      }

      return historicalAgent(task, id);
    }));

    for (const agent of currentAgents) {
      if (!agent.historical && !fileTaskIds.has(agent.taskId)) {
        newAgents.push(agent);
      }
    }

    const changed =
      newAgents.length !== currentAgents.length ||
      newAgents.some((a, i) => {
        const cur = currentAgents[i];
        return !cur || a.taskId !== cur.taskId || a.status !== cur.status || a.lastActivity !== cur.lastActivity;
      });

    if (changed) setAgents(newAgents);
  }, [cwd]);

  // ── Load history on mount ──────────────────────────────────────────

  useEffect(() => {
    syncWithHistory();
  }, [syncWithHistory]);

  // ── Poll history file for changes from other deer instances ────────

  useEffect(() => {
    const interval = setInterval(syncWithHistory, 2_000);
    return () => clearInterval(interval);
  }, [syncWithHistory]);

  return { agents, setAgents, agentsRef, nextId, deletedTaskIdsRef, baseBranchRef };
}
