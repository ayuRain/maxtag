import type { SourceMessage, SourceThread } from '@opentag/core';
import type { ThreadBinding } from '@opentag/delivery';
import {
  normalizeLarkHistoryMessage,
  type LarkChatInfo,
  type LarkHistoryMessage,
  type LarkTransport,
} from '@opentag/platform-lark';

export interface LarkBackfillIngestResult {
  accepted?: boolean;
  duplicate?: boolean;
  reason?: string;
}

export interface LarkBackfillResult {
  complete: boolean;
  workspaceId: string;
  since: string;
  until: string;
  channels: number;
  threads: number;
  scanned: number;
  replayed: number;
  duplicates: number;
  ignored: number;
  failed: number;
  truncated: boolean;
  errors: Array<{ channelId: string; containerType: 'chat' | 'thread'; error: string }>;
}

export interface BackfillLarkHistoryOptions {
  workspaceId: string;
  since: Date;
  until: Date;
  bindings: ThreadBinding[];
  transport: LarkTransport;
  botOpenId?: string;
  maxMessages?: number;
  ingest(input: {
    eventId: string;
    eventType: string;
    thread: SourceThread;
    message: SourceMessage;
  }): Promise<LarkBackfillIngestResult>;
}

interface ChannelRoute {
  channelId: string;
  bindings: ThreadBinding[];
  fallback: ThreadBinding;
  chat?: LarkChatInfo;
}

