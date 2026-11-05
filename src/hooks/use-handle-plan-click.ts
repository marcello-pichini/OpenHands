import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import {
  useIsMutating,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useConversationStore } from "#/stores/conversation-store";
import { useActiveConversation } from "#/hooks/query/use-active-conversation";
import { useCreateConversation } from "#/hooks/mutation/use-create-conversation";
import {
  displayErrorToast,
  displaySuccessToast,
} from "#/utils/custom-toast-handlers";
import {
  getConversationState,
  setConversationState,
} from "#/utils/conversation-local-storage";
import { useActiveBackend } from "#/contexts/active-backend-context";
import AgentServerConversationService from "#/api/conversation-service/agent-server-conversation-service.api";
import { getStoredConversationMetadata } from "#/api/conversation-metadata-store";
import {
  CONVERSATION_QUERY_KEYS,
  CLOUD_PLANNER_MUTATION_KEYS,
  LOCAL_PLANNER_MUTATION_KEYS,
} from "#/hooks/query/query-keys";
import { useSubConversations } from "#/hooks/query/use-sub-conversations";
import { useSubConversationTaskPolling } from "#/hooks/query/use-sub-conversation-task-polling";
import { findPlannerConversationId } from "#/utils/plan-file";
import { invalidateConversationQueries } from "#/hooks/mutation/conversation-mutation-utils";

function useCreateLocalPlanningConversationMutation(options: {
  onCreated: (planningConversationId: string) => void;
  onInitialized: () => void;
  onFailed: () => void;
}) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationKey: LOCAL_PLANNER_MUTATION_KEYS.create,
    mutationFn: (variables: {
      parentConversationId: string;
      initialMessage?: string;
    }) =>
      AgentServerConversationService.createLocalPlanningConversation(
        variables.parentConversationId,
        variables.initialMessage,
      ),
    onSuccess: (planningConversation, variables) => {
      options.onCreated(planningConversation.id);
      invalidateConversationQueries(
        queryClient,
        variables.parentConversationId,
      );
      queryClient.invalidateQueries({
        queryKey: CONVERSATION_QUERY_KEYS.subConversations,
      });
      options.onInitialized();
    },
    onError: options.onFailed,
  });
}

function restorePlanningConversationIds(options: {
  conversationId: string;
  serverPlanningConversationId: string | null;
  subConversationTaskId: string | null;
  localPlanningConversationId: string | null;
  setSubConversationTaskId: (taskId: string | null) => void;
  setLocalPlanningConversationId: (conversationId: string | null) => void;
}) {
  const storedState = getConversationState(options.conversationId);
  if (storedState.subConversationTaskId && !options.subConversationTaskId) {
    options.setSubConversationTaskId(storedState.subConversationTaskId);
  }

  // Server first: `sub_conversation_ids` is derived by the agent-server from
  // the planner's `parent_conversation_id`, so it survives cleared site data
  // and follows the user to another browser. The localStorage hint is only the
  // fallback for agent-servers older than 1.37.1, which drop the parent link.
  const restoredId =
    options.serverPlanningConversationId ??
    getStoredConversationMetadata(options.conversationId)
      ?.local_planning_conversation_id ??
    null;

  if (restoredId && restoredId !== options.localPlanningConversationId) {
    options.setLocalPlanningConversationId(restoredId);
  }
}

/**
 * Custom hook that encapsulates the logic for handling plan creation.
 * Returns a function that can be called to create a plan conversation and
 * the pending state of the conversation creation.
 *
 * @returns An object containing handlePlanClick function and isCreatingConversation boolean
 */
