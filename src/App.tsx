import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Marked from 'marked-react';
import hljs from 'highlight.js/lib/common';
import {
  API_BASE,
  DEEPGRAM_WS_URL,
  WS_RELAY_URL,
  type AskRequest,
  type ChatTurn,
} from './config';

/* ==========================================================================
   Interview & OA Copilot — overlay renderer

   Pipeline (all wired inside this component):

     system loopback audio ──► MediaRecorder (250 ms chunks)
                                   │
                                   ▼
                     Deepgram Streaming STT (nova-2, interim_results=true,
                                   endpointing=400)
                                   │  is_final && speech_final
                                   ▼
                     POST /api/ask ──► SSE stream ──► Markdown answer

     ⌘/Ctrl+Shift+S screenshot ──► IPC ──► POST /api/ask (multimodal) ──► SSE
   ========================================================================== */

type ConnState = 'idle' | 'connecting' | 'live' | 'error';

interface TranscriptLine {
  id: number;
  text: string;
  final: boolean;
}

const STORAGE_KEY = 'copilot.context.v1';

export default function App() {
  /* ------------------------------------------------------------- state -- */
  const [conn, setConn] = useState<ConnState>('idle');
  const [lines, setLines] = useState<TranscriptLine[]>([]);
  const [interim, setInterim] = useState('');
  const [answer, setAnswer] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState('');
  const [contextOpen, setContextOpen] = useState(true);
  const [ghostMode, setGhostMode] = useState(false);
  const [manualQuestion, setManualQuestion] = useState('');
  const [lastShot, setLastShot] = useState<string | null>(null);

  const [resumeContext, setResumeContext] = useState('');
  const [jobDescription, setJobDescription] = useState('');

  /* -------------------------------------------------------------- refs -- */
  // Mirrors so callbacks fired from sockets / IPC always read fresh values.
  const resumeRef = useRef(resumeContext);
  const jdRef = useRef(jobDescription);
  const historyRef = useRef<ChatTurn[]>([]);
  const answerBufferRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lineIdRef = useRef(0);
  const transcriptBoxRef = useRef<HTMLDivElement | null>(null);
  const answerBoxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    resumeRef.current = resumeContext;
  }, [resumeContext]);
  useEffect(() => {
    jdRef.current = jobDescription;
  }, [jobDescription]);

  /* Restore resume / JD context between sessions (kept on-device only). */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { resume?: string; jd?: string };
        setResumeContext(parsed.resume ?? '');
        setJobDescription(parsed.jd ?? '');
      }
    } catch {
      /* corrupted cache -> start clean */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ resume: resumeContext, jd: jobDescription }),
      );
    } catch {
      /* storage unavailable -> non-fatal */
    }
  }, [resumeContext, jobDescription]);

  /* Auto-scroll the two live panes as content streams in. */
  useEffect(() => {
    const el = transcriptBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, interim]);

  useEffect(() => {
    const el = answerBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [answer]);

  /* ===================================================== AI (SSE client) == */

  const askAI = useCallback(async (question: string, screenshotBase64?: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    answerBufferRef.current = '';
    setAnswer('');
    setStreaming(true);
    setError('');

    if (screenshotBase64) setLastShot(screenshotBase64);

    const body: AskRequest = {
      question,
      resumeContext: resumeRef.current,
      jobDescription: jdRef.current,
      conversationHistory: historyRef.current,
      screenshotBase64,
    };

    try {
      const res = await fetch(`${API_BASE}/api/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw new Error(`Backend responded ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      // Parse Server-Sent Events incrementally: events are separated by a blank
      // line and may be split across arbitrary network chunks.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop() ?? '';

        for (const evt of events) {
          for (const line of evt.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data) as { text?: string; error?: string };
              if (parsed.error) setError(parsed.error);
              if (parsed.text) {
                answerBufferRef.current += parsed.text;
                setAnswer(answerBufferRef.current);
              }
            } catch {
              /* partial JSON fragment -> re-assembled on the next chunk */
            }
          }
        }
      }

      if (answerBufferRef.current.trim()) {
        const turn: ChatTurn[] = [
          { role: 'user', content: screenshotBase64 ? '[screenshot of screen]' : question },
          { role: 'assistant', content: answerBufferRef.current },
        ];
        historyRef.current = [...historyRef.current, ...turn].slice(-8);
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError((err as Error).message || 'Could not reach the local backend.');
      }
    } finally {
      setStreaming(false);
    }
  }, []);

  /* ============================================ capture teardown helper == */

  function cleanupCapture() {
    try {
      if (recorderRef.current && recorderRef.current.state === 'recording') {
        recorderRef.current.stop();
      }
    } catch {
      /* already stopped */
    }
    recorderRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }

  /* ================================================ Deepgram streaming == */

  const handleTranscriptEvent = useCallback(
    (raw: string) => {
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'error' || msg.error) {
        setError(String(msg.error ?? msg.description ?? 'Deepgram stream error'));
        return;
      }

      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;

      const text: string = alt.transcript ?? '';
      const isFinal: boolean = msg.is_final === true;
      const speechFinal: boolean = msg.speech_final === true;

      if (!text) return;

      if (isFinal) {
        // Committed utterance: append to the transcript log, clear interim text.
        setInterim('');
        setLines((prev) => {
          const next = [...prev, { id: ++lineIdRef.current, text, final: true }];
          return next.length > 40 ? next.slice(next.length - 40) : next;
        });

        // Trigger the AI exactly when the interviewer finishes speaking.
        if (speechFinal && text.trim().length > 6) {
          void askAI(text.trim());
        }
      } else {
        setInterim(text);
      }
    },
    [askAI],
  );

  const openSTTSocket = useCallback(
    async (key: string, useRelay: boolean): Promise<WebSocket> => {
      const wsUrl = useRelay ? WS_RELAY_URL : DEEPGRAM_WS_URL;
      // Subprotocol ['token', key] is how Deepgram authenticates browser sockets.
      const socket = new WebSocket(wsUrl, useRelay ? undefined : ['token', key]);
      socket.binaryType = 'arraybuffer';

      socket.onmessage = (e) => {
        if (typeof e.data === 'string') handleTranscriptEvent(e.data);
      };
      socket.onerror = () => setError('Speech-to-text socket error.');
      socket.onclose = () => {
        if (recorderRef.current?.state === 'recording') {
          cleanupCapture();
          setConn('idle');
        }
      };

      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        window.setTimeout(() => reject(new Error('Timed out opening the STT socket.')), 8000);
      });

      return socket;
    },
    [handleTranscriptEvent],
  );

  const startListening = useCallback(async () => {
    if (conn === 'connecting' || conn === 'live') return;
    setConn('connecting');
    setError('');

    try {
      // 1) Ephemeral, scoped Deepgram key minted by OUR backend — the renderer
      //    never learns the master API key.
      const tokenRes = await fetch(`${API_BASE}/api/stt-token`);
      if (!tokenRes.ok) throw new Error('Could not fetch the STT token from the backend.');
      const token = (await tokenRes.json()) as {
        key?: string;
        ephemeral?: boolean;
        error?: string;
      };
      if (!token.key) throw new Error(token.error ?? 'Backend returned no STT key.');

      // 2) System loopback audio ONLY. Electron's main process auto-approves
      //    getDisplayMedia with { video: sources[0], audio: 'loopback' }, so no
      //    picker appears; we then immediately stop the video track, leaving the
      //    interviewer's voice (never the candidate microphone) on the wire.
      const display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });
      display.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = display.getAudioTracks();
      if (audioTracks.length === 0) {
        throw new Error(
          'No loopback audio track found. On Windows enable “Stereo Mix”; on macOS install BlackHole 2ch.',
        );
      }
      const audioStream = new MediaStream(audioTracks);
      streamRef.current = audioStream;

      // 3) Deepgram live socket: direct wss:// when we got an ephemeral key,
      //    otherwise the localhost relay that uses the server-side key.
      const socket = await openSTTSocket(token.key, token.ephemeral === false);
      socketRef.current = socket;

      // 4) 250 ms WebM/Opus chunks streamed as binary frames to Deepgram.
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const recorder = new MediaRecorder(audioStream, { mimeType });
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && socket.readyState === WebSocket.OPEN) {
          socket.send(e.data);
        }
      };
      recorder.start(250);
      recorderRef.current = recorder;

      setConn('live');
    } catch (err) {
      console.error('[startListening]', err);
      setError((err as Error).message || 'Failed to start listening.');
      setConn('error');
      cleanupCapture();
    }
  }, [conn, openSTTSocket]);

  const stopListening = useCallback(() => {
    cleanupCapture();
    setConn('idle');
  }, []);

  // Always tear the audio capture + socket down when the overlay unmounts.
  useEffect(() => cleanupCapture, []);

  /* ======================================================= IPC hotkeys == */

  useEffect(() => {
    const api = window.copilotAPI;
    if (!api) return;

    // ⌘/Ctrl+Shift+S -> base64 PNG arrives from main; solve what's on screen.
    const offShot = api.onScreenshotCaptured((dataUrl) => {
      void askAI('', dataUrl);
    });

    // ⌘/Ctrl+Shift+H -> mirror visibility/click-through state into the UI.
    const offMode = api.onOverlayModeChanged(({ visible }) => {
      setGhostMode(!visible);
    });

    return () => {
      offShot();
      offMode();
    };
  }, [askAI]);

  /* Click-through ("ghost") mode also reachable from the header button. */
  const toggleGhost = useCallback(() => {
    setGhostMode((prev) => {
      const next = !prev;
      window.copilotAPI?.setIgnoreMouse(next);
      return next;
    });
  }, []);

  const captureNow = useCallback(() => {
    const api = window.copilotAPI;
    if (api) {
      void api.captureScreen();
    } else {
      setError('Screenshot capture requires the Electron app (npm run dev).');
    }
  }, []);

  const resetSession = useCallback(() => {
    abortRef.current?.abort();
    historyRef.current = [];
    answerBufferRef.current = '';
    setAnswer('');
    setLines([]);
    setInterim('');
    setError('');
    setLastShot(null);
    setManualQuestion('');
    stopListening();
  }, [stopListening]);

  const submitManual = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = manualQuestion.trim();
      if (!q) return;
      setManualQuestion('');
      setLines((prev) => [...prev, { id: ++lineIdRef.current, text: `(typed) ${q}`, final: true }]);
      void askAI(q, lastShot ?? undefined);
    },
    [manualQuestion, askAI, lastShot],
  );

  /* Syntax-highlight fenced code blocks + inject Copy buttons after render. */
  useEffect(() => {
    const root = answerBoxRef.current;
    if (!root) return;

    root.querySelectorAll<HTMLElement>('pre code').forEach((block) => {
      if (block.dataset.hl !== '1') {
        hljs.highlightElement(block);
        block.dataset.hl = '1';
      }
    });

    root.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
      if (pre.querySelector('.copy-btn')) return;
      const btn = document.createElement('button');
      btn.className = 'copy-btn';
      btn.textContent = 'Copy';
      btn.addEventListener('click', () => {
        const code = pre.querySelector('code')?.innerText ?? '';
        void navigator.clipboard.writeText(code);
        btn.textContent = 'Copied!';
        window.setTimeout(() => {
          btn.textContent = 'Copy';
        }, 1200);
      });
      pre.appendChild(btn);
    });
  }, [answer]);

  /* ------------------------------------------------------------ derived -- */
  const isLive = conn === 'live';
  const statusText = useMemo(() => {
    switch (conn) {
      case 'connecting':
        return 'Connecting…';
      case 'live':
        return 'Listening to meeting audio';
      case 'error':
        return 'Capture failed';
      default:
        return 'Idle';
    }
  }, [conn]);

  /* --------------------------------------------------------------- view -- */
  return (
    <div className={`app-shell${ghostMode ? ' ghosted' : ''}`}>
      {/* ===== Title bar: draggable chrome, non-draggable controls ===== */}
      <header className="titlebar">
        <div className="brand">
          <span className={`dot ${isLive ? 'live' : 'idle'}`} />
          Interview Copilot
          <span className="hotkey-hints no-drag">⌘⇧S shot · ⌘⇧H hide</span>
        </div>
        <div className="row no-drag">
          <button
            className={`btn icon ${ghostMode ? 'toggled-on' : ''}`}
            onClick={toggleGhost}
            title="Click-through ghost mode (⌘/Ctrl+Shift+H)"
          >
            👁
          </button>
          <button className="btn icon" onClick={captureNow} title="Capture screen (⌘/Ctrl+Shift+S)">
            📸
          </button>
          <button className="btn danger" onClick={resetSession} title="Clear / Reset session">
            Clear
          </button>
          <button
            className={`btn ${isLive ? 'stop' : 'primary'}`}
            onClick={isLive ? stopListening : startListening}
          >
            {isLive ? 'Stop' : conn === 'connecting' ? 'Starting…' : 'Start Copilot'}
          </button>
        </div>
      </header>

      {/* ===== Collapsible Resume / Job Description context ===== */}
      <section className="context-panel no-drag">
        <div className="context-header" onClick={() => setContextOpen((o) => !o)}>
          <span className={`chevron ${contextOpen ? 'open' : ''}`}>▶</span>
          Interview Context
          {(resumeContext || jobDescription) && <span className="context-badge">attached</span>}
          <span className="spacer" />
          <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>stored locally</span>
        </div>
        {contextOpen && (
          <div className="context-body">
            <textarea
              placeholder="Paste your resume (bullet points are fine)…"
              value={resumeContext}
              onChange={(e) => setResumeContext(e.target.value)}
              spellCheck={false}
            />
            <textarea
              placeholder="Paste the job description you're interviewing for…"
              value={jobDescription}
              onChange={(e) => setJobDescription(e.target.value)}
              spellCheck={false}
            />
          </div>
        )}
      </section>

      {/* ===== Live interviewer transcript ===== */}
      <section className="no-drag" style={{ flexShrink: 0 }}>
        <div className="pane-label">Interviewer · live transcript</div>
        <div className="transcript" ref={transcriptBoxRef}>
          {lines.length === 0 && !interim && (
            <span className="placeholder">
              {isLive
                ? 'Waiting for speech… answers trigger automatically at the end of each sentence.'
                : 'Press “Start Copilot” to transcribe the meeting audio.'}
            </span>
          )}
          {lines.map((l) => (
            <div key={l.id} className="final">
              {l.text}
            </div>
          ))}
          {interim && (
            <div className="interim">
              {interim}
              <span className="cursor" />
            </div>
          )}
        </div>
      </section>

      {/* ===== Streaming AI answer (Markdown + highlighted code) ===== */}
      <section
        className="no-drag"
        style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}
      >
        <div className="pane-label">
          Suggested answer {streaming && '· streaming…'}
          {lastShot && !streaming && ' · screenshot attached'}
        </div>
        <div className="answer" ref={answerBoxRef}>
          {answer ? (
            <Marked>{answer}</Marked>
          ) : (
            <div className="empty">
              Answers stream here: 3 instant talking points, then a STAR-method spoken response.
              Press <strong>⌘/Ctrl+Shift+S</strong> during an OA to solve the on-screen coding
              problem with optimal code and complexity analysis.
            </div>
          )}
        </div>
      </section>

      {/* ===== Manual ask bar ===== */}
      <form className="ask-bar no-drag" onSubmit={submitManual}>
        <input
          value={manualQuestion}
          onChange={(e) => setManualQuestion(e.target.value)}
          placeholder="Or type a question and press Enter…"
        />
        <button className="btn primary" type="submit" disabled={!manualQuestion.trim() || streaming}>
          Ask
        </button>
      </form>

      {/* ===== Status bar ===== */}
      <footer className="statusbar no-drag">
        <span>{statusText}</span>
        <span className="spacer" />
        {error ? <span className="err">{error}</span> : <span>backend {API_BASE}</span>}
      </footer>
    </div>
  );
}
