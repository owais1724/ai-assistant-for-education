
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, BookOpen, Info, ShieldCheck, 
  MessageSquare, Upload, Settings, 
  Layout, Cpu, Database, Zap, XCircle
} from 'lucide-react';
import { AppState, ChatMessage, PDFMetadata } from './types';
import { SYSTEM_PROMPT } from './constants';
import { getAIClient, encodeBase64, decodeBase64, decodeAudioData } from './services/geminiService';
import { extractTextFromPDF } from './services/pdfService';
import Visualizer from './components/Visualizer';
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
  
  // Timers to clear on cleanup
  const countdownIntervalRef = useRef<number | null>(null);
  const processingTimeoutRef = useRef<number | null>(null);
  const turnCompleteTimeoutRef = useRef<number | null>(null);

  // Sync state to ref for reliable access in async callbacks
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
    console.log("Cleaning up session...");
    
    // 1. Immediately reset state and UI
    setState(AppState.IDLE);
    setCountdown(null);
    clearAllTimers();

    // 2. Stop all model audio playback
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch(e) {}
    });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    isModelSpeakingRef.current = false;

    // 3. Close and nullify Live Session
    if (sessionRef.current) {
      try {
        const session = await sessionRef.current;
        if (session && typeof session.close === 'function') {
          session.close();
        }
      } catch (e) {
        console.warn("Error closing session:", e);
      }
      sessionRef.current = null;
    }

    // 4. Stop Microphone and Processor
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    // 5. Shutdown Audio Contexts
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
    const listenSeconds = 7; // Extended to 7 seconds to prevent cutting mid-speech
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
      // Transition to processing but DO NOT stop the mic stream yet
      if (stateRef.current === AppState.LISTENING) {
        setState(AppState.PROCESSING);
        setCountdown(null);
      }
    }, listenSeconds * 1000);
  }, [clearAllTimers]);

  const startLiveConversation = async () => {
    if (stateRef.current !== AppState.IDLE) return;

    try {
      console.log("Initializing Murshid AI Session...");
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
            console.log("Pipeline Ready");
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
              console.log("AI Turn Ended");
              // Wait for audio buffers to finish playing before restarting listening
              if (turnCompleteTimeoutRef.current) clearTimeout(turnCompleteTimeoutRef.current);
              turnCompleteTimeoutRef.current = window.setTimeout(() => {
                if (!isModelSpeakingRef.current && stateRef.current === AppState.PROCESSING) {
                  startListeningWindow();
                }
              }, 800);
            }
          },
          onerror: (e) => {
            console.error("Session Protocol Error:", e);
            cleanupSession();
          },
          onclose: (e) => {
            console.log("Connection Terminated", e);
            cleanupSession();
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err) {
      console.error("Critical Failure:", err);
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
      // FIX: Keep the mic hot during LISTENING AND PROCESSING to prevent "cutting" mid-thought
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
      clearAllTimers(); // AI is now in control, stop listening logic
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
          // Loop back to listening when AI is done speaking
          if (stateRef.current === AppState.SPEAKING) {
            startListeningWindow();
          }
        }
      };

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
    } catch (e) {
      console.error("Stream Decoding Failure:", e);
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
      {/* Header */}
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
          {/* Main Interface */}
          <div className="lg:col-span-2 flex flex-col bg-white rounded-3xl border border-gray-100 shadow-2xl overflow-hidden min-h-[600px] relative">
            
            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50/50">
              <div className="flex items-center space-x-2">
                <div className={`w-3 h-3 rounded-full ${state !== AppState.IDLE ? 'bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]' : 'bg-gray-300'}`} />
                <span className="text-sm font-bold text-gray-700 capitalize tracking-tight">{state.replace(/_/g, ' ')}</span>
              </div>
              {countdown !== null && (
                <div className="flex items-center gap-2 text-xs font-black bg-blue-600 text-white px-4 py-1.5 rounded-full shadow-lg transition-all duration-300">
                  <Mic size={14} />
                  LISTENING: {countdown}s
                </div>
              )}
            </div>

            <div className="flex-1 p-8 flex flex-col items-center justify-center text-center space-y-8">
              <div className={`relative transition-all duration-500 transform ${state !== AppState.IDLE ? 'scale-110' : 'scale-100'}`}>
                <div className={`w-40 h-40 rounded-full flex items-center justify-center relative transition-colors duration-300 ${
                  state === AppState.LISTENING ? 'bg-red-50 ring-4 ring-red-100' : 
                  state === AppState.SPEAKING ? 'bg-blue-50 ring-4 ring-blue-100' : 
                  state === AppState.PROCESSING ? 'bg-amber-50 ring-4 ring-amber-100' : 'bg-gray-50'
                }`}>
                  {state === AppState.LISTENING && (
                    <div className="absolute inset-0 rounded-full border-4 border-red-500 animate-ping opacity-20" />
                  )}
                  {state === AppState.SPEAKING ? (
                    <Volume2Icon className="text-blue-600" size={56} />
                  ) : state === AppState.LISTENING ? (
                    <Mic className="text-red-600" size={56} />
                  ) : state === AppState.PROCESSING ? (
                    <Zap className="text-amber-500 animate-pulse" size={56} />
                  ) : (
                    <MessageSquare className="text-gray-300" size={56} />
                  )}
                </div>
              </div>

              <div className="max-w-xs space-y-3">
                <h3 className="text-2xl font-black text-gray-900 leading-tight">
                  {state === AppState.IDLE ? "Start Learning" : 
                   state === AppState.LISTENING ? "Tell me anything" : 
                   state === AppState.PROCESSING ? "AI is thinking..." : "Murshid Speaking..."}
                </h3>
                <p className="text-sm text-gray-500 font-medium leading-relaxed">
                  {state === AppState.IDLE 
                    ? "Connect for English-first academic support. Multilingual on request."
                    : state === AppState.LISTENING 
                      ? "Keep speaking. I'm listening to your complete question."
                      : state === AppState.PROCESSING 
                        ? "Streaming tokens and processing neural audio..."
                        : "High-speed interaction loop is active."}
                </p>
              </div>

              <Visualizer state={state} />
            </div>

            <div className="p-8 border-t border-gray-100 bg-white grid grid-cols-1 gap-4">
              {state === AppState.IDLE ? (
                <button
                  onClick={startLiveConversation}
                  className="group w-full py-5 rounded-2xl bg-blue-600 text-white flex items-center justify-center space-x-4 font-black text-lg transition-all transform hover:bg-blue-700 hover:shadow-xl active:scale-[0.98]"
                >
                  <Zap size={24} className="fill-current group-hover:scale-125 transition-transform" />
                  <span>START CONVERSATION</span>
                </button>
              ) : (
                <button
                  onClick={cleanupSession}
                  className="w-full py-5 rounded-2xl bg-red-50 text-red-600 border-2 border-red-100 flex items-center justify-center space-x-4 font-black text-lg transition-all transform hover:bg-red-600 hover:text-white hover:shadow-xl active:scale-[0.98]"
                >
                  <XCircle size={24} />
                  <span>END CONVERSATION</span>
                </button>
              )}
              <p className="text-[10px] text-center font-bold text-gray-400 uppercase tracking-widest">
                {state === AppState.IDLE ? "Ready for Academic Queries" : "Session Active • Anti-Cut Loop Engaged"}
              </p>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6 flex flex-col h-full">
            <div className="bg-white p-6 rounded-3xl border border-gray-100 shadow-xl">
              <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Upload size={14} className="text-blue-500" />
                Textbook Grounding
              </h3>
              <div className="space-y-4">
                {pdf ? (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-2xl flex items-center space-x-3">
                    <ShieldCheck className="text-green-600" size={20} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-black text-green-900 truncate">{pdf.name}</p>
                      <p className="text-[10px] text-green-700 font-bold uppercase">RAG Context Active</p>
                    </div>
                    <button onClick={() => setPdf(null)} className="p-1 hover:bg-green-200 rounded-full transition-colors">
                      <XCircle size={16} className="text-green-800" />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-3xl p-8 hover:border-blue-400 hover:bg-blue-50/50 cursor-pointer transition-all group">
                    <BookOpen className="text-gray-200 mb-3 group-hover:text-blue-200 transition-colors" size={40} />
                    <span className="text-xs font-black text-gray-600">UPLOAD TEXTBOOK</span>
                    <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} />
                  </label>
                )}
              </div>
            </div>

            <div className="bg-gray-900 p-6 rounded-3xl text-white shadow-xl flex-1">
              <h3 className="text-xs font-black text-blue-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Settings size={14} /> Stability Monitor
              </h3>
              <div className="space-y-4">
                <Metric label="Language Model" value="Gemini 2.5 Live" />
                <Metric label="Turn Loop" value="7s + Grace Period" />
                <Metric label="Inertia Mode" value="Active (Anti-Cut)" />
                <Metric label="Session State" value="Persistent" />
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
    <span className="text-gray-500 uppercase tracking-tighter">{label}</span>
    <span className="text-blue-100">{value}</span>
  </div>
);

