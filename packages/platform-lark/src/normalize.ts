import type {
  SourceAttachment,
  SourceMessage,
  SourceThread,
} from '@opentag/core';
import type {
  LarkChatInfo,
  LarkHistoryMessage,
  LarkIncomingEvent,
} from './types.js';

export function applyLarkChatInfo(
  thread: SourceThread,
  chat: LarkChatInfo,
): SourceThread {
  if (thread.platform !== 'lark' || thread.visibility === 'direct') return thread;
  const channelId = thread.channelId || chat.chatId;
  const syntheticTitle =
    !thread.title || thread.title === `Lark ${channelId}`;
  return {
    ...thread,
    title: syntheticTitle && chat.name ? chat.name : thread.title,
    visibility:
      chat.chatType === 'private'
        ? 'private'
        : chat.chatType === 'public'
          ? 'public'
          : thread.visibility,
    metadata: {
      ...thread.metadata,
      larkChatInfoStatus: 'resolved',
      larkChatName: chat.name,
      larkChatMode: chat.chatMode,
      larkChatType: chat.chatType,
      larkExternal: chat.external,
    },
  };
}

export function applyUnavailableLarkChatInfo(
  thread: SourceThread,
): SourceThread {
  if (thread.platform !== 'lark' || thread.visibility === 'direct') return thread;
  return {
    ...thread,
    visibility: 'private',
    metadata: {
      ...thread.metadata,
      larkChatInfoStatus: 'unavailable',
    },
  };
}

function parsedContent(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseTextContent(raw: string | undefined, messageType: string | undefined): string {
  if (!raw) return '';
  if (messageType && messageType !== 'text') return '';
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : raw;
  } catch {
    return raw;
  }
}

function contentString(
  content: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = content[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function attachmentFor(
  messageId: string,
  messageType: string | undefined,
  raw: string | undefined,
): SourceAttachment[] | undefined {
  const content = parsedContent(raw);
  const fileKey = contentString(content, 'file_key');
  const imageKey = contentString(content, 'image_key');
  let attachment: SourceAttachment | undefined;
  if (messageType === 'image' && imageKey) {
    attachment = {
      id: `lark:image:${imageKey}`,
      kind: 'image',
      name: 'image',
      metadata: {
        larkMessageId: messageId,
        larkFileKey: imageKey,
        larkResourceType: 'image',
      },
    };
  } else if (messageType === 'file' && fileKey) {
    attachment = {
      id: `lark:file:${fileKey}`,
      kind: 'file',
      name: contentString(content, 'file_name'),
      metadata: {
        larkMessageId: messageId,
        larkFileKey: fileKey,
        larkResourceType: 'file',
      },
    };
  } else if (messageType === 'audio' && fileKey) {
    attachment = {
      id: `lark:audio:${fileKey}`,
      kind: 'audio',
      name: contentString(content, 'file_name') || 'audio.opus',
      metadata: {
        larkMessageId: messageId,
        larkFileKey: fileKey,
        larkResourceType: 'file',
        durationMs: content.duration,
      },
    };
  } else if (messageType === 'media' && fileKey) {
    attachment = {
      id: `lark:video:${fileKey}`,
      kind: 'video',
      name: contentString(content, 'file_name') || 'video.mp4',
      metadata: {
        larkMessageId: messageId,
        larkFileKey: fileKey,
        larkResourceType: 'file',
        durationMs: content.duration,
        previewImageKey: imageKey,
      },
    };
  }
  return attachment ? [attachment] : undefined;
}

function createdAt(value: string | undefined): string {
  const timestamp = Number(value);
  const parsed = Number.isFinite(timestamp) && timestamp > 0
    ? new Date(timestamp)
    : new Date();
  return parsed.toISOString();
}

export function normalizeLarkEvent(
  body: LarkIncomingEvent,
  options?: { botOpenId?: string },
): { thread: SourceThread; message: SourceMessage } | null {
  const message = body.event?.message;
  if (!message?.message_id || !message.chat_id) return null;

  const isDirect = message.chat_type === 'p2p';
  const rootId = message.root_id || message.parent_id || message.message_id;
  const topicId = message.thread_id || rootId;
  const threadExternalId = isDirect
    ? message.chat_id
    : `${message.chat_id}:${rootId}`;
  const senderId =
    body.event?.sender?.sender_id?.open_id ||
    body.event?.sender?.sender_id?.user_id ||
    'unknown';
  const mentionsAgent =
    isDirect ||
    (!!options?.botOpenId &&
      (message.mentions || []).some(
        (mention) => mention.id?.open_id === options.botOpenId,
      ));

  const thread: SourceThread = {
    id: `lark:${threadExternalId}`,
    platform: 'lark',
    externalId: threadExternalId,
    workspaceId: body.header?.tenant_key || body.event?.sender?.tenant_key,
    projectId: message.chat_id,
    channelId: message.chat_id,
    rootMessageId: isDirect ? undefined : rootId,
    topicId: isDirect ? undefined : topicId,
    visibility: isDirect ? 'direct' : 'public',
    title: `Lark ${message.chat_id}`,
    metadata: {
      chatType: message.chat_type,
      eventId: body.header?.event_id || body.event_id,
      larkThreadId: message.thread_id,
    },
  };

  return {
    thread,
    message: {
      id: message.message_id,
      threadId: thread.id,
      platform: 'lark',
      text: parseTextContent(message.content, message.message_type),
      actor: {
        id: senderId,
        platformUserId: senderId,
        isBot: body.event?.sender?.sender_type === 'app',
      },
      createdAt: createdAt(message.create_time),
      mentionsAgent,
      replyToMessageId: message.parent_id,
      attachments: attachmentFor(
        message.message_id,
        message.message_type,
        message.content,
      ),
      metadata: {
        messageType: message.message_type,
        eventId: body.header?.event_id || body.event_id,
        larkThreadId: message.thread_id,
      },
    },
  };
}

export function normalizeLarkHistoryMessage(
  message: LarkHistoryMessage,
  options: { thread: SourceThread; botOpenId?: string },
): SourceMessage | null {
  if (!message.message_id || message.deleted) return null;
  const senderId = message.sender?.id || 'unknown';
  return {
    id: message.message_id,
    threadId: options.thread.id,
    platform: 'lark',
    text: parseTextContent(message.body?.content, message.msg_type),
    actor: {
      id: senderId,
      platformUserId: senderId,
      isBot: message.sender?.sender_type === 'app',
    },
    createdAt: createdAt(message.create_time),
    mentionsAgent:
      Boolean(options.botOpenId) &&
      (message.mentions || []).some(
        (mention) => mention.id === options.botOpenId,
      ),
    replyToMessageId: message.parent_id,
    attachments: attachmentFor(
      message.message_id,
      message.msg_type,
      message.body?.content,
    ),
    metadata: {
      messageType: message.msg_type,
      larkThreadId: message.thread_id,
      importedFromHistory: true,
    },
  };
}
