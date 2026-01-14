
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, BookOpen, Info, ShieldCheck, 
  MessageSquare, Upload, Settings, 
  Layout, Cpu, Database, Zap, XCircle
} from 'lucide-react';
import { AppState, ChatMessage, PDFMetadata } from './types.ts';
import { SYSTEM_PROMPT } from './constants.ts';
import { getAIClient, encodeBase64, decodeBase64, decodeAudioData } from './services/geminiService.ts';
import { extractTextFromPDF } from './services/pdfService.ts';
import Visualizer from './components/Visualizer.tsx';
import { Modality, LiveServerMessage } from '@google/genai';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [pdf, setPdf] = useState<PDFMetadata | null>(null);
  const [showArchitecture, setShowArchitecture] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const stateRef = useRef<AppState>(AppState.IDLE);
  const isModelSpeakingRef = useRef<boolean>(false);
  
  const countdownIntervalRef = useRef<number | null>(null);
  const processingTimeoutRef = useRef<number | null>(null);
  const turnCompleteTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const clearAllTimers = useCallback(() => {
    if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
    if (turnCompleteTimeoutRef.current) clearTimeout(turnCompleteTimeoutRef.current);
    countdownIntervalRef.current = null;
    processingTimeoutRef.current = null;
    turnCompleteTimeoutRef.current = null;
  }, []);

  const cleanupSession = useCallback(async () => {
    console.log("Murshid AI: Cleaning up session...");
    setState(AppState.IDLE);
    setCountdown(null);
    clearAllTimers();

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    isModelSpeakingRef.current = false;

    if (sessionRef.current) {
      try {
        const session = await sessionRef.current;
        if (session && typeof session.close === 'function') {
          session.close();
        }
      } catch (e) {
        console.warn("Murshid AI: Session close error", e);
      }
      sessionRef.current = null;
    }

    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    if (audioContextInRef.current) {
      await audioContextInRef.current.close().catch(() => {});
      audioContextInRef.current = null;
    }
    if (audioContextOutRef.current) {
      await audioContextOutRef.current.close().catch(() => {});
      audioContextOutRef.current = null;
    }
  }, [clearAllTimers]);

  const startListeningWindow = useCallback(() => {
    if (stateRef.current === AppState.IDLE) return;
    
    clearAllTimers();
    setState(AppState.LISTENING);
    const listenSeconds = 8; // Extended to give more time to think/speak
    setCountdown(listenSeconds);
    
    countdownIntervalRef.current = window.setInterval(() => {
      setCountdown(prev => {
        if (prev === null || prev <= 1) {
          if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    processingTimeoutRef.current = window.setTimeout(() => {
      if (stateRef.current === AppState.LISTENING) {
        setState(AppState.PROCESSING);
        setCountdown(null);
      }
    }, listenSeconds * 1000);
  }, [clearAllTimers]);

  const startLiveConversation = async () => {
    if (stateRef.current !== AppState.IDLE) return;

    try {
      console.log("Murshid AI: Starting session...");
      setState(AppState.PROCESSING);
      
      const ai = getAIClient();
      const audioContextIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = audioContextIn;
      audioContextOutRef.current = audioContextOut;

      await audioContextIn.resume();
      await audioContextOut.resume();

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: pdf 
            ? `${SYSTEM_PROMPT}\n\n[TEXTBOOK CONTEXT]:\n${pdf.content}` 
            : SYSTEM_PROMPT,
        },
        callbacks: {
          onopen: () => {
            console.log("Murshid AI: Connection Open");
            setupMicStreaming(stream, sessionPromise);
            startListeningWindow();
          },
          onmessage: async (message: LiveServerMessage) => {
            if (stateRef.current === AppState.IDLE) return;

            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              isModelSpeakingRef.current = true;
              handleIncomingAudio(audioData);
            }

            if (message.serverContent?.interrupted) {
              stopPlaybackNow();
            }

            if (message.serverContent?.turnComplete) {
              // Only reset listening if we're not currently in the middle of speaking/playing
              if (turnCompleteTimeoutRef.current) clearTimeout(turnCompleteTimeoutRef.current);
              turnCompleteTimeoutRef.current = window.setTimeout(() => {
                if (!isModelSpeakingRef.current && (stateRef.current === AppState.PROCESSING || stateRef.current === AppState.SPEAKING)) {
                  startListeningWindow();
                }
              }, 1000);
            }
          },
          onerror: (e) => {
            console.error("Murshid AI: Session Error", e);
            cleanupSession();
          },
          onclose: (e) => {
            console.log("Murshid AI: Connection Closed");
            cleanupSession();
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err) {
      console.error("Murshid AI: Setup Failed", err);
      cleanupSession();
    }
  };

  const stopPlaybackNow = () => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    isModelSpeakingRef.current = false;
  };

  const setupMicStreaming = (stream: MediaStream, sessionPromise: Promise<any>) => {
    const ctx = audioContextInRef.current;
    if (!ctx) return;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      // Allow mic input during LISTENING and PROCESSING to prevent early cuts
      if (stateRef.current !== AppState.LISTENING && stateRef.current !== AppState.PROCESSING) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        int16[i] = inputData[i] * 32768;
      }
      
      const base64 = encodeBase64(new Uint8Array(int16.buffer));
      sessionPromise.then(session => {
        if (session && (stateRef.current === AppState.LISTENING || stateRef.current === AppState.PROCESSING)) {
          session.sendRealtimeInput({
            media: { data: base64, mimeType: 'audio/pcm;rate=16000' }
          });
        }
      }).catch(() => {});
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  };

  const handleIncomingAudio = async (base64: string) => {
    const ctx = audioContextOutRef.current;
    if (!ctx || stateRef.current === AppState.IDLE) return;

    if (stateRef.current !== AppState.SPEAKING) {
      setState(AppState.SPEAKING);
      clearAllTimers();
      setCountdown(null);
    }

    try {
      const buffer = await decodeAudioData(decodeBase64(base64), ctx, 24000, 1);
      nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      
      source.onended = () => {
        sourcesRef.current.delete(source);
        if (sourcesRef.current.size === 0) {
          isModelSpeakingRef.current = false;
          // Return to listening after response is finished
          if (stateRef.current === AppState.SPEAKING) {
            startListeningWindow();
          }
        }
      };

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
    } catch (e) {
      console.error("Murshid AI: Audio Decode Error", e);
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      const content = await extractTextFromPDF(file);
      setPdf({ name: file.name, content });
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-4xl flex justify-between items-center mb-8">
        <div className="flex items-center space-x-3">
          <div className="p-2 bg-blue-600 rounded-lg text-white">
            <BookOpen size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 tracking-tight">Murshid AI</h1>
            <p className="text-sm text-gray-500 font-medium flex items-center gap-1">
              Receptionist <span className="text-blue-600 px-1.5 py-0.5 bg-blue-50 rounded text-[10px] font-bold uppercase tracking-wider">Fast-Link</span>
            </p>
          </div>
        </div>
        <button 
          onClick={() => setShowArchitecture(!showArchitecture)}
          className="flex items-center space-x-2 text-sm text-gray-600 bg-white px-4 py-2 rounded-full border border-gray-200 hover:border-blue-500 hover:text-blue-600 transition-all shadow-sm"
        >
          <Info size={16} />
          <span>{showArchitecture ? 'Back to App' : 'Tech Stack'}</span>
        </button>
      </header>

      {showArchitecture ? (
        <ArchitectureView />
      ) : (
        <div className="w-full max-w-4xl grid grid-cols-1 lg:grid-cols-3 gap-8 h-full">
          <div className="lg:col-span-2 flex flex-col bg-white rounded-3xl border border-gray-100 shadow-2xl overflow-hidden min-h-[600px] relative">
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${state !== AppState.IDLE ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
                <span className="text-sm font-bold text-gray-700 capitalize tracking-tight">{state.toLowerCase()}</span>
              </div>
              {countdown !== null && (
                <div className="flex items-center gap-2 text-xs font-black bg-blue-600 text-white px-4 py-1.5 rounded-full shadow-lg">
                  <Mic size={14} />
                  LISTENING: {countdown}s
                </div>
              )}
            </div>

            <div className="flex-1 p-8 flex flex-col items-center justify-center text-center space-y-8">
              <div className={`relative transition-all duration-500 transform ${state !== AppState.IDLE ? 'scale-110' : 'scale-100'}`}>
                <div className={`w-40 h-40 rounded-full flex items-center justify-center relative transition-colors duration-300 ${
                  state === AppState.LISTENING ? 'bg-red-50' : 
                  state === AppState.SPEAKING ? 'bg-blue-50' : 'bg-gray-50'
                }`}>
                  {state === AppState.LISTENING && (
                    <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-ping opacity-20" />
                  )}
                  {state === AppState.SPEAKING ? (
                    <Volume2Icon className="text-blue-600" size={56} />
                  ) : state === AppState.LISTENING ? (
                    <Mic className="text-red-600" size={56} />
                  ) : (
                    <MessageSquare className="text-gray-300" size={56} />
                  )}
                </div>
              </div>

              <div className="max-w-xs space-y-3">
                <h3 className="text-2xl font-black text-gray-900 leading-tight uppercase tracking-tighter">
                  {state === AppState.IDLE ? "Start Session" : 
                   state === AppState.LISTENING ? "Listening..." : 
                   state === AppState.PROCESSING ? "Analyzing..." : "Speaking..."}
                </h3>
                <p className="text-sm text-gray-500 font-medium leading-relaxed">
                  {state === AppState.IDLE 
                    ? "Tap the button below to start your academic session with Murshid AI."
                    : state === AppState.LISTENING 
                      ? "I am listening for your question. Speak naturally."
                      : "Processing and generating real-time response."}
                </p>
              </div>

              <Visualizer state={state} />
            </div>

            <div className="p-8 border-t border-gray-100 bg-white">
              {state === AppState.IDLE ? (
                <button
                  onClick={startLiveConversation}
                  className="w-full py-5 rounded-2xl bg-blue-600 text-white flex items-center justify-center space-x-4 font-black text-lg transition-all hover:bg-blue-700 shadow-xl active:scale-[0.98]"
                >
                  <Zap size={24} />
                  <span>START CONVERSATION</span>
                </button>
              ) : (
                <button
                  onClick={cleanupSession}
                  className="w-full py-5 rounded-2xl bg-red-50 text-red-600 border border-red-100 flex items-center justify-center space-x-4 font-black text-lg transition-all hover:bg-red-100 active:scale-[0.98]"
                >
                  <XCircle size={24} />
                  <span>END SESSION</span>
                </button>
              )}
            </div>
          </div>

          <div className="space-y-6 flex flex-col">
            <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-xl">
              <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Upload size={14} className="text-blue-500" />
                Textbook (PDF)
              </h3>
              {pdf ? (
                <div className="p-4 bg-green-50 border border-green-200 rounded-2xl flex items-center space-x-3">
                  <ShieldCheck className="text-green-600" size={20} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-black text-green-900 truncate">{pdf.name}</p>
                    <p className="text-[10px] text-green-700 font-bold uppercase">RAG Mode Active</p>
                  </div>
                  <button onClick={() => setPdf(null)} className="p-1 hover:bg-green-200 rounded-full">
                    <XCircle size={16} className="text-green-800" />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-3xl p-8 hover:border-blue-400 hover:bg-blue-50 cursor-pointer transition-all">
                  <BookOpen className="text-gray-200 mb-3" size={40} />
                  <span className="text-xs font-black text-gray-600">UPLOAD TEXTBOOK</span>
                  <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} />
                </label>
              )}
            </div>

            <div className="bg-gray-900 p-6 rounded-3xl text-white shadow-xl flex-1">
              <h3 className="text-xs font-black text-blue-400 uppercase tracking-widest mb-4">Pipeline Status</h3>
              <div className="space-y-4">
                <Metric label="Model" value="Gemini 2.5 Live" />
                <Metric label="Latency" value="Ultra Low" />
                <Metric label="Audio" value="PCM @ 24kHz" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const Metric = ({ label, value }: { label: string, value: string }) => (
  <div className="flex justify-between items-center text-[10px] font-bold">
    <span className="text-gray-500 uppercase">{label}</span>
    <span className="text-blue-100">{value}</span>
  </div>
);

const Volume2Icon = ({ className, size }: { className?: string, size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

const ArchitectureView = () => (
  <div className="w-full max-w-4xl bg-white rounded-3xl border border-gray-100 shadow-2xl p-12 overflow-y-auto max-h-[700px]">
    <h2 className="text-4xl font-black text-gray-900 uppercase tracking-tighter mb-12">System Architecture</h2>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
      <ArchCard title="Real-time Audio" desc="Raw PCM streaming directly to Gemini's neural layers without STT overhead." />
      <ArchCard title="RAG Integration" desc="PDF context injection into the system prompt for high-fidelity grounding." />
      <ArchCard title="Native Multilingual" desc="Seamless English/Hindi toggling driven by natural language intent." />
      <ArchCard title="Scheduled Playback" desc="Gapless audio synthesis using high-precision Web Audio API buffers." />
    </div>
  </div>
);

const ArchCard = ({ title, desc }: { title: string, desc: string }) => (
  <div className="p-8 bg-gray-50 rounded-3xl border border-gray-100">
    <h3 className="text-lg font-black text-gray-900 uppercase tracking-tight mb-2">{title}</h3>
    <p className="text-sm text-gray-500 leading-relaxed">{desc}</p>
  </div>
);

export default App;
