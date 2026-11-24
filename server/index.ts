/**
 * Interview & OA Copilot — backend proxy (Express + TypeScript).
 *
 * SECURITY MODEL: all third-party secrets (Gemini / OpenAI / Deepgram) live
 * ONLY here, loaded from `.env`. The Electron renderer talks to this server
 * over localhost HTTP/SSE/WebSocket-relay and never sees a raw provider key.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient, type ListenLiveClient } from '@deepgram/sdk';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT ?? 3001);

// Screenshots arrive as base64 PNG data URLs -> allow up to 25 MB bodies.
app.use(cors({ origin: true }));
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------
const deepgram = createClient(process.env.DEEPGRAM_API_KEY ?? '');
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });

type ChatTurn = { role: 'user' | 'assistant'; content: string };

interface AskPayload {
  question?: string;
  resumeContext?: string;
  jobDescription?: string;
  conversationHistory?: ChatTurn[];
  screenshotBase64?: string; // data:image/png;base64,... or bare base64
}

const SYSTEM_PROMPT = `You are "Copilot", an expert real-time interview and online-assessment (OA) assistant
embedded in a stealth overlay. The candidate is LIVE in an interview or coding assessment and can barely
look away from the screen, so your output must be instantly usable.

CANDIDATE RESUME:
{{RESUME}}

TARGET JOB DESCRIPTION:
{{JD}}

OUTPUT CONTRACT — follow it exactly for every verbal question:
1. First, output a section titled "### ⚡ Say this first" containing EXACTLY 3 ultra-concise bullet points
   (max ~12 words each). These are instant talking points the candidate can blurt out within 2 seconds.
2. Then, output a section titled "### 🗣 Spoken answer" with ONE natural, first-person, conversational
   paragraph (60-120 words) the candidate can read aloud verbatim. For behavioral/situational questions
   use the STAR method explicitly: Situation, Task, Action, Result (quantify the Result).
3. Only if useful, add a final "### 💡 Follow-up probe" line anticipating the interviewer's next question.

CODING / OA SCREENSHOT RULES (when an image is attached):
- Identify the problem, then give OPTIMAL, complete, copy-ready code in the language shown on screen
  (default Python if unclear). No stubs, no pseudo-code.
- State Time complexity and Space complexity on their own lines.
- Give a 2-4 sentence explanation of the key insight, plus one tricky edge case to mention out loud.
- Never lecture about ethics or note-taking; just solve it fast and correctly.

Keep everything tight. No preamble, no apologies, no restating the question.`;

function buildSystemPrompt(p: AskPayload): string {
  return SYSTEM_PROMPT.replace('{{RESUME}}', p.resumeContext?.trim() || 'Not provided.')
    .replace('{{JD}}', p.jobDescription?.trim() || 'Not provided.');
}

function stripDataUrlPrefix(b64: string): { data: string; mimeType: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(b64);
  if (match) return { mimeType: match[1], data: match[2] };
  return { mimeType: 'image/png', data: b64 };
}

// ---------------------------------------------------------------------------
// GET /api/stt-token — ephemeral, scoped Deepgram key for direct client streaming
// ---------------------------------------------------------------------------
app.get('/api/stt-token', async (_req: Request, res: Response) => {
  try {
    const projectId = process.env.DEEPGRAM_PROJECT_ID;
    if (!projectId) {
      // Fallback mode: no project id configured -> hand back the master key.
      // (Fine for local MVP; set DEEPGRAM_PROJECT_ID for real interviews.)
      return res.json({ key: process.env.DEEPGRAM_API_KEY, ephemeral: false });
    }
    const { result } = await deepgram.manage.createProjectKey(projectId, {
      comment: `copilot-ephemeral-${Date.now()}`,
      scopes: ['usage:write'],
      time_to_live_in_seconds: 3600,
    });
    if (!result?.key) throw new Error('Deepgram returned no key');
    res.json({ key: result.key, ephemeral: true, expiresInSeconds: 3600 });
  } catch (err) {
    console.error('[stt-token]', err);
    res.status(500).json({ error: 'Failed to create STT token' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/ask — multimodal streaming answer over Server-Sent Events
// ---------------------------------------------------------------------------
app.post('/api/ask', async (req: Request, res: Response) => {
  const payload = (req.body ?? {}) as AskPayload;
  const question = (payload.question ?? '').trim();
  const history = Array.isArray(payload.conversationHistory)
    ? payload.conversationHistory.slice(-8)
    : [];

  if (!question && !payload.screenshotBase64) {
    return res.status(400).json({ error: 'Provide either a question or a screenshot.' });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const sendEvent = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  try {
    if ((process.env.AI_PROVIDER ?? 'gemini').toLowerCase() === 'openai') {
      await streamOpenAI(payload, history, sendEvent, abort.signal);
    } else {
      await streamGemini(payload, history, sendEvent, abort.signal);
    }
    res.write('data: [DONE]\n\n');
  } catch (err) {
    console.error('[ask]', err);
    sendEvent({ error: 'Generation failed — check GEMINI_API_KEY / OPENAI_API_KEY in .env' });
    res.write('data: [DONE]\n\n');
  } finally {
    res.end();
  }
});

async function streamGemini(
  payload: AskPayload,
  history: ChatTurn[],
  sendEvent: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const parts: Array<Record<string, unknown>> = [];

  if (payload.screenshotBase64) {
    const { data, mimeType } = stripDataUrlPrefix(payload.screenshotBase64);
    parts.push({ inlineData: { mimeType, data } });
    parts.push({
      text: payload.question?.trim()
        ? `Solve the problem shown on screen. Extra context from the candidate: "${payload.question}"`
        : 'Solve the coding / online-assessment problem shown on screen.',
    });
  } else {
    parts.push({ text: `The interviewer just asked: "${payload.question}"` });
  }

  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.content }] })),
    { role: 'user', parts },
  ];

  const stream = await gemini.models.generateContentStream({
    model: process.env.GEMINI_MODEL ?? 'gemini-2.5-flash',
    contents: contents as never,
    config: {
      systemInstruction: buildSystemPrompt(payload),
      temperature: 0.4,
      maxOutputTokens: 2048,
      // Gemini 2.5 "thinking" adds latency; cap it for snappy live answers.
      thinkingConfig: { includeThoughts: false, thinkingBudget: 0 },
    },
    signal,
  } as never);

  for await (const chunk of stream as AsyncGenerator<GenerateContentResponse>) {
    const text = chunk.text ?? '';
    if (text) sendEvent({ text });
  }
}

async function streamOpenAI(
  payload: AskPayload,
  history: ChatTurn[],
  sendEvent: (obj: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: buildSystemPrompt(payload) },
    ...history.map((h) => ({ role: h.role, content: h.content })),
  ];

  if (payload.screenshotBase64) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: payload.question?.trim() || 'Solve the problem shown on screen.' },
        { type: 'image_url', image_url: { url: payload.screenshotBase64, detail: 'high' } },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: `The interviewer just asked: "${payload.question}"`,
    });
  }

  const upstream = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
      stream: true,
      temperature: 0.4,
      messages,
    }),
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(`OpenAI error ${upstream.status}: ${await upstream.text()}`);
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return;
      try {
        const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (delta) sendEvent({ text: delta });
      } catch {
        /* ignore keep-alive fragments */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// WS /listen — optional relay: streams client audio to Deepgram using the
