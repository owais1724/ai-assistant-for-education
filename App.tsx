
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { 
  Mic, BookOpen, ShieldCheck, 
  MessageSquare, Upload, Settings, 
  Zap, XCircle, Loader2, AlertCircle, Headphones, Activity
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
  const isClosingRef = useRef<boolean>(false);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const stopPlaybackNow = useCallback(() => {
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    isModelSpeakingRef.current = false;
  }, []);

  const cleanupSession = useCallback(async (isError = false) => {
    if (isClosingRef.current && !isError) return;
    isClosingRef.current = true;

    console.log("Murshid AI: Ending session...");
    setState(AppState.IDLE);
    stopPlaybackNow();

    if (sessionRef.current) {
      try {
        const session = await sessionRef.current;
        if (session) session.close();
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
    
    isClosingRef.current = false;
  }, [stopPlaybackNow]);

  const handleIncomingAudio = async (base64: string) => {
    const ctx = audioContextOutRef.current;
    if (!ctx || stateRef.current === AppState.IDLE) return;

    if (ctx.state === 'suspended') await ctx.resume();

    if (stateRef.current !== AppState.SPEAKING) {
      setState(AppState.SPEAKING);
    }

    try {
      const buffer = await decodeAudioData(decodeBase64(base64), ctx, 24000, 1);
      
      if (nextStartTimeRef.current < ctx.currentTime) {
        nextStartTimeRef.current = ctx.currentTime + 0.08;
      }
      
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
          }, 400);
        }
      };

      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
      isModelSpeakingRef.current = true;
    } catch (e) {
      console.error("Murshid AI: Playback sequence interrupted", e);
    }
  };

  const setupMicStreaming = (stream: MediaStream, sessionPromise: Promise<any>) => {
    const ctx = audioContextInRef.current;
    if (!ctx) return;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    scriptProcessorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (stateRef.current !== AppState.LISTENING) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        int16[i] = inputData[i] * 32768;
      }
      
      const base64 = encodeBase64(new Uint8Array(int16.buffer));
      sessionPromise.then(session => {
        if (session && stateRef.current === AppState.LISTENING) {
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
      const ai = getAIClient();
      if (!(ai as any).apiKey && !(globalThis as any).process?.env?.API_KEY) {
        alert("Murshid AI: Please configure your API_KEY to start the session.");
        return;
      }

      setState(AppState.PROCESSING);
      
      const audioContextIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioContextOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = audioContextIn;
      audioContextOutRef.current = audioContextOut;

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
            ? `${SYSTEM_PROMPT}\n\n[TEXTBOOK CONTEXT (PRIORITY SOURCE)]:\n${pdf.content}\n\n[IMPORTANT]: Use this content for all academic questions.` 
            : SYSTEM_PROMPT,
        },
        callbacks: {
          onopen: () => {
            console.log("Murshid AI: Neural Link Established");
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
              if (audioContextInRef.current?.state === 'suspended') audioContextInRef.current.resume();
              if (audioContextOutRef.current?.state === 'suspended') audioContextOutRef.current.resume();

              if (!isModelSpeakingRef.current) {
                setState(AppState.LISTENING);
              }
            }
          },
          onerror: (e) => {
            console.error("Murshid AI: Session encountered an error", e);
            cleanupSession(true);
          },
          onclose: (e) => {
            if (!isClosingRef.current) {
              cleanupSession();
            }
          }
        }
      });

      sessionRef.current = sessionPromise;

    } catch (err) {
      console.error("Murshid AI: Boot sequence failed", err);
      cleanupSession(true);
      alert("Microphone access or connection failed. Please check permissions.");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file && file.type === 'application/pdf') {
      setIsReadingPdf(true);
      try {
        const content = await extractTextFromPDF(file);
        setPdf({ name: file.name, content });
      } catch (err: any) {
        // Detailed error reporting for PDF issues
        const errorMsg = err instanceof Error ? err.message : "PDF processing failed.";
        alert(`Textbook Error: ${errorMsg}`);
      } finally {
        setIsReadingPdf(false);
      }
    }
  };

  return (
    <div className="min-h-screen bg-[#fcfcfc] flex flex-col items-center p-4 md:p-8">
      <header className="w-full max-w-4xl flex justify-between items-center mb-8">
        <div className="flex items-center space-x-3">
          <div className="p-2.5 bg-blue-600 rounded-xl text-white shadow-xl shadow-blue-100">
            <Headphones size={22} />
          </div>
          <div>
            <h1 className="text-xl font-black text-gray-900 tracking-tight">Murshid <span className="text-blue-600">Voice</span></h1>
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${state === AppState.IDLE ? 'bg-gray-300' : 'bg-green-500 animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.6)]'}`} />
              <p className="text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                {state === AppState.IDLE ? 'Link Idle' : 'Neural Stream Active'}
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
           {state !== AppState.IDLE && (
             <div className="flex items-center gap-1 px-3 py-1 bg-blue-50 text-blue-600 rounded-full border border-blue-100 animate-pulse">
               <Activity size={12} />
               <span className="text-[10px] font-bold uppercase">Live</span>
             </div>
           )}
           <button className="p-2 text-gray-400 hover:text-blue-600 transition-colors">
            <Settings size={18} />
          </button>
        </div>
      </header>

      <main className="w-full max-w-md flex-1 flex flex-col items-center justify-center space-y-12 pb-20">
        <div className="relative">
          <div className={`absolute -inset-12 rounded-full blur-[60px] transition-opacity duration-1000 ${
            state === AppState.LISTENING ? 'bg-blue-400/15 opacity-100' :
            state === AppState.SPEAKING ? 'bg-indigo-400/15 opacity-100' : 'opacity-0'
          }`} />
          
          <div className={`w-44 h-44 rounded-full border-2 flex items-center justify-center relative transition-all duration-500 ${
            state === AppState.LISTENING ? 'border-blue-500 bg-white scale-110 shadow-2xl shadow-blue-50' :
            state === AppState.SPEAKING ? 'border-indigo-500 bg-white scale-105 shadow-2xl shadow-indigo-50' :
            state === AppState.PROCESSING ? 'border-amber-400 bg-white animate-pulse' : 'border-gray-100 bg-white'
          }`}>
            {state === AppState.LISTENING && (
              <div className="absolute inset-0 rounded-full border border-blue-400 animate-[ping_2s_infinite] opacity-10" />
            )}
            
            {state === AppState.SPEAKING ? (
              <div className="flex gap-1.5 items-center h-12">
                {[1,2,3,4].map(i => (
                  <div 
                    key={i} 
                    className="w-1.5 bg-indigo-600 rounded-full animate-bounce" 
                    style={{
                      height: `${20 + (i * 10)}px`,
                      animationDelay: `${i*0.1}s`,
                      animationDuration: '0.6s'
                    }} 
                  />
                ))}
              </div>
            ) : state === AppState.LISTENING ? (
              <Mic className="text-blue-600" size={56} />
            ) : state === AppState.PROCESSING ? (
              <Zap className="text-amber-500" size={56} />
            ) : (
              <MessageSquare className="text-gray-200" size={56} />
            )}
          </div>
        </div>

        <div className="text-center w-full">
          <h2 className="text-2xl font-black text-gray-900 mb-2 tracking-tight">
            {state === AppState.IDLE ? "Start Session" : 
             state === AppState.LISTENING ? "Listening..." : 
             state === AppState.SPEAKING ? "Murshid Responding" : "Analyzing Text..."}
          </h2>
          <Visualizer state={state} />
        </div>

        <div className="w-full space-y-4">
          {state === AppState.IDLE ? (
            <button
              onClick={startLiveConversation}
              className="w-full py-5 rounded-2xl bg-gray-900 text-white font-bold text-lg hover:bg-black transition-all shadow-xl shadow-gray-200 flex items-center justify-center gap-3 transform active:scale-[0.98]"
            >
              <Zap size={20} className="text-amber-400" />
              ACTIVATE TUTOR
            </button>
          ) : (
            <button
              onClick={() => cleanupSession()}
              className="w-full py-5 rounded-2xl bg-white text-red-600 border border-red-100 font-bold text-lg hover:bg-red-50 transition-all flex items-center justify-center gap-3 transform active:scale-[0.98]"
            >
              <XCircle size={20} />
              END CONVERSATION
            </button>
          )}

          {!pdf && state === AppState.IDLE && (
            <label className={`w-full py-4 border border-dashed rounded-2xl flex items-center justify-center gap-2 cursor-pointer transition-all ${isReadingPdf ? 'bg-blue-50 border-blue-300 animate-pulse' : 'border-gray-200 hover:border-blue-400 hover:bg-blue-50'}`}>
              {isReadingPdf ? (
                <>
                  <Loader2 size={16} className="text-blue-600 animate-spin" />
                  <span className="text-xs font-bold text-blue-600">Reconstructing Layout...</span>
                </>
              ) : (
                <>
                  <Upload size={16} className="text-gray-400" />
                  <span className="text-xs font-bold text-gray-500">Upload Textbook (PDF)</span>
                </>
              )}
              <input type="file" accept="application/pdf" className="hidden" onChange={handleFileUpload} disabled={isReadingPdf} />
            </label>
          )}

          {pdf && (
            <div className="p-4 bg-green-50 border border-green-100 rounded-xl flex items-center justify-between animate-in fade-in slide-in-from-bottom-2">
              <div className="flex items-center gap-3">
                <ShieldCheck className="text-green-600" size={18} />
                <span className="text-[10px] font-bold text-green-900 uppercase tracking-tighter truncate max-w-[200px]">{pdf.name}</span>
              </div>
              {state === AppState.IDLE && (
                <button onClick={() => setPdf(null)} className="text-green-800 hover:text-red-600 transition-colors">
                  <XCircle size={16} />
                </button>
              )}
            </div>
          )}
        </div>
      </main>

      <footer className="mt-auto py-6 text-center">
        <div className="flex items-center justify-center gap-2 mb-1">
          <AlertCircle size={10} className="text-gray-400" />
          <p className="text-[9px] font-bold text-gray-400 uppercase tracking-[0.2em]">Enhanced Layout RAG Enabled</p>
        </div>
        <p className="text-[10px] font-black text-gray-200 uppercase tracking-[0.3em]">
          Class 1-10 Learning Framework
        </p>
      </footer>
    </div>
  );
};

export default App;
