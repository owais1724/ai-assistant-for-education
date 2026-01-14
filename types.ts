
export enum AppState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING = 'PROCESSING',
  SPEAKING = 'SPEAKING',
  FOLLOW_UP_WAIT = 'FOLLOW_UP_WAIT'
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  timestamp: Date;
}

export interface PDFMetadata {
  name: string;
  content: string;
}

export interface SystemArchitecture {
  layers: {
    title: string;
    description: string;
    tech: string[];
  }[];
}
