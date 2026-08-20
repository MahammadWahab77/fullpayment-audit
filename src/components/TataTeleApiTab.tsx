import React, { useState, useEffect } from 'react';
import {
  Zap, Copy, Check, Play, RefreshCw, Server,
  FileCode, Terminal, AlertTriangle, CheckCircle2, XCircle,
  Clock, ShieldCheck, Database, Volume2, ArrowUpRight,
  Filter, Search, Download, Trash2, ChevronRight, Layers,
  ExternalLink, Sparkles, Activity, Gauge, FileText, AlertCircle
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface RecordingResult {
  url: string;
  callId: string;
  status: 'ok' | 'error';
  durationSec?: number;
  transcript?: string;
  audioQuality?: {
    clarity: string;
    noiseLevel: string;
    dropouts: number | string;
    silenceRatio: number;
  };
  issues?: string[];
  score?: number;
  code?: string;
  message?: string;
  httpStatus?: number;
  debug?: string;
  byteLength?: number;
}

interface TataTeleResponse {
  uid: string;
  results: RecordingResult[];
  summary: {
    total: number;
    ok: number;
    error: number;
    totalDurationSec?: number;
    avgScore?: number;
  };
}

interface AuditLogItem {
  id: string;
  timestamp: string;
  uid: string;
  source: string;
  recordingsCount: number;
  status: string;
  okCount: number;
  errorCount: number;
  avgScore?: number;
  totalDurationSec?: number;
  durationMs: number;
  results: RecordingResult[];
  error?: string;
}

interface ServerStats {
  totalRequests: number;
  okAudits: number;
  errorAudits: number;
  totalRecordings: number;
  successRatePercent: number;
  avgDurationMs: number;
}

const SAMPLE_PRE_SIGNED_URL =
  'https://cloudphone.tatateleservices.com/file/recording?callId=HYD1-D7-1786537145.280683&type=rec&token=dGhpcy1pcy1hLXNhbXBsZS10b2tlbg%3D%3D';

export const TataTeleApiTab: React.FC = () => {
  const [activeSubView, setActiveSubView] = useState<'tester' | 'logs' | 'docs'>('tester');
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Single test form state
  const [uidInput, setUidInput] = useState('LEAD-TT-94821');
  const [recordingsInput, setRecordingsInput] = useState(SAMPLE_PRE_SIGNED_URL);
  const [useMultipleUrls, setUseMultipleUrls] = useState(false);
  const [multiUrlsInput, setMultiUrlsInput] = useState(SAMPLE_PRE_SIGNED_URL);

  // API Call state
  const [isLoading, setIsLoading] = useState(false);
  const [apiResponse, setApiResponse] = useState<TataTeleResponse | null>(null);
  const [responseError, setResponseError] = useState<string | null>(null);
  const [responseLatency, setResponseLatency] = useState<number | null>(null);

  // Server Logs State
  const [logs, setLogs] = useState<AuditLogItem[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsSearch, setLogsSearch] = useState('');
  const [logsStatusFilter, setLogsStatusFilter] = useState('ALL');
  const [selectedLog, setSelectedLog] = useState<AuditLogItem | null>(null);
  const [serverStats, setServerStats] = useState<ServerStats | null>(null);

  // Doc code tab
  const [docLanguage, setDocLanguage] = useState<'curl' | 'nodejs' | 'python'>('curl');

  const originUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
  const endpointUrl = `${originUrl}/api/audit/tata-tele`;

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const fetchLogsAndStats = async () => {
    setLogsLoading(true);
    try {
      const [logsRes, statsRes] = await Promise.all([
        fetch(`/api/audit/logs?status=${logsStatusFilter}&search=${encodeURIComponent(logsSearch)}`),
        fetch('/api/audit/stats'),
      ]);

      if (logsRes.ok) {
        const data = await logsRes.json();
        setLogs(data.logs || []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setServerStats(data);
      }
    } catch (err) {
      console.warn('Failed to fetch audit logs:', err);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    fetchLogsAndStats();
    const interval = setInterval(fetchLogsAndStats, 8000);
    return () => clearInterval(interval);
  }, [logsStatusFilter, logsSearch]);

  const handleHitEndpoint = async () => {
    setIsLoading(true);
    setResponseError(null);
    setApiResponse(null);
    const start = performance.now();

    try {
      const urls = useMultipleUrls
        ? multiUrlsInput.split('\n').map((u) => u.trim()).filter(Boolean)
        : [recordingsInput.trim()].filter(Boolean);

      if (urls.length === 0) {
        throw new Error('Please enter at least one Tata Tele call recording URL');
      }

      const payload = {
        uid: uidInput.trim() || `CALL-${Date.now()}`,
        recordings: urls,
      };

      const res = await fetch('/api/audit/tata-tele', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      setResponseLatency(Math.round(performance.now() - start));

      if (!res.ok) {
        setResponseError(data.error || data.message || `Server returned HTTP ${res.status}`);
        setApiResponse(data);
      } else {
        setApiResponse(data);
        fetchLogsAndStats();
      }
    } catch (err: any) {
      setResponseLatency(Math.round(performance.now() - start));
      setResponseError(err.message || 'Failed to connect to endpoint');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClearLogs = async () => {
    if (!confirm('Are you sure you want to clear the server audit logs history?')) return;
    try {
      await fetch('/api/audit/logs/clear', { method: 'POST' });
      fetchLogsAndStats();
      setSelectedLog(null);
    } catch (err) {
      console.error(err);
    }
  };

  const getCurlSnippet = () => `curl -X POST "${endpointUrl}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "uid": "${uidInput || 'LEAD-98765'}",
    "recordings": [
      "${recordingsInput || SAMPLE_PRE_SIGNED_URL}"
    ]
  }'`;

  const getNodeJsSnippet = () => `// Node.js
import axios from 'axios';

async function auditTataTeleRecordings() {
  const response = await axios.post('${endpointUrl}', {
    uid: '${uidInput || 'LEAD-98765'}',
    recordings: [
      '${recordingsInput || SAMPLE_PRE_SIGNED_URL}'
    ]
  });

  console.log('Audit Summary:', response.data.summary);
  console.log('Results:', response.data.results);
}

auditTataTeleRecordings();`;

  const getPythonSnippet = () => `# Python 3
import requests

payload = {
    "uid": "${uidInput || 'LEAD-98765'}",
    "recordings": [
        "${recordingsInput || SAMPLE_PRE_SIGNED_URL}"
    ]
}

response = requests.post("${endpointUrl}", json=payload)
data = response.json()

print("Summary:", data.get("summary"))
for item in data.get("results", []):
    print(f"CallId: {item.get('callId')} | Status: {item.get('status')} | Score: {item.get('score')}")`;

  return (
    <div className="space-y-6">
      {/* Top Banner with live endpoint info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl relative overflow-hidden">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 relative z-10">
          <div>
            <div className="flex items-center gap-2 mb-2">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-bold rounded-full uppercase tracking-wider">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
                Live Endpoint Active
              </span>
              <span className="px-2.5 py-1 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 text-xs font-mono font-bold rounded-full">
                POST /api/audit/tata-tele
              </span>
            </div>
            <h1 className="text-2xl lg:text-3xl font-extrabold text-white tracking-tight">
              Tata Tele Call Recording Audit API
            </h1>
            <p className="text-zinc-400 text-sm mt-1 max-w-2xl">
              Audits pre-signed Tata Tele CloudPhone URLs with verbatim URL preservation, 16kHz mono FFmpeg normalization, Gemini AI transcription, audio quality scoring, and comprehensive error isolation.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => copyToClipboard(endpointUrl, 'endpoint')}
              className="flex items-center gap-2 px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-sm font-semibold border border-zinc-700 transition-all cursor-pointer"
            >
              {copiedKey === 'endpoint' ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
              {copiedKey === 'endpoint' ? 'Copied URL!' : 'Copy Endpoint URL'}
            </button>
            <button
              onClick={() => copyToClipboard(getCurlSnippet(), 'curl')}
              className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-xl text-sm font-semibold shadow-lg shadow-indigo-600/20 transition-all cursor-pointer"
            >
              {copiedKey === 'curl' ? <Check className="w-4 h-4" /> : <Terminal className="w-4 h-4" />}
              {copiedKey === 'curl' ? 'Copied cURL!' : 'Copy cURL'}
            </button>
          </div>
        </div>

        {/* Quick Endpoint URL display bar */}
        <div className="mt-5 pt-5 border-t border-zinc-800/80 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 font-mono text-zinc-400 overflow-x-auto w-full md:w-auto">
            <span className="text-emerald-400 font-bold bg-emerald-950/60 px-2 py-0.5 rounded border border-emerald-800/40">POST</span>
            <span className="text-zinc-200 font-semibold bg-zinc-950 px-3 py-1.5 rounded-xl border border-zinc-800 select-all">
              {endpointUrl}
            </span>
          </div>

          {serverStats && (
            <div className="flex items-center gap-4 text-zinc-400">
              <span>Total API Hits: <strong className="text-white">{serverStats.totalRequests}</strong></span>
              <span>•</span>
              <span>Success Rate: <strong className="text-emerald-400">{serverStats.successRatePercent}%</strong></span>
              <span>•</span>
              <span>Avg Latency: <strong className="text-indigo-300">{serverStats.avgDurationMs} ms</strong></span>
            </div>
          )}
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="flex items-center gap-2 border-b border-zinc-800 pb-3">
        <button
          onClick={() => setActiveSubView('tester')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all cursor-pointer',
            activeSubView === 'tester'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
          )}
        >
          <Zap className="w-4 h-4" /> Live Endpoint Tester
        </button>

        <button
          onClick={() => { setActiveSubView('logs'); fetchLogsAndStats(); }}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all cursor-pointer',
            activeSubView === 'logs'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
          )}
        >
          <Database className="w-4 h-4" /> Inbound Request Logs
          {logs.length > 0 && (
            <span className="px-1.5 py-0.5 text-[11px] bg-zinc-800 text-zinc-300 rounded-full font-mono">
              {logs.length}
            </span>
          )}
        </button>

        <button
          onClick={() => setActiveSubView('docs')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-bold transition-all cursor-pointer',
            activeSubView === 'docs'
              ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/20'
              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
          )}
        >
          <FileCode className="w-4 h-4" /> API Contract & Docs
        </button>
      </div>

      {/* VIEW 1: LIVE TESTER */}
      {activeSubView === 'tester' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          {/* Request Configurator Form */}
          <div className="lg:col-span-5 space-y-5">
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Terminal className="w-5 h-5 text-indigo-400" />
                  Request Payload
                </h2>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      setUidInput('LEAD-TT-94821');
                      setRecordingsInput(SAMPLE_PRE_SIGNED_URL);
                      setUseMultipleUrls(false);
                    }}
                    className="text-xs text-indigo-400 hover:underline cursor-pointer"
                  >
                    Reset Pre-signed Sample
                  </button>
                </div>
              </div>

              {/* UID Field */}
              <div>
                <label className="block text-xs font-bold text-zinc-400 uppercase tracking-wider mb-2">
                  UID (string) <span className="text-indigo-400">*</span>
                </label>
                <input
                  type="text"
                  value={uidInput}
                  onChange={(e) => setUidInput(e.target.value)}
                  placeholder="e.g. LEAD-TT-94821"
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-xl px-4 py-3 text-sm text-white font-mono outline-none transition-colors"
                />
              </div>

              {/* Mode Toggle: Single vs Multi URL */}
              <div className="flex items-center justify-between pt-2">
                <label className="text-xs font-bold text-zinc-400 uppercase tracking-wider">
                  recordings (string[]) <span className="text-indigo-400">*</span>
                </label>
                <button
                  onClick={() => setUseMultipleUrls(!useMultipleUrls)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer"
                >
                  {useMultipleUrls ? 'Switch to Single URL' : '+ Add Multiple URLs'}
                </button>
              </div>

              {!useMultipleUrls ? (
                <div>
                  <textarea
                    rows={4}
                    value={recordingsInput}
                    onChange={(e) => setRecordingsInput(e.target.value)}
                    placeholder="https://cloudphone.tatateleservices.com/file/recording?callId=...&type=rec&token=...%3D%3D"
                    className="w-full bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-xl p-3 text-xs text-white font-mono outline-none transition-colors resize-none"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Pre-signed Tata Tele CloudPhone URLs with %3D%3D tokens are preserved verbatim.
                  </p>
                </div>
              ) : (
                <div>
                  <textarea
                    rows={6}
                    value={multiUrlsInput}
                    onChange={(e) => setMultiUrlsInput(e.target.value)}
                    placeholder="Enter one Tata Tele recording URL per line..."
                    className="w-full bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-xl p-3 text-xs text-white font-mono outline-none transition-colors resize-none"
                  />
                  <p className="text-[11px] text-zinc-500 mt-1">
                    Each URL is audited independently with isolated error boundaries.
                  </p>
                </div>
              )}

              {/* Action Button */}
              <div className="pt-3">
                <button
                  onClick={handleHitEndpoint}
                  disabled={isLoading}
                  className="w-full py-3.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-xl font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/25 transition-all cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      Fetching, Normalizing (FFmpeg) & Analyzing with Gemini...
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4 fill-current" />
                      Hit Endpoint (POST /api/audit/tata-tele)
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Request Payload Preview Card */}
            <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold text-zinc-400 uppercase tracking-wider">JSON Body Preview</span>
                <button
                  onClick={() => copyToClipboard(JSON.stringify({
                    uid: uidInput,
                    recordings: useMultipleUrls ? multiUrlsInput.split('\n').filter(Boolean) : [recordingsInput]
                  }, null, 2), 'payload')}
                  className="text-xs text-zinc-400 hover:text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {copiedKey === 'payload' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  Copy JSON
                </button>
              </div>
              <pre className="text-xs font-mono text-zinc-300 bg-zinc-950 p-3 rounded-xl border border-zinc-800 overflow-x-auto">
                {JSON.stringify({
                  uid: uidInput,
                  recordings: useMultipleUrls ? multiUrlsInput.split('\n').filter(Boolean) : [recordingsInput]
                }, null, 2)}
              </pre>
            </div>
          </div>

          {/* Response Inspector Area */}
          <div className="lg:col-span-7 space-y-5">
            <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl min-h-[460px] flex flex-col">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-4">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Server className="w-4 h-4 text-indigo-400" />
                    Response Inspector (Contract: 200 with uid, results, summary)
                  </h3>
                  {responseLatency !== null && (
                    <p className="text-xs text-zinc-500 mt-0.5">
                      Response latency: <span className="text-indigo-400 font-semibold">{responseLatency} ms</span>
                    </p>
                  )}
                </div>

                {apiResponse && (
                  <button
                    onClick={() => copyToClipboard(JSON.stringify(apiResponse, null, 2), 'res-json')}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-800 px-3 py-1.5 rounded-lg border border-zinc-700 cursor-pointer"
                  >
                    {copiedKey === 'res-json' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                    Copy JSON
                  </button>
                )}
              </div>

              {isLoading ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8 space-y-4">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-full border-4 border-indigo-500/20 border-t-indigo-500 animate-spin" />
                    <Sparkles className="w-6 h-6 text-indigo-400 absolute inset-0 m-auto animate-pulse" />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-white">Auditing Tata Tele Call Audio</h4>
                    <p className="text-xs text-zinc-400 mt-1 max-w-sm">
                      Executing 60s stream fetch, FFmpeg 16kHz mono normalization, and Gemini multimodal audio analysis...
                    </p>
                  </div>
                </div>
              ) : responseError && !apiResponse ? (
                <div className="p-5 bg-red-500/10 border border-red-500/30 rounded-2xl text-red-400 text-sm space-y-2">
                  <div className="flex items-center gap-2 font-bold">
                    <AlertTriangle className="w-5 h-5" />
                    Connection Error
                  </div>
                  <p className="text-xs font-mono">{responseError}</p>
                </div>
              ) : apiResponse ? (
                <div className="space-y-5 flex-1">
                  {/* Summary Bar */}
                  {apiResponse.summary && (
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                      <div className="p-3 bg-zinc-950 rounded-2xl border border-zinc-800">
                        <span className="text-[10px] font-bold uppercase text-zinc-500 block">Total URLs</span>
                        <span className="text-base font-mono font-bold text-white">{apiResponse.summary.total}</span>
                      </div>
                      <div className="p-3 bg-zinc-950 rounded-2xl border border-zinc-800">
                        <span className="text-[10px] font-bold uppercase text-emerald-500 block">Success (OK)</span>
                        <span className="text-base font-mono font-bold text-emerald-400">{apiResponse.summary.ok}</span>
                      </div>
                      <div className="p-3 bg-zinc-950 rounded-2xl border border-zinc-800">
                        <span className="text-[10px] font-bold uppercase text-red-500 block">Errors</span>
                        <span className="text-base font-mono font-bold text-red-400">{apiResponse.summary.error}</span>
                      </div>
                      <div className="p-3 bg-zinc-950 rounded-2xl border border-zinc-800">
                        <span className="text-[10px] font-bold uppercase text-indigo-400 block">Avg Quality</span>
                        <span className="text-base font-mono font-bold text-indigo-300">
                          {apiResponse.summary.avgScore !== undefined ? `${apiResponse.summary.avgScore}/100` : '—'}
                        </span>
                      </div>
                      <div className="p-3 bg-zinc-950 rounded-2xl border border-zinc-800 col-span-2 sm:col-span-1">
                        <span className="text-[10px] font-bold uppercase text-zinc-500 block">Duration</span>
                        <span className="text-base font-mono font-bold text-zinc-300">
                          {apiResponse.summary.totalDurationSec ? `${apiResponse.summary.totalDurationSec}s` : '—'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Per Recording Results List */}
                  <div className="space-y-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400">
                      Recording Results ({apiResponse.results?.length || 0})
                    </h4>

                    {apiResponse.results && apiResponse.results.length > 0 ? (
                      apiResponse.results.map((rec, idx) => (
                        <div
                          key={idx}
                          className={cn(
                            'p-4 rounded-2xl border transition-all space-y-3',
                            rec.status === 'ok'
                              ? 'bg-zinc-950/80 border-zinc-800 hover:border-zinc-700'
                              : 'bg-red-500/5 border-red-500/30'
                          )}
                        >
                          {/* Header row */}
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2.5">
                            <div className="flex items-center gap-2">
                              {rec.status === 'ok' ? (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-full text-xs font-bold">
                                  <CheckCircle2 className="w-3 h-3" /> OK
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 px-2.5 py-0.5 bg-red-500/10 text-red-400 border border-red-500/30 rounded-full text-xs font-bold">
                                  <XCircle className="w-3 h-3" /> ERROR: {rec.code || 'FAILED'}
                                </span>
                              )}

                              {rec.callId && (
                                <span className="px-2 py-0.5 bg-zinc-800 text-zinc-300 rounded-md font-mono text-xs">
                                  callId: {rec.callId}
                                </span>
                              )}
                            </div>

                            {rec.status === 'ok' && rec.score !== undefined && (
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs text-zinc-400">Quality Score:</span>
                                <span className={cn(
                                  'font-mono font-bold text-xs px-2 py-0.5 rounded',
                                  rec.score >= 80 ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40' :
                                  rec.score >= 60 ? 'bg-amber-950 text-amber-400 border border-amber-800/40' :
                                  'bg-red-950 text-red-400 border border-red-800/40'
                                )}>
                                  {rec.score}/100
                                </span>
                              </div>
                            )}
                          </div>

                          {/* URL display */}
                          <div className="text-[11px] font-mono text-zinc-500 truncate select-all" title={rec.url}>
                            {rec.url}
                          </div>

                          {/* Success Body */}
                          {rec.status === 'ok' ? (
                            <div className="space-y-3 pt-1">
                              {/* Audio Quality Grid */}
                              {rec.audioQuality && (
                                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                                  <div className="p-2 bg-zinc-900 rounded-xl border border-zinc-800/80">
                                    <span className="text-[10px] text-zinc-500 block">Clarity</span>
                                    <span className="font-semibold text-zinc-200 capitalize">{rec.audioQuality.clarity}</span>
                                  </div>
                                  <div className="p-2 bg-zinc-900 rounded-xl border border-zinc-800/80">
                                    <span className="text-[10px] text-zinc-500 block">Noise Level</span>
                                    <span className="font-semibold text-zinc-200 capitalize">{rec.audioQuality.noiseLevel}</span>
                                  </div>
                                  <div className="p-2 bg-zinc-900 rounded-xl border border-zinc-800/80">
                                    <span className="text-[10px] text-zinc-500 block">Dropouts</span>
                                    <span className="font-semibold text-zinc-200">{String(rec.audioQuality.dropouts)}</span>
                                  </div>
                                  <div className="p-2 bg-zinc-900 rounded-xl border border-zinc-800/80">
                                    <span className="text-[10px] text-zinc-500 block">Duration / Silence</span>
                                    <span className="font-semibold text-zinc-200">
                                      {rec.durationSec}s ({Math.round(rec.audioQuality.silenceRatio * 100)}% silence)
                                    </span>
                                  </div>
                                </div>
                              )}

                              {/* Issues */}
                              {rec.issues && rec.issues.length > 0 && (
                                <div className="p-2.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-xs space-y-1">
                                  <span className="font-bold text-amber-400 flex items-center gap-1">
                                    <AlertCircle className="w-3.5 h-3.5" /> Detected Audio Issues:
                                  </span>
                                  <ul className="list-disc list-inside text-amber-200/90 pl-1 space-y-0.5">
                                    {rec.issues.map((iss, i) => (
                                      <li key={i}>{iss}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}

                              {/* Transcript */}
                              {rec.transcript && (
                                <div className="p-3 bg-zinc-900/90 rounded-xl border border-zinc-800/80 space-y-1">
                                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 block">
                                    Verbatim Transcript
                                  </span>
                                  <p className="text-xs text-zinc-300 leading-relaxed max-h-36 overflow-y-auto">
                                    {rec.transcript}
                                  </p>
                                </div>
                              )}
                            </div>
                          ) : (
                            /* Error Body */
                            <div className="p-3 bg-red-950/40 border border-red-800/40 rounded-xl text-xs space-y-1.5">
                              <p className="text-red-300 font-semibold">{rec.message}</p>
                              {rec.debug && (
                                <div className="mt-1 pt-1 border-t border-red-900/50">
                                  <span className="text-[10px] font-bold uppercase text-red-400 block mb-0.5">Debug Output:</span>
                                  <pre className="font-mono text-[11px] text-red-200/80 bg-red-950/60 p-2 rounded max-h-24 overflow-x-auto">
                                    {rec.debug}
                                  </pre>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    ) : (
                      <p className="text-xs text-zinc-500">No recording results returned.</p>
                    )}
                  </div>

                  {/* Raw JSON Accordion */}
                  <div className="pt-2">
                    <details className="text-xs bg-zinc-950 rounded-xl border border-zinc-800 p-3">
                      <summary className="font-semibold text-zinc-400 cursor-pointer hover:text-zinc-200">
                        View Raw Contract JSON Response
                      </summary>
                      <pre className="mt-3 p-2 bg-zinc-900 rounded-lg text-zinc-300 font-mono text-[11px] overflow-x-auto max-h-48 overflow-y-auto">
                        {JSON.stringify(apiResponse, null, 2)}
                      </pre>
                    </details>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center p-8 text-zinc-500 space-y-3">
                  <Server className="w-12 h-12 text-zinc-700" />
                  <div>
                    <p className="text-sm font-semibold text-zinc-400">Ready to audit</p>
                    <p className="text-xs text-zinc-500 mt-1 max-w-xs">
                      Enter pre-signed Tata Tele CloudPhone URLs on the left and click "Hit Endpoint" to test.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* VIEW 2: SERVER LOGS */}
      {activeSubView === 'logs' && (
        <div className="space-y-5">
          <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold text-white">Inbound Endpoint Audit Logs</h2>
                <p className="text-zinc-400 text-sm">
                  History of requests processed by <code className="text-indigo-400 font-mono">/api/audit/tata-tele</code>
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={fetchLogsAndStats}
                  disabled={logsLoading}
                  className="flex items-center gap-1.5 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-semibold border border-zinc-700 cursor-pointer"
                >
                  <RefreshCw className={cn('w-3.5 h-3.5', logsLoading && 'animate-spin')} />
                  Refresh
                </button>
                <button
                  onClick={handleClearLogs}
                  className="flex items-center gap-1.5 px-3 py-2 bg-red-950/40 hover:bg-red-900/60 text-red-300 rounded-xl text-xs font-semibold border border-red-800/40 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Clear Logs
                </button>
              </div>
            </div>

            {/* Filter and Search Bar */}
            <div className="flex flex-col sm:flex-row gap-3 pt-2">
              <div className="flex-1 relative">
                <Search className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={logsSearch}
                  onChange={(e) => setLogsSearch(e.target.value)}
                  placeholder="Search by UID, CallID, or Transcript text..."
                  className="w-full bg-zinc-950 border border-zinc-800 focus:border-indigo-500 rounded-xl pl-9 pr-4 py-2.5 text-xs text-white outline-none"
                />
              </div>

              <select
                value={logsStatusFilter}
                onChange={(e) => setLogsStatusFilter(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 rounded-xl px-3 py-2.5 text-xs text-zinc-300 outline-none"
              >
                <option value="ALL">All Statuses</option>
                <option value="COMPLETED">Completed</option>
                <option value="PARTIAL_OK">Partial OK</option>
                <option value="FAILED">Failed</option>
              </select>
            </div>

            {/* Logs Table */}
            <div className="overflow-x-auto rounded-2xl border border-zinc-800">
              <table className="w-full text-left text-xs">
                <thead className="bg-zinc-950/80 text-zinc-400 font-bold uppercase tracking-wider border-b border-zinc-800">
                  <tr>
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">UID</th>
                    <th className="py-3 px-4">Recordings</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Avg Score</th>
                    <th className="py-3 px-4">Latency</th>
                    <th className="py-3 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/60 font-mono">
                  {logs.length > 0 ? (
                    logs.map((log) => (
                      <tr key={log.id} className="hover:bg-zinc-800/40 transition-colors">
                        <td className="py-3 px-4 text-zinc-400 whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleTimeString()}
                        </td>
                        <td className="py-3 px-4 font-bold text-white">{log.uid}</td>
                        <td className="py-3 px-4 text-zinc-300">
                          {log.recordingsCount} url(s) ({log.okCount} ok, {log.errorCount} err)
                        </td>
                        <td className="py-3 px-4">
                          <span className={cn(
                            'px-2 py-0.5 rounded text-[11px] font-bold',
                            log.status === 'COMPLETED' ? 'bg-emerald-950 text-emerald-400 border border-emerald-800/40' :
                            log.status === 'PARTIAL_OK' ? 'bg-amber-950 text-amber-400 border border-amber-800/40' :
                            'bg-red-950 text-red-400 border border-red-800/40'
                          )}>
                            {log.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-zinc-200">
                          {log.avgScore !== undefined ? `${log.avgScore}/100` : '—'}
                        </td>
                        <td className="py-3 px-4 text-indigo-400">{log.durationMs} ms</td>
                        <td className="py-3 px-4 text-right">
                          <button
                            onClick={() => setSelectedLog(log)}
                            className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-lg text-xs font-sans font-semibold cursor-pointer"
                          >
                            Inspect
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-zinc-500 font-sans">
                        No logs recorded yet. Hit the endpoint from the Tester or cURL to see entries here.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Modal Inspector for Log Detail */}
          {selectedLog && (
            <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
              <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 max-w-2xl w-full max-h-[85vh] overflow-y-auto space-y-4">
                <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
                  <h3 className="text-base font-bold text-white">Log Inspection: {selectedLog.uid}</h3>
                  <button
                    onClick={() => setSelectedLog(null)}
                    className="text-zinc-400 hover:text-zinc-200 font-bold text-sm cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
                <div className="space-y-3 text-xs">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
                      <span className="text-zinc-500 block">UID</span>
                      <span className="font-bold text-white font-mono">{selectedLog.uid}</span>
                    </div>
                    <div className="p-3 bg-zinc-950 rounded-xl border border-zinc-800">
                      <span className="text-zinc-500 block">Latency</span>
                      <span className="font-bold text-indigo-400 font-mono">{selectedLog.durationMs} ms</span>
                    </div>
                  </div>
                  <div>
                    <span className="text-zinc-400 font-bold block mb-1">Full Results Payload:</span>
                    <pre className="bg-zinc-950 p-3 rounded-xl border border-zinc-800 font-mono text-[11px] text-zinc-300 overflow-x-auto max-h-60">
                      {JSON.stringify(selectedLog.results, null, 2)}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIEW 3: API CONTRACT & DOCUMENTATION */}
      {activeSubView === 'docs' && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-xl space-y-6">
          <div>
            <h2 className="text-xl font-bold text-white">API Integration Contract</h2>
            <p className="text-zinc-400 text-sm mt-1">
              Specification for integrating the Tata Tele CloudPhone recording auditor endpoint into CRM, Python scripts, or backend services.
            </p>
          </div>

          {/* Contract Schema Box */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 space-y-2">
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wider block">
                Request Contract
              </span>
              <pre className="text-xs font-mono text-zinc-300 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800/80 overflow-x-auto">
{`{
  "uid": "LEAD-12345",
  "recordings": [
    "https://cloudphone.tatateleservices.com/file/recording?callId=HYD1-D7-1786537145.280683&type=rec&token=...%3D%3D"
  ]
}`}
              </pre>
            </div>

            <div className="bg-zinc-950 p-4 rounded-2xl border border-zinc-800 space-y-2">
              <span className="text-xs font-bold text-indigo-400 uppercase tracking-wider block">
                Response Contract (HTTP 200)
              </span>
              <pre className="text-xs font-mono text-zinc-300 bg-zinc-900/60 p-3 rounded-xl border border-zinc-800/80 overflow-x-auto max-h-48 overflow-y-auto">
{`{
  "uid": "LEAD-12345",
  "results": [
    {
      "url": "https://...",
      "callId": "HYD1-D7-1786537145.280683",
      "status": "ok",
      "durationSec": 45.2,
      "transcript": "Hello, speaking with ...",
      "audioQuality": {
        "clarity": "high",
        "noiseLevel": "low",
        "dropouts": 0,
        "silenceRatio": 0.05
      },
      "issues": [],
      "score": 92
    },
    {
      "url": "https://...",
      "callId": "...",
      "status": "error",
      "code": "AUTH_FAILED",
      "message": "token expired or invalid",
      "debug": "..."
    }
  ],
  "summary": {
    "total": 2,
    "ok": 1,
    "error": 1,
    "totalDurationSec": 45.2,
    "avgScore": 92
  }
}`}
              </pre>
            </div>
          </div>

          {/* Language Snippet Switcher */}
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-2 border-b border-zinc-800 pb-2">
              <button
                onClick={() => setDocLanguage('curl')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                  docLanguage === 'curl' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                cURL
              </button>
              <button
                onClick={() => setDocLanguage('nodejs')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                  docLanguage === 'nodejs' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                Node.js (Axios)
              </button>
              <button
                onClick={() => setDocLanguage('python')}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer',
                  docLanguage === 'python' ? 'bg-indigo-600 text-white' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                Python 3 (Requests)
              </button>
            </div>

            <div className="relative">
              <pre className="p-4 bg-zinc-950 rounded-2xl border border-zinc-800 text-xs font-mono text-zinc-300 overflow-x-auto">
                {docLanguage === 'curl' && getCurlSnippet()}
                {docLanguage === 'nodejs' && getNodeJsSnippet()}
                {docLanguage === 'python' && getPythonSnippet()}
              </pre>
              <button
                onClick={() =>
                  copyToClipboard(
                    docLanguage === 'curl'
                      ? getCurlSnippet()
                      : docLanguage === 'nodejs'
                      ? getNodeJsSnippet()
                      : getPythonSnippet(),
                    'code-doc'
                  )
                }
                className="absolute top-3 right-3 flex items-center gap-1.5 px-3 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-bold rounded-lg border border-zinc-700 cursor-pointer"
              >
                {copiedKey === 'code-doc' ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                {copiedKey === 'code-doc' ? 'Copied' : 'Copy Code'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
