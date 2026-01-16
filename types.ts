
export enum AppState {
  IDLE = 'IDLE',
  LISTENING = 'LISTENING',
  PROCESSING = 'PROCESSING',
  SPEAKING = 'SPEAKING',
  FOLLOW_UP_WAIT = 'FOLLOW_UP_WAIT',
  QUIZ = 'QUIZ',
  MINDMAP = 'MINDMAP'
}

export enum UserRole {
  STUDENT = 'STUDENT',
  TEACHER = 'TEACHER',
  PARENT = 'PARENT'
}

export type StudentStatus = 'GOOD' | 'AVERAGE' | 'NEEDS_IMPROVEMENT';

export interface Interaction {
  question: string;
  answer: string;
  topic: string;
  timestamp: number;
  complexity: 'BASIC' | 'CONCEPTUAL';
}

export interface QuizQuestion {
  question: string;
  options: string[];
  correctAnswer: number; // index
  explanation: string;
}

export interface Quiz {
  title: string;
  questions: QuizQuestion[];
}

export interface MindMapNode {
  id: string;
  label: string;
  description: string;
  children?: MindMapNode[];
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  // Relationship links
  childId?: string;       // For PARENT role
  studentIds?: string[];  // For TEACHER role
  // Student specific data
  uploadedTextbooks: PDFMetadata[];
  history: Interaction[];
  weakAreas: string[];
  strongAreas: string[];
  status: StudentStatus;
  aiInsightSummary: string;
  conceptAttempts: Record<string, number>;
}

export interface PDFMetadata {
  name: string;
  content: string;
}