const Volume2Icon = ({ className, size }: { className?: string, size?: number }) => (
  <svg 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="3" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    className={`${className} animate-pulse`}
  >
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

const ArchitectureView = () => (
  <div className="w-full max-w-4xl bg-white rounded-3xl border border-gray-100 shadow-2xl overflow-y-auto p-12 h-[700px]">
    <div className="max-w-2xl mx-auto space-y-16">
      <header className="text-center space-y-4">
        <h2 className="text-4xl font-black text-gray-900 tracking-tighter uppercase text-blue-600">Audio Processing 2.0</h2>
        <p className="text-gray-500 font-medium">Ultra-low latency student reception infrastructure</p>
      </header>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
        <ArchCard 
          icon={<Zap className="text-blue-500" />}
          title="Direct Byte Streaming"
          desc="Audio is ingested as raw Int16 PCM at 16kHz, converted to Base64, and streamed without intermediate text buffers."
        />
        <ArchCard 
          icon={<Cpu className="text-purple-500" />}
          title="Turn-Persistence Engine"
          desc="Ensures the conversational loop stays open. Gating logic prevents mic cutoff even when the UI transitions between states."
        />
        <ArchCard 
          icon={<Database className="text-orange-500" />}
          title="RAG Pinning"
          desc="Uploaded textbooks are injected into the model's system context, forcing strict adherence to curricula without hallucination."
        />
        <ArchCard 
          icon={<Layout className="text-green-500" />}
          title="Dynamic Synthesis"
          desc="Model audio is decoded and scheduled using precise Web Audio API timestamps for gapless multi-turn responses."
        />
      </div>
    </div>
  </div>
);

const ArchCard = ({ icon, title, desc }: { icon: React.ReactNode, title: string, desc: string }) => (
  <div className="space-y-4 p-8 rounded-[2rem] border-2 border-gray-50 bg-white shadow-sm">
    <div className="w-12 h-12 bg-gray-50 rounded-2xl flex items-center justify-center">
      {icon}
    </div>
    <h3 className="font-black text-gray-800 text-lg uppercase tracking-tight">{title}</h3>
    <p className="text-sm text-gray-500 leading-relaxed font-medium">{desc}</p>
  </div>
);

export default App;
