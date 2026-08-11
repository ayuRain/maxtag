import type {
  SourceAttachment,
  SourceMessage,
  SourceThread,
} from '@opentag/core';
import type {
  TelegramFileDescriptor,
  TelegramMessage,
  TelegramMessageEntity,
  TelegramUpdate,
} from './types.js';

export interface NormalizeTelegramOptions {
  botUsername?: string;
  workspaceId?: string;
  ignoreBotMessages?: boolean;
}

function displayName(input: {
  first_name?: string;
  last_name?: string;
  username?: string;
}): string | undefined {
  const name = [input.first_name, input.last_name].filter(Boolean).join(' ');
  return name || input.username;
}

function messageFromUpdate(body: TelegramUpdate): {
  message?: TelegramMessage;
  eventType: string;
} {
  if (body.message) return { message: body.message, eventType: 'message' };
  if (body.edited_message) {
    return { message: body.edited_message, eventType: 'edited_message' };
  }
  if (body.channel_post) {
    return { message: body.channel_post, eventType: 'channel_post' };
  }
  if (body.edited_channel_post) {
    return {
      message: body.edited_channel_post,
      eventType: 'edited_channel_post',
    };
  }
  return { eventType: 'unknown' };
}

function entityText(
  text: string,
  entity: TelegramMessageEntity,
): string {
  return text.slice(entity.offset, entity.offset + entity.length);
}

function normalizedBotUsername(value: string | undefined): string | undefined {
  const result = value?.trim().replace(/^@/u, '').toLowerCase();
  return result || undefined;
}

function mentionsAgent(
  text: string,
  entities: TelegramMessageEntity[],
  options: NormalizeTelegramOptions,
  direct: boolean,
): boolean {
  if (direct) return true;
  const username = normalizedBotUsername(options.botUsername);
  for (const entity of entities) {
    const value = entityText(text, entity).toLowerCase();
    if (entity.type === 'bot_command') {
      const command = value.replace(/^\//u, '').split('@', 2);
      if (
        command[0] === 'opentag' &&
        (!command[1] || (username && command[1] === username))
      ) {
        return true;
      }
    }
    if (entity.type === 'mention' && username && value === `@${username}`) {
      return true;
    }
    if (
      entity.type === 'text_mention' &&
      entity.user?.is_bot &&
      username &&
      entity.user.username?.toLowerCase() === username
    ) {
      return true;
    }
  }
  const command = /^\s*\/opentag(?:@([a-z0-9_]+))?\b/iu.exec(text);
  if (command && (!command[1] || (username && command[1].toLowerCase() === username))) {
    return true;
  }
  return Boolean(username && text.toLowerCase().includes(`@${username}`));
}

function attachment(
  descriptor: TelegramFileDescriptor | undefined,
  kind: SourceAttachment['kind'],
  prefix: string,
): SourceAttachment | undefined {
  if (!descriptor?.file_id) return undefined;
  return {
    id: `${prefix}:${descriptor.file_unique_id || descriptor.file_id}`,
    kind,
    name: descriptor.file_name,
    mimeType: descriptor.mime_type,
    sizeBytes: descriptor.file_size,
    metadata: {
      telegramFileId: descriptor.file_id,
      telegramFileUniqueId: descriptor.file_unique_id,
    },
  };
}

function attachmentsFor(message: TelegramMessage): SourceAttachment[] | undefined {
  const result: SourceAttachment[] = [];
  const photo = message.photo?.at(-1);
  const candidates = [
    attachment(photo, 'image', 'photo'),
    attachment(message.document, 'file', 'document'),
    attachment(message.audio, 'audio', 'audio'),
    attachment(message.video, 'video', 'video'),
    attachment(message.voice, 'audio', 'voice'),
    attachment(message.animation, 'video', 'animation'),
  ];
  for (const item of candidates) {
    if (item) result.push(item);
  }
  return result.length ? result : undefined;
}

function chatTitle(message: TelegramMessage): string {
  return (
    message.chat.title ||
    displayName(message.chat) ||
    message.chat.username ||
    `Telegram ${message.chat.id}`
  );
}

export function normalizeTelegramUpdate(
  body: TelegramUpdate,
  options: NormalizeTelegramOptions = {},
): { thread: SourceThread; message: SourceMessage } | null {
  const selected = messageFromUpdate(body);
  const incoming = selected.message;
  if (!incoming?.message_id || !incoming.chat?.id) return null;
  if ((options.ignoreBotMessages ?? true) && incoming.from?.is_bot) return null;

  const chatId = String(incoming.chat.id);
  const topicId = incoming.message_thread_id
    ? String(incoming.message_thread_id)
    : undefined;
  const externalId = topicId ? `${chatId}:${topicId}` : chatId;
  const direct = incoming.chat.type === 'private';
  const text = incoming.text ?? incoming.caption ?? '';
  const entities = incoming.text
    ? incoming.entities ?? []
    : incoming.caption_entities ?? [];
  const actor = incoming.from;
  const senderChat = incoming.sender_chat;
  const actorId = actor
    ? String(actor.id)
    : senderChat
      ? `chat:${senderChat.id}`
      : 'unknown';

  const thread: SourceThread = {
    id: `telegram:${externalId}`,
    platform: 'telegram',
    externalId,
    workspaceId: options.workspaceId || 'dev-workspace',
    projectId: chatId,
    channelId: chatId,
    topicId,
    title: chatTitle(incoming),
    visibility: direct ? 'direct' : 'public',
    metadata: {
      chatType: incoming.chat.type,
      updateId: body.update_id,
      incomingMessageId: String(incoming.message_id),
      messageThreadId: topicId,
      eventType: selected.eventType,
    },
  };

  return {
    thread,
    message: {
      id: String(incoming.message_id),
      threadId: thread.id,
      platform: 'telegram',
      text,
      actor: {
        id: actorId,
        platformUserId: actorId,
        displayName: actor
          ? displayName(actor)
          : senderChat
            ? chatTitle({ ...incoming, chat: senderChat })
            : undefined,
        isBot: actor?.is_bot,
      },
      createdAt: new Date(incoming.date * 1000).toISOString(),
      mentionsAgent: mentionsAgent(text, entities, options, direct),
      replyToMessageId: incoming.reply_to_message
        ? String(incoming.reply_to_message.message_id)
        : undefined,
      attachments: attachmentsFor(incoming),
      metadata: {
        updateId: body.update_id,
        eventType: selected.eventType,
        messageThreadId: topicId,
      },
    },
  };
}