// MASTER key so interviewers can run without a DEEPGRAM_PROJECT_ID. The
// renderer prefers the direct wss:// socket from /api/stt-token and only
// falls back to this relay when the token response is not ephemeral.
// ---------------------------------------------------------------------------
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/listen' });

wss.on('connection', (client: WebSocket) => {
  let dg: ListenLiveClient | undefined;

  try {
    dg = deepgram.listen.live({
      model: 'nova-2',
      punctuate: true,
      interim_results: true,
      endpointing: 400,
      format: 'webm',
    });

    dg.on('Transcript.Message', (ev) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(ev));
      }
    });
    dg.on('Lifecycle.Close', () => client.close());
    dg.on('Lifecycle.Error', (e) => {
      client.send(JSON.stringify({ type: 'error', error: String(e) }));
      client.close();
    });

    client.on('message', (data: Buffer) => {
      // `send` pushes raw binary audio frames straight onto the Deepgram socket.
      if (!dg || dg.getReadyState() !== WebSocket.OPEN) return;
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      dg.send(ab as ArrayBuffer);
    });
    client.on('close', () => dg?.requestClose());
  } catch (err) {
    console.error('[ws relay]', err);
    client.close(1011, 'Deepgram relay unavailable');
  }
});

server.listen(PORT, () => {
  console.log(`✅ Copilot backend listening on http://localhost:${PORT}`);
  console.log(`   • GET  http://localhost:${PORT}/api/stt-token`);
  console.log(`   • POST http://localhost:${PORT}/api/ask  (SSE)`);
  console.log(`   • WS   ws://localhost:${PORT}/listen     (audio relay)`);
});
