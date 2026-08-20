import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  Video, History, LogOut, Search, AlertCircle, CheckCircle2, Loader2,
  User, ShieldCheck, Languages, MessageSquare, Eye, Camera,
  FileVideo, FileText, Activity, Play, Upload, Download, FileSpreadsheet,
  X, AlertTriangle, Check, Layers, Clock, RotateCcw, Trash2,
  Database, Key, Settings, LayoutDashboard, BarChart3, Zap, ArrowUpRight, Filter, ChevronLeft,
  History as HistoryIcon, FileAudio, Square, XCircle, RefreshCw, Server
} from 'lucide-react';
import Papa from 'papaparse';
import { motion, AnimatePresence } from 'motion/react';
import { 
  VideoAnalysis, AuditStatus, AuditResult, FPGroupedUID, 
  FPGeminiResponse, FPHistoryItem 
} from './types';
import { 
  STATIC_CREDENTIALS, DAILY_QUOTA, FP_SYSTEM_PROMPT,
  FP_INPUT_COST_PER_TOKEN, FP_OUTPUT_COST_PER_TOKEN 
} from './constants';
import { cn } from './lib/utils';
import { processVideoLocally } from './utils/videoProcessor';
import { transcribeAndIdentify } from './services/geminiService';
import { GoogleGenAI } from "@google/genai";
import { TataTeleApiTab } from './components/TataTeleApiTab';
import { 
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip 
} from 'recharts';

const STORAGE_KEY = 'sd_analyst_history';
const FP_STORAGE_KEY = 'fp_audit_history';

const loadHistory = (): VideoAnalysis[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const all: VideoAnalysis[] = JSON.parse(raw);
    const sanitized = all.map(i => ({ ...i, transcriptEnglish: i.transcriptEnglish || '' }));
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const fresh = sanitized.filter(i => i.timestamp >= cutoff);
    if (fresh.length !== all.length) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    return [];
  }
};

const saveHistory = (history: VideoAnalysis[]) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
};

const loadFpHistory = (): FPHistoryItem[] => {
  try {
    const raw = localStorage.getItem(FP_STORAGE_KEY);
    if (!raw) return [];
    const all: FPHistoryItem[] = JSON.parse(raw);
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const fresh = all.filter(i => new Date(i.auditDate).getTime() >= cutoff);
    if (fresh.length !== all.length) {
      localStorage.setItem(FP_STORAGE_KEY, JSON.stringify(fresh));
    }
    return fresh;
  } catch {
    return [];
  }
};

const saveFpHistory = (history: FPHistoryItem[]) => {
  localStorage.setItem(FP_STORAGE_KEY, JSON.stringify(history));
};

