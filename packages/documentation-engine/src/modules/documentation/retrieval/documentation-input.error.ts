export class DocumentationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentationInputError';
  }
}
