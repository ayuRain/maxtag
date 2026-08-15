import type { ToolApprovalRecord } from '@opentag/core';
import type { CreateAgentRunOrSteerResult, DeliveryStore } from '@opentag/delivery';

function continuationRunId(approvalId: string): string {
  return `tool-approval:${approvalId}`;
}

export async function scheduleToolApprovalContinuation(input: {
  deliveryStore: DeliveryStore;
  approval: ToolApprovalRecord;
}): Promise<CreateAgentRunOrSteerResult | undefined> {
  if (input.approval.status !== 'succeeded') return undefined;
  if (input.approval.continuationStatus === 'scheduled') return undefined;
  const source = await input.deliveryStore.getAgentRun(input.approval.runId);
  if (!source?.thread || !source.message) return undefined;
  const messageId = continuationRunId(input.approval.id);
  const message = {
    id: messageId,
    threadId: source.thread.id,
    platform: source.thread.platform,
    text: [
      `Approved tool operation completed: ${input.approval.title}.`,
      input.approval.resultPreview
        ? `Result: ${input.approval.resultPreview}`
        : 'The operation completed successfully.',
      input.approval.resultUrl
        ? `External result: ${input.approval.resultUrl}`
        : '',
      'Continue the original request from the durable thread context. Verify the change and complete any remaining work. Do not repeat this write unless the user explicitly requests another change.',
    ].filter(Boolean).join('\n'),
    actor: {
      id: 'opentag:tool-approval',
      displayName: 'MaxTag approval',
    },
    createdAt: input.approval.completedAt || new Date().toISOString(),
    mentionsAgent: true,
    replyToMessageId: source.message.replyToMessageId || source.message.id,
    metadata: {
      source: 'tool-approval',
      approvalId: input.approval.id,
      toolName: input.approval.toolName,
      resultUrl: input.approval.resultUrl,
      sourceRunId: source.id,
    },
  };
  const staged = await input.deliveryStore.createAgentRunOrSteer({
    runId: messageId,
    thread: source.thread,
    message,
    bindingId: source.bindingId,
    executorId: source.executorId,
    transportMode: source.transportMode,
    allowLiveSteering: false,
    metadata: {
      ...source.metadata,
      source: 'tool-approval',
      toolApprovalId: input.approval.id,
      continuationOfRunId: source.id,
    },
  });
  const scheduledRunId = staged.steering
    ? `steering:${staged.steering.id}`
    : staged.run.id;
  await input.deliveryStore.markToolApprovalContinuationScheduled({
    id: input.approval.id,
    runId: scheduledRunId,
  });
  return staged;
}
