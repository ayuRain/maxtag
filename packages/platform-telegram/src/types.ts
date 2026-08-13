import type { SourceThread } from '@opentag/core';

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | (string & {});
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

export interface TelegramFileDescriptor {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramPhotoSize extends TelegramFileDescriptor {
  width?: number;
  height?: number;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: Pick<TelegramMessage, 'message_id'>;
  is_topic_message?: boolean;
  photo?: TelegramPhotoSize[];
  document?: TelegramFileDescriptor;
  audio?: TelegramFileDescriptor;
  video?: TelegramFileDescriptor;
  voice?: TelegramFileDescriptor;
  animation?: TelegramFileDescriptor;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
}

export interface TelegramDeliveryMetadata {
  runId?: string;
  thread?: SourceThread;
  stage?: 'progress' | 'thread-reply' | 'routine-notification' | 'artifact';
  notificationId?: string;
}

export interface TelegramDocumentInput {
  url?: string;
  path?: string;
  name?: string;
}

export interface TelegramDownloadedFile {
  bytes: Uint8Array;
  name?: string;
  sizeBytes?: number;
}

export interface TelegramTransport {
  sendText(input: {
    chatId: string;
    text: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }>;
  editText(input: {
    chatId: string;
    messageId: string;
    text: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<void>;
  sendDocument(input: {
    chatId: string;
    document: TelegramDocumentInput;
    caption?: string;
    messageThreadId?: string;
    replyToMessageId?: string;
    metadata?: TelegramDeliveryMetadata;
  }): Promise<{ messageId: string }>;
  downloadFile(input: {
    fileId: string;
    maxBytes?: number;
  }): Promise<TelegramDownloadedFile>;
}
