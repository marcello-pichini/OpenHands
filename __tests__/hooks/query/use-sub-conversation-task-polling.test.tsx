import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { useSubConversationTaskPolling } from "#/hooks/query/use-sub-conversation-task-polling";
import type { AppConversationStartTask } from "#/api/conversation-service/agent-server-conversation-service.types";

const { activeScope } = vi.hoisted(() => ({
  activeScope: { backend: { id: "local" }, orgId: null as string | null },
}));
vi.mock("#/contexts/active-backend-context", () => ({
  useActiveBackend: () => activeScope,
}));

// Mock the underlying service
vi.mock(
  "#/api/conversation-service/agent-server-conversation-service.api",
  () => ({
    default: {
      getStartTask: vi.fn(),
    },
  }),
);

describe("useSubConversationTaskPolling", () => {
  let queryClient: QueryClient;

  const createWrapper = () => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });

    return function ({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    };
  };

  const createMockTask = (
    status: AppConversationStartTask["status"],
    appConversationId: string | null = null,
  ): AppConversationStartTask => ({
    id: "task-123",
    created_by_user_id: "user-1",
    status,
    detail: null,
    app_conversation_id: appConversationId,
    agent_server_url: null,
    request: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    activeScope.backend.id = "local";
    activeScope.orgId = null;
  });

  afterEach(() => {
    queryClient?.clear();
  });

  it("should return task status when task is READY", async () => {
    // Arrange
    const mockTask = createMockTask("READY", "sub-conversation-123");
    vi.mocked(AgentServerConversationService.getStartTask).mockResolvedValue(
      mockTask,
    );

    // Act
    const { result } = renderHook(
      () =>
        useSubConversationTaskPolling("task-123", "parent-conversation-456"),
      { wrapper: createWrapper() },
    );

    // Assert
    await waitFor(() => {
      expect(result.current.taskStatus).toBe("READY");
    });
    expect(result.current.subConversationId).toBe("sub-conversation-123");
    expect(AgentServerConversationService.getStartTask).toHaveBeenCalledWith(
      "task-123",
    );
  });

  it("should not poll when taskId is null", async () => {
    // Arrange
    vi.mocked(AgentServerConversationService.getStartTask).mockResolvedValue(
      null,
    );

    // Act
    const { result } = renderHook(
      () => useSubConversationTaskPolling(null, "parent-conversation-456"),
      { wrapper: createWrapper() },
    );

    // Assert - wait a bit to ensure no calls are made
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(AgentServerConversationService.getStartTask).not.toHaveBeenCalled();
    expect(result.current.taskStatus).toBeUndefined();
  });

  it("should not poll when parentConversationId is null", async () => {
    // Arrange
    vi.mocked(AgentServerConversationService.getStartTask).mockResolvedValue(
      null,
    );

    // Act
    const { result } = renderHook(
      () => useSubConversationTaskPolling("task-123", null),
      { wrapper: createWrapper() },
    );

    // Assert - wait a bit to ensure no calls are made
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(AgentServerConversationService.getStartTask).not.toHaveBeenCalled();
    expect(result.current.taskStatus).toBeUndefined();
  });

  it.each(["backend", "organization", "parent"])(
    "does not reuse a failed task from another %s scope",
    async (scope) => {
      const failedTask = createMockTask("ERROR");
      const readyTask = createMockTask("READY", "planner");
      vi.mocked(AgentServerConversationService.getStartTask)
        .mockResolvedValueOnce(failedTask)
        .mockResolvedValueOnce(readyTask);
      const { result, rerender } = renderHook(
        ({ parent }) => useSubConversationTaskPolling("task-123", parent),
        { wrapper: createWrapper(), initialProps: { parent: "parent-1" } },
      );
      await waitFor(() => expect(result.current.taskStatus).toBe("ERROR"));

      if (scope === "backend") activeScope.backend.id = "other-backend";
      if (scope === "organization") activeScope.orgId = "other-org";
      rerender({ parent: scope === "parent" ? "parent-2" : "parent-1" });

      // A previous scope's terminal error must not authorize replacement of
      // a task which is READY in the newly selected scope.
      await waitFor(() => expect(result.current.taskStatus).toBe("READY"));
      expect(result.current.subConversationId).toBe("planner");
      expect(AgentServerConversationService.getStartTask).toHaveBeenCalledTimes(
        2,
      );
    },
  );
});
