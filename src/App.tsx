import React, { useEffect, useRef, useState } from 'react';

declare global {
  interface Window {
    copilotAPI: {
      onScreenshotCaptured: (cb: (img: string) => void) => void;
      setIgnoreMouse: (ignore: boolean) => void;
    };
  }
}

export default function App() {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [resumeContext, setResumeContext] = useState('');
  const socketRef = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);

  // Listen for global screenshot hotkey (Ctrl/Cmd + Shift + S)
  useEffect(() => {
    window.copilotAPI?.onScreenshotCaptured((imageDataUrl) => {
      generateAnswer('', imageDataUrl);
    });
  }, [resumeContext]);

  const startSystemAudioCapture = async () => {
    // 1. Fetch ephemeral Deepgram key from backend
    const tokenRes = await fetch('http://localhost:3001/api/stt-token');
    const { key } = await tokenRes.json();

    // 2. Capture system loopback audio (handled automatically by Electron main.ts)
    const displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // Required by spec, we immediately stop the video track
      audio: true,
    });
    displayStream.getVideoTracks().forEach((track) => track.stop());

    const audioStream = new MediaStream(displayStream.getAudioTracks());

    // 3. Connect to Deepgram Live WebSocket
    const dgSocket = new WebSocket(
      'wss://api.deepgram.com/v1/listen?model=nova-2&punctuate=true&interim_results=true&endpointing=400',
      ['token', key]
    );
    socketRef.current = dgSocket;

    dgSocket.onopen = () => {
      setIsListening(true);
      const recorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(e.data);
        }
      };
      recorder.start(250); // Send 250ms chunks for low latency
    };

    dgSocket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      const text = data.channel?.alternatives?.[0]?.transcript;
      if (!text) return;

      setTranscript(text);

      // When interviewer pauses/finishes speaking, trigger AI answer
      if (data.is_final && data.speech_final && text.trim().length > 8) {
        generateAnswer(text);
      }
    };
  };

  const stopCapture = () => {
    mediaRecorderRef.current?.stop();
    socketRef.current?.close();
    setIsListening(false);
  };

  const generateAnswer = async (question: string, screenshotBase64?: string) => {
    setAiResponse('');

    const response = await fetch('http://localhost:3001/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        question,
        resumeContext,
        screenshotBase64,
      }),
    });

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) return;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ') && line !== 'data: [DONE]') {
          const parsed = JSON.parse(line.replace('data: ', ''));
          if (parsed.text) {
            setAiResponse((prev) => prev + parsed.text);
          }
        }
      }
    }
  };

  return (
    <div
      style={{
        background: 'rgba(18, 18, 22, 0.85)',
        color: '#f4f4f5',
        height: '100vh',
        padding: '14px',
        borderRadius: '12px',
        fontFamily: 'system-ui, sans-serif',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        WebkitAppRegion: 'drag', // Allows dragging the frameless window
      } as React.CSSProperties}
    >
      {/* Header Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <strong>Interview Copilot</strong>
        <button
          onClick={isListening ? stopCapture : startSystemAudioCapture}
          style={{
            background: isListening ? '#ef4444' : '#22c55e',
            color: '#fff',
            border: 'none',
            padding: '6px 12px',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          {isListening ? 'Stop Listening' : 'Start Copilot'}
        </button>
      </div>

      {/* Resume / Context Input */}
      <textarea
        placeholder="Paste key resume highlights & job description here..."
        value={resumeContext}
        onChange={(e) => setResumeContext(e.target.value)}
        rows={3}
        style={{
          background: 'rgba(255,255,255,0.08)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.15)',
          borderRadius: '6px',
          padding: '8px',
          fontSize: '12px',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      />

      {/* Live Interviewer Transcript */}
      <div style={{ fontSize: '12px', color: '#a1a1aa', minHeight: '36px' }}>
        <strong>Interviewer:</strong> {transcript || 'Waiting for audio...'}
      </div>

      {/* Streaming AI Answer */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          background: 'rgba(255,255,255,0.05)',
          padding: '10px',
          borderRadius: '8px',
          fontSize: '13px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          WebkitAppRegion: 'no-drag',
        } as React.CSSProperties}
      >
        {aiResponse || 'Answers and Ctrl+Shift+S screenshot solutions will stream here...'}
      </div>
    </div>
  );
}