function timestampMs(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

function metadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function bindingLarkThreadId(binding: ThreadBinding): string | undefined {
  const direct = metadataString(binding.metadata, 'larkThreadId');
  if (direct) return direct;
  const clientThread = binding.metadata?.clientThread;
  if (!clientThread || typeof clientThread !== 'object' || Array.isArray(clientThread)) {
    return undefined;
  }
  const threadMetadata = (clientThread as Record<string, unknown>).metadata;
  if (
    !threadMetadata ||
    typeof threadMetadata !== 'object' ||
    Array.isArray(threadMetadata)
  ) {
    return undefined;
  }
  return metadataString(
    threadMetadata as Record<string, unknown>,
    'larkThreadId',
  );
}

function channelIdFor(binding: ThreadBinding): string | undefined {
  if (binding.channelId) return binding.channelId;
  if (binding.scope === 'channel') return binding.externalId;
  return undefined;
}

function routeForChannel(bindings: ThreadBinding[]): ThreadBinding {
  return (
    bindings.find(
      (binding) => binding.scope === 'channel' && binding.source === 'configured',
    ) ||
    bindings.find((binding) => binding.source === 'configured') ||
    bindings[0]
  );
}

function knownThreadIds(route: ChannelRoute): Set<string> {
  const result = new Set<string>();
  for (const binding of route.bindings) {
    if (binding.scope !== 'thread') continue;
    const metadataId = bindingLarkThreadId(binding);
    if (metadataId) result.add(metadataId);
  }
  return result;
}

function threadFor(
  route: ChannelRoute,
  message: LarkHistoryMessage,
): SourceThread {
  const configuredChatType = metadataString(route.fallback.metadata, 'chatType');
  const direct = route.chat?.chatMode === 'p2p' || configuredChatType === 'p2p';
  const larkRootId = message.root_id || message.parent_id;
  const threaded = !direct && Boolean(message.thread_id);
  const rootId = direct ? undefined : larkRootId || message.message_id;
  const externalId = direct
    ? route.channelId
    : `${route.channelId}:${threaded ? rootId : 'main'}`;
  const topicExternalId =
    !direct && message.thread_id
      ? `${route.channelId}:${message.thread_id}`
      : undefined;
  const exact = route.bindings.find(
    (binding) =>
      binding.scope === 'thread' &&
      (binding.externalId === externalId ||
        binding.externalId === topicExternalId),
  );
  const binding = exact || route.fallback;
  const visibility: SourceThread['visibility'] = direct
    ? 'direct'
    : route.chat?.chatType === 'public'
      ? 'public'
      : 'private';
  return {
    id: `lark:${externalId}`,
    platform: 'lark',
    externalId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    channelId: route.channelId,
    rootMessageId: rootId,
    topicId: threaded ? message.thread_id || rootId : undefined,
    visibility,
    title: route.chat?.name || binding.title || `Lark ${route.channelId}`,
    metadata: {
      ingress: 'lark-long-connection-backfill',
      larkThreadId: message.thread_id,
      larkRootId: message.root_id,
      larkConversationMode: direct ? 'direct' : threaded ? 'thread' : 'main',
      larkChatInfoStatus: route.chat ? 'resolved' : 'unavailable',
      larkChatMode: route.chat?.chatMode,
      larkChatType: route.chat?.chatType,
      recoveredFromHistory: true,
    },
  };
}

export async function backfillLarkHistory(
  options: BackfillLarkHistoryOptions,
): Promise<LarkBackfillResult> {
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 1_000, 5_000));
  const sinceMs = options.since.getTime();
  const untilMs = options.until.getTime();
  const errors: LarkBackfillResult['errors'] = [];
  const messages = new Map<
    string,
    { route: ChannelRoute; message: LarkHistoryMessage }
  >();
  const channels = new Map<string, ThreadBinding[]>();
  for (const binding of options.bindings) {
    if (
      binding.platform !== 'lark' ||
      binding.workspaceId !== options.workspaceId
    ) {
      continue;
    }
    const channelId = channelIdFor(binding);
    if (!channelId) continue;
    const current = channels.get(channelId) || [];
    current.push(binding);
    channels.set(channelId, current);
  }
  const routes: ChannelRoute[] = [];
  for (const [channelId, bindings] of channels) {
    let chat: LarkChatInfo | undefined;
    try {
      chat = await options.transport.getChat(channelId);
    } catch (error) {
      errors.push({
        channelId,
        containerType: 'chat',
        error: `chat_info:${error instanceof Error ? error.message : String(error)}`,
      });
    }
    routes.push({
      channelId,
      bindings,
      fallback: routeForChannel(bindings),
      chat,
    });
  }

  let scanned = 0;
  let truncated = false;
  const discoveredThreads = new Set<string>();

  const collect = async (
    route: ChannelRoute,
    containerType: 'chat' | 'thread',
    containerId: string,
  ): Promise<void> => {
    let pageToken: string | undefined;
    while (!truncated) {
      try {
        const page = await options.transport.listMessages({
          containerType,
          containerId,
          startTime:
            containerType === 'chat'
              ? String(Math.floor(sinceMs / 1000))
              : undefined,
          endTime:
            containerType === 'chat'
              ? String(Math.ceil(untilMs / 1000))
              : undefined,
          sortType:
            containerType === 'chat' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
          pageSize: 50,
          pageToken,
        });
        let reachedOlderThreadMessage = false;
        for (const message of page.items) {
          scanned += 1;
          const createdMs = timestampMs(message.create_time);
          if (createdMs === undefined || createdMs > untilMs) continue;
          if (createdMs < sinceMs) {
            if (containerType === 'thread') reachedOlderThreadMessage = true;
            continue;
          }
          if (message.message_id && !message.deleted) {
            if (
              !messages.has(message.message_id) &&
              messages.size >= maxMessages
            ) {
              truncated = true;
              break;
            }
            messages.set(message.message_id, { route, message });
            if (message.thread_id) discoveredThreads.add(
              `${route.channelId}:${message.thread_id}`,
            );
          }
        }
        if (
          truncated ||
          reachedOlderThreadMessage ||
          !page.hasMore ||
          !page.pageToken
        ) {
          return;
        }
        pageToken = page.pageToken;
      } catch (error) {
        errors.push({
          channelId: route.channelId,
          containerType,
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
  };

  for (const route of routes) {
    await collect(route, 'chat', route.channelId);
    if (truncated) break;
  }
  for (const route of routes) {
    const threadIds = knownThreadIds(route);
    for (const discovered of discoveredThreads) {
      const prefix = `${route.channelId}:`;
      if (discovered.startsWith(prefix)) threadIds.add(discovered.slice(prefix.length));
    }
    for (const threadId of threadIds) {
      await collect(route, 'thread', threadId);
      if (truncated) break;
    }
    if (truncated) break;
  }

  let replayed = 0;
  let duplicates = 0;
  let ignored = 0;
  let failed = 0;
  const ordered = [...messages.values()].sort(
    (left, right) =>
      (timestampMs(left.message.create_time) || 0) -
        (timestampMs(right.message.create_time) || 0) ||
      String(left.message.message_id).localeCompare(String(right.message.message_id)),
  );
  for (const entry of ordered) {
    const thread = threadFor(entry.route, entry.message);
    const message = normalizeLarkHistoryMessage(entry.message, {
      thread,
      botOpenId: options.botOpenId,
    });
    if (!message || message.actor.isBot) continue;
    message.metadata = {
      ...message.metadata,
      recoveredFromLongConnectionBackfill: true,
    };
    try {
      const result = await options.ingest({
        eventId: message.id,
        eventType: 'im.message.receive_v1',
        thread,
        message,
      });
      replayed += 1;
      if (result.duplicate) duplicates += 1;
      else if (result.accepted === false) ignored += 1;
    } catch (error) {
      failed += 1;
      errors.push({
        channelId: entry.route.channelId,
        containerType: entry.message.thread_id ? 'thread' : 'chat',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    complete: !truncated && errors.length === 0 && failed === 0,
    workspaceId: options.workspaceId,
    since: options.since.toISOString(),
    until: options.until.toISOString(),
    channels: routes.length,
    threads: new Set(
      ordered
        .filter((entry) => entry.message.thread_id)
        .map((entry) => `${entry.route.channelId}:${entry.message.thread_id}`),
    ).size,
    scanned,
    replayed,
    duplicates,
    ignored,
    failed,
    truncated,
    errors: errors.slice(0, 20),
  };
}
