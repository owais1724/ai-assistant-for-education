
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { 
  Mic, BookOpen, ShieldCheck, 
  MessageSquare, Upload, Settings, 
  Zap, XCircle, Loader2, AlertCircle, Headphones, Activity,
  User as UserIcon, LogOut, History, Brain, LayoutDashboard, ChevronRight, Clock, 
  TrendingUp, PieChart, BarChart3, GraduationCap, Users, Heart, Search, Filter,
  FileText, RefreshCw, CheckCircle2, Trash2, Sparkles, Target, Send, Keyboard, Bot, Award, ChevronLeft, Copy, Check, GitBranch, AlertTriangle, Compass, Key
} from 'lucide-react';
import { AppState, PDFMetadata, User, Interaction, UserRole, StudentStatus, Quiz, QuizQuestion, MindMapNode } from './types.ts';
import { getSystemPrompt } from './constants.ts';
import { getAIClient, encodeBase64, decodeBase64, decodeAudioData, generateQuiz, generateMindMap } from './services/geminiService.ts';
import { extractTextFromPDF } from './services/pdfService.ts';
import { storageService } from './services/storageService.ts';
import Visualizer from './components/Visualizer.tsx';
import MindMapVisualizer from './components/MindMapVisualizer.tsx';
import { Modality, LiveServerMessage, GoogleGenAI } from '@google/genai';

// Chart.js imports
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';
import { Line, Doughnut, Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, ArcElement, Title, Tooltip, Legend, Filler);

