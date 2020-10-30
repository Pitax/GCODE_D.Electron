import { CompletionItem, MarkupContent } from 'vscode-languageserver-protocol'

export interface CursorInfo {
  type: string;
  word: string;
}

