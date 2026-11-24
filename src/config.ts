/** Single place where the renderer learns how to reach the local backend proxy. */
export const BACKEND_PORT = 3001;
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) ??
  `http://localhost:${BACKEND_PORT}`;

export const WS_RELAY_URL = API_BASE.replace(/^http/, 'ws') + '/listen';

export const DEEPGRAM_WS_URL =
  'wss://api.deepgram.com/v1/listen' +
  '?model=nova-2' +
  '&punctuate=true' +
  '&interim_results=true' +
  '&endpointing=400' +
  '&smart_format=true';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AskRequest {
  question: string;
  resumeContext: string;
  jobDescription: string;
  conversationHistory: ChatTurn[];
  screenshotBase64?: string;
}
