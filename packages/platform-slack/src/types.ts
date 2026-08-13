import type { SourceThread } from '@opentag/core';

export interface SlackFileDescriptor {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  mode?: string;
  url_private?: string;
  url_private_download?: string;
}

export interface SlackMessageEvent {
  type: 'app_mention' | 'message' | (string & {});
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  event_ts?: string;
  channel?: string;
  channel_type?: 'im' | 'channel' | 'group' | 'mpim' | (string & {});
  thread_ts?: string;
  files?: SlackFileDescriptor[];
}

export interface SlackEventEnvelope {
  type?: 'url_verification' | 'event_callback' | (string & {});
  challenge?: string;
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event_id?: string;
  event_time?: number;
  event?: SlackMessageEvent;
  authorizations?: Array<{
    team_id?: string;
    user_id?: string;
    is_bot?: boolean;
    is_enterprise_install?: boolean;
  }>;
}

export interface SlackDeliveryMetadata {
  runId?: string;
  thread?: SourceThread;
  stage?: 'progress' | 'thread-reply' | 'routine-notification' | 'artifact';
  notificationId?: string;
}

export interface SlackFileInput {
  path: string;
  name?: string;
  title?: string;
}

export interface SlackDownloadedFile {
  bytes: Uint8Array;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface SlackTransport {
  sendText(input: {
    channelId: string;
    text: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ messageId: string }>;
  editText(input: {
    channelId: string;
    messageId: string;
    text: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<void>;
  sendFile(input: {
    channelId: string;
    file: SlackFileInput;
    comment?: string;
    threadTs?: string;
    metadata?: SlackDeliveryMetadata;
  }): Promise<{ fileId: string; messageId?: string }>;
  downloadFile(input: {
    url: string;
    name?: string;
    mimeType?: string;
    expectedSizeBytes?: number;
    maxBytes?: number;
  }): Promise<SlackDownloadedFile>;
}