const getSDVideoStatus = (item: VideoAnalysis): string => {
  if (!item.videoUrl || item.videoUrl.trim() === '') return 'Video Not Uploaded';
  if (!item.faceVisible) return 'Irrelevant Video is Uploaded';
  if (!item.transcript || item.transcript === 'NO AUDIO DETECTED') return 'Irrelevant Video is Uploaded';
  if (item.isIrrelevant) return 'Irrelevant Video is Uploaded';
  
  // Future status - not yet triggered but added for consistency
  // if (item.isCoApplicantDifferent) return 'Video and Co applicant are different';

  const speakerType = (item.speakerType || '').toLowerCase().trim();
  if (speakerType === 'student') return 'SD video done by Student';
  const clarity = (item.videoClarity || '').toLowerCase();
  if (clarity !== 'clear') return 'Uploaded video is not clear';
  if (!item.loanWordUsed && !item.documentWordUsed) return 'Loan and Documents word not used';
  if (!item.loanWordUsed) return 'Loan word Not used';
  if (!item.documentWordUsed) return 'Documents word not mentioned';
  return 'Verified';
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  initialDelay: number = 15000
): Promise<T> {
  let lastError: any;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      
      const errorStr = JSON.stringify(error).toLowerCase();
      const messageStr = (error?.message || '').toLowerCase();
      
      const isRateLimit = 
        error?.status === 429 || 
        error?.error?.code === 429 ||
        messageStr.includes('429') || 
        messageStr.includes('resource_exhausted') ||
        messageStr.includes('quota') ||
        errorStr.includes('429') ||
        errorStr.includes('resource_exhausted') ||
        errorStr.includes('quota');
      
      if (isRateLimit && i < maxRetries) {
        // Fixed backoff: 15s, 30s, 45s
        const waitTime = initialDelay * (i + 1);
        console.warn(`Rate limit hit. Retrying in ${waitTime}ms... (Attempt ${i + 1}/${maxRetries})`);
        await delay(waitTime);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

interface BulkItem {
  name: string;
  url: string;
  recordId?: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  analysisId?: string;
}

interface CsvRow {
  name: string;
  url: string;
  recordId?: string;
  errors: string[];
  rawData: any;
}

const CsvPreviewModal = ({
  rows, onClose, onConfirm,
}: {
  rows: CsvRow[];
  onClose: () => void;
  onConfirm: () => void;
}) => {
  const [filter, setFilter] = useState<'all' | 'valid' | 'invalid'>('all');
  const totalRows = rows.length;
  const validRows = rows.filter(r => r.errors.length === 0).length;
  const invalidRows = totalRows - validRows;
  const filteredRows = rows.filter(r => {
    if (filter === 'valid') return r.errors.length === 0;
    if (filter === 'invalid') return r.errors.length > 0;
    return true;
  });
  const headers = Array.from(new Set(rows.flatMap(r => Object.keys(r.rawData))));

  const downloadPreviewCsv = () => {
    const csvData = rows.map(row => ({
      'Validation Status': row.errors.length > 0 ? `INVALID: ${row.errors.join(', ')}` : 'VALID',
      'Extracted UID': row.name,
      'Extracted Video URL': row.url,
      ...row.rawData,
    }));
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `validation_report_${Date.now()}.csv`;
    link.click();
  };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="bg-zinc-900 border border-zinc-800 w-full max-w-6xl max-h-[90vh] rounded-3xl overflow-hidden flex flex-col shadow-2xl">
        <div className="p-6 border-b border-zinc-800 flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white flex items-center gap-3">
              <FileSpreadsheet className="text-indigo-500" /> CSV Upload Preview
            </h2>
            <p className="text-zinc-500 text-sm mt-1">Review your data before starting bulk analysis</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={downloadPreviewCsv}
              className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm font-bold transition-all border border-zinc-700">
              <Download className="w-4 h-4" /> Download Report
            </button>
            <button onClick={onClose} className="p-2 hover:bg-zinc-800 rounded-full transition-colors text-zinc-400">
              <X className="w-6 h-6" />
            </button>
          </div>
        </div>
        <div className="p-6 grid grid-cols-3 gap-4">
          <button onClick={() => setFilter('all')}
            className={cn('p-4 rounded-2xl text-left border transition-all', filter === 'all' ? 'bg-zinc-800 border-indigo-500/50' : 'bg-zinc-800/50 border-zinc-700/50')}>
            <p className="text-zinc-500 text-xs font-bold uppercase mb-1">Total Records</p>
            <p className="text-3xl font-bold text-white">{totalRows}</p>
          </button>
          <button onClick={() => setFilter('valid')}
            className={cn('p-4 rounded-2xl text-left border transition-all', filter === 'valid' ? 'bg-emerald-500/10 border-emerald-500/50' : 'bg-emerald-500/5 border-emerald-500/10')}>
            <p className="text-emerald-500/70 text-xs font-bold uppercase mb-1">Valid Records</p>
            <p className="text-3xl font-bold text-emerald-400">{validRows}</p>
          </button>
          <button onClick={() => setFilter('invalid')}
            className={cn('p-4 rounded-2xl text-left border transition-all', filter === 'invalid' ? 'bg-red-500/10 border-red-500/50' : 'bg-red-500/5 border-red-500/10')}>
            <p className="text-red-500/70 text-xs font-bold uppercase mb-1">Invalid Records</p>
            <p className="text-3xl font-bold text-red-400">{invalidRows}</p>
          </button>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <div className="border border-zinc-800 rounded-2xl overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead className="bg-zinc-800/50 text-zinc-400 text-xs font-bold uppercase">
                <tr>
                  <th className="px-4 py-3 border-b border-zinc-700">Status</th>
                  <th className="px-4 py-3 border-b border-zinc-700">UID</th>
                  <th className="px-4 py-3 border-b border-zinc-700">Video URL</th>
                  {headers.map(h => <th key={h} className="px-4 py-3 border-b border-zinc-700 whitespace-nowrap">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {filteredRows.map((row, idx) => (
                  <tr key={idx} className={cn('hover:bg-zinc-800/30 transition-colors', row.errors.length > 0 ? 'bg-red-500/5' : 'bg-emerald-500/5')}>
                    <td className="px-4 py-3 align-top">
                      {row.errors.length > 0 ? (
                        <div className="flex flex-col gap-1">
                          {row.errors.map((err, i) => (
                            <span key={i} className="inline-flex items-center gap-1 text-[10px] font-bold text-red-400 bg-red-400/10 px-2 py-0.5 rounded-full uppercase">
                              <AlertTriangle className="w-3 h-3" />{err}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-400/10 px-2 py-0.5 rounded-full uppercase">
                          <Check className="w-3 h-3" />Ready
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm font-mono text-zinc-300 align-top">{row.name || '-'}</td>
                    <td className="px-4 py-3 text-sm font-mono text-zinc-500 align-top break-all max-w-xs">{row.url || '-'}</td>
                    {headers.map(h => <td key={h} className="px-4 py-3 text-xs text-zinc-500 align-top whitespace-nowrap">{row.rawData[h] || '-'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="p-6 border-t border-zinc-800 flex items-center justify-between">
          <button onClick={onClose} className="px-6 py-3 bg-zinc-800 text-white rounded-xl font-bold hover:bg-zinc-700 transition-all">
            Cancel & Reupload
          </button>
          <div className="flex items-center gap-4">
            <p className="text-zinc-500 text-sm">{validRows === 0 ? 'No valid records to process' : `Will process ${validRows} valid records`}</p>
            <button onClick={onConfirm} disabled={validRows === 0}
              className="px-8 py-3 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center gap-2">
              <Play className="w-4 h-4" /> Submit & Continue
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
};

const DetailItem = ({ icon, label, value, highlight, primary }: {
  icon: React.ReactNode; label: string; value: string; highlight?: boolean; primary?: boolean;
}) => (
  <div className={cn('flex items-center justify-between p-3 rounded-xl border transition-all',
    primary ? 'bg-indigo-500/10 border-indigo-500/30 ring-1 ring-indigo-500/20' : 'bg-zinc-950 border-zinc-800/50')}>
    <div className="flex items-center gap-3">
      <div className={cn(primary ? 'text-indigo-400' : 'text-zinc-500')}>{icon}</div>
      <span className={cn('text-sm', primary ? 'text-indigo-200 font-bold' : 'text-zinc-500')}>{label}</span>
    </div>
    <span className={cn('text-sm font-semibold', highlight ? 'text-indigo-400' : 'text-zinc-200', primary && 'text-lg')}>{value}</span>
  </div>
);

const AnalysisCard = ({ analysis }: { analysis: VideoAnalysis }) => (
  <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
    className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl">
    <div className="p-8 border-b border-zinc-800 flex justify-between items-start">
      <div>
        <div className="flex items-center gap-2 text-indigo-400 text-xs font-bold uppercase tracking-widest mb-2">
          <CheckCircle2 className="w-4 h-4" /> Analysis Complete
        </div>
        <p className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-1">UID</p>
        <h2 className="text-3xl font-bold">{analysis.recordingName}</h2>
        <p className="text-zinc-500 text-sm mt-1">{new Date(analysis.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
      </div>
      <div className={cn('px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-widest',
        (analysis.sentiment || '').toLowerCase() === 'positive' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400')}>
        {analysis.sentiment}
      </div>
    </div>
    <div className="p-8 grid grid-cols-1 md:grid-cols-2 gap-8">
      <div className="space-y-6">
        <section>
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Core Details</h3>
          <div className="space-y-3">
            <DetailItem icon={<Activity className="w-4 h-4" />} label="SD Video Status" value={getSDVideoStatus(analysis)} highlight={getSDVideoStatus(analysis) === 'Verified'} primary />
            <DetailItem icon={<User className="w-4 h-4" />} label="Speaker Type" value={analysis.speakerType} />
            <DetailItem icon={<ShieldCheck className="w-4 h-4" />} label="Relationship" value={analysis.specificRelationship} />
            <DetailItem icon={<MessageSquare className="w-4 h-4" />} label='"Loan" Word' value={analysis.loanWordUsed ? `Yes (by ${analysis.loanWordSpeaker})` : 'No'} highlight={analysis.loanWordUsed} />
            <DetailItem icon={<FileText className="w-4 h-4" />} label='"Document" Word' value={analysis.documentWordUsed ? 'Yes' : 'No'} highlight={analysis.documentWordUsed} />
          </div>
        </section>
        <section>
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Video Quality</h3>
          <div className="space-y-3">
            <DetailItem icon={<Eye className="w-4 h-4" />} label="Clarity" value={analysis.videoClarity} />
            <DetailItem icon={<Camera className="w-4 h-4" />} label="Face Visibility" value={analysis.faceVisible ? 'Clearly Visible' : 'Not Visible'} highlight={analysis.faceVisible} />
            {analysis.transcriptEnglish && (
              <DetailItem icon={<Languages className="w-4 h-4" />} label="English Translation" value="Available" highlight />
            )}
          </div>
        </section>
      </div>
      <div className="space-y-6">
        <section>
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Video Playback</h3>
          <div className="aspect-video bg-zinc-950 rounded-2xl overflow-hidden border border-zinc-800">
            <video src={analysis.videoUrl} controls className="w-full h-full" />
          </div>
        </section>
        <section>
          <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-4">Transcript</h3>
          <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 max-h-60 overflow-y-auto space-y-4">
            <div>
              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">Original</p>
              <p className="text-sm text-zinc-400 leading-relaxed italic">"{analysis.transcript}"</p>
            </div>
            {analysis.transcriptEnglish && (
              <div className="pt-4 border-t border-zinc-800">
                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">English Translation</p>
                <p className="text-sm text-indigo-300/70 leading-relaxed italic">"{analysis.transcriptEnglish}"</p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  </motion.div>
);

const StatusBadge = ({ status }: { status: AuditStatus }) => {
  switch (status) {
    case 'PAYMENT_CONSENT_FOUND':
      return <span className="badge-green flex items-center gap-2 shadow-lg shadow-success/10"><CheckCircle2 className="w-3.5 h-3.5" /> FOUND</span>;
    case 'PARTIAL_CONFIRMATION':
      return <span className="badge-amber flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5" /> PARTIAL
      </span>;
    case 'NOT_FOUND':
      return <span className="badge-red flex items-center gap-2 shadow-lg shadow-error/10"><XCircle className="w-3.5 h-3.5" /> NOT FOUND</span>;
    case 'PROCESSING':
      return <span className="badge-blue flex items-center gap-2 animate-pulse shadow-lg shadow-processing/10"><RefreshCw className="w-3.5 h-3.5 animate-spin" /> PROCESSING</span>;
    case 'NOISY_AUDIO_UNABLE_TO_AUDIT':
      return <span className="badge-gray flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5" /> NOISY</span>;
    case 'FETCH_FAILED':
      return <span className="badge-gray flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5" /> FETCH FAILED</span>;
    case 'PARSE_ERROR':
      return <span className="badge-gray flex items-center gap-2"><AlertTriangle className="w-3.5 h-3.5" /> PARSE ERROR</span>;
    default:
      return <span className="badge-gray">— PENDING</span>;
  }
};

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(() => sessionStorage.getItem('qa_auth') === 'true');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  const [recordingName, setRecordingName] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState('');
  const [currentAnalysis, setCurrentAnalysis] = useState<VideoAnalysis | null>(null);
  const [history, setHistory] = useState<VideoAnalysis[]>(() => loadHistory());
  const [activeTab, setActiveTab] = useState<'home' | 'analyze' | 'history' | 'quota' | 'fp_audit' | 'fp_history' | 'fp_guide' | 'fp_dashboard' | 'tata_tele_api'>('home');
  const [previousTab, setPreviousTab] = useState<'home' | 'analyze' | 'history' | 'fp_audit' | 'fp_history' | 'fp_guide' | 'fp_dashboard' | 'tata_tele_api'>('home');
  const [sdSubTab, setSdSubTab] = useState<'bulk' | 'single' | 'dashboard' | 'guide'>('single');
  const [fpSubTab, setFpSubTab] = useState<'bulk' | 'single' | 'dashboard' | 'guide'>('bulk');
  const [historySubTab, setHistorySubTab] = useState<'sd' | 'fp'>('sd');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [bulkQueue, setBulkQueue] = useState<BulkItem[]>([]);
  const [isBulkProcessing, setIsBulkProcessing] = useState(false);
  const [bulkIndex, setBulkIndex] = useState(0);
  const [csvPreviewRows, setCsvPreviewRows] = useState<CsvRow[]>([]);
  const [showCsvPreview, setShowCsvPreview] = useState(false);
  const isProcessingRef = useRef(false);

  // --- FP Audit State ---
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('fp_api_key') || '');
  const [fpData, setFpData] = useState<FPGroupedUID[]>([]);
  const [fpFileName, setFpFileName] = useState('');
  const [fpIsProcessing, setFpIsProcessing] = useState(false);
  const [fpCurrentUID, setFpCurrentUID] = useState<string | null>(null);
  const [fpHistory, setFpHistory] = useState<FPHistoryItem[]>(() => loadFpHistory());
  const [fpHistorySearch, setFpHistorySearch] = useState('');
  const [fpHistoryStatusFilter, setFpHistoryStatusFilter] = useState<string>('ALL');
  const fpStopRef = useRef(false);

  // Shared token tracking (covers both tools)
  const [totalTokensUsed, setTotalTokensUsed] = useState(() => {
    return parseInt(localStorage.getItem('combined_total_tokens') || '0');
  });
  const [totalCostUsd, setTotalCostUsd] = useState(() => {
    return parseFloat(localStorage.getItem('combined_total_cost') || '0');
  });
  const [tokenLimit, setTokenLimit] = useState(() => {
    return parseInt(localStorage.getItem('combined_token_limit') || '2000000');
  });
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showQuotaDropdown, setShowQuotaDropdown] = useState(false);
  const quotaDropdownRef = useRef<HTMLDivElement>(null);
  const [adminLimitInput, setAdminLimitInput] = useState('');
  const warned80Ref = useRef(false);

  // Single FP audit state
  const [fpSingleUID, setFpSingleUID] = useState('');
  const [fpSingleLink, setFpSingleLink] = useState('');
  const [fpSingleResult, setFpSingleResult] = useState<FPGeminiResponse | { status: 'ERROR' | 'FETCH_FAILED' } | null>(null);
  const [fpSingleLoading, setFpSingleLoading] = useState(false);

  const genAI = useMemo(() => {
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
  }, [apiKey]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (quotaDropdownRef.current && !quotaDropdownRef.current.contains(event.target as Node)) {
        setShowQuotaDropdown(false);
      }
    };
    if (showQuotaDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showQuotaDropdown]);

  const quotaUsage = useMemo(() => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    
    const todaySdItems = history.filter(i => i.timestamp >= todayStart.getTime());
    const todayFpItems = fpHistory.filter(i => {
      const auditDate = new Date(i.auditDate);
      return auditDate.getTime() >= todayStart.getTime();
    });

    const videosAudited = todaySdItems.length + todayFpItems.length;
    const sdTokens = todaySdItems.reduce((acc, i) => acc + (i.totalTokens || 0), 0);
    const fpTokens = todayFpItems.reduce((acc, i) => acc + (i.totalTokens || 0), 0);
    const tokensUsed = sdTokens + fpTokens;

    return {
      videosAudited,
      videosRemaining: Math.max(0, DAILY_QUOTA.VIDEOS - videosAudited),
      tokensUsed,
      tokensRemaining: Math.max(0, DAILY_QUOTA.TOKENS - tokensUsed),
    };
  }, [history, fpHistory]);

  const filteredHistory = useMemo(() =>
    history.filter(item => {
      const matchesSearch = (item.recordingName || '').toLowerCase().includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || getSDVideoStatus(item) === statusFilter;
      return matchesSearch && matchesStatus;
    }),
  [history, searchQuery, statusFilter]);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoggingIn(true);
    setLoginError('');
    setTimeout(() => {
      if (email === STATIC_CREDENTIALS.email && password === STATIC_CREDENTIALS.password) {
        sessionStorage.setItem('qa_auth', 'true');
        setIsLoggedIn(true);
        setActiveTab('home');
      } else {
        setLoginError('Invalid email or password.');
      }
      setIsLoggingIn(false);
    }, 500);
  };

  const handleLogout = () => {
    sessionStorage.removeItem('qa_auth');
    setIsLoggedIn(false);
  };

  // --- FP Audit Persistence ---
  useEffect(() => {
    localStorage.setItem('fp_api_key', apiKey);
  }, [apiKey]);

  useEffect(() => {
    saveFpHistory(fpHistory);
  }, [fpHistory]);

  const saveToFpHistory = useCallback((item: Omit<FPHistoryItem, 'id' | 'auditDate'>) => {
    const newItem: FPHistoryItem = {
      ...item,
      id: crypto.randomUUID(),
      auditDate: new Date().toLocaleString(),
    };
    setFpHistory(prev => [newItem, ...prev].slice(0, 1000));
  }, []);

  const updateTokens = (promptTokens: number, candidatesTokens: number) => {
    const total = promptTokens + candidatesTokens;
    const cost = (promptTokens * FP_INPUT_COST_PER_TOKEN) + (candidatesTokens * FP_OUTPUT_COST_PER_TOKEN);
    setTotalTokensUsed(prev => {
      const newVal = prev + total;
      localStorage.setItem('combined_total_tokens', newVal.toString());
      return newVal;
    });
    setTotalCostUsd(prev => {
      const newVal = prev + cost;
      localStorage.setItem('combined_total_cost', newVal.toFixed(6));
      return newVal;
    });
  };

  // --- FP Audit Helpers ---
  const fpNormalizeKey = (key: string) =>
    key.trim()
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .replace(/[_-]/g, ' ')
      .replace(/\s+/g, ' ');

  const fpGetValue = (row: any, keys: string[]) => {
    for (const key of keys) {
      if (row[key]) return String(row[key]).trim();
    }
    return '';
  };

  const fpExtractJSON = (text: string): any => {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON found');
    return JSON.parse(cleaned.substring(first, last + 1));
  };

  const fpFetchAudio = async (url: string): Promise<string> => {
    const isS3Url = (
      url.includes('nw-sales-prdm-media-static') ||
      url.includes('nw-sales-prdzn-media-static') ||
      url.includes('s3.ap-south-1') ||
      url.includes('s3.amazonaws.com')
    );

    let res: Response | null = null;
    let lastError: any = null;

    if (isS3Url) {
      const proxies = [
        (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u: string) => `https://corsproxy.org/?${encodeURIComponent(u)}`
      ];

      for (let i = 0; i < proxies.length; i++) {
        try {
          const proxiedUrl = proxies[i](url);
          console.log(`fpFetchAudio: Attempting fetch via proxy ${i + 1}/${proxies.length}: ${proxiedUrl}`);
          const tempRes = await fetch(proxiedUrl);
          if (tempRes.ok) {
            res = tempRes;
            break;
          }
          throw new Error(`Proxy status: ${tempRes.status} ${tempRes.statusText}`);
        } catch (err: any) {
          console.warn(`fpFetchAudio: Proxy option ${i + 1} failed:`, err.message || err);
          lastError = err;
        }
      }
    }

    if (!res) {
      try {
        console.log('fpFetchAudio: Attempting direct fetch...');
        res = await fetch(url);
        if (!res.ok) {
          throw new Error(`Direct fetch failed with status: ${res.status}`);
        }
      } catch (directErr: any) {
        throw new Error(`fpFetchAudio failed. Last proxy error: ${lastError ? lastError.message : 'None'}. Direct error: ${directErr.message}`);
      }
    }

    const blob = await res.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const fpHandleCSV = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFpFileName(file.name);
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        const grouped: Record<string, FPGroupedUID> = {};
        results.data.forEach((row: any) => {
          const clean: any = {};
          Object.keys(row).forEach(k => { clean[fpNormalizeKey(k)] = row[k]; });
          const uid = fpGetValue(clean, ['userid', 'uid', 'user id', 'uid / reference']);
          const link = fpGetValue(clean, [
            'recording url', 'recording link', 'recordinglink', 'recording', 'link', 
            'fp link', 'full payment link', 'full payment recording', 'full payment recording link'
          ]);
          const selfDec = fpGetValue(clean, ['self declaration', 'selfdeclaration', 'self dec', 'declaration']);
          if (!uid) return;
          const validLink = link && (() => { try { new URL(link); return true; } catch { return false; } })() ? link : null;
          if (!grouped[uid]) {
            grouped[uid] = { uid, selfDeclaration: selfDec, recordings: [], result: { status: 'PENDING', recordingsChecked: 0, totalRecordings: 0 } };
          }
          if (validLink) grouped[uid].recordings.push(validLink);
        });
        const final = Object.values(grouped).map(item => ({ ...item, result: { ...item.result, totalRecordings: item.recordings.length } }));
        setFpData(final);
      }
    });
  };

  const fpProcessRecording = async (url: string, retries = 0): Promise<{ result: FPGeminiResponse | 'PARSE_ERROR' | 'ERROR' | { status: 'FETCH_FAILED' }, usage: { promptTokenCount: number, candidatesTokenCount: number, totalTokenCount: number } }> => {
    try {
      if (!genAI) {
        // Automatically route to backend /api/audit/tata-tele endpoint
        try {
          const serverRes = await fetch('/api/audit/tata-tele', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uid: 'LEAD-AUDIT', recordings: [url] })
          });
          if (serverRes.ok) {
            const sData = await serverRes.json();
            const usageData = {
              promptTokenCount: sData.tokenUsage?.promptTokens || 0,
              candidatesTokenCount: sData.tokenUsage?.candidatesTokens || 0,
              totalTokenCount: sData.tokenUsage?.totalTokens || 0
            };
            if (usageData.totalTokenCount > 0) {
              updateTokens(usageData.promptTokenCount, usageData.candidatesTokenCount);
            }
            return {
              result: {
                status: sData.status,
                timestamp: sData.audioTimestamp || '',
                confidence: sData.confidence || 0,
                statement: sData.statement || '',
                transcript_english: sData.transcriptEnglish || ''
              } as FPGeminiResponse,
              usage: usageData
            };
          }
        } catch (serverErr) {
          console.warn('Server fallback failed:', serverErr);
        }
        alert("Please enter your Gemini API Key in the header or ensure the server backend is running.");
        return { result: 'ERROR', usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
      }
      const currentTokens = parseInt(localStorage.getItem('combined_total_tokens') || '0');
      if (currentTokens >= tokenLimit) return { result: 'ERROR', usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
      
      const audio = await fpFetchAudio(url);
      
      let mimeType = 'audio/mpeg';
      if (url.toLowerCase().endsWith('.wav')) mimeType = 'audio/wav';

      const response = await genAI.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: [{ parts: [{ inlineData: { mimeType, data: audio } }] }],
        config: { systemInstruction: FP_SYSTEM_PROMPT, responseMimeType: 'application/json' }
      });
      const usage = response.usageMetadata;
      const usageData = {
        promptTokenCount: usage?.promptTokenCount || 0,
        candidatesTokenCount: usage?.candidatesTokenCount || 0,
        totalTokenCount: usage?.totalTokenCount || 0
      };
      if (usage) updateTokens(usageData.promptTokenCount, usageData.candidatesTokenCount);
      const text = response.text;
      if (!text) return { result: 'PARSE_ERROR', usage: usageData };
      try { return { result: fpExtractJSON(text) as FPGeminiResponse, usage: usageData }; }
      catch { return { result: 'PARSE_ERROR', usage: usageData }; }
    } catch (err: any) {
      const msg = JSON.stringify(err).toLowerCase();
      if (msg.includes('429') || msg.includes('quota') || msg.includes('resource_exhausted')) {
        if (retries < 3) {
          const wait = [15000, 30000, 45000][retries];
          await new Promise(r => setTimeout(r, wait));
          return fpProcessRecording(url, retries + 1);
        }
      }
      if (msg.includes('fetch')) return { result: { status: 'FETCH_FAILED' }, usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
      return retries === 0 ? fpProcessRecording(url, 1) : { result: 'ERROR', usage: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 } };
    }
  };

  const fpProcessUID = async (uidItem: FPGroupedUID) => {
    let finalResult: AuditResult = { status: 'NOT_FOUND', recordingsChecked: 0, totalRecordings: uidItem.recordings.length, totalTokens: 0 };
    let bestCandidate: any = null;
    let accumulatedTokens = 0;

    for (let i = 0; i < uidItem.recordings.length; i++) {
      if (fpStopRef.current) break;
      const url = uidItem.recordings[i];
      setFpData(prev => prev.map(item => item.uid === uidItem.uid ? { ...item, result: { ...item.result, status: 'PROCESSING', recordingsChecked: i + 1 } } : item));

      let noisyRetries = 0;
      let parseRetries = 0;
      let shouldBreak = false;

      while (noisyRetries <= 2 && parseRetries <= 2) {
        const { result, usage } = await fpProcessRecording(url);
        accumulatedTokens += usage.totalTokenCount;

        if (result === 'ERROR') { finalResult = { ...finalResult, status: 'PARSE_ERROR', recordingsChecked: i + 1 }; shouldBreak = true; break; }
        if (typeof result === 'object' && result !== null && 'status' in result && result.status === 'FETCH_FAILED') { finalResult = { ...finalResult, status: 'FETCH_FAILED', recordingsChecked: i + 1 }; break; }
        if (result === 'PARSE_ERROR') { parseRetries++; if (parseRetries > 2) { finalResult = { ...finalResult, status: 'PARSE_ERROR', recordingsChecked: i + 1 }; break; } await new Promise(r => setTimeout(r, 1000)); continue; }

        if (typeof result === 'object' && result !== null && 'status' in result) {
          if (result.status === 'PAYMENT_CONSENT_FOUND') {
            const conf = result.confidence || 0;
            if (conf >= 75) {
              if (!bestCandidate || conf > bestCandidate.confidence) {
                bestCandidate = { confidence: conf, timestamp: result.timestamp, statement: result.statement, transcriptEnglish: result.transcript_english, recordingLink: url, recordingsChecked: i + 1 };
              }
              if (conf >= 90) {
                finalResult = { status: 'PAYMENT_CONSENT_FOUND', timestamp: bestCandidate.timestamp, confidence: bestCandidate.confidence, statement: bestCandidate.statement, transcriptEnglish: bestCandidate.transcriptEnglish, recordingLink: bestCandidate.recordingLink, recordingsChecked: i + 1, totalRecordings: uidItem.recordings.length };
                shouldBreak = true;
              }
            } else {
              finalResult = { ...finalResult, status: 'NOT_FOUND', recordingsChecked: i + 1 };
            }
            break;
          }
          if (result.status === 'NOT_FOUND') { finalResult = { ...finalResult, status: 'NOT_FOUND', recordingsChecked: i + 1 }; break; }
          if (result.status === 'NOISY_AUDIO') { noisyRetries++; if (noisyRetries > 2) { finalResult = { ...finalResult, status: 'NOISY_AUDIO_UNABLE_TO_AUDIT', recordingsChecked: i + 1 }; break; } await new Promise(r => setTimeout(r, 1000)); continue; }
        }
        break;
      }
      if (shouldBreak) break;
      await new Promise(r => setTimeout(r, 1000));
    }

    if (finalResult.status !== 'PAYMENT_CONSENT_FOUND' && bestCandidate) {
      finalResult = bestCandidate.confidence >= 90
        ? { status: 'PAYMENT_CONSENT_FOUND', timestamp: bestCandidate.timestamp, confidence: bestCandidate.confidence, statement: bestCandidate.statement, transcriptEnglish: bestCandidate.transcriptEnglish, recordingLink: bestCandidate.recordingLink, recordingsChecked: finalResult.recordingsChecked, totalRecordings: uidItem.recordings.length }
        : { status: 'PARTIAL_CONFIRMATION', timestamp: bestCandidate.timestamp, confidence: bestCandidate.confidence, statement: bestCandidate.statement, transcriptEnglish: bestCandidate.transcriptEnglish, recordingLink: bestCandidate.recordingLink, recordingsChecked: finalResult.recordingsChecked, totalRecordings: uidItem.recordings.length };
    }

    finalResult.totalTokens = accumulatedTokens;
    setFpData(prev => prev.map(item => item.uid === uidItem.uid ? { ...item, result: finalResult } : item));
    
    if (!fpStopRef.current && finalResult.recordingsChecked > 0 && finalResult.status !== 'PENDING') {
      saveToFpHistory({
        uid: uidItem.uid,
        status: finalResult.status,
        audioTimestamp: finalResult.timestamp,
        confidence: finalResult.confidence,
        statement: finalResult.statement,
        transcriptEnglish: finalResult.transcriptEnglish,
        recordingLink: finalResult.recordingLink,
        mode: 'bulk',
        totalTokens: accumulatedTokens
      });
    }
  };

  const fpStartProcessing = async () => {
    if (fpData.length === 0 || !apiKey) return;
    setFpIsProcessing(true);
    fpStopRef.current = false;
    warned80Ref.current = false;
    for (const item of fpData) {
      if (fpStopRef.current) break;
      if (item.result.status === 'PAYMENT_CONSENT_FOUND') continue;
      const currentTokens = parseInt(localStorage.getItem('combined_total_tokens') || '0');
      if (currentTokens >= tokenLimit) { alert('Token limit reached.'); break; }
      if (currentTokens >= tokenLimit * 0.8 && !warned80Ref.current) { alert('Warning: 80% of token limit reached.'); warned80Ref.current = true; }
      setFpCurrentUID(item.uid);
      await fpProcessUID(item);
      await new Promise(r => setTimeout(r, 1000));
    }
    setFpIsProcessing(false);
    setFpCurrentUID(null);
  };

  const fpDownloadCSV = () => {
    const escape = (v: any) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const headers = ['userId', 'Self Declaration', 'Status', 'FP Recording Link', 'Timestamp', 'Confidence', 'Statement', 'Transcript (English)', 'Recordings Checked'];
    const rows = fpData.map(item => [item.uid, item.selfDeclaration || '', item.result.status, item.result.recordingLink || '', item.result.timestamp || '', item.result.confidence || '', item.result.statement || '', item.result.transcriptEnglish || '', `${item.result.recordingsChecked} of ${item.result.totalRecordings}`]);
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'fp_audit_results.csv'; a.click();
  };

  const handleSingleFpAudit = async () => {
    if (!fpSingleLink) return;
    setFpSingleLoading(true);
    setFpSingleResult(null);
    try {
      const { result, usage } = await fpProcessRecording(fpSingleLink);
      if (result === 'PARSE_ERROR' || result === 'ERROR') {
        setFpSingleResult({ status: 'ERROR' } as any);
      } else if (typeof result === 'object' && result !== null) {
        setFpSingleResult(result);
        if (!('status' in result && result.status === 'FETCH_FAILED')) {
          const geminiRes = result as FPGeminiResponse;
          saveToFpHistory({
            uid: fpSingleUID,
            status: geminiRes.status as AuditStatus,
            audioTimestamp: geminiRes.timestamp,
            confidence: geminiRes.confidence,
            statement: geminiRes.statement,
            transcriptEnglish: geminiRes.transcript_english,
            recordingLink: fpSingleLink,
            mode: 'single',
            totalTokens: usage.totalTokenCount
          });
        }
      }
    } catch (err) {
      console.error(err);
      setFpSingleResult({ status: "ERROR" } as any);
    }
    setFpSingleLoading(false);
  };

  const fpStats = useMemo(() => {
    const processed = fpData.filter(d => d.result.status !== 'PENDING').length;
    const found = fpData.filter(d => d.result.status === 'PAYMENT_CONSENT_FOUND').length;
    const partial = fpData.filter(d => d.result.status === 'PARTIAL_CONFIRMATION').length;
    return { processed, total: fpData.length, found, partial };
  }, [fpData]);

  const filteredFpHistory = useMemo(() => {
    return fpHistory.filter(h => {
      const matchesSearch = h.uid.toLowerCase().includes(fpHistorySearch.toLowerCase());
      const matchesStatus = fpHistoryStatusFilter === 'ALL' || h.status === fpHistoryStatusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [fpHistory, fpHistorySearch, fpHistoryStatusFilter]);

  const downloadFilteredFpHistory = () => {
    const escape = (v: any) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const headers = ['Date', 'userId', 'Mode', 'Status', 'Time', 'Confidence', 'Statement', 'Transcript (EN)', 'Link'];
    const rows = filteredFpHistory.map(item => [
      escape(item.auditDate), escape(item.uid), escape(item.mode), escape(item.status),
      escape(item.audioTimestamp || ''), escape(item.confidence || ''), escape(item.statement || ''),
      escape(item.transcriptEnglish || ''), escape(item.recordingLink || '')
    ]);
    const csv = [headers, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `fp_history_${fpHistoryStatusFilter.toLowerCase()}.csv`; a.click();
  };

  const fpDashboardStats = useMemo(() => {
    const last7Days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - i);
      return d.toLocaleDateString();
    }).reverse();
    const chartData = last7Days.map(date => {
      const dayAudits = fpHistory.filter(h => h.auditDate.split(',')[0] === date);
      return {
        name: date.split('/')[0] + '/' + date.split('/')[1],
        audits: dayAudits.length,
        found: dayAudits.filter(h => h.status === 'PAYMENT_CONSENT_FOUND').length
      };
    });
    const totalAudits = fpHistory.length;
    const foundAudits = fpHistory.filter(h => h.status === 'PAYMENT_CONSENT_FOUND').length;
    const successRate = totalAudits > 0 ? ((foundAudits / totalAudits) * 100).toFixed(1) : "0.0";
    return { chartData, totalAudits, foundAudits, successRate };
  }, [fpHistory]);

  const addToHistory = (analysis: VideoAnalysis) => {
    setHistory(prev => {
      const updated = [analysis, ...prev];
      const toSave = updated.map(item => ({ ...item, faceScreenshot: undefined }));
      saveHistory(toSave);
      return updated;
    });
  };

  const handleAnalyze = async (
    e?: React.FormEvent,
    manualData?: { name: string; url: string; recordId?: string }
  ): Promise<VideoAnalysis> => {
    if (e) e.preventDefault();

    if (quotaUsage.videosRemaining <= 0) {
      const msg = 'Daily video quota (1500) reached. Resets at midnight.';
      if (!manualData) setAnalysisError(msg);
      throw new Error(msg);
    }

    const name = (manualData?.name || recordingName).trim();
    const url = (manualData?.url || videoUrl).trim();

    if (!name || !url) {
      const msg = 'Please provide both a UID and a video URL.';
      if (!manualData) setAnalysisError(msg);
      throw new Error(msg);
    }
    if (!url.startsWith('http')) {
      const msg = 'Invalid URL. Must start with http:// or https://';
      if (!manualData) setAnalysisError(msg);
      throw new Error(msg);
    }

    if (!manualData) {
      setIsAnalyzing(true);
      setAnalysisError('');
      setCurrentAnalysis(null);
    }

    try {
      const { frames, audio, audioMimeType, hasAudio } = await processVideoLocally(url);

      // Single Step Analysis (Text Only)
      // transcribeAndIdentify now handles the full analysis using ANALYSIS_PROMPT and a simulated transcript
      const step1 = await transcribeAndIdentify(audio, audioMimeType, frames, apiKey);
      console.log('Gemini API Response Data:', step1.data);
      console.log('Gemini API Usage:', step1.usage);
      
      const result = step1.data;
      result.speakerType = (result.speakerType || '').toLowerCase().trim();
      result.videoClarity = result.videoClarity
        ? result.videoClarity.charAt(0).toUpperCase() + result.videoClarity.slice(1).toLowerCase()
        : 'Clear';
      result.sentiment = result.sentiment || 'Neutral';
      result.language = result.language || 'Unknown';
      result.transcript = result.transcript || 'NO AUDIO DETECTED';
      result.transcriptEnglish = result.transcriptEnglish || '';

      const usage = step1.usage;
      
      const totalPromptTokens = usage?.promptTokenCount || 0;
      const totalCandidatesTokens = usage?.candidatesTokenCount || 0;
      const totalTokens = usage?.totalTokenCount || 0;

      // Update shared token counter
      updateTokens(totalPromptTokens, totalCandidatesTokens);

      const id = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

      const analysisData: VideoAnalysis = {
        ...result,
        id,
        recordingName: name,
        videoUrl: url,
        recordId: manualData?.recordId,
        timestamp: Date.now(),
        faceScreenshot: `data:image/jpeg;base64,${frames[1]}`,
        loanMentionTimestamp: result.loanWordTimestamp,
        documentMentionTimestamp: result.documentWordTimestamp,
        promptTokens: totalPromptTokens,
        candidatesTokens: totalCandidatesTokens,
        totalTokens: totalTokens,
      };

      addToHistory(analysisData);

      if (!manualData) {
        setCurrentAnalysis(analysisData);
        setRecordingName('');
        setVideoUrl('');
      }

      return analysisData;
    } catch (err: any) {
      console.error('Analysis Error:', err);
      const msg = err.message || 'Analysis failed. Check the URL and try again.';
      if (!manualData) setAnalysisError(msg);
      throw new Error(msg);
    } finally {
      if (!manualData) setIsAnalyzing(false);
    }
  };

  useEffect(() => {
    if (!isBulkProcessing) return;
    if (bulkIndex >= bulkQueue.length) {
      setIsBulkProcessing(false);
      isProcessingRef.current = false;
      return;
    }
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;

    const item = bulkQueue[bulkIndex];
    if (item.status === 'completed') {
      isProcessingRef.current = false;
      setBulkIndex(p => p + 1);
      return;
    }

    const run = async () => {
      setBulkQueue(prev => prev.map((it, i) =>
        i === bulkIndex ? { ...it, status: 'processing', error: undefined } : it));
      
      try {
        const result = await retryWithBackoff(() => 
          handleAnalyze(undefined, { name: item.name, url: item.url, recordId: item.recordId })
        );
        
        setBulkQueue(prev => prev.map((it, i) =>
          i === bulkIndex ? { ...it, status: 'completed', analysisId: result.id } : it));
        
        console.log(`Successfully processed: ${item.name}`);
      } catch (err: any) {
        console.error(`Error processing ${item.name}:`, err);
        setBulkQueue(prev => prev.map((it, i) =>
          i === bulkIndex ? { ...it, status: 'failed', error: err.message } : it));
      } finally {
        // Sequential delay of 15 seconds after each item
        await delay(15000);
        isProcessingRef.current = false;
        setBulkIndex(p => p + 1);
      }
    };
    run();
  }, [isBulkProcessing, bulkIndex]);

  const handleRetryBulkItem = (index: number) => {
    setBulkQueue(prev => prev.map((it, i) =>
      i === index ? { ...it, status: 'pending', error: undefined } : it));
    if (!isBulkProcessing) {
      isProcessingRef.current = false;
      setBulkIndex(index);
      setIsBulkProcessing(true);
    }
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: (h: string) => h.trim(),
      complete: (results) => {
        const data = results.data as any[];
        const previewRows: CsvRow[] = data.map(row => {
          const getCol = (...keys: string[]) => {
            for (const key of keys) {
              const found = Object.keys(row).find(k => k.trim().toLowerCase() === key.trim().toLowerCase());
              if (found && row[found]?.toString().trim()) return row[found].toString().trim();
            }
            return '';
          };
          const name = getCol('UID', 'Lead UID', 'Program UID', 'recordingName', 'Name');
          const url = getCol('Academy PRE Loan Journey: Self Declaration Video URL', 'SD video link', 'SD Video Link', 'videoUrl', 'Video URL', 'URL');
          const recordId = getCol('Academy PRE Loan Journey: Record ID', 'Record ID', 'RecordID', 'Lead ID', 'ID');
          const errors: string[] = [];
          if (!name) errors.push('UID missing');
          if (!url) errors.push('Video URL missing');
          else if (!url.startsWith('http')) errors.push('Invalid URL format');
          return { name, url, recordId, errors, rawData: row };
        });
        if (previewRows.length === 0) { setAnalysisError('CSV file is empty.'); return; }
        setCsvPreviewRows(previewRows);
        setShowCsvPreview(true);
        e.target.value = '';
      },
    });
  };

  const startBulkAnalysis = () => {
    const validQueue = csvPreviewRows
      .filter(r => r.errors.length === 0)
      .map(r => ({ name: r.name, url: r.url, recordId: r.recordId, status: 'pending' as const }));
    if (validQueue.length === 0) { alert('No valid rows to process.'); return; }
    setBulkQueue(validQueue);
    setBulkIndex(0);
    isProcessingRef.current = false;
    setIsBulkProcessing(true);
    setShowCsvPreview(false);
    setCsvPreviewRows([]);
  };

  const downloadHistoryCsv = () => {
    const csvData = filteredHistory.map(item => ({
      'Lead UID': item.recordingName,
      'Record ID': item.recordId || '',
      'Language': item.language,
      'Speaker Type': item.speakerType,
      'Relationship': item.specificRelationship,
      'Sentiment': item.sentiment,
      'Loan Word Used': item.loanWordUsed ? 'Yes' : 'No',
      'Loan Mention Time': item.loanMentionTimestamp || '',
      'Loan Word Speaker': item.loanWordSpeaker || 'N/A',
      'Document Word Used': item.documentWordUsed ? 'Yes' : 'No',
      'Document Mention Time': item.documentMentionTimestamp || '',
      'SD Video Status': getSDVideoStatus(item),
      'Video Clarity': item.videoClarity,
      'Face Visible': item.faceVisible ? 'Yes' : 'No',
      'Audit Remarks': (item.transcriptEnglish || item.transcript || ''),
      'Video URL': item.videoUrl,
      'Total Tokens': item.totalTokens || 0,
    }));
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `sd_audit_report_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const downloadBulkReport = () => {
    const csvData = bulkQueue.map(item => {
      const rec = history.find(h => h.id === item.analysisId);
      return {
        'Lead UID': item.name,
        'Record ID': item.recordId || (rec ? rec.recordId : ''),
        'Video URL': item.url,
        'Processing Status': item.status.toUpperCase(),
        'SD Video Status': rec ? getSDVideoStatus(rec) : 'N/A',
        'Loan Word Used': rec ? (rec.loanWordUsed ? 'Yes' : 'No') : 'N/A',
        'Loan Mention Time': rec ? (rec.loanMentionTimestamp || '') : '',
        'Document Word Used': rec ? (rec.documentWordUsed ? 'Yes' : 'No') : 'N/A',
        'Document Mention Time': rec ? (rec.documentMentionTimestamp || '') : '',
        'Audit Remarks': rec ? (rec.transcriptEnglish || rec.transcript || '') : ''
      };
    });
    const csv = Papa.unparse(csvData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `bulk_report_${Date.now()}.csv`;
    link.click();
  };

  const downloadSampleCsv = () => {
    const sample = [
      { 'Program UID': 'Loan_App_001', 'SD video link': 'https://nw-sales-prdzn-media-static.s3.ap-south-1.amazonaws.com/prod/media/co_applicant_self_declaration/0ab312a2-6f58-4885-ace0-08c79001b4ba.mp4' },
      { 'Program UID': 'Loan_App_002', 'SD video link': 'https://nw-sales-prdzn-media-static.s3.ap-south-1.amazonaws.com/prod/media/co_applicant_self_declaration/0ab312a2-6f58-4885-ace0-08c79001b4ba.mp4' },
    ];
    const csv = Papa.unparse(sample);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'sample_bulk_upload.csv';
    link.click();
  };

  const clearBulkQueue = () => {
    if (window.confirm('Clear the bulk processing dashboard?')) {
      setBulkQueue([]);
      setBulkIndex(0);
      setIsBulkProcessing(false);
      isProcessingRef.current = false;
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0a0a0a] p-4">
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="max-w-md w-full">
          <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl shadow-2xl">
            <div className="flex justify-center mb-8">
              <div className="w-16 h-16 bg-indigo-500 rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <ShieldCheck className="w-8 h-8 text-white" />
              </div>
            </div>
            <h1 className="text-3xl font-bold text-white text-center mb-2">Quality Analyst AI</h1>
            <p className="text-zinc-400 text-center mb-8">Sign in to access the analysis dashboard</p>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 ml-1">Email Address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  placeholder="admin@example.com" required />
              </div>
              <div>
                <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 ml-1">Password</label>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                  className="w-full bg-zinc-800 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                  placeholder="••••••••" required />
              </div>
              {loginError && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm">
                  <AlertCircle className="w-4 h-4 shrink-0" /><p>{loginError}</p>
                </div>
              )}
              <button type="submit" disabled={isLoggingIn}
                className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center justify-center gap-2">
                {isLoggingIn ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Sign In'}
              </button>
            </form>
            <div className="mt-6 pt-6 border-t border-zinc-800 text-center">
              <p className="text-zinc-500 text-sm">Use your admin credentials to sign in</p>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050505] text-zinc-100 font-sans">
      <AnimatePresence>
        {showCsvPreview && (
          <CsvPreviewModal rows={csvPreviewRows} onClose={() => setShowCsvPreview(false)} onConfirm={startBulkAnalysis} />
        )}
      </AnimatePresence>

      <nav className="border-b border-zinc-800 bg-zinc-950/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between h-20 items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-white" />
              </div>
              <span className="text-xl font-bold tracking-tight">Audit <span className="text-indigo-500">Suite</span></span>
            </div>
            <div className="flex items-center gap-6">
              <div className="hidden md:flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
                <button onClick={() => setActiveTab('home')}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                    activeTab === 'home' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
                  <LayoutDashboard className="w-4 h-4" /> Home
                </button>
                <button onClick={() => { setPreviousTab(activeTab); setActiveTab('analyze'); }}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                    activeTab === 'analyze' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
                  <Video className="w-4 h-4" /> SD Audit
                </button>
                <button onClick={() => { setPreviousTab(activeTab); setActiveTab('fp_audit'); }}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                    (activeTab === 'fp_audit' || activeTab === 'fp_dashboard' || activeTab === 'fp_history' || activeTab === 'fp_guide') ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
                  <Zap className="w-4 h-4" /> FP Audit
                </button>
                <button onClick={() => { setPreviousTab(activeTab); setActiveTab('tata_tele_api'); }}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                    activeTab === 'tata_tele_api' ? 'bg-indigo-600 text-white shadow-sm shadow-indigo-600/20' : 'text-indigo-400 hover:text-indigo-300 hover:bg-zinc-800')}>
                  <Server className="w-4 h-4" /> Tata Tele API
                </button>
                <button onClick={() => { setPreviousTab(activeTab); setActiveTab('history'); }}
                  className={cn('px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2',
                    activeTab === 'history' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200')}>
                  <History className="w-4 h-4" /> History
                </button>
              </div>
              
              <div className="h-8 w-px bg-zinc-800" />
              
              <button 
                onClick={() => setShowAdminPanel(true)}
                className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-xl transition-all"
                title="Admin Settings"
              >
                <Settings className="w-5 h-5" />
              </button>
              <button onClick={handleLogout} className="p-2 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded-xl transition-all" title="Logout">
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </nav>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <AnimatePresence mode="wait">
          {activeTab === 'home' && (
            <motion.div key="home" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-12 py-8">
              <div className="text-center space-y-4">
                <h2 className="text-4xl font-bold tracking-tight text-white">Welcome back, <span className="text-indigo-500">Admin</span></h2>
                <p className="text-zinc-400 text-lg">Select the audit tool you want to use</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-6xl mx-auto">
                {/* SD Video Audit Card */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-8 flex flex-col h-full hover:border-indigo-500/50 transition-all group relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-3xl -mr-16 -mt-16" />
                  <div className="mb-6">
                    <div className="w-14 h-14 bg-indigo-500/10 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                      <Video className="w-7 h-7 text-indigo-400" />
                    </div>
                  </div>
                  <h3 className="text-2xl font-bold text-white mb-3">SD Video Audit</h3>
                  <p className="text-zinc-400 mb-6 text-sm leading-relaxed">
                    Analyze self-declaration videos for NBFC loan compliance. Detects loan & document keywords, speaker type, and video clarity.
                  </p>
                  <ul className="space-y-2.5 mb-8 flex-1">
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                      Single & bulk video analysis
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                      Telugu, Hindi, Tamil, Kannada, Malayalam
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-indigo-500 rounded-full" />
                      Parent / student detection
                    </li>
                  </ul>
                  <button 
                    onClick={() => { setPreviousTab('home'); setActiveTab('analyze'); }}
                    className="w-full py-3.5 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all flex items-center justify-center gap-2 text-sm"
                  >
                    Open SD Audit <ArrowUpRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Full Payment Audit Card */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-8 flex flex-col h-full hover:border-amber-500/50 transition-all group relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 blur-3xl -mr-16 -mt-16" />
                  <div className="mb-6">
                    <div className="w-14 h-14 bg-amber-500/10 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                      <Zap className="w-7 h-7 text-amber-400" />
                    </div>
                  </div>
                  <h3 className="text-2xl font-bold text-white mb-3">Full Payment Audit</h3>
                  <p className="text-zinc-400 mb-6 text-sm leading-relaxed">
                    Detect payment consent in call recordings. Finds exact timestamp where student confirmed full payment through PRE's link.
                  </p>
                  <ul className="space-y-2.5 mb-8 flex-1">
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                      Bulk CSV processing from Salesforce
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                      Exact MM:SS timestamp extraction
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-amber-500 rounded-full" />
                      Confidence scoring & verbatim transcripts
                    </li>
                  </ul>
                  <button 
                    onClick={() => { setPreviousTab('home'); setActiveTab('fp_audit'); }}
                    className="w-full py-3.5 bg-amber-600 text-white rounded-xl font-bold hover:bg-amber-500 transition-all flex items-center justify-center gap-2 text-sm"
                  >
                    Open FP Audit <ArrowUpRight className="w-4 h-4" />
                  </button>
                </div>

                {/* Tata Tele Call Recording API Card */}
                <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-8 flex flex-col h-full hover:border-emerald-500/50 transition-all group relative overflow-hidden">
                  <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/5 blur-3xl -mr-16 -mt-16" />
                  <div className="mb-6 flex items-center justify-between">
                    <div className="w-14 h-14 bg-emerald-500/10 rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform duration-500">
                      <Server className="w-7 h-7 text-emerald-400" />
                    </div>
                    <span className="px-2.5 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-mono font-bold rounded-full">
                      POST /api/audit/tata-tele
                    </span>
                  </div>
                  <h3 className="text-2xl font-bold text-white mb-3">Tata Tele API</h3>
                  <p className="text-zinc-400 mb-6 text-sm leading-relaxed">
                    Dedicated REST & Webhook endpoint to audit Tata Tele / Smartflo call recording links with Gemini AI directly.
                  </p>
                  <ul className="space-y-2.5 mb-8 flex-1">
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                      Direct REST endpoint for Tata Tele links
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                      Smartflo Webhook & Multi-call chain
                    </li>
                    <li className="flex items-center gap-2.5 text-xs text-zinc-300">
                      <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full" />
                      Batch processing endpoint (<code className="text-emerald-400 font-mono">/batch</code>)
                    </li>
                  </ul>
                  <button 
                    onClick={() => { setPreviousTab('home'); setActiveTab('tata_tele_api'); }}
                    className="w-full py-3.5 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-500 transition-all flex items-center justify-center gap-2 text-sm"
                  >
                    Open API Suite <ArrowUpRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="text-center pt-8">
                <p className="text-zinc-500 text-sm flex items-center justify-center gap-2">
                  <ShieldCheck className="w-4 h-4" /> Both tools share one API key and token counter. Switch between them anytime using the header tabs.
                </p>
              </div>
            </motion.div>
          )}

          {activeTab === 'analyze' && (
            <motion.div key="analyze" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }}
              className="space-y-8">
              <div className="flex items-start justify-between">
                <div className="space-y-4">
                  <button 
                    onClick={() => setActiveTab(previousTab)}
                    className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 transition-colors text-sm font-medium group"
                  >
                    <ChevronLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                    Go Back
                  </button>
                  <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                    <Video className="w-8 h-8 text-indigo-500" /> SD Video Audit
                  </h1>
                </div>
                
                <div className="flex flex-col items-end gap-3">
                  <div className="relative" ref={quotaDropdownRef}>
                    <button 
                      onClick={() => setShowQuotaDropdown(!showQuotaDropdown)}
                      className={cn(
                        "px-4 py-2 rounded-xl transition-all flex items-center gap-2 border text-sm font-bold uppercase tracking-wider",
                        showQuotaDropdown 
                          ? "bg-indigo-500/10 border-indigo-500/50 text-indigo-400" 
                          : "bg-zinc-900 text-zinc-400 hover:text-white hover:bg-zinc-800 border-zinc-800"
                      )}
                    >
                      <Activity className="w-4 h-4" /> Quota
                    </button>

                    <AnimatePresence>
                      {showQuotaDropdown && (
                        <motion.div 
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 10, scale: 0.95 }}
                          className="absolute right-0 mt-3 w-80 bg-zinc-900 border border-zinc-800 rounded-3xl shadow-2xl p-6 z-[60] overflow-hidden"
                        >
                          <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-3xl -mr-16 -mt-16" />
                          
                          <div className="flex items-center justify-between mb-6 relative">
                            <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                              <Activity className="w-4 h-4 text-indigo-500" /> System Quota
                            </h3>
                            <span className="text-[10px] font-bold text-zinc-500 bg-zinc-800 px-2 py-0.5 rounded-full uppercase">Daily</span>
                          </div>
                          
                          <div className="space-y-6 relative">
                            <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800/50">
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Videos</p>
                              <div className="flex items-baseline gap-1">
                                <span className="text-xl font-bold text-white">{quotaUsage.videosRemaining}</span>
                                <span className="text-[10px] text-zinc-500">/ {DAILY_QUOTA.VIDEOS} left</span>
                              </div>
                              <div className="mt-3 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: 0 }} 
                                  animate={{ width: `${(quotaUsage.videosRemaining / DAILY_QUOTA.VIDEOS) * 100}%` }} 
                                  className="h-full bg-indigo-500"
                                />
                              </div>
                            </div>
                            
                            <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800/50">
                              <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-1">Tokens</p>
                              <div className="flex items-baseline gap-1">
                                <span className="text-xl font-bold text-white">{(totalTokensUsed / 1000).toFixed(1)}k</span>
                                <span className="text-[10px] text-zinc-500">/ {(tokenLimit / 1000).toFixed(0)}k used</span>
                              </div>
                              <div className="mt-3 h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                                <motion.div 
                                  initial={{ width: 0 }} 
                                  animate={{ width: `${(totalTokensUsed / tokenLimit) * 100}%` }} 
                                  className={cn("h-full", totalTokensUsed >= tokenLimit ? "bg-red-500" : "bg-emerald-500")}
                                />
                              </div>
                            </div>
                          </div>
                          
                          <p className="mt-6 text-[10px] text-zinc-500 text-center leading-relaxed">
                            Quotas reset at midnight UTC. <br/>
                            Usage is shared across all audit tools.
                          </p>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="flex gap-3 p-1.5 bg-zinc-900/50 border border-zinc-800 rounded-2xl shadow-xl">
                    <button 
                      className={sdSubTab === "dashboard" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                      onClick={() => setSdSubTab("dashboard")}
                    >
                      <BarChart3 className="w-4 h-4" />
                      Dashboard
                    </button>
                    <button 
                      className={sdSubTab === "guide" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                      onClick={() => setSdSubTab("guide")}
                    >
                      <ShieldCheck className="w-4 h-4" />
                      Help / Guide
                    </button>
                  </div>
                </div>
              </div>

              {/* SD Audit Internal Sub-Navigation */}
              <div className="flex items-center justify-between mb-10">
                <div className="flex gap-3 p-1.5 bg-zinc-900/50 border border-zinc-800 rounded-2xl shadow-xl">
                  <button 
                    className={sdSubTab === "bulk" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                    onClick={() => setSdSubTab("bulk")}
                  >
                    <Layers className="w-4 h-4 mr-2.5 inline-block" />
                    Bulk Audit
                  </button>
                  <button 
                    className={sdSubTab === "single" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                    onClick={() => setSdSubTab("single")}
                  >
                    <Search className="w-4 h-4 mr-2.5 inline-block" />
                    Single Audit
                  </button>
                </div>
              </div>

              {sdSubTab === 'single' && (
                <div className="grid grid-cols-1 lg:grid-cols-12 gap-12">
                  <div className="lg:col-span-5 space-y-8">
                    <div className="bg-zinc-900/50 border border-zinc-800 p-8 rounded-3xl">
                      <h2 className="text-2xl font-bold mb-6 flex items-center gap-3">
                        <Search className="w-6 h-6 text-indigo-500" /> New Analysis
                      </h2>
                      <form onSubmit={handleAnalyze} className="space-y-6">
                        <div>
                          <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 ml-1">UID</label>
                          <input type="text" value={recordingName} onChange={e => setRecordingName(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                            placeholder="e.g. Loan Application #123" />
                        </div>
                        <div>
                          <label className="block text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2 ml-1">Video URL (MP4)</label>
                          <input type="url" value={videoUrl} onChange={e => setVideoUrl(e.target.value)}
                            className="w-full bg-zinc-950 border border-zinc-800 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
                            placeholder="https://example.com/video.mp4" />
                        </div>
                        {analysisError && (
                          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-start gap-3 text-red-400 text-sm">
                            <AlertCircle className="w-5 h-5 shrink-0" /><p>{analysisError}</p>
                          </div>
                        )}
                        <button type="submit" disabled={isAnalyzing}
                          className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center justify-center gap-3 shadow-lg shadow-indigo-600/20">
                          {isAnalyzing ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
                          {isAnalyzing ? 'Analyzing...' : 'Analyze'}
                        </button>
                      </form>
                    </div>
                    <div className="p-6 bg-indigo-500/5 border border-indigo-500/10 rounded-3xl">
                      <h3 className="text-sm font-bold text-indigo-400 uppercase tracking-widest mb-4">Sample Links</h3>
                      <div className="space-y-4">
                        <div>
                          <p className="text-zinc-500 text-[10px] uppercase tracking-widest font-bold mb-2">Sample Video URL</p>
                          <p className="text-zinc-400 text-xs mb-2 break-all">https://nw-sales-prdzn-media-static.s3.ap-south-1.amazonaws.com/prod/media/co_applicant_self_declaration/0ab312a2-6f58-4885-ace0-08c79001b4ba.mp4</p>
                          <button onClick={() => setVideoUrl('https://nw-sales-prdzn-media-static.s3.ap-south-1.amazonaws.com/prod/media/co_applicant_self_declaration/0ab312a2-6f58-4885-ace0-08c79001b4ba.mp4')}
                            className="text-xs font-bold text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-2">
                            <CheckCircle2 className="w-3 h-3" /> Use Sample URL
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="lg:col-span-7">
                    {isAnalyzing ? (
                      <div className="h-full min-h-[500px] bg-zinc-900/30 border border-zinc-800 border-dashed rounded-3xl flex flex-col items-center justify-center p-12 text-center">
                        <div className="relative mb-8">
                          <div className="w-24 h-24 border-4 border-indigo-500/20 rounded-full animate-ping absolute inset-0" />
                          <div className="w-24 h-24 border-4 border-indigo-500 rounded-full animate-spin border-t-transparent" />
                          <Video className="w-10 h-10 text-indigo-500 absolute inset-0 m-auto" />
                        </div>
                        <h3 className="text-2xl font-bold mb-2">Processing Video</h3>
                        <p className="text-zinc-500 max-w-xs">Extracting frames, analyzing audio and detecting loan and document words...</p>
                      </div>
                    ) : currentAnalysis ? (
                      <AnalysisCard analysis={currentAnalysis} />
                    ) : (
                      <div className="space-y-8">
                        <div className="bg-zinc-900/30 border border-zinc-800 rounded-3xl p-12 text-center flex flex-col items-center justify-center min-h-[300px]">
                          <div className="w-20 h-20 bg-zinc-800 rounded-3xl flex items-center justify-center mb-6">
                            <FileVideo className="w-10 h-10 text-zinc-600" />
                          </div>
                          <h3 className="text-xl font-bold mb-2 text-zinc-400">No Active Analysis</h3>
                          <p className="text-zinc-600 max-w-xs">Enter a video URL and UID to start quality analysis.</p>
                        </div>

                        {history.filter(h => h.type === 'sd').length > 0 && (
                          <div className="bg-zinc-900/50 border border-zinc-800 rounded-3xl p-8">
                            <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-6 flex items-center gap-2">
                              <HistoryIcon className="w-4 h-4 text-indigo-500" />
                              Recent SD Audits
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                              {history.filter(h => h.type === 'sd').slice(0, 4).map((audit, idx) => (
                                <button 
                                  key={audit.id} 
                                  onClick={() => setCurrentAnalysis(audit)}
                                  className="p-5 bg-zinc-950 border border-zinc-800 rounded-2xl hover:border-indigo-500/50 transition-all text-left group flex items-center gap-4"
                                >
                                  <div className={cn(
                                    "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                                    getSDVideoStatus(audit) === 'PASS' ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                                  )}>
                                    <Video className="w-5 h-5" />
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-bold text-zinc-200 truncate">{audit.name}</p>
                                    <p className="text-[10px] text-zinc-500 font-mono truncate">{new Date(audit.timestamp).toLocaleDateString()}</p>
                                  </div>
                                  <div className={cn(
                                    "text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-tighter",
                                    getSDVideoStatus(audit) === 'PASS' ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                                  )}>
                                    {getSDVideoStatus(audit)}
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {sdSubTab === 'bulk' && (
                <div className="space-y-8 animate-in fade-in duration-500">
                  <div className="grid grid-cols-1 gap-8">
                    <div className="space-y-8">
                      <div className="bg-zinc-900/50 border border-zinc-800 p-8 rounded-3xl shadow-xl">
                        <div className="flex items-center justify-between mb-8">
                          <div className="space-y-1">
                            <h2 className="text-2xl font-bold flex items-center gap-3 text-white">
                              <Layers className="w-6 h-6 text-indigo-500" /> Bulk Processing
                            </h2>
                            <p className="text-xs text-zinc-500 uppercase tracking-widest font-medium">Upload multiple videos for automated quality audit</p>
                          </div>
                          <button onClick={downloadSampleCsv}
                            className="px-4 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-xl text-xs font-bold transition-all border border-emerald-500/20 flex items-center gap-2 group">
                            <Download className="w-3.5 h-3.5 group-hover:translate-y-0.5 transition-transform" /> 
                            Download Template
                          </button>
                        </div>
                        
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                          <label className={cn(
                            'relative group py-12 bg-zinc-950 border-2 border-dashed border-zinc-800 hover:border-indigo-500/50 text-zinc-400 rounded-3xl font-bold transition-all cursor-pointer flex flex-col items-center justify-center gap-4 overflow-hidden',
                            isBulkProcessing && 'opacity-50 cursor-not-allowed'
                          )}>
                            <div className="absolute inset-0 bg-indigo-500/0 group-hover:bg-indigo-500/5 transition-colors" />
                            <div className="p-4 bg-zinc-900 rounded-2xl group-hover:scale-110 transition-transform">
                              <Upload className="w-8 h-8 text-zinc-500 group-hover:text-indigo-400 transition-colors" />
                            </div>
                            <div className="text-center space-y-1">
                              <span className="block text-lg">Click to Upload CSV</span>
                              <span className="text-[10px] font-normal text-zinc-600 uppercase tracking-widest">Supports .csv files up to 500 rows</span>
                            </div>
                            <input type="file" accept=".csv" className="hidden" onChange={handleCsvUpload} disabled={isBulkProcessing} />
                          </label>
                          
                          <div className="bg-zinc-950/50 border border-zinc-800 rounded-3xl p-8 flex flex-col justify-between relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 opacity-10 pointer-events-none">
                              <Activity className="w-24 h-24 text-indigo-500" />
                            </div>
                            
                            <div>
                              <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-6 flex items-center gap-2">
                                <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                Processing Status
                              </h3>
                              
                              {bulkQueue.length > 0 ? (
                                <div className="space-y-6">
                                  <div className="flex items-end justify-between">
                                    <div className="space-y-1">
                                      <p className="text-2xl font-mono font-bold text-white tracking-tighter">
                                        {bulkQueue.filter(i => i.status === 'completed').length}
                                        <span className="text-zinc-600 mx-1">/</span>
                                        {bulkQueue.length}
                                      </p>
                                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-bold">Files Completed</p>
                                    </div>
                                    <span className="text-sm font-mono text-indigo-400 font-bold">
                                      {Math.round((bulkQueue.filter(i => i.status === 'completed').length / bulkQueue.length) * 100)}%
                                    </span>
                                  </div>
                                  
                                  <div className="h-3 bg-zinc-800/50 rounded-full overflow-hidden p-0.5 border border-zinc-800">
                                    <motion.div 
                                      className="h-full bg-gradient-to-r from-indigo-600 to-indigo-400 rounded-full shadow-[0_0_10px_rgba(99,102,241,0.5)]" 
                                      initial={{ width: 0 }}
                                      animate={{ width: `${(bulkQueue.filter(i => i.status === 'completed').length / bulkQueue.length) * 100}%` }} 
                                    />
                                  </div>
                                </div>
                              ) : (
                                <div className="flex flex-col items-center justify-center py-6 space-y-3 opacity-40">
                                  <Clock className="w-8 h-8 text-zinc-600" />
                                  <p className="text-zinc-500 text-sm italic">Queue is empty</p>
                                </div>
                              )}
                            </div>

                            <div className="flex gap-3 mt-8">
                              <button onClick={downloadBulkReport} disabled={bulkQueue.length === 0}
                                className="flex-1 flex items-center justify-center gap-2 py-3 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-xs font-bold transition-all border border-zinc-700 disabled:opacity-50 disabled:cursor-not-allowed group">
                                <Download className="w-3.5 h-3.5 group-hover:translate-y-0.5 transition-transform" /> 
                                Export Report
                              </button>
                              {!isBulkProcessing && bulkQueue.length > 0 && (
                                <button onClick={clearBulkQueue}
                                  className="px-4 flex items-center justify-center bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-xl text-xs font-bold transition-all border border-red-500/20" title="Clear Queue">
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {bulkQueue.length > 0 && (
                        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}
                          className="bg-zinc-900/50 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl flex flex-col">
                          <div className="px-8 py-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/30">
                            <h3 className="text-sm font-bold text-zinc-400 uppercase tracking-widest flex items-center gap-2">
                              <HistoryIcon className="w-4 h-4 text-indigo-500" />
                              Processing Queue
                            </h3>
                            <span className="text-[10px] font-mono text-zinc-500">{bulkQueue.length} items</span>
                          </div>
                          <div className="overflow-auto max-h-[500px]">
                            <table className="w-full text-left border-collapse">
                              <thead className="bg-zinc-800/30 text-zinc-500 text-[10px] font-bold uppercase tracking-wider sticky top-0 z-10">
                                <tr>
                                  <th className="px-8 py-4">Status</th>
                                  <th className="px-8 py-4">UID & Source</th>
                                  <th className="px-8 py-4 text-right">Action</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-zinc-800/50">
                                {bulkQueue.map((item, idx) => (
                                  <tr key={idx} className={cn('group transition-colors', item.status === 'processing' ? 'bg-indigo-500/5' : 'hover:bg-zinc-800/30')}>
                                    <td className="px-8 py-5">
                                      {item.status === 'pending' && <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-zinc-500 bg-zinc-500/10 px-2.5 py-1 rounded-full uppercase"><Clock className="w-3 h-3" />Pending</span>}
                                      {item.status === 'processing' && <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-indigo-400 bg-indigo-400/10 px-2.5 py-1 rounded-full uppercase"><Loader2 className="w-3 h-3 animate-spin" />Processing</span>}
                                      {item.status === 'completed' && <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-full uppercase"><CheckCircle2 className="w-3 h-3" />Done</span>}
                                      {item.status === 'failed' && (
                                        <div className="flex flex-col gap-1">
                                          <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-red-400 bg-red-400/10 px-2.5 py-1 rounded-full uppercase w-fit"><AlertCircle className="w-3 h-3" />Failed</span>
                                          <p className="text-[10px] text-red-500/70 max-w-[150px] truncate" title={item.error}>{item.error}</p>
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-8 py-5">
                                      <div className="space-y-1">
                                        <p className="text-sm font-mono font-bold text-zinc-300 truncate max-w-[200px]" title={item.name}>{item.name}</p>
                                        <p className="text-[10px] text-zinc-500 font-mono truncate max-w-[200px] flex items-center gap-1.5" title={item.url}>
                                          <FileVideo className="w-3 h-3" /> {item.url}
                                        </p>
                                      </div>
                                    </td>
                                    <td className="px-8 py-5 text-right">
                                      <div className="flex justify-end gap-2">
                                        {item.status === 'failed' && (
                                          <button onClick={() => handleRetryBulkItem(idx)} className="p-2.5 hover:bg-indigo-500/10 text-indigo-400 rounded-xl transition-all hover:scale-110" title="Retry">
                                            <RotateCcw className="w-4 h-4" />
                                          </button>
                                        )}
                                        {item.status === 'completed' && item.analysisId && (
                                          <button onClick={() => { const a = history.find(h => h.id === item.analysisId); if (a) { setCurrentAnalysis(a); setSdSubTab('single'); window.scrollTo({ top: 0, behavior: 'smooth' }); } }}
                                            className="p-2.5 hover:bg-emerald-500/10 text-emerald-400 rounded-xl transition-all hover:scale-110" title="View Result">
                                            <Eye className="w-4 h-4" />
                                          </button>
                                        )}
                                      </div>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </motion.div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {sdSubTab === 'dashboard' && (
                <div className="space-y-10 animate-in fade-in duration-500">
                  {/* Dashboard Stats */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-indigo-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Total SD Audits</p>
                        <div className="p-3 bg-indigo-500/10 rounded-xl group-hover:bg-indigo-500/20 transition-colors">
                          <Activity className="w-5 h-5 text-indigo-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">
                        {history.filter(h => h.type === 'sd').length}
                      </h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Lifetime video audits</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-emerald-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Pass Rate</p>
                        <div className="p-3 bg-emerald-500/10 rounded-xl group-hover:bg-emerald-500/20 transition-colors">
                          <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">
                        {history.filter(h => h.type === 'sd').length > 0 
                          ? Math.round((history.filter(h => h.type === 'sd' && getSDVideoStatus(h) === 'PASS').length / history.filter(h => h.type === 'sd').length) * 100) 
                          : 0}%
                      </h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Compliance success</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-indigo-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Loan Word Detection</p>
                        <div className="p-3 bg-indigo-500/10 rounded-xl group-hover:bg-indigo-500/20 transition-colors">
                          <Zap className="w-5 h-5 text-indigo-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">
                        {history.filter(h => h.type === 'sd').length > 0 
                          ? Math.round((history.filter(h => h.type === 'sd' && h.loanWordUsed).length / history.filter(h => h.type === 'sd').length) * 100) 
                          : 0}%
                      </h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Keywords found</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-amber-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Avg. Processing</p>
                        <div className="p-3 bg-amber-500/10 rounded-xl group-hover:bg-amber-500/20 transition-colors">
                          <Clock className="w-5 h-5 text-amber-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">42s</h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Per video audit</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8">
                      <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-8 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-indigo-500" /> Audit Trends
                      </h3>
                      <div className="h-[300px] flex items-end justify-between gap-4 px-4">
                        {[40, 70, 45, 90, 65, 85, 55].map((val, i) => (
                          <div key={i} className="flex-1 flex flex-col items-center gap-4 group">
                            <div className="w-full bg-zinc-800 rounded-t-xl relative overflow-hidden transition-all group-hover:bg-zinc-700" style={{ height: `${val}%` }}>
                              <div className="absolute inset-x-0 bottom-0 bg-indigo-500/20 h-full transition-all group-hover:bg-indigo-500/40" />
                            </div>
                            <span className="text-[10px] font-mono text-zinc-600 uppercase tracking-tighter">Day {i+1}</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8">
                      <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest mb-8 flex items-center gap-2">
                        <Activity className="w-4 h-4 text-indigo-500" /> Recent Activity
                      </h3>
                      <div className="space-y-6">
                        {history.filter(h => h.type === 'sd').slice(0, 5).map((audit, i) => (
                          <div key={i} className="flex items-center justify-between p-4 bg-zinc-950/50 border border-zinc-800/50 rounded-2xl">
                            <div className="flex items-center gap-4">
                              <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center",
                                getSDVideoStatus(audit) === 'PASS' ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                              )}>
                                <Video className="w-5 h-5" />
                              </div>
                              <div>
                                <p className="text-sm font-bold text-zinc-200">{audit.name}</p>
                                <p className="text-[10px] text-zinc-500 font-mono">{new Date(audit.timestamp).toLocaleTimeString()}</p>
                              </div>
                            </div>
                            <div className={cn(
                              "text-[10px] font-bold px-3 py-1 rounded-full uppercase tracking-widest",
                              getSDVideoStatus(audit) === 'PASS' ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
                            )}>
                              {getSDVideoStatus(audit)}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {sdSubTab === 'guide' && (
                <div className="max-w-4xl mx-auto space-y-12 animate-in fade-in duration-500">
                  <div className="text-center space-y-4">
                    <h2 className="text-4xl font-bold text-white tracking-tight">SD Audit System Guide</h2>
                    <p className="text-zinc-500 text-lg">Understanding the automated quality assurance process for Self-Declaration videos.</p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-6">
                      <div className="w-12 h-12 bg-indigo-500/10 rounded-2xl flex items-center justify-center">
                        <Video className="w-6 h-6 text-indigo-400" />
                      </div>
                      <h3 className="text-xl font-bold text-white">Visual Analysis</h3>
                      <p className="text-sm text-zinc-400 leading-relaxed">
                        The system extracts high-resolution frames from the video to identify key visual markers. It checks for:
                      </p>
                      <ul className="space-y-3">
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Presence of the customer in the frame
                        </li>
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Lighting and video quality consistency
                        </li>
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" /> Background environment verification
                        </li>
                      </ul>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-6">
                      <div className="w-12 h-12 bg-amber-500/10 rounded-2xl flex items-center justify-center">
                        <Activity className="w-6 h-6 text-amber-400" />
                      </div>
                      <h3 className="text-xl font-bold text-white">Audio Intelligence</h3>
                      <p className="text-sm text-zinc-400 leading-relaxed">
                        Our AI processes the audio track to transcribe speech and detect critical compliance keywords:
                      </p>
                      <ul className="space-y-3">
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" /> <strong>"Loan"</strong> - Must be mentioned clearly
                        </li>
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" /> <strong>"Document"</strong> - Must be mentioned clearly
                        </li>
                        <li className="flex items-center gap-3 text-xs text-zinc-500">
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-500" /> Multi-language support (Hindi/English/Regional)
                        </li>
                      </ul>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                    <div className="md:col-span-1 bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-6">
                      <h3 className="text-xs font-bold text-zinc-500 uppercase tracking-widest flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-indigo-500" />
                        Bulk Audit Guide
                      </h3>
                      
                      <div className="space-y-6">
                        <div className="flex gap-4">
                          <div className="w-8 h-8 rounded-xl bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">1</div>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-zinc-200">Download Template</p>
                            <p className="text-xs text-zinc-500 leading-relaxed">Use our standard CSV format with 'Program UID' and 'SD video link' columns.</p>
                          </div>
                        </div>
                        
                        <div className="flex gap-4">
                          <div className="w-8 h-8 rounded-xl bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">2</div>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-zinc-200">Upload CSV</p>
                            <p className="text-xs text-zinc-500 leading-relaxed">Drag and drop your file. The system will automatically queue all valid video links.</p>
                          </div>
                        </div>
                        
                        <div className="flex gap-4">
                          <div className="w-8 h-8 rounded-xl bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">3</div>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-zinc-200">Monitor Progress</p>
                            <p className="text-xs text-zinc-500 leading-relaxed">Watch the real-time progress bar. You can view individual results as they complete.</p>
                          </div>
                        </div>
                        
                        <div className="flex gap-4">
                          <div className="w-8 h-8 rounded-xl bg-zinc-800 flex items-center justify-center text-xs font-bold text-zinc-400 shrink-0">4</div>
                          <div className="space-y-1">
                            <p className="text-sm font-bold text-zinc-200">Export Results</p>
                            <p className="text-xs text-zinc-500 leading-relaxed">Once finished, download the comprehensive report containing all audit details.</p>
                          </div>
                        </div>
                      </div>

                      <div className="pt-6 border-t border-zinc-800/50">
                        <div className="p-4 bg-indigo-500/5 border border-indigo-500/10 rounded-2xl">
                          <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest mb-2 flex items-center gap-2">
                            <Zap className="w-3 h-3" /> Pro Tip
                          </p>
                          <p className="text-xs text-zinc-400 leading-relaxed">
                            For faster processing, ensure your video links are direct S3 or CDN URLs. Avoid links requiring authentication.
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="md:col-span-2 bg-indigo-600/10 border border-indigo-500/20 p-10 rounded-[40px] relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-10 opacity-10">
                      <ShieldCheck className="w-40 h-40 text-indigo-500" />
                    </div>
                    <div className="relative z-10 space-y-6">
                      <h3 className="text-2xl font-bold text-white">Compliance Checklist</h3>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-6">
                        <div className="flex items-start gap-4">
                          <div className="p-1 bg-emerald-500/20 rounded-full">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </div>
                          <p className="text-sm text-zinc-300">Video must be in MP4 format and publicly accessible via URL.</p>
                        </div>
                        <div className="flex items-start gap-4">
                          <div className="p-1 bg-emerald-500/20 rounded-full">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </div>
                          <p className="text-sm text-zinc-300">The customer must state their name and the purpose of the loan.</p>
                        </div>
                        <div className="flex items-start gap-4">
                          <div className="p-1 bg-emerald-500/20 rounded-full">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </div>
                          <p className="text-sm text-zinc-300">Background noise should be minimal for accurate transcription.</p>
                        </div>
                        <div className="flex items-start gap-4">
                          <div className="p-1 bg-emerald-500/20 rounded-full">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </div>
                          <p className="text-sm text-zinc-300">The video duration should typically be between 15-45 seconds.</p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div key="history" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-8">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-end gap-6">
                <div className="space-y-4">
                  <button 
                    onClick={() => setActiveTab(previousTab)}
                    className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 transition-colors text-sm font-medium group"
                  >
                    <ChevronLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                    Go Back
                  </button>
                  <div className="flex gap-3 p-1.5 bg-zinc-900/50 border border-zinc-800 rounded-2xl w-fit">
                    <button 
                      className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2", historySubTab === 'sd' ? "bg-zinc-800 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200")} 
                      onClick={() => setHistorySubTab('sd')}
                    >
                      <Video className="w-4 h-4" /> SD Audit
                    </button>
                    <button 
                      className={cn("px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2", historySubTab === 'fp' ? "bg-zinc-800 text-white shadow-sm" : "text-zinc-400 hover:text-zinc-200")} 
                      onClick={() => setHistorySubTab('fp')}
                    >
                      <Zap className="w-4 h-4" /> FP Audit
                    </button>
                  </div>
                  <div>
                    <h2 className="text-4xl font-bold tracking-tight mb-2">Audit History</h2>
                    <p className="text-zinc-500">Review past {historySubTab === 'sd' ? 'video quality assessments' : 'payment detection audits'}</p>
                    <div className="mt-2 inline-flex items-center gap-2 text-amber-500/80 text-xs font-medium bg-amber-500/5 border border-amber-500/10 px-3 py-1.5 rounded-lg">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Records auto-delete after 24 hours
                    </div>
                  </div>
                </div>
                
                {historySubTab === 'sd' ? (
                  <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
                    <div className="relative flex-grow md:w-64">
                      <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input type="text" placeholder="Search by UID..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 text-white pl-10 pr-4 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                    <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                      className="bg-zinc-900 border border-zinc-800 text-white px-4 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer">
                      <option value="all">All Statuses</option>
                      <option value="Verified">Verified</option>
                      <option value="SD video done by Student">Done by Student</option>
                      <option value="Irrelevant Video is Uploaded">Irrelevant Video</option>
                      <option value="Uploaded video is not clear">Unclear Video</option>
                      <option value="Loan word Not used">Loan Word Missing</option>
                      <option value="Documents word not mentioned">Documents Word Missing</option>
                      <option value="Loan and Documents word not used">Both Words Missing</option>
                    </select>
                    <button onClick={downloadHistoryCsv} disabled={filteredHistory.length === 0}
                      className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm font-medium border border-zinc-700 transition-all disabled:opacity-50">
                      <Download className="w-4 h-4" /> Export CSV
                    </button>
                    <div className="text-right min-w-[80px]">
                      <span className="text-3xl font-bold text-indigo-500">{filteredHistory.length}</span>
                      <p className="text-xs font-bold text-zinc-600 uppercase tracking-widest">Total Logs</p>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center gap-4 w-full md:w-auto">
                    <div className="relative flex-grow md:w-64">
                      <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input type="text" placeholder="Search by UID..." value={fpHistorySearch} onChange={(e) => setFpHistorySearch(e.target.value)}
                        className="w-full bg-zinc-900 border border-zinc-800 text-white pl-10 pr-4 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500" />
                    </div>
                    <select value={fpHistoryStatusFilter} onChange={(e) => setFpHistoryStatusFilter(e.target.value)}
                      className="bg-zinc-900 border border-zinc-800 text-white px-4 py-2 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer">
                      <option value="ALL">All Statuses</option>
                      <option value="PAYMENT_CONSENT_FOUND">Consent Found</option>
                      <option value="NOT_FOUND">Not Found</option>
                      <option value="NOISY_AUDIO_UNABLE_TO_AUDIT">Noisy / Unclear</option>
                      <option value="FETCH_FAILED">Fetch Failed</option>
                      <option value="PARSE_ERROR">Parse Error</option>
                    </select>
                    <button onClick={downloadFilteredFpHistory} disabled={filteredFpHistory.length === 0}
                      className="flex items-center gap-2 px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-xl text-sm font-medium border border-zinc-700 transition-all disabled:opacity-50">
                      <Download className="w-4 h-4" /> Export CSV
                    </button>
                    <div className="text-right min-w-[80px]">
                      <span className="text-3xl font-bold text-indigo-500">{filteredFpHistory.length}</span>
                      <p className="text-xs font-bold text-zinc-600 uppercase tracking-widest">Total Logs</p>
                    </div>
                  </div>
                )}
              </div>

              {historySubTab === 'sd' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {filteredHistory.map(item => (
                    <div key={item.id} className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden hover:border-indigo-500/50 transition-all group">
                      <div className="aspect-video bg-zinc-950 relative overflow-hidden">
                        {item.faceScreenshot && <img src={item.faceScreenshot} alt="Frame" className="w-full h-full object-contain opacity-80 group-hover:opacity-100 transition-opacity duration-500" />}
                        <div className="absolute inset-0 bg-gradient-to-t from-zinc-900 via-transparent to-transparent pointer-events-none" />
                        <div className="absolute bottom-4 left-4 right-4">
                          <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest mb-0.5">UID</p>
                          <h3 className="font-bold text-lg truncate">{item.recordingName}</h3>
                          <p className="text-xs text-zinc-400">{new Date(item.timestamp).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</p>
                        </div>
                      </div>
                      <div className="p-6 space-y-4">
                        <div className="flex justify-between items-center text-sm"><span className="text-zinc-500">Speaker</span><span className="font-medium">{item.speakerType}</span></div>
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-zinc-500">"Loan" Used</span>
                          <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-bold uppercase', item.loanWordUsed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500')}>
                            {item.loanWordUsed ? 'Yes' : 'No'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-zinc-500">"Document" Used</span>
                          <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-bold uppercase', item.documentWordUsed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-zinc-800 text-zinc-500')}>
                            {item.documentWordUsed ? 'Yes' : 'No'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-zinc-500">Tokens</span>
                          <span className="font-mono text-xs text-zinc-400">{(item.totalTokens || 0).toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between items-center text-sm">
                          <span className="text-zinc-500">SD Status</span>
                          <span className={cn('px-2 py-0.5 rounded-md text-[10px] font-bold uppercase', getSDVideoStatus(item) === 'Verified' ? 'bg-indigo-500/10 text-indigo-400' : 'bg-red-500/10 text-red-400')}>
                            {getSDVideoStatus(item)}
                          </span>
                        </div>
                        <div className="pt-2"><p className="text-[11px] text-zinc-500 line-clamp-2 italic">"{item.transcript}"</p></div>
                        <button onClick={() => { setCurrentAnalysis(item); setPreviousTab('history'); setActiveTab('analyze'); }}
                          className="w-full py-2 bg-zinc-800 hover:bg-zinc-700 text-white rounded-lg text-xs font-bold transition-colors">
                          View Full Report
                        </button>
                      </div>
                    </div>
                  ))}
                  {history.length === 0 && (
                    <div className="col-span-full py-24 text-center bg-zinc-900/30 border border-zinc-800 rounded-3xl">
                      <History className="w-12 h-12 text-zinc-700 mx-auto mb-4" />
                      <p className="text-zinc-500">No history yet. Start by analyzing a video.</p>
                    </div>
                  )}
                </div>
              ) : (
                <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl">
                  <div className="overflow-x-auto scrollbar-custom">
                    <table className="w-full text-left border-collapse">
                      <thead className="bg-zinc-800/40 border-b border-zinc-800">
                        <tr>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Date</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">userId</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Mode</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Status</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Conf.</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Tokens</th>
                          <th className="px-8 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Statement</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-zinc-800/30">
                        {filteredFpHistory.length === 0 ? (
                          <tr><td colSpan={7} className="px-8 py-32 text-center opacity-10"><HistoryIcon className="w-20 h-20 mx-auto mb-6" /><p className="text-xs uppercase font-bold tracking-[0.4em]">No Historical Records Found</p></td></tr>
                        ) : (
                          filteredFpHistory.map((item) => (
                            <tr key={item.id} className="hover:bg-white/[0.03] transition-all group">
                              <td className="px-8 py-5"><div className="flex items-center gap-2 text-zinc-500 font-mono text-[11px]"><Clock className="w-3 h-3" />{item.auditDate}</div></td>
                              <td className="px-8 py-5"><span className="font-mono text-sm font-bold text-white tracking-tight">{item.uid}</span></td>
                              <td className="px-8 py-5"><span className={cn("text-[9px] font-bold uppercase px-2 py-0.5 rounded border tracking-widest", item.mode === 'single' ? "border-indigo-500/30 text-indigo-400 bg-indigo-500/5" : "border-emerald-500/30 text-emerald-400 bg-emerald-500/5")}>{item.mode}</span></td>
                              <td className="px-8 py-5"><StatusBadge status={item.status} /></td>
                              <td className="px-8 py-5">{item.confidence ? <span className="text-sm font-mono font-bold text-indigo-400 bg-indigo-500/10 px-2 py-1 rounded border border-indigo-500/20">{item.confidence}%</span> : <span className="text-zinc-500 opacity-30">—</span>}</td>
                              <td className="px-8 py-5"><span className="text-xs font-mono text-zinc-400">{(item.totalTokens || 0).toLocaleString()}</span></td>
                              <td className="px-8 py-5"><p className="text-xs text-zinc-100 line-clamp-1 italic max-w-[400px] font-medium leading-relaxed">{item.transcriptEnglish || item.statement || "—"}</p></td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'fp_audit' && (
            <motion.div key="fp_audit" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-8">
              <div className="space-y-4">
                <button 
                  onClick={() => setActiveTab(previousTab)}
                  className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 transition-colors text-sm font-medium group"
                >
                  <ChevronLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                  Go Back
                </button>
                <h1 className="text-3xl font-bold text-white flex items-center gap-3">
                  <Zap className="w-8 h-8 text-amber-500" /> Full Payment Audit
                </h1>
              </div>

              {/* FP Audit Internal Sub-Navigation */}
              <div className="flex items-center justify-between mb-10">
                <div className="flex gap-3 p-1.5 bg-zinc-900/50 border border-zinc-800 rounded-2xl shadow-xl">
                  <button 
                    className={fpSubTab === "bulk" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                    onClick={() => setFpSubTab("bulk")}
                  >
                    <Layers className="w-4 h-4 mr-2.5 inline-block" />
                    Bulk Audit
                  </button>
                  <button 
                    className={fpSubTab === "single" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                    onClick={() => setFpSubTab("single")}
                  >
                    <Search className="w-4 h-4 mr-2.5 inline-block" />
                    Single Audit
                  </button>
                </div>
                
                <div className="flex flex-col items-end gap-3">
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                      <Key className="w-3.5 h-3.5 text-zinc-500 group-focus-within:text-indigo-400 transition-colors" />
                    </div>
                    <input
                      type="password"
                      placeholder="Gemini API Key"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      className="bg-zinc-900/50 border border-zinc-800 rounded-xl pl-11 pr-5 py-2.5 text-xs font-mono focus:border-indigo-500/50 focus:ring-4 focus:ring-indigo-500/5 outline-none transition-all w-[180px] focus:w-[240px]"
                    />
                  </div>
                  
                  <div className="flex gap-3 p-1.5 bg-zinc-900/50 border border-zinc-800 rounded-2xl shadow-xl">
                    <button 
                      className={fpSubTab === "dashboard" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"} 
                      onClick={() => setFpSubTab("dashboard")}
                    >
                      <BarChart3 className="w-4 h-4" />
                      Dashboard
                    </button>
                    <button
                      className={fpSubTab === "guide" ? "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 bg-zinc-800 text-white shadow-sm" : "px-4 py-2 rounded-lg text-sm font-medium transition-all flex items-center gap-2 text-zinc-400 hover:text-zinc-200"}
                      onClick={() => setFpSubTab("guide")}
                    >
                      <ShieldCheck className="w-4 h-4" />
                      Help / Guide
                    </button>
                  </div>
                </div>
              </div>

              {/* FP Audit Content based on fpSubTab */}
              {fpSubTab === 'dashboard' && (
                <div className="space-y-10 animate-in fade-in duration-500">
                  {/* Dashboard Stats */}
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-indigo-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Total Audits</p>
                        <div className="p-3 bg-indigo-500/10 rounded-xl group-hover:bg-indigo-500/20 transition-colors">
                          <Activity className="w-5 h-5 text-indigo-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">{fpDashboardStats.totalAudits}</h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Lifetime system audits</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-emerald-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Success Rate</p>
                        <div className="p-3 bg-emerald-500/10 rounded-xl group-hover:bg-emerald-500/20 transition-colors">
                          <ShieldCheck className="w-5 h-5 text-emerald-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">{fpDashboardStats.successRate}%</h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Payment consent detection</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-indigo-500/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Token Usage</p>
                        <div className="p-3 bg-indigo-500/10 rounded-xl group-hover:bg-indigo-500/20 transition-colors">
                          <Zap className="w-5 h-5 text-indigo-400" />
                        </div>
                      </div>
                      <h3 className="text-4xl font-mono font-bold text-white tracking-tighter">
                        {totalTokensUsed >= 1000 ? (totalTokensUsed / 1000).toFixed(1) + 'k' : totalTokensUsed}
                      </h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Combined tokens used</p>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-4 group hover:border-zinc-700/50 transition-all">
                      <div className="flex justify-between items-start">
                        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">System Health</p>
                        <div className={cn(
                          "p-3 rounded-xl transition-colors bg-opacity-10",
                          fpIsProcessing ? "bg-emerald-500/10" : "bg-zinc-500/10"
                        )}>
                          <RefreshCw className={cn(
                            "w-5 h-5",
                            fpIsProcessing ? "text-emerald-400 animate-spin" : "text-zinc-500"
                          )} />
                        </div>
                      </div>
                      <h3 className={cn(
                        "text-4xl font-mono font-bold tracking-tighter",
                        fpIsProcessing ? "text-emerald-400" : "text-white"
                      )}>
                        {fpIsProcessing ? "ACTIVE" : "IDLE"}
                      </h3>
                      <p className="text-[10px] text-zinc-500 uppercase tracking-widest font-medium">Operational status</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                    <div className="lg:col-span-2 bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-8">
                      <div className="flex justify-between items-center">
                        <div>
                          <h4 className="text-lg font-bold text-white tracking-tight">Audit Volume Trend</h4>
                          <p className="text-[10px] text-zinc-500 uppercase tracking-[0.2em] mt-1">Real-time processing activity logs</p>
                        </div>
                      </div>
                      <div className="h-[340px] w-full flex items-center justify-center">
                        {fpHistory.length === 0 ? (
                          <div className="text-center opacity-20">
                            <BarChart3 className="w-12 h-12 mx-auto mb-3" />
                            <p className="text-xs font-bold uppercase tracking-widest">No audit data yet</p>
                          </div>
                        ) : (
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={fpDashboardStats.chartData}>
                              <defs>
                                <linearGradient id="colorAudits" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.4}/>
                                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0}/>
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" vertical={false} opacity={0.5} />
                              <XAxis dataKey="name" stroke="#4B5563" fontSize={10} tickLine={false} axisLine={false} dy={15} />
                              <YAxis stroke="#4B5563" fontSize={10} tickLine={false} axisLine={false} dx={-15} />
                              <Tooltip 
                                contentStyle={{ backgroundColor: '#111827', border: '1px solid #1F2937', borderRadius: '12px', fontSize: '12px' }}
                                itemStyle={{ color: '#6366f1', fontWeight: 'bold' }}
                              />
                              <Area type="monotone" dataKey="audits" stroke="#6366f1" strokeWidth={3} fillOpacity={1} fill="url(#colorAudits)" />
                            </AreaChart>
                          </ResponsiveContainer>
                        )}
                      </div>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl space-y-8">
                      <div className="flex justify-between items-center">
                        <h4 className="text-lg font-bold text-white tracking-tight">Recent Activity</h4>
                        <Activity className="w-4 h-4 text-zinc-500" />
                      </div>
                      <div className="space-y-5">
                        {fpHistory.slice(0, 6).map((item) => (
                          <div key={item.id} className="flex items-center gap-5 p-4 bg-zinc-950/30 rounded-2xl border border-zinc-800/30 hover:border-indigo-500/30 transition-all group cursor-pointer">
                            <div className={cn(
                              "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-lg transition-transform group-hover:scale-110",
                              item.status === 'PAYMENT_CONSENT_FOUND' ? "bg-emerald-500/10 text-emerald-400 shadow-emerald-500/5" : "bg-red-500/10 text-red-400 shadow-red-500/5"
                            )}>
                              {item.status === 'PAYMENT_CONSENT_FOUND' ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-xs font-bold text-white truncate group-hover:text-indigo-400 transition-colors">{item.uid}</p>
                              <p className="text-[9px] text-zinc-500 uppercase tracking-widest mt-1 font-medium">{item.auditDate}</p>
                            </div>
                            <div className="text-right">
                              <p className="text-xs font-mono font-bold text-indigo-400">{item.confidence || 0}%</p>
                              <ArrowUpRight className="w-3 h-3 text-zinc-500 group-hover:text-indigo-400 ml-auto mt-1 transition-colors" />
                            </div>
                          </div>
                        ))}
                        {fpHistory.length === 0 && (
                          <div className="py-20 text-center opacity-10">
                            <HistoryIcon className="w-16 h-16 mx-auto mb-4" />
                            <p className="text-xs font-bold uppercase tracking-[0.3em]">No activity detected</p>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {fpSubTab === 'bulk' && (
                <div className="space-y-10 animate-in fade-in duration-500">
                  {/* FP Bulk Audit Tool */}
                  <div className="space-y-8">
                    <div className="bg-zinc-900 border border-zinc-800 p-4 rounded-3xl flex flex-col md:flex-row items-center gap-6 shadow-xl">
                      {/* Upload CSV Section */}
                      <div className="relative overflow-hidden group flex-1 w-full md:w-auto">
                        <input type="file" accept=".csv" onChange={fpHandleCSV} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                        <div className="flex items-center gap-4 p-3 bg-zinc-950/50 border border-zinc-800 rounded-2xl group-hover:border-indigo-500/50 transition-all">
                          <div className="w-10 h-10 bg-indigo-500/10 rounded-xl flex items-center justify-center group-hover:bg-indigo-500/20 transition-colors">
                            <Upload className="text-indigo-400 w-5 h-5" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-bold uppercase tracking-tight text-white truncate">{fpFileName || "Upload CSV"}</p>
                            <p className="text-[9px] text-zinc-500 uppercase tracking-widest mt-0.5">{fpData.length > 0 ? `${fpData.length} UIDs` : "Select File"}</p>
                          </div>
                        </div>
                      </div>

                      {/* Controls Section */}
                      <div className="flex items-center gap-3 w-full md:w-auto">
                        <div className="flex gap-2">
                          {!fpIsProcessing ? (
                            <button 
                              onClick={fpStartProcessing} 
                              disabled={fpData.length === 0 || !apiKey} 
                              title={!apiKey ? "Please enter the Gemini API Key above to start" : ""}
                              className="h-12 px-6 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center justify-center gap-2 text-xs uppercase tracking-widest"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" /> Start
                            </button>
                          ) : (
                            <button onClick={() => { fpStopRef.current = true; setFpIsProcessing(false); }} className="h-12 px-6 bg-red-600 text-white rounded-xl font-bold hover:bg-red-500 transition-all flex items-center justify-center gap-2 text-xs uppercase tracking-widest">
                              <Square className="w-3.5 h-3.5 fill-current" /> Stop
                            </button>
                          )}
                          <button onClick={fpDownloadCSV} disabled={fpStats.processed === 0} className="w-12 h-12 bg-zinc-800 text-zinc-300 rounded-xl border border-zinc-700 hover:bg-zinc-700 transition-all disabled:opacity-50 flex items-center justify-center">
                            <Download className="w-5 h-5" />
                          </button>
                        </div>
                        {fpIsProcessing && fpCurrentUID && (
                          <div className="hidden lg:flex items-center gap-2 px-3 py-2 bg-indigo-500/5 border border-indigo-500/10 rounded-lg animate-in fade-in">
                            <Loader2 className="w-3 h-3 text-indigo-400 animate-spin" />
                            <p className="text-[9px] font-mono text-zinc-400 uppercase tracking-widest truncate max-w-[80px]">{fpCurrentUID}</p>
                          </div>
                        )}
                      </div>

                      {/* Progress Section */}
                      <div className="flex-1 w-full md:w-auto space-y-2">
                        <div className="flex justify-between items-end">
                          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Processing Progress</p>
                          <p className="text-[9px] font-mono text-white">{fpStats.processed} / {fpStats.total}</p>
                        </div>
                        <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${(fpStats.processed / (fpStats.total || 1)) * 100}%` }} />
                        </div>
                        <div className="flex justify-between">
                          <span className="text-[8px] font-bold uppercase text-emerald-400">Found: {fpStats.found}</span>
                          <span className="text-[8px] font-bold uppercase text-red-400">Not Found: {fpStats.processed - fpStats.found - fpStats.partial}</span>
                        </div>
                      </div>
                    </div>

                    <div className="bg-zinc-900 border border-zinc-800 rounded-3xl overflow-hidden shadow-2xl">
                      <div className="overflow-x-auto scrollbar-custom">
                        <table className="w-full text-left border-collapse">
                          <thead>
                            <tr className="bg-zinc-800/40 border-b border-zinc-800 text-left">
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">UserID</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Self Dec.</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Status</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Checked</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">FP Link</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Time</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Conf.</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Statement</th>
                              <th className="px-6 py-5 text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 text-right">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-800/30">
                            {fpData.length === 0 ? (
                              <tr>
                                <td colSpan={9} className="px-8 py-32 text-center">
                                  <div className="flex flex-col items-center gap-6 opacity-10">
                                    <Database className="w-20 h-20" />
                                    <p className="text-xs uppercase font-bold tracking-[0.4em]">Awaiting CSV Data Stream</p>
                                  </div>
                                </td>
                              </tr>
                            ) : (
                              fpData.map((item) => (
                                <tr key={item.uid} className={cn("hover:bg-white/[0.03] transition-all group border-b border-zinc-800/10", item.uid === fpCurrentUID && "bg-indigo-500/[0.03]")}>
                                  <td className="px-6 py-5"><p className="font-mono text-xs font-bold text-white tracking-tight truncate max-w-[80px]">{item.uid}</p></td>
                                  <td className="px-6 py-5"><p className="text-[9px] text-zinc-500 uppercase tracking-widest truncate max-w-[100px] font-medium">{item.selfDeclaration || "—"}</p></td>
                                  <td className="px-6 py-5"><StatusBadge status={item.result.status} /></td>
                                  <td className="px-6 py-5"><span className="text-[10px] font-mono font-bold text-zinc-500">{item.result.recordingsChecked} / {item.result.totalRecordings}</span></td>
                                  <td className="px-6 py-5">{item.result.recordingLink ? <a href={item.result.recordingLink} target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:underline text-[10px] font-mono">LINK</a> : "—"}</td>
                                  <td className="px-6 py-5"><span className="text-[10px] font-mono text-zinc-500">{item.result.timestamp || "—"}</span></td>
                                  <td className="px-6 py-5"><span className="text-[10px] font-mono font-bold text-indigo-400">{item.result.confidence ? `${item.result.confidence}%` : "—"}</span></td>
                                  <td className="px-6 py-5">
                                    <div className="group/stat relative">
                                      <p className="text-[11px] text-zinc-100 line-clamp-1 italic max-w-[120px] font-medium leading-relaxed">{item.result.statement || "—"}</p>
                                      {item.result.statement && (
                                        <div className="absolute left-0 top-full mt-2 hidden group-hover/stat:block z-50 bg-zinc-900 border border-zinc-800 p-3 rounded shadow-xl text-[10px] max-w-[300px] space-y-2">
                                          <p className="font-medium">"{item.result.statement}"</p>
                                          {item.result.transcriptEnglish && item.result.transcriptEnglish !== item.result.statement && (
                                            <p className="text-[9px] text-zinc-500 italic border-t border-zinc-800/30 pt-1">Translation: {item.result.transcriptEnglish}</p>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  </td>
                                  <td className="px-6 py-5 text-right">
                                    <button onClick={() => fpProcessUID(item)} disabled={fpIsProcessing} className="p-2 hover:bg-indigo-500/10 rounded-lg transition-all disabled:opacity-20 text-zinc-500 hover:text-indigo-400">
                                      <RefreshCw className="w-3.5 h-3.5" />
                                    </button>
                                  </td>
                                </tr>
                              ))
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {fpSubTab === 'single' && (
                <div className="max-w-3xl mx-auto space-y-8 animate-in fade-in duration-700 slide-in-from-bottom-4">
                  {/* Single FP Audit Section */}
                  <div className="bg-zinc-900 border border-zinc-800 p-10 rounded-3xl max-w-2xl mx-auto space-y-8 shadow-2xl">
                    <div className="flex items-center gap-4 mb-2">
                      <div className="bg-indigo-500/10 p-3 rounded-xl border border-indigo-500/20"><Search className="text-indigo-400 w-6 h-6" /></div>
                      <div>
                        <h2 className="text-xl font-bold text-white tracking-tight">Single FP Audit Analysis</h2>
                        <p className="text-[10px] text-zinc-500 uppercase tracking-widest mt-1">Manual verification tool</p>
                      </div>
                    </div>
                    <div className="space-y-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 ml-1">UID / Reference</label>
                        <input type="text" placeholder="Enter UID" value={fpSingleUID} onChange={(e) => setFpSingleUID(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500 ml-1">Recording URL</label>
                        <input type="text" placeholder="Enter Recording Link" value={fpSingleLink} onChange={(e) => setFpSingleLink(e.target.value)} className="w-full bg-zinc-950 border border-zinc-800 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all" />
                      </div>
                      <button 
                        onClick={handleSingleFpAudit} 
                        disabled={!fpSingleLink || fpSingleLoading || !apiKey} 
                        title={!apiKey ? "Please enter the Gemini API Key above to start" : ""}
                        className="w-full py-4 bg-indigo-600 text-white rounded-xl font-bold hover:bg-indigo-500 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                      >
                        {fpSingleLoading ? <><Loader2 className="w-5 h-5 animate-spin" /> Analyzing...</> : <><Play className="w-5 h-5 fill-current" /> Run Intelligence Audit</>}
                      </button>
                    </div>
                    {fpSingleResult && (
                      <div className="mt-10 p-8 bg-zinc-950/50 rounded-2xl border border-zinc-800 space-y-6 relative overflow-hidden shadow-inner">
                        <div className="absolute top-0 left-0 w-1.5 h-full bg-indigo-500" />
                        <div className="flex justify-between items-start">
                          <div className="space-y-2">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Audit Result</p>
                            <StatusBadge status={(fpSingleResult as any).status} />
                          </div>
                          {(fpSingleResult as any).confidence && (
                            <div className="text-right">
                              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Confidence</p>
                              <p className="text-2xl font-mono font-bold text-indigo-400">{(fpSingleResult as any).confidence}%</p>
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-2 gap-6">
                          <div className="space-y-2">
                            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Timestamp</p>
                            <div className="flex items-center gap-2 text-white font-mono text-sm bg-zinc-800/30 px-3 py-1.5 rounded-lg border border-zinc-800 w-fit">
                              <Clock className="w-3.5 h-3.5 text-indigo-400" />
                              {(fpSingleResult as any).timestamp || "—"}
                            </div>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-zinc-500">Statement / Evidence</p>
                          <div className="p-4 bg-zinc-800/20 rounded-xl border border-zinc-800/50 italic">
                            <p className="text-sm font-medium text-zinc-100 leading-relaxed">
                              {(fpSingleResult as any).transcript_english || (fpSingleResult as any).statement || "No evidence provided."}
                            </p>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {fpSubTab === 'guide' && (
                <div className="space-y-8 animate-in fade-in duration-500 max-w-4xl mx-auto">
                  <div>
                    <h2 className="text-2xl font-bold uppercase tracking-tight">Help & Guide</h2>
                    <p className="text-xs text-zinc-500 mt-1 font-mono uppercase tracking-widest">Full Payment Detection System — PRE Operations</p>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 space-y-6">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-indigo-400">Step-by-Step Usage</h3>
                    <ol className="space-y-4 text-sm text-zinc-400 list-none">
                      {[
                        { step: "01", title: "Get your CSV from Salesforce", desc: "Export as CSV. Do not modify the file after exporting." },
                        { step: "02", title: "Enter your Gemini API Key", desc: "Paste your Gemini API Key in the field at the top right of the screen." },
                        { step: "03", title: "Upload the CSV", desc: "Click the upload area or drag and drop the exported CSV file." },
                        { step: "04", title: "Start Processing", desc: "Click 'Start'. The system will analyze recordings and show results in real time." },
                        { step: "05", title: "Review Results", desc: "Each UID will show a status (FOUND or NOT FOUND), timestamp, and confidence score." },
                        { step: "06", title: "Download Output CSV", desc: "Once complete, click the download button to export the summary CSV." }
                      ].map(({ step, title, desc }) => (
                        <li key={step} className="flex gap-4">
                          <span className="text-indigo-400 font-mono font-bold text-lg w-8 shrink-0">{step}</span>
                          <div className="space-y-1"><p className="text-white font-bold">{title}</p><p className="text-zinc-500 text-xs leading-relaxed">{desc}</p></div>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 space-y-6">
                    <h3 className="text-sm font-bold uppercase tracking-widest text-indigo-400">What FOUND vs NOT FOUND Means</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-6 space-y-3">
                        <span className="badge-green text-xs">✓ FOUND</span>
                        <p className="text-xs text-zinc-400 leading-relaxed">The user acknowledged, consented to, or confirmed making a payment. This includes:</p>
                        <ul className="text-xs text-zinc-500 space-y-1 list-none">
                          {["User confirmed payment is done", "User said they will pay soon", "User acknowledged receiving the payment link", "User said screenshot has been shared"].map(item => <li key={item} className="flex items-start gap-2"><span className="text-emerald-400 mt-0.5">→</span><span>{item}</span></li>)}
                        </ul>
                      </div>
                      <div className="bg-red-500/5 border border-red-500/20 rounded-xl p-6 space-y-3">
                        <span className="badge-red text-xs">✗ NOT FOUND</span>
                        <p className="text-xs text-zinc-400 leading-relaxed">No clear payment consent was found in the recording. This includes:</p>
                        <ul className="text-xs text-zinc-500 space-y-1 list-none">
                          {["Payment was never mentioned", "Only agent talked about payment", "User explicitly refused to pay", "Call was about OTP only"].map(item => <li key={item} className="flex items-start gap-2"><span className="text-red-400 mt-0.5">→</span><span>{item}</span></li>)}
                        </ul>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'tata_tele_api' && (
            <motion.div key="tata_tele_api" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -20 }} className="space-y-8">
              <div className="flex items-start justify-between">
                <button 
                  onClick={() => setActiveTab(previousTab)}
                  className="flex items-center gap-2 text-zinc-500 hover:text-zinc-300 transition-colors text-sm font-medium group"
                >
                  <ChevronLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                  Go Back
                </button>
              </div>

              <TataTeleApiTab />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Admin Panel Modal */}
      <AnimatePresence>
        {showAdminPanel && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl shadow-2xl max-w-md w-full space-y-6"
            >
              <div className="flex justify-between items-center">
                <h2 className="text-xl font-bold uppercase tracking-tight">Admin Settings</h2>
                <button onClick={() => setShowAdminPanel(false)} className="text-zinc-500 hover:text-white">
                  <XCircle className="w-6 h-6" />
                </button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">Cumulative Token Limit</label>
                  <div className="flex gap-2">
                    <input 
                      type="number"
                      value={adminLimitInput}
                      onChange={(e) => setAdminLimitInput(e.target.value)}
                      placeholder={tokenLimit.toString()}
                      className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2 text-sm outline-none focus:border-indigo-500"
                    />
                    <button 
                      onClick={() => {
                        const val = parseInt(adminLimitInput);
                        if (!isNaN(val) && val > 0) {
                          setTokenLimit(val);
                          localStorage.setItem('combined_token_limit', val.toString());
                          setAdminLimitInput('');
                          alert("Limit updated successfully.");
                        }
                      }}
                      className="bg-indigo-600 text-white px-4 py-2 rounded-xl font-bold text-xs uppercase tracking-widest"
                    >
                      Save
                    </button>
                  </div>
                </div>

                <div className="pt-4 border-t border-zinc-800 space-y-3">
                  <button 
                    onClick={() => {
                      if (window.confirm("Are you sure you want to reset all token counters? This cannot be undone.")) {
                        setTotalTokensUsed(0);
                        setTotalCostUsd(0);
                        localStorage.removeItem('combined_total_tokens');
                        localStorage.removeItem('combined_total_cost');
                        alert("Counters reset.");
                      }
                    }}
                    className="w-full py-3 border border-red-500/30 text-red-400 hover:bg-red-500/10 rounded-xl font-bold text-xs uppercase tracking-widest transition-colors"
                  >
                    Reset All Counters
                  </button>
                  <button 
                    onClick={() => {
                      if (window.confirm("Are you sure you want to clear FP history?")) {
                        setFpHistory([]);
                        localStorage.removeItem('fp_audit_history');
                        alert("FP History cleared.");
                      }
                    }}
                    className="w-full py-3 border border-zinc-700 text-zinc-400 hover:bg-zinc-800 rounded-xl font-bold text-xs uppercase tracking-widest transition-colors"
                  >
                    Clear FP History
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}