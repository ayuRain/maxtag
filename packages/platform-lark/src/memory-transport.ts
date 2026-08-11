import type { LarkTransport } from './types.js';

export class MemoryLarkTransport implements LarkTransport {
  readonly texts: Array<Record<string, unknown>> = [];
  readonly cards: Array<{ id: string; card: Record<string, unknown> }> = [];

  async sendText(input: {
    chatId: string;
    text: string;
    rootId?: string;
    replyToMessageId?: string;
  }): Promise<void> {
    this.texts.push(input);
  }

  async createCard(input: {
    chatId: string;
    card: Record<string, unknown>;
    rootId?: string;
    replyToMessageId?: string;
  }): Promise<{ cardId: string }> {
    const id = `card_${this.cards.length + 1}`;
    this.cards.push({ id, card: input.card });
    return { cardId: id };
  }

  async updateCard(input: {
    cardId: string;
    card: Record<string, unknown>;
  }): Promise<void> {
    const existing = this.cards.find((card) => card.id === input.cardId);
    if (existing) {
      existing.card = input.card;
      return;
    }
    this.cards.push({ id: input.cardId, card: input.card });
  }
}

