import type {
  SourceAttachment,
  SourceMessage,
  SourceThread,
  ThreadVisibility,
} from '@opentag/core';
import type {
  SlackEventEnvelope,
  SlackFileDescriptor,
  SlackMessageEvent,
} from './types.js';

export interface NormalizeSlackOptions {
  workspaceId?: string;
  botUserId?: string;
  ignoreBotMessages?: boolean;
}

function visibilityFor(event: SlackMessageEvent): ThreadVisibility {
  if (event.channel_type === 'im' || event.channel?.startsWith('D')) {
    return 'direct';
  }
  if (
    event.channel_type === 'group' ||
    event.channel_type === 'mpim' ||
    event.channel?.startsWith('G')
  ) {
    return 'private';
  }
  if (event.channel_type === 'channel') return 'public';
  return 'private';
}

function messageText(
  body: SlackEventEnvelope,
  event: SlackMessageEvent,
  botUserId: string | undefined,
): string {
  const text = event.text || '';
  if (event.type !== 'app_mention') return text;
  const botId =
    botUserId ||
    body.authorizations?.find((authorization) => authorization.is_bot)?.user_id;
  const trimmed = text.trimStart();
  if (botId && trimmed.startsWith(`<@${botId}>`)) {
    return trimmed.slice(botId.length + 3).trimStart();
  }
  return trimmed.replace(/^<@[A-Z0-9]+>\s*/u, '');
}

function attachmentKind(file: SlackFileDescriptor): SourceAttachment['kind'] {
  if (file.mimetype?.startsWith('image/')) return 'image';
  if (file.mimetype?.startsWith('audio/')) return 'audio';
  if (file.mimetype?.startsWith('video/')) return 'video';
  return 'file';
}

function attachment(file: SlackFileDescriptor): SourceAttachment | undefined {
  if (!file.id) return undefined;
  const downloadUrl = file.url_private_download || file.url_private;
  return {
    id: `slack-file:${file.id}`,
    kind: attachmentKind(file),
    name: file.name || file.title,
    mimeType: file.mimetype,
    sizeBytes: file.size,
    metadata: {
      slackFileId: file.id,
      slackDownloadUrl: downloadUrl,
      slackFileMode: file.mode,
      slackFileType: file.filetype,
    },
  };
}

function timestampIso(value: string): string {
  const milliseconds = Number(value) * 1000;
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : new Date().toISOString();
}

export function normalizeSlackEvent(
  body: SlackEventEnvelope,
  options: NormalizeSlackOptions = {},
): { thread: SourceThread; message: SourceMessage } | null {
  if (body.type !== 'event_callback') return null;
  const event = body.event;
  if (!event?.channel || !event.ts || !event.type) return null;
  const visibility = visibilityFor(event);
  const direct = visibility === 'direct';
  if (event.type !== 'app_mention' && !(event.type === 'message' && direct)) {
    return null;
  }
  if (
    (options.ignoreBotMessages ?? true) &&
    (event.bot_id || event.subtype === 'bot_message' ||
      (options.botUserId && event.user === options.botUserId))
  ) {
    return null;
  }
  if (event.subtype && event.subtype !== 'file_share') return null;

  const channelId = event.channel;
  const rootTs = event.thread_ts || (direct ? undefined : event.ts);
  const externalId = rootTs ? `${channelId}:${rootTs}` : channelId;
  const files = event.files
    ?.map(attachment)
    .filter((item): item is SourceAttachment => Boolean(item));
  const actorId = event.user || 'unknown';
  const thread: SourceThread = {
    id: `slack:${externalId}`,
    platform: 'slack',
    externalId,
    workspaceId: options.workspaceId || 'dev-workspace',
    projectId: channelId,
    channelId,
    rootMessageId: rootTs,
    topicId: rootTs,
    title: `Slack ${channelId}`,
    visibility,
    metadata: {
      teamId: body.team_id,
      eventId: body.event_id,
      eventType: event.type,
      incomingMessageTs: event.ts,
      slackThreadTs: rootTs,
      channelType: event.channel_type,
    },
  };
  return {
    thread,
    message: {
      id: event.ts,
      threadId: thread.id,
      platform: 'slack',
      text: messageText(body, event, options.botUserId),
      actor: {
        id: actorId,
        platformUserId: actorId,
        isBot: false,
      },
      createdAt: timestampIso(event.ts),
      mentionsAgent: event.type === 'app_mention' || direct,
      replyToMessageId: event.thread_ts,
      attachments: files?.length ? files : undefined,
      metadata: {
        teamId: body.team_id,
        eventId: body.event_id,
        eventType: event.type,
        slackThreadTs: rootTs,
      },
    },
  };
}