export const useHandlePlanClick = () => {
  const { t } = useTranslation("openhands");
  const { backend, orgId } = useActiveBackend();
  const queryClient = useQueryClient();
  const {
    setConversationMode,
    setSubConversationTaskId,
    subConversationTaskId,
    setLocalPlanningConversationId,
    localPlanningConversationId,
  } = useConversationStore();
  const { data: conversation } = useActiveConversation();
  const activeScopeRef = useRef({
    backendId: backend.id,
    orgId,
    parentId: conversation?.id,
  });
  activeScopeRef.current = {
    backendId: backend.id,
    orgId,
    parentId: conversation?.id,
  };
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const { mutateAsync: createConversation } = useCreateConversation();
  const cloudPlannerMutationKey = CLOUD_PLANNER_MUTATION_KEYS.create(
    backend.id,
    orgId,
    conversation?.id ?? null,
  );
  const isCreatingCloudConversation =
    useIsMutating({
      mutationKey: cloudPlannerMutationKey,
      exact: true,
    }) > 0;
  const { mutate: createCloudPlanningConversation } = useMutation({
    mutationKey: cloudPlannerMutationKey,
    // The underlying create mutation owns reporting a failed request.
    meta: { disableToast: true },
    mutationFn: (variables: {
      parentConversationId: string;
      initialMessage?: string;
      backendId: string;
      orgId: string | null;
    }) =>
      createConversation({
        parentConversationId: variables.parentConversationId,
        agentType: "plan",
        entryPoint: "plan_sub_conversation",
        ...(variables.initialMessage
          ? { query: variables.initialMessage }
          : {}),
      }),
    onSuccess: (data, variables) => {
      if (data.task_id) {
        setConversationState(variables.parentConversationId, {
          subConversationTaskId: data.task_id,
        });
        if (
          mountedRef.current &&
          activeScopeRef.current.parentId === variables.parentConversationId &&
          activeScopeRef.current.backendId === variables.backendId &&
          activeScopeRef.current.orgId === variables.orgId
        ) {
          setSubConversationTaskId(data.task_id);
        }
      }
      displaySuccessToast(
        t(I18nKey.PLANNING_AGENTT$PLANNING_AGENT_INITIALIZED),
      );
    },
    onError: (_error, variables) => {
      if (
        mountedRef.current &&
        activeScopeRef.current.parentId === variables.parentConversationId &&
        activeScopeRef.current.backendId === variables.backendId &&
        activeScopeRef.current.orgId === variables.orgId
      ) {
        setConversationMode("code");
      }
    },
  });
  const {
    mutate: createLocalPlanningConversation,
    isPending: isCreatingLocalPlanningConversation,
  } = useCreateLocalPlanningConversationMutation({
    onCreated: setLocalPlanningConversationId,
    onInitialized: () => {
      displaySuccessToast(
        t(I18nKey.PLANNING_AGENTT$PLANNING_AGENT_INITIALIZED),
      );
    },
    // handlePlanClick sets conversationMode("plan") before this mutation
    // starts. On failure, back out of that mode instead of stranding the
    // user in plan mode with no planner to talk to.
    onFailed: () => {
      setConversationMode("code");
      displayErrorToast(t(I18nKey.CONVERSATION$ERROR_STARTING_CONVERSATION));
    },
  });

  // On local backends the agent-server reports the planner helper back on the
  // parent's `sub_conversation_ids` (it was created with
  // `parent_conversation_id`), so that is the authoritative handle. Cloud
  // sub-conversations are driven by their own task/socket plumbing.
  const isLocalBackend = backend.kind !== "cloud";
  const { data: rawSubConversations } = useSubConversations(
    isLocalBackend ? conversation?.sub_conversation_ids : undefined,
  );

  const serverPlanningConversationId = isLocalBackend
    ? findPlannerConversationId(rawSubConversations, conversation?.id)
    : null;

  // Restore planning conversation ids on conversation load. This handles page
  // refreshes while cloud or local planning conversation creation is in
  // progress, and recovers the local planner after browser storage is lost.
  useEffect(() => {
    if (!conversation?.id) return;

    restorePlanningConversationIds({
      conversationId: conversation.id,
      serverPlanningConversationId,
      subConversationTaskId,
      localPlanningConversationId,
      setSubConversationTaskId,
      setLocalPlanningConversationId,
    });
  }, [
    conversation?.id,
    serverPlanningConversationId,
    localPlanningConversationId,
    setLocalPlanningConversationId,
    subConversationTaskId,
    setSubConversationTaskId,
    isCreatingCloudConversation,
  ]);

  const { task: cloudPlannerTask } = useSubConversationTaskPolling(
    backend.kind === "cloud" ? subConversationTaskId : null,
    conversation?.id ?? null,
  );
  // A failed start with no conversation is retryable. Unknown/in-progress
  // tasks and READY planners retain their ownership and must not be duplicated.
  const hasFailedCloudPlannerTask =
    cloudPlannerTask?.status === "ERROR" &&
    !cloudPlannerTask.app_conversation_id;
  const hasCloudPlanner = !!(
    (conversation?.sub_conversation_ids &&
      conversation.sub_conversation_ids.length > 0) ||
    (subConversationTaskId && !hasFailedCloudPlannerTask)
  );
  // Whether a planner helper already exists for this conversation — callers
  // (e.g. the `/plan <task>` interceptor) use this to decide whether they can
  // send a message to the planner immediately, or must wait for creation.
  const hasPlanner = isLocalBackend
    ? !!(localPlanningConversationId || serverPlanningConversationId)
    : hasCloudPlanner;

  const handlePlanClick = useCallback(
    (
      event?: MouseEvent<HTMLButtonElement> | KeyboardEvent,
      initialMessage?: string,
    ) => {
      event?.preventDefault();
      event?.stopPropagation();

      setConversationMode("plan");

      if (backend.kind !== "cloud") {
        // Guard on the server-reported helper, the store, and the mutation's
        // own in-flight state — the last one stops two rapid invocations
        // (e.g. a double-click) from both passing before either updates and
        // creating two planners for the same parent.
        if (
          !conversation?.id ||
          localPlanningConversationId ||
          serverPlanningConversationId ||
          isCreatingLocalPlanningConversation
        ) {
          return;
        }
        createLocalPlanningConversation({
          parentConversationId: conversation.id,
          initialMessage,
        });
        return;
      }

      if (
        hasCloudPlanner ||
        !conversation?.id ||
        queryClient.isMutating({
          mutationKey: cloudPlannerMutationKey,
          exact: true,
        })
      ) {
        return;
      }

      if (hasFailedCloudPlannerTask) {
        // Clear persistence first: the restoration effect must not bring the
        // failed task back while the explicit replacement request is pending.
        setConversationState(conversation.id, { subConversationTaskId: null });
        setSubConversationTaskId(null);
      }
      createCloudPlanningConversation({
        parentConversationId: conversation.id,
        initialMessage,
        backendId: backend.id,
        orgId,
      });
    },
    [
      backend.kind,
      backend.id,
      orgId,
      conversation,
      createCloudPlanningConversation,
      createLocalPlanningConversation,
      hasCloudPlanner,
      hasFailedCloudPlannerTask,
      cloudPlannerMutationKey,
      queryClient,
      isCreatingLocalPlanningConversation,
      localPlanningConversationId,
      serverPlanningConversationId,
      setConversationMode,
      setSubConversationTaskId,
    ],
  );

  return {
    handlePlanClick,
    hasPlanner,
    isCreatingConversation:
      isCreatingCloudConversation || isCreatingLocalPlanningConversation,
  };
};
