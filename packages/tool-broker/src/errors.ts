export class ToolDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}
