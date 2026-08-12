import type { SourceThread } from '@opentag/core';

export interface LarkDeliveryMetadata {
  runId?: string;
  thread?: SourceThread;
  stage?: 'progress-card' | 'thread-reply' | 'artifact';
  artifactId?: string;
}

export interface LarkFileInput {
  path: string;
  name?: string;
  mimeType?: string;
}

export interface LarkDownloadedResource {
  bytes: Uint8Array;
  name?: string;
  mimeType?: string;
}

export interface LarkIncomingEvent {
  event_id?: string;
  type?: string;
  token?: string;
  challenge?: string;
  header?: {
    event_id?: string;
    event_type?: string;
    create_time?: string;
    token?: string;
    app_id?: string;
    tenant_key?: string;
  };
  event?: {
    message?: {
      message_id?: string;
      root_id?: string;
      parent_id?: string;
      chat_id?: string;
      chat_type?: 'p2p' | 'group';
      message_type?: string;
      content?: string;
      create_time?: string;
      mentions?: Array<{ id?: { open_id?: string; user_id?: string }; name?: string }>;
    };
    sender?: {
      sender_id?: {
        open_id?: string;
        user_id?: string;
      };
      sender_type?: string;
      tenant_key?: string;
    };
    operator?: {
      open_id?: string;
      user_id?: string;
      union_id?: string;
      tenant_key?: string;
    };
    action?: {
      tag?: string;
      value?: unknown;
      option?: string;
      name?: string;
    };
    context?: {
      open_message_id?: string;
      open_chat_id?: string;
    };
    token?: string;
    host?: string;
  };
}

export interface LarkCardAction {
  action: string;
  runId?: string;
  actorId: string;
  cardMessageId: string;
  chatId: string;
  tenantKey?: string;
  componentTag?: string;
}

export interface LarkCardActionResponse {
  [key: string]: unknown;
  toast: {
    type: 'success' | 'info' | 'warning' | 'error';
    content: string;
  };
}

export interface LarkTransport {
  sendText(input: {
    chatId: string;
    text: string;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void>;
  createCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ cardId: string }>;
  updateCard(input: {
    cardId: string;
    card: Record<string, unknown>;
    metadata?: LarkDeliveryMetadata;
  }): Promise<void>;
  sendFile(input: {
    chatId: string;
    file: LarkFileInput;
    rootId?: string;
    replyToMessageId?: string;
    metadata?: LarkDeliveryMetadata;
  }): Promise<{ messageId: string }>;
  downloadMessageResource(input: {
    messageId: string;
    fileKey: string;
    type: 'file' | 'image';
    maxBytes?: number;
  }): Promise<LarkDownloadedResource>;
}
