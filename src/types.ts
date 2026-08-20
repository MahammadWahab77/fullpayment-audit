export interface VideoAnalysis {
  id: string;
  recordingName: string;
  videoUrl: string;
  timestamp: number;
  language: string;
  speakerType: string;
  specificRelationship: string;
  transcript: string;
  transcriptEnglish?: string;
  loanWordUsed: boolean;
  loanWordSpeaker: string;
  documentWordUsed: boolean;
  sentiment: string;
  videoClarity: string;
  faceVisible: boolean;
  isIrrelevant: boolean;
  faceScreenshot?: string;
  recordId?: string;
  loanMentionTimestamp?: string;
  documentMentionTimestamp?: string;
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
}

export type AuditStatus = 
  | 'PENDING'
  | 'PROCESSING'
  | 'PAYMENT_CONSENT_FOUND'
  | 'PARTIAL_CONFIRMATION'
  | 'NOT_FOUND'
  | 'NOISY_AUDIO_UNABLE_TO_AUDIT'
  | 'FETCH_FAILED'
  | 'PARSE_ERROR';

export interface AuditResult {
  status: AuditStatus;
  timestamp?: string;
  confidence?: number;
  statement?: string;
  transcriptEnglish?: string;
  recordingLink?: string;
  recordingsChecked: number;
  totalRecordings: number;
  totalTokens?: number;
}

export interface FPGroupedUID {
  uid: string;
  selfDeclaration?: string;
  recordings: string[];
  result: AuditResult;
}

export interface FPGeminiResponse {
  status: 'PAYMENT_CONSENT_FOUND' | 'NOT_FOUND' | 'NOISY_AUDIO';
  timestamp?: string;
  confidence?: number;
  statement?: string;
  transcript_english?: string;
}

export interface FPHistoryItem {
  id: string;
  uid: string;
  status: AuditStatus;
  auditDate: string;
  audioTimestamp?: string;
  confidence?: number;
  statement?: string;
  transcriptEnglish?: string;
  recordingLink?: string;
  mode: 'single' | 'bulk';
  totalTokens?: number;
}
