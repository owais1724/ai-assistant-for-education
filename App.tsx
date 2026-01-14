
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, BookOpen, Info, ShieldCheck, 
  MessageSquare, Upload, Settings, 
  Layout, Cpu, Database, Zap, XCircle, Loader2
} from 'lucide-react';
import { AppState, PDFMetadata } from './types.ts';
import { SYSTEM_PROMPT } from './constants.ts';
import { getAIClient, encodeBase64, decodeBase64, decodeAudioData } from './services/geminiService.ts';
import { extractTextFromPDF } from './services/pdfService.ts';
import Visualizer from './components/Visualizer.tsx';
import { Modality, LiveServerMessage } from '@google/genai';

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [pdf, setPdf] = useState<PDFMetadata | null>(null);
  const [isReadingPdf, setIsReadingPdf] = useState(false);
  const [showArchitecture, setShowArchitecture] = useState(false);
  
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const stateRef = useRef<AppState>(AppState.IDLE);
  const isModelSpeakingRef = useRef<boolean>(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const stopPlaybackNow = useCallback(() => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    isModelSpeakingRef.current = false;
  }, []);

  const cleanupSession = useCallback(async () => {
    console.log("Murshid AI: Session Terminated");
    setState(AppState.IDLE);
    stopPlaybackNow();

    if (sessionRef.current) {
      try {
        const session = await sessionRef.current;
        if (session && typeof session.close === 'function') session.close();
      } catch (e) {}
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
  }, [stopPlaybackNow]);

  const handleIncomingAudio = async (base64: string) => {
    const ctx = audioContextOutRef.current;
    if (!ctx || stateRef.current === AppState.IDLE) return;

    if (stateRef.current !== AppState.SPEAKING) {
      setState(AppState.SPEAKING);
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
          setTimeout(() => {
            if (!isModelSpeakingRef.current && stateRef.current === AppState.SPEAKING) {
              setState(AppState.LISTENING);
            }
          }, 300);
        }
      };

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
      isModelSpeakingRef.current = true;
    } catch (e) {
      console.error("Murshid AI: Audio Decoding Failed", e);
    }
  };

  const setupMicStreaming = (stream: MediaStream, sessionPromise: Promise<any>) => {
    const ctx = audioContextInRef.current;
    if (!ctx) return;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (stateRef.current === AppState.IDLE || stateRef.current === AppState.SPEAKING) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        int16[i] = inputData[i] * 32768;
      }
      
      const base64 = encodeBase64(new Uint8Array(int16.buffer));
      sessionPromise.then(session => {
        if (session && stateRef.current !== AppState.SPEAKING) {
          session.sendRealtimeInput({
            media: { data: base64, mimeType: 'audio/pcm;rate=16000' }
          });
        }
      }).catch(() => {});
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  };

  const startLiveConversation = async () => {
    if (stateRef.current !== AppState.IDLE) return;

    try {
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
            ? `${SYSTEM_PROMPT}\n\n[TEXTBOOK CONTEXT (PRIORITY SOURCE)]:\n${pdf.content}` 
            : SYSTEM_PROMPT,
        },
        callbacks: {
          onopen: () => {
            console.log("Murshid AI: Session Active");
            setState(AppState.LISTENING);
            setupMicStreaming(stream, sessionPromise);
          },
          onmessage: async (message: LiveServerMessage) => {
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) {
              handleIncomingAudio(audioData);
            }

            if (message.serverContent?.interrupted) {
              stopPlaybackNow();
              setState(AppState.LISTENING);
            }

            if (message.serverContent?.turnComplete) {
              if (!isModelSpeakingRef.current) {
                setState(AppState.LISTENING);
              }
            }
          },
          onerror: (e) => {
            console.error("Murshid AI: Connection Failure", e);
            cleanupSession();
          },
          onclose: () => {
            cleanupSession();
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err) {
      console.error("Murshid AI: Boot Error", err);
      cleanupSession();
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setIsReadingPdf(true);
      try {
        const content = await extractTextFromPDF(file);
        setPdf({ name: file.name, content });
      } catch (err) {
        alert("Failed to read PDF content.");
      } finally {
        setIsReadingPdf(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-4xl flex justify-between items-center mb-12">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-blue-600 rounded-2xl text-white shadow-lg shadow-blue-200">
            <BookOpen size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-black text-gray-900 tracking-tighter">Murshid AI</h1>
            <div className="flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              <p className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Digital Learning Assistant</p>
            </div>
          </div>
        </div>
        <button 
          onClick={() => setShowArchitecture(!showArchitecture)}
          className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
        >
          <Settings size={20} />
        </button>
      </header>

      <main className="w-full max-w-xl flex-1 flex flex-col items-center justify-center space-y-12 pb-20">
        <div className="relative group">
          <div className={`absolute inset-0 rounded-full blur-3xl transition-opacity duration-1000 ${
            state === AppState.LISTENING ? 'bg-blue-400/20 opacity-100' :
            state === AppState.SPEAKING ? 'bg-indigo-400/20 opacity-100' : 'bg-gray-100/0 opacity-0'
          }`} />
          
          <div className={`w-48 h-48 rounded-full border-4 flex items-center justify-center relative transition-all duration-500 ${
            state === AppState.LISTENING ? 'border-blue-500 bg-blue-50 scale-110 shadow-2xl shadow-blue-100' :
            state === AppState.SPEAKING ? 'border-indigo-500 bg-indigo-50 scale-105 shadow-2xl shadow-indigo-100' :
            state === AppState.PROCESSING ? 'border-amber-400 bg-amber-50 animate-pulse' : 'border-gray-100 bg-white'
          }`}>
            {state === AppState.LISTENING && (
              <div className="absolute inset-0 rounded-full border-2 border-blue-400 animate-ping opacity-25" />
            )}
            
            {state === AppState.SPEAKING ? (
              <VolumeIcon className="text-indigo-600" size={64} />
            ) : state === AppState.LISTENING ? (
              <Mic className="text-blue-600" size={64} />
            ) : state === AppState.PROCESSING ? (
              <Zap className="text-amber-500" size={64} />
            ) : (
              <MessageSquare className="text-gray-200" size={64} />
            )}
          </div>
        </div>

        <div className="text-center space-y-4">
          <h2 className="text-3xl font-black text-gray-900 tracking-tight uppercase">
            {state === AppState.IDLE ? "Start Session" : 
             state === AppState.LISTENING ? "I'm Listening" : 
             state === AppState.SPEAKING ? "Murshid AI" : "Processing..."}
          </h2>
          <p className="text-gray-500 font-medium max-w-xs mx-auto">
            {state === AppState.IDLE ? "Connect to start your personalized academic guidance session." : 
             state === AppState.LISTENING ? "Ask questions from your textbook or about Murshid platform." : 
             "Synthesizing knowledge for a real-time response."}
          </p>
        </div>

        <Visualizer state={state} />

        <div className="w-full flex flex-col gap-4">
          {state === AppState.IDLE ? (
            <button
              onClick={startLiveConversation}
              className="w-full py-6 rounded-3xl bg-gray-900 text-white font-black text-xl hover:bg-black transition-all transform active:scale-[0.98] shadow-2xl shadow-gray-200 flex items-center justify-center gap-3"
            >
              <Zap size={24} className="fill-current text-amber-400" />
              ACTIVATE VOICE
            </button>
          ) : (
            <button
              onClick={cleanupSession}
              className="w-full py-6 rounded-3xl bg-red-50 text-red-600 border-2 border-red-100 font-black text-xl hover:bg-red-600 hover:text-white transition-all transform active:scale-[0.98] flex items-center justify-center gap-3"
            >
              <XCircle size={24} />
              END SESSION
            </button>
          )}

          {!pdf && state === AppState.IDLE && (
            <label className={`w-full py-4 border-2 border-dashed rounded-3xl flex items-center justify-center gap-2 cursor-pointer transition-all ${isReadingPdf ? 'bg-gray-50 border-gray-300' : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50'}`}>
              {isReadingPdf ? (
                <>
                  <Loader2 size={18} className="text-blue-600 animate-spin" />
                  <span className="text-sm font-bold text-blue-600">Reading Textbook...</span>
                </>
              ) : (
                <>
                  <Upload size={18} className="text-gray-400" />
                  <span className="text-sm font-bold text-gray-500">Upload Textbook (PDF)</span>
                </>
              )}
              <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} disabled={isReadingPdf} />
            </label>
          )}

          {pdf && (
            <div className="p-4 bg-green-50 border border-green-200 rounded-2xl flex items-center justify-between animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-center gap-3">
                <ShieldCheck className="text-green-600" size={20} />
                <span className="text-xs font-black text-green-900 uppercase truncate max-w-[200px]">{pdf.name}</span>
              </div>
              <button 
                onClick={() => setPdf(null)} 
                className="text-green-800 hover:text-red-600 transition-colors"
                disabled={state !== AppState.IDLE}
              >
                <XCircle size={18} />
              </button>
            </div>
          )}
        </div>
      </main>

      <footer className="mt-auto py-8 text-center">
        <p className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">
          Engineered for Class 1-10 Excellence
        </p>
      </footer>
    </div>
  );
};

const VolumeIcon = ({ className, size }: { className?: string, size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`${className} animate-pulse`}>
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
  </svg>
);

export default App;
