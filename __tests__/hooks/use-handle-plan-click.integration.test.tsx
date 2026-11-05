import React from "react";
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveBackendProvider } from "#/contexts/active-backend-context";
import { NavigationProvider } from "#/context/navigation-context";
import {
  getActiveSelection,
  getRegisteredBackends,
  setActiveSelection,
  setRegisteredBackends,
} from "#/api/backend-registry/active-store";
import ConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import AutomationService from "#/api/automation-service/automation-service.api";
import { ExecutionStatus } from "#/types/agent-server/core";
import { useHandlePlanClick } from "#/hooks/use-handle-plan-click";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useSubConversationTaskPolling } from "#/hooks/query/use-sub-conversation-task-polling";
import { useConversationStore } from "#/stores/conversation-store";
import {
  getConversationState,
  setConversationState,
} from "#/utils/conversation-local-storage";
import {
  AGENT_PROFILES_QUERY_KEYS,
  LLM_PROFILES_QUERY_KEYS,
  META_PROFILES_QUERY_KEYS,
  SETTINGS_QUERY_KEYS,
} from "#/hooks/query/query-keys";
import type {
  AppConversation,
  AppConversationStartTask,
} from "#/api/conversation-service/agent-server-conversation-service.types";

const backend = {
  id: "cloud-planner-test",
  name: "Cloud",
  host: "https://cloud.example",
  apiKey: "",
  kind: "cloud" as const,
};
const parentId = "parent-conversation";
const parentConversation: AppConversation = {
  id: parentId,
  created_by_user_id: "user",
  selected_repository: null,
  selected_branch: null,
  git_provider: null,
  title: "Existing task",
  trigger: null,
  pr_number: [],
  llm_model: "test-model",
  metrics: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  execution_status: ExecutionStatus.IDLE,
  sandbox_status: "RUNNING",
  conversation_url: "https://runtime.example",
  session_api_key: "test-runtime-key",
  sandbox_id: "parent-sandbox",
  sub_conversation_ids: [],
};
const taskId = "planner-start";
const task = (
  status: AppConversationStartTask["status"],
  overrides: Partial<AppConversationStartTask> = {},
): AppConversationStartTask => ({
  id: taskId,
  status,
  detail: status === "ERROR" ? "Planner initialization failed" : null,
  app_conversation_id: null,
  agent_server_url: null,
  created_by_user_id: "user",
  request: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

let client: QueryClient;
let previousBackends: ReturnType<typeof getRegisteredBackends>;
let previousSelection: ReturnType<typeof getActiveSelection>;

beforeEach(() => {
  previousBackends = getRegisteredBackends();
  previousSelection = getActiveSelection();
  localStorage.clear();
  useConversationStore.getState().resetConversationState();
  setRegisteredBackends([backend]);
  setActiveSelection({ backendId: backend.id, orgId: "org" });
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData([...AGENT_PROFILES_QUERY_KEYS.all, backend.id, "org"], {
    profiles: [],
    active_agent_profile_id: null,
  });
  client.setQueryData([...LLM_PROFILES_QUERY_KEYS.all, backend.id, "org"], {
    profiles: [],
    active_profile: null,
  });
  client.setQueryData([...META_PROFILES_QUERY_KEYS.all, backend.id, "org"], {
    profiles: [],
    active_meta_profile: null,
  });
  client.setQueryData(
    [...SETTINGS_QUERY_KEYS.byScope("personal"), backend.id, "org"],
    { run_router_at_conversation_start: false },
  );
  vi.spyOn(AutomationService, "getSdkVersion").mockResolvedValue("1.26.1");
  vi.spyOn(ConversationService, "batchGetAppConversations").mockResolvedValue([
    parentConversation,
  ]);
});

afterEach(() => {
  cleanup();
  client.clear();
  vi.restoreAllMocks();
  localStorage.clear();
  useConversationStore.getState().resetConversationState();
  setRegisteredBackends(previousBackends);
  setActiveSelection(previousSelection);
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={client}>
      <ActiveBackendProvider>
        <NavigationProvider
          value={{
            conversationId: parentId,
            currentPath: `/conversations/${parentId}`,
            isNavigating: false,
            navigate: vi.fn(),
          }}
        >
          {children}
        </NavigationProvider>
      </ActiveBackendProvider>
    </QueryClientProvider>
  );
}

function useWorkflow() {
  const conversation = useActiveConversation();
  // The button and slash-command interceptor each mount this hook.
  const button = useHandlePlanClick();
  const command = useHandlePlanClick();
  const id = useConversationStore((state) => state.subConversationTaskId);
  const polling = useSubConversationTaskPolling(id, parentId);
  return { ...button, command, ...polling, conversation: conversation.data };
}

it("retries a failed Cloud planner after reload, clears both owners, and creates one replacement", async () => {
  const replacementTaskId = "replacement-planner-start";
  let acceptReplacement!: (value: AppConversationStartTask) => void;
  const replacement = new Promise<AppConversationStartTask>((resolve) => {
    acceptReplacement = resolve;
  });
  const create = vi
    .spyOn(ConversationService, "createConversation")
    .mockResolvedValueOnce(task("WORKING"))
    .mockReturnValueOnce(replacement);
  vi.spyOn(ConversationService, "getStartTask").mockImplementation(
    async (id) =>
      id === taskId
        ? task("ERROR")
        : task("WORKING", { id: replacementTaskId }),
  );
  let rendered = renderHook(useWorkflow, { wrapper: Wrapper });
  await waitFor(() =>
    expect(rendered.result.current.conversation?.id).toBe(parentId),
  );
  act(() => rendered.result.current.handlePlanClick());
  await waitFor(() => expect(rendered.result.current.taskStatus).toBe("ERROR"));
  expect(create).toHaveBeenCalledTimes(1);
  expect(getConversationState(parentId).subConversationTaskId).toBe(taskId);

  rendered.unmount();
  act(() => useConversationStore.getState().resetConversationState());
  rendered = renderHook(useWorkflow, { wrapper: Wrapper });
  await waitFor(() => expect(rendered.result.current.taskStatus).toBe("ERROR"));
  expect(rendered.result.current.hasPlanner).toBe(false);
  // No automatic retry on error or reload; the user deliberately retries.
  expect(create).toHaveBeenCalledTimes(1);
  act(() => {
    rendered.result.current.handlePlanClick(undefined, "Try planning again");
    rendered.result.current.command.handlePlanClick();
  });
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  expect(create).toHaveBeenLastCalledWith(
    expect.objectContaining({
      parentConversationId: parentId,
      agentType: "plan",
      initialUserMsg: "Try planning again",
    }),
  );
  expect(getConversationState(parentId).subConversationTaskId).toBeNull();
  expect(useConversationStore.getState().subConversationTaskId).toBeNull();
  act(() => rendered.result.current.command.handlePlanClick());
  expect(create).toHaveBeenCalledTimes(2);

  await act(async () => {
    acceptReplacement(task("WORKING", { id: replacementTaskId }));
    await replacement;
  });
  await waitFor(() =>
    expect(useConversationStore.getState().subConversationTaskId).toBe(
      replacementTaskId,
    ),
  );
  expect(getConversationState(parentId).subConversationTaskId).toBe(
    replacementTaskId,
  );
});

it.each([
  task("WORKING"),
  task("READY", { app_conversation_id: "ready-planner" }),
  task("ERROR", { app_conversation_id: "created-planner" }),
])(
  "preserves existing planner ownership for $status / $app_conversation_id",
  async (existingTask) => {
    setConversationState(parentId, { subConversationTaskId: taskId });
    const create = vi.spyOn(ConversationService, "createConversation");
    vi.spyOn(ConversationService, "getStartTask").mockResolvedValue(
      existingTask,
    );
    const { result } = renderHook(useWorkflow, { wrapper: Wrapper });
    await waitFor(() => expect(result.current.task).toEqual(existingTask));
    act(() => result.current.handlePlanClick());
    expect(create).not.toHaveBeenCalled();
    expect(getConversationState(parentId).subConversationTaskId).toBe(taskId);
    expect(useConversationStore.getState().subConversationTaskId).toBe(taskId);
  },
);

it("keeps the existing planner when a failed task is still saved", async () => {
  setConversationState(parentId, { subConversationTaskId: taskId });
  vi.mocked(ConversationService.batchGetAppConversations).mockResolvedValue([
    {
      ...parentConversation,
      sub_conversation_ids: ["existing-planner"],
    },
  ]);
  const create = vi.spyOn(ConversationService, "createConversation");
  vi.spyOn(ConversationService, "getStartTask").mockResolvedValue(
    task("ERROR"),
  );
  const { result } = renderHook(useWorkflow, { wrapper: Wrapper });
  await waitFor(() => expect(result.current.taskStatus).toBe("ERROR"));
  expect(result.current.hasPlanner).toBe(true);
  act(() => result.current.handlePlanClick());
  expect(create).not.toHaveBeenCalled();
  expect(getConversationState(parentId).subConversationTaskId).toBe(taskId);
});

it("allows another explicit retry after the replacement request is rejected", async () => {
  setConversationState(parentId, { subConversationTaskId: taskId });
  const create = vi
    .spyOn(ConversationService, "createConversation")
    .mockRejectedValueOnce(new Error("Create failed"))
    .mockResolvedValueOnce(task("WORKING", { id: "next-attempt" }));
  vi.spyOn(ConversationService, "getStartTask").mockImplementation(async (id) =>
    task(id === taskId ? "ERROR" : "WORKING", { id }),
  );
  const { result } = renderHook(useWorkflow, { wrapper: Wrapper });
  await waitFor(() => expect(result.current.taskStatus).toBe("ERROR"));
  act(() => result.current.handlePlanClick());
  await waitFor(() =>
    expect(useConversationStore.getState().conversationMode).toBe("code"),
  );
  expect(getConversationState(parentId).subConversationTaskId).toBeNull();
  expect(useConversationStore.getState().subConversationTaskId).toBeNull();
  act(() => result.current.handlePlanClick());
  await waitFor(() =>
    expect(useConversationStore.getState().subConversationTaskId).toBe(
      "next-attempt",
    ),
  );
  expect(create).toHaveBeenCalledTimes(2);
});

it("recovers an accepted replacement when the initiating view remounts during creation", async () => {
  setConversationState(parentId, { subConversationTaskId: taskId });
  let acceptReplacement!: (value: AppConversationStartTask) => void;
  const replacement = new Promise<AppConversationStartTask>((resolve) => {
    acceptReplacement = resolve;
  });
  const create = vi
    .spyOn(ConversationService, "createConversation")
    .mockReturnValue(replacement);
  vi.spyOn(ConversationService, "getStartTask").mockImplementation(async (id) =>
    task(id === taskId ? "ERROR" : "WORKING", { id }),
  );
  let rendered = renderHook(useWorkflow, { wrapper: Wrapper });
  await waitFor(() => expect(rendered.result.current.taskStatus).toBe("ERROR"));
  act(() => rendered.result.current.handlePlanClick());
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));

  rendered.unmount();
  act(() => useConversationStore.getState().resetConversationState());
  rendered = renderHook(useWorkflow, { wrapper: Wrapper });
  expect(rendered.result.current.isCreatingConversation).toBe(true);
  act(() => rendered.result.current.handlePlanClick());
  expect(create).toHaveBeenCalledTimes(1);
  await act(async () => {
    acceptReplacement(task("WORKING", { id: "replacement-start" }));
    await replacement;
  });
  await waitFor(() =>
    expect(useConversationStore.getState().subConversationTaskId).toBe(
      "replacement-start",
    ),
  );
  expect(getConversationState(parentId).subConversationTaskId).toBe(
    "replacement-start",
  );
});