const App: React.FC = () => {
  const [state, setState] = useState<AppState>(AppState.IDLE);
  const [user, setUser] = useState<User | null>(null);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginName, setLoginName] = useState('');
  const [loginRole, setLoginRole] = useState<UserRole>(UserRole.STUDENT);
  const [linkedId, setLinkedId] = useState('');
  
  const [selectedPdf, setSelectedPdf] = useState<PDFMetadata | null>(null);
  const [isReadingPdf, setIsReadingPdf] = useState(false);
  const [pdfProgress, setPdfProgress] = useState(0);
  const [pdfError, setPdfError] = useState<string | null>(null);
  
  const [showDashboard, setShowDashboard] = useState(false);
  const [viewingStudent, setViewingStudent] = useState<User | null>(null);
  
  const [textInput, setTextInput] = useState('');
  const [latestResponse, setLatestResponse] = useState<{q: string, a: string} | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Quiz State
  const [activeQuiz, setActiveQuiz] = useState<Quiz | null>(null);
  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [quizScore, setQuizScore] = useState(0);
  const [quizFinished, setQuizFinished] = useState(false);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [showExplanation, setShowExplanation] = useState(false);

  // Mind Map State
  const [activeMindMap, setActiveMindMap] = useState<MindMapNode | null>(null);

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

  const currentTurnInput = useRef<string>('');
  const currentTurnOutput = useRef<string>('');

  useEffect(() => {
    stateRef.current = state;
    const savedUser = storageService.getCurrentUser();
    if (savedUser) {
      setUser(savedUser);
      if (savedUser.role === UserRole.PARENT && savedUser.childId) {
        const child = storageService.getUser(savedUser.childId);
        if (child) setViewingStudent(child);
      }
    }
  }, [state]);

  const cleanupSession = useCallback(async (isError = false) => {
    if (isClosingRef.current && !isError) return;
    isClosingRef.current = true;
    setState(AppState.IDLE);
    sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
    sourcesRef.current.clear();
    nextStartTimeRef.current = 0;
    
    if (sessionRef.current) {
      try { 
        const s = await sessionRef.current; 
        if (s && typeof s.close === 'function') s.close(); 
      } catch (e) {}
      sessionRef.current = null;
    }
    
    if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
    if (micStreamRef.current) micStreamRef.current.getTracks().forEach(t => t.stop());
    if (audioContextInRef.current) await audioContextInRef.current.close().catch(() => {});
    if (audioContextOutRef.current) await audioContextOutRef.current.close().catch(() => {});
    
    isClosingRef.current = false;
  }, []);

  const handleIncomingAudio = async (base64: string) => {
    let ctx = audioContextOutRef.current;
    if (!ctx) {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextOutRef.current = ctx;
    }
    
    if (ctx.state === 'suspended') await ctx.resume();
    if (stateRef.current !== AppState.SPEAKING) setState(AppState.SPEAKING);

    try {
      const buffer = await decodeAudioData(decodeBase64(base64), ctx, 24000, 1);
      if (nextStartTimeRef.current < ctx.currentTime) nextStartTimeRef.current = ctx.currentTime + 0.05;
      
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => {
        sourcesRef.current.delete(source);
        if (sourcesRef.current.size === 0) {
          isModelSpeakingRef.current = false;
          // Return to listening automatically when speech ends
          if (sessionRef.current) setState(AppState.LISTENING);
        }
      };
      source.start(nextStartTimeRef.current);
      nextStartTimeRef.current += buffer.duration;
      sourcesRef.current.add(source);
      isModelSpeakingRef.current = true;
    } catch (e) { console.error("Playback error", e); }
  };

  const startLiveConversation = async () => {
    if (!user || user.role !== UserRole.STUDENT) return;

    // Strict Key Selection Flow
    try {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
      }
    } catch (e) {
      console.error("Key selection error", e);
    }

    setConnectionError(null);
    try {
      // Fresh client instance right before connection
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      setState(AppState.PROCESSING);
      
      const audioContextIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      audioContextInRef.current = audioContextIn;
      
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      const historyString = user.history.slice(0, 5).map(h => `Q: ${h.question}\nA: ${h.answer}`).join('\n\n');

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction: getSystemPrompt(user.name, historyString, user.weakAreas) + (selectedPdf ? `\n\n[TEXTBOOK]: ${selectedPdf.content}` : ""),
        },
        callbacks: {
          onopen: () => {
            setState(AppState.LISTENING);
            const source = audioContextIn.createMediaStreamSource(stream);
            const processor = audioContextIn.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = processor;
            processor.onaudioprocess = (e) => {
              // Only stream if session is alive; allow stream during SPEAKING for interruptions
              if (stateRef.current !== AppState.LISTENING && stateRef.current !== AppState.SPEAKING) return;
              const inputData = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(inputData.length);
              for (let i = 0; i < inputData.length; i++) int16[i] = inputData[i] * 32768;
              const base64 = encodeBase64(new Uint8Array(int16.buffer));
              sessionPromise.then(s => s.sendRealtimeInput({ media: { data: base64, mimeType: 'audio/pcm;rate=16000' } }));
            };
            source.connect(processor);
            processor.connect(audioContextIn.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Interruption Signal
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              isModelSpeakingRef.current = false;
              setState(AppState.LISTENING);
              return;
            }

            if (message.serverContent?.inputTranscription) currentTurnInput.current += message.serverContent.inputTranscription.text;
            if (message.serverContent?.outputTranscription) currentTurnOutput.current += message.serverContent.outputTranscription.text;
            
            const audioData = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData) handleIncomingAudio(audioData);

            if (message.serverContent?.turnComplete) {
              if (currentTurnInput.current && currentTurnOutput.current) {
                storageService.addInteraction(user.id, {
                  question: currentTurnInput.current.trim(),
                  answer: currentTurnOutput.current.trim(),
                  topic: 'Voice Session',
                  timestamp: Date.now(),
                  complexity: 'CONCEPTUAL'
                });
                currentTurnInput.current = '';
                currentTurnOutput.current = '';
                const updated = storageService.getUser(user.id);
                if (updated) setUser(updated);
              }
              // Mandatory: Keep convo alive by staying in LISTENING
              if (!isModelSpeakingRef.current) setState(AppState.LISTENING);
            }
          },
          onerror: (err: any) => {
            console.error("Live Error", err);
            const msg = err?.message || String(err);
            if (msg.includes("Entity was not found") || msg.includes("Network error") || msg.includes("404")) {
              setConnectionError("Project authentication error. Please select a valid paid project key.");
              window.aistudio.openSelectKey();
            } else {
              setConnectionError(`Connection lost: ${msg}`);
            }
            if (!isClosingRef.current) cleanupSession(true);
          },
          onclose: () => {
            if (!isClosingRef.current) cleanupSession();
          }
        }
      });
      sessionRef.current = sessionPromise;
    } catch (err: any) {
      console.error("Init Error", err);
      setConnectionError(err?.message || "Critical failure.");
      cleanupSession(true);
    }
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginEmail && loginName) {
      const loggedInUser = storageService.login(loginEmail, loginName, loginRole, linkedId);
      setUser(loggedInUser);
    }
  };

  const handleLogout = () => {
    storageService.logout();
    setUser(null);
    cleanupSession();
  };

  const processPDF = async (file: File) => {
    if (!user) return;
    setIsReadingPdf(true);
    setPdfProgress(10);
    try {
      const content = await extractTextFromPDF(file);
      storageService.addTextbook(user.id, { name: file.name, content });
      setSelectedPdf({ name: file.name, content });
      const updated = storageService.getUser(user.id);
      if (updated) setUser(updated);
      setPdfProgress(100);
      setTimeout(() => setIsReadingPdf(false), 500);
    } catch (err: any) {
      setPdfError(err.message);
      setIsReadingPdf(false);
    }
  };

  const renderAnalytics = (targetUser: User, viewerRole: UserRole) => {
    const gapsData = {
      labels: Object.keys(targetUser.conceptAttempts).length > 0 ? Object.keys(targetUser.conceptAttempts).map(t => t.replace(/_/g, ' ')) : ['General'],
      datasets: [{ 
        data: Object.values(targetUser.conceptAttempts).length > 0 ? Object.values(targetUser.conceptAttempts) : [1], 
        backgroundColor: ['#4f46e5', '#3b82f6', '#818cf8', '#a5b4fc', '#c7d2fe'], 
        borderWidth: 0 
      }]
    };
    return (
      <div className="space-y-8 animate-in fade-in duration-500">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-8 bg-white border rounded-[40px] shadow-sm">
            <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-widest mb-4">Status</h4>
            <div className={`px-6 py-4 rounded-3xl border text-lg font-black text-center ${targetUser.status === 'GOOD' ? 'bg-green-50 text-green-700' : 'bg-amber-50 text-amber-700'}`}>
              {targetUser.status.replace('_', ' ')}
            </div>
            <p className="mt-4 text-sm text-gray-500 font-medium">{targetUser.aiInsightSummary}</p>
          </div>
          <div className="md:col-span-2 p-8 bg-white border rounded-[40px] shadow-sm">
            <h4 className="text-[11px] font-black text-gray-400 uppercase tracking-widest mb-6">Concept Mastery</h4>
            <div className="h-56 flex justify-center">
              <Doughnut data={gapsData} options={{ maintainAspectRatio: false, cutout: '70%' }} />
            </div>
          </div>
        </div>
      </div>
    );
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white p-12 rounded-[56px] shadow-2xl border border-gray-100">
          <div className="text-center mb-10">
            <div className="inline-block p-6 bg-gradient-to-br from-blue-600 to-indigo-700 rounded-[32px] text-white shadow-xl mb-8"><GraduationCap size={56} /></div>
            <h1 className="text-4xl font-black text-gray-900 tracking-tighter">Murshid AI</h1>
          </div>
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="flex bg-gray-100 p-1.5 rounded-[24px]">
              {(['STUDENT', 'TEACHER', 'PARENT'] as UserRole[]).map(role => (
                <button key={role} type="button" onClick={() => setLoginRole(role)} className={`flex-1 py-3 text-[10px] font-black rounded-[18px] transition-all ${loginRole === role ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-400'}`}>
                  {role}
                </button>
              ))}
            </div>
            <input type="text" required value={loginName} onChange={e => setLoginName(e.target.value)} placeholder="Full Name" className="w-full px-7 py-5 rounded-[24px] bg-gray-50 border-none font-black text-lg" />
            <input type="email" required value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="Email Address" className="w-full px-7 py-5 rounded-[24px] bg-gray-50 border-none font-black text-lg" />
            <button type="submit" className="w-full py-7 rounded-[32px] bg-gray-900 text-white font-black text-xl hover:bg-black transition-all shadow-2xl">AUTHENTICATE</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col p-4 md:p-8 relative">
      {showDashboard && (
        <div className="fixed inset-0 z-[60] bg-white/95 backdrop-blur-3xl p-6 md:p-12 overflow-y-auto animate-in fade-in duration-700 scrollbar-hide">
          <div className="max-w-5xl mx-auto space-y-12 pb-32">
            <div className="flex justify-between items-end border-b pb-12">
              <h2 className="text-6xl font-black text-gray-900 tracking-tighter">Academic Progress</h2>
              <button onClick={() => setShowDashboard(false)} className="p-6 bg-gray-100 rounded-[32px] hover:text-red-500"><XCircle size={36} /></button>
            </div>
            {renderAnalytics(user, user.role)}
          </div>
        </div>
      )}

      <header className="flex justify-between items-center mb-12 max-w-5xl w-full mx-auto">
        <div className="flex items-center gap-5">
          <div className="w-16 h-16 bg-blue-600 rounded-[24px] flex items-center justify-center text-white font-black text-3xl shadow-xl">{user.name.charAt(0)}</div>
          <div><h1 className="text-2xl font-black text-gray-900">Murshid AI</h1><p className="text-[10px] font-black text-gray-400 tracking-widest uppercase">Student ID: {user.id}</p></div>
        </div>
        <div className="flex gap-3">
           <button onClick={() => setShowDashboard(true)} className="p-5 bg-white border rounded-[28px] text-gray-600 hover:text-blue-600 shadow-sm"><LayoutDashboard size={24} /></button>
           <button onClick={handleLogout} className="p-5 bg-white border rounded-[28px] text-gray-400 hover:text-red-500 shadow-sm"><LogOut size={24} /></button>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center max-w-4xl mx-auto w-full space-y-12 pb-24 relative">
        <div className="flex flex-col items-center gap-8 w-full">
           <div className={`relative group cursor-pointer transition-transform duration-700 ${state !== AppState.IDLE ? 'scale-110' : ''}`} onClick={state === AppState.IDLE ? startLiveConversation : undefined}>
              <div className={`absolute -inset-20 rounded-full blur-[80px] transition-all duration-1000 ${state === AppState.LISTENING ? 'bg-blue-400/30 animate-pulse' : state === AppState.SPEAKING ? 'bg-indigo-400/30' : 'bg-transparent'}`} />
              <div className={`w-56 h-56 rounded-[72px] border-2 flex flex-col items-center justify-center relative bg-white shadow-2xl transition-all ${state !== AppState.IDLE ? 'border-blue-500 ring-[20px] ring-blue-50' : 'border-gray-50'}`}>
                {state === AppState.SPEAKING ? (
                   <div className="flex gap-2.5 h-16 items-center">
                    {[1,2,3,4,5].map(i => <div key={i} className="w-2.5 bg-indigo-500 rounded-full animate-bounce" style={{ height: `${20 + i*10}px`, animationDelay: `${i*0.1}s` }} />)}
                  </div>
                ) : state === AppState.LISTENING ? (
                  <Mic className="text-blue-600 animate-pulse" size={72} />
                ) : state === AppState.PROCESSING ? (
                  <Loader2 className="text-amber-500 animate-spin" size={72} />
                ) : (
                  <Zap className="text-gray-200" size={72} />
                )}
              </div>
           </div>
           
           <div className="text-center w-full px-6">
              <h2 className="text-4xl font-black text-gray-900 tracking-tighter mb-4 uppercase">
                {state === AppState.IDLE ? `Welcome, ${user.name}` : state === AppState.LISTENING ? "Murshid is Listening..." : state === AppState.SPEAKING ? "Murshid is Talking" : "Processing..."}
              </h2>
              <Visualizer state={state} />
              {connectionError && (
                <div className="mt-8 p-6 bg-red-50 border border-red-100 rounded-[32px] text-red-600 font-bold text-sm animate-in fade-in flex flex-col gap-4">
                  <div className="flex items-center justify-center gap-2"><AlertCircle size={20} /> {connectionError}</div>
                  <button onClick={() => window.aistudio.openSelectKey()} className="mx-auto px-6 py-3 bg-red-600 text-white rounded-2xl flex items-center gap-2 hover:bg-red-700 shadow-lg shadow-red-100">
                    <Key size={16} /> RECONFIGURE KEY
                  </button>
                </div>
              )}
           </div>
        </div>

        <div className="w-full max-w-2xl space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <button onClick={state === AppState.IDLE ? startLiveConversation : () => cleanupSession()} className={`py-6 rounded-[32px] font-black text-lg transition-all shadow-xl flex items-center justify-center gap-3 ${state === AppState.IDLE ? 'bg-gray-900 text-white hover:bg-black' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}>
               {state === AppState.IDLE ? <><Mic size={24} /> START VOICE</> : <><XCircle size={24} /> DISCONNECT</>}
            </button>
            <label className={`py-6 rounded-[32px] border-2 border-dashed font-black text-lg transition-all flex items-center justify-center gap-3 cursor-pointer ${isReadingPdf ? 'bg-blue-50 border-blue-400' : 'bg-white border-gray-100 hover:border-blue-200'}`}>
              {isReadingPdf ? <Loader2 className="animate-spin" size={24} /> : <Upload size={24} />} 
              {isReadingPdf ? 'UPLOADING...' : 'ADD TEXTBOOK'}
              <input type="file" accept="application/pdf" className="hidden" onChange={e => e.target.files?.[0] && processPDF(e.target.files[0])} disabled={isReadingPdf} />
            </label>
          </div>
        </div>
      </main>

      <footer className="text-center py-10 opacity-30 mt-auto"><p className="text-[12px] font-black text-gray-400 uppercase tracking-[0.5em] flex items-center justify-center gap-4"><ShieldCheck size={16} /> Murshid Intelligent Core</p></footer>
    </div>
  );
};

export default App;
