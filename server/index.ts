import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@deepgram/sdk';
import { GoogleGenAI } from '@google/genai';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const deepgram = createClient(process.env.DEEPGRAM_API_KEY!);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

// 1. Issue temporary Deepgram token so the client can stream audio directly
app.get('/api/stt-token', async (_req, res) => {
  try {
    const { result } = await deepgram.manage.createProjectKey(
      process.env.DEEPGRAM_PROJECT_ID!,
      {
        comment: 'ephemeral-session',
        scopes: ['usage:write'],
        time_to_live_in_seconds: 3600,
      }
    );
    res.json({ key: result?.key });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create STT token' });
  }
});

// 2. Stream real-time interview answers or screenshot solutions (SSE)
app.post('/api/ask', async (req, res) => {
  const { question, resumeContext, jobDescription, screenshotBase64 } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const systemPrompt = `You are a concise, real-time interview assistant.
Candidate Resume:
${resumeContext || 'Not provided'}

Target Job Description:
${jobDescription || 'Not provided'}

Rules:
- First give 3 ultra-short bullet points (key takeaways to say immediately).
- Then provide a concise, natural spoken response (STAR format for behavioral questions).
- If a screenshot of a coding/OA problem is attached, provide the optimal solution, time/space complexity, and brief explanation.`;

  try {
    const contents: any[] = [];

    if (screenshotBase64) {
      const base64Data = screenshotBase64.replace(/^data:image\/\w+;base64,/, '');
      contents.push({
        inlineData: {
          data: base64Data,
          mimeType: 'image/png',
        },
      });
      contents.push('Solve the problem shown on screen.');
    } else {
      contents.push(`Interviewer just asked: "${question}"`);
    }

    const responseStream = await ai.models.generateContentStream({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: systemPrompt,
        temperature: 0.4,
      },
    });

    for await (const chunk of responseStream) {
      if (chunk.text) {
        res.write(`data: ${JSON.stringify({ text: chunk.text })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error) {
    res.write(`data: ${JSON.stringify({ error: 'Generation failed' })}\n\n`);
    res.end();
  }
});

app.listen(3001, () => console.log('Copilot backend running on http://localhost:3001'));
