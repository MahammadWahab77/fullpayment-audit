import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';

interface TataTeleRecordingResult {
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

interface TataTeleAuditResponse {
  uid: string;
  results: TataTeleRecordingResult[];
  summary: {
    total: number;
    ok: number;
    error: number;
    totalDurationSec?: number;
    avgScore?: number;
  };
}

interface AuditLogEntry {
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
  results: TataTeleRecordingResult[];
  error?: string;
}

const auditLogs: AuditLogEntry[] = [];
const MAX_LOGS = 500;

function getAI(customKey?: string) {
  const apiKey = customKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server. Please set it in Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

/**
 * Parse callId out of the query string for display only.
 */
function extractCallId(urlStr: string): string {
  try {
    const match = urlStr.match(/[?&]callId=([^&]+)/i);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  } catch {
    // fallback
  }
  return '';
}

/**
 * Convert audio buffer to 16kHz mono PCM WAV via FFmpeg
 */
function normalizeAudioToWav(inputPath: string, outputPath: string): Promise<{ exitCode: number; durationMs: number }> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', inputPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath],
      (err, stdout, stderr) => {
        const durationMs = Math.round(performance.now() - start);
        if (err) {
          console.error(`[FFmpeg] Error (exit code ${err.code ?? 1}, ${durationMs}ms):`, stderr);
          return reject(new Error(`FFmpeg exit ${err.code ?? 1}: ${stderr || err.message}`));
        }
        console.log(`[FFmpeg] Exit code 0, conversion completed in ${durationMs}ms`);
        resolve({ exitCode: 0, durationMs });
      }
    );
  });
}

/**
 * Extract clean JSON from Gemini output
 */
function extractJsonFromText(rawText: string): any {
  const cleaned = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first === -1 || last === -1) {
    throw new Error('No valid JSON object found in model output');
  }
  return JSON.parse(cleaned.substring(first, last + 1));
}

/**
 * Audit a single recording URL with strict error isolation, URL preservation, and FFmpeg normalization.
 */
async function auditSingleRecording(
  url: string,
  index: number,
  total: number,
  customApiKey?: string
): Promise<TataTeleRecordingResult> {
  const callId = extractCallId(url);
  const randomId = crypto.randomBytes(6).toString('hex');
  const tempInputPath = path.join(os.tmpdir(), `tata_in_${randomId}.raw`);
  const tempWavPath = path.join(os.tmpdir(), `tata_out_${randomId}.wav`);

  // Log exact outbound URL before fetching
  console.log(`[TataTele] [${index + 1}/${total}] Outbound URL: ${url}`);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 60000);

  try {
    // 1. Fetch exactly as received - Opaque string, no URL normalizer or encodeURIComponent
    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'audio/*, application/octet-stream, */*',
        },
        redirect: 'follow',
        signal: abortController.signal,
      });
    } catch (fetchErr: any) {
      if (fetchErr.name === 'AbortError') {
        console.error(`[TataTele] [${index + 1}/${total}] Fetch timed out after 60s`);
        return {
          url,
          callId,
          status: 'error',
          code: 'FETCH_TIMEOUT',
          message: 'Request timed out after 60s',
        };
      }
      console.error(`[TataTele] [${index + 1}/${total}] Fetch network error:`, fetchErr.message);
      return {
        url,
        callId,
        status: 'error',
        code: 'FETCH_FAILED',
        message: fetchErr.message || 'Failed to fetch recording URL',
      };
    } finally {
      clearTimeout(timeoutId);
    }

    const contentType = response.headers.get('content-type') || '';
    console.log(`[TataTele] [${index + 1}/${total}] Response status: ${response.status} ${response.statusText}`);
    console.log(`[TataTele] [${index + 1}/${total}] Content-Type: ${contentType || '(none)'}`);

    // 2. Validate HTTP status
    if (!response.ok) {
      return {
        url,
        callId,
        status: 'error',
        code: 'FETCH_FAILED',
        message: `HTTP fetch failed with status ${response.status}`,
        httpStatus: response.status,
      };
    }

    // 3. Read ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    console.log(`[TataTele] [${index + 1}/${total}] Byte length: ${buffer.length} bytes`);

    // 4. Validate Content-Type & Token Auth (HTML or JSON error responses)
    const lowerContentType = contentType.toLowerCase();
    if (lowerContentType.includes('text/html') || lowerContentType.includes('application/json')) {
      const debugText = buffer.toString('utf8', 0, Math.min(buffer.length, 200));
      console.warn(`[TataTele] [${index + 1}/${total}] Auth failed (Content-Type: ${contentType}): ${debugText}`);
      return {
        url,
        callId,
        status: 'error',
        code: 'AUTH_FAILED',
        message: 'token expired or invalid',
        debug: debugText,
      };
    }

    // 5. Validate byte length
    if (buffer.length < 1024) {
      console.warn(`[TataTele] [${index + 1}/${total}] Empty recording (${buffer.length} bytes < 1024)`);
      return {
        url,
        callId,
        status: 'error',
        code: 'EMPTY_RECORDING',
        message: `Recording file too small (${buffer.length} bytes)`,
        byteLength: buffer.length,
      };
    }

    // 6. Magic bytes check: if octet-stream / missing header contains text HTML/JSON
    const startAscii = buffer.toString('ascii', 0, Math.min(buffer.length, 64)).trim().toLowerCase();
    if (
      startAscii.startsWith('<html') ||
      startAscii.startsWith('<!doctype') ||
      startAscii.startsWith('{"') ||
      startAscii.startsWith('{')
    ) {
      const debugText = buffer.toString('utf8', 0, Math.min(buffer.length, 200));
      console.warn(`[TataTele] [${index + 1}/${total}] Magic bytes detect HTML/JSON error body: ${debugText}`);
      return {
        url,
        callId,
        status: 'error',
        code: 'AUTH_FAILED',
        message: 'token expired or invalid',
        debug: debugText,
      };
    }

    // 7. Write to temp file for FFmpeg
    await fs.promises.writeFile(tempInputPath, buffer);

    // 8. Normalize with FFmpeg -> 16kHz mono PCM WAV
    try {
      await normalizeAudioToWav(tempInputPath, tempWavPath);
    } catch (ffmpegErr: any) {
      console.error(`[TataTele] [${index + 1}/${total}] FFmpeg failed:`, ffmpegErr.message);
      return {
        url,
        callId,
        status: 'error',
        code: 'FFMPEG_CONVERSION_FAILED',
        message: ffmpegErr.message || 'Failed to normalize audio with FFmpeg',
      };
    }

    // 9. Read normalized WAV & calculate exact duration
    const wavBuffer = await fs.promises.readFile(tempWavPath);
    // 16000 Hz * 1 channel * 2 bytes/sample = 32000 bytes/sec PCM data (minus 44-byte WAV header)
    const durationSec = Number(Math.max(0.1, (wavBuffer.length - 44) / 32000).toFixed(1));
    console.log(`[TataTele] [${index + 1}/${total}] Normalized WAV size: ${wavBuffer.length} bytes, duration: ${durationSec}s`);

    // 10. Analyze with Gemini (audio input)
    const ai = getAI(customApiKey);
    const modelStartTime = performance.now();

    let contentPart: any;
    const isLargeFile = wavBuffer.length > 20 * 1024 * 1024; // > 20MB

    if (isLargeFile) {
      console.log(`[TataTele] [${index + 1}/${total}] File size > 20MB, uploading via Gemini Files API...`);
      const uploadResult = await ai.files.upload({
        file: tempWavPath,
        config: {
          mimeType: 'audio/wav',
        },
      });
      contentPart = {
        fileData: {
          fileUri: uploadResult.uri,
          mimeType: uploadResult.mimeType || 'audio/wav',
        },
      };
    } else {
      contentPart = {
        inlineData: {
          mimeType: 'audio/wav',
          data: wavBuffer.toString('base64'),
        },
      };
    }

    const geminiPrompt = `Analyze this call recording audio.
Tasks:
1. Provide a verbatim transcript of the entire audio conversation in English/spoken language.
2. Evaluate the audio quality:
   - clarity: "high" | "medium" | "low"
   - noiseLevel: "low" | "medium" | "high"
   - dropouts: number of detected audio dropouts, glitches, or packet loss pauses (0 if none)
   - silenceRatio: proportion of dead silence / empty hold time as a decimal between 0.0 and 1.0 (e.g. 0.05)
3. List any audio, telecommunication, or communication issues detected in the call (e.g. "heavy background noise", "speaker clipping", "agent crosstalk", "long silence pause"). Empty array if none.
4. Calculate an overall audio quality score from 0 to 100 based on clarity, noise level, and intelligibility.

Return ONLY a valid JSON object matching this schema:
{
  "transcript": "string",
  "audioQuality": {
    "clarity": "high" | "medium" | "low",
    "noiseLevel": "low" | "medium" | "high",
    "dropouts": 0,
    "silenceRatio": 0.05
  },
  "issues": ["string"],
  "score": 90
}`;

    let geminiResponse: any;
    try {
      geminiResponse = await ai.models.generateContent({
        model: 'gemini-3.7-flash',
        contents: [
          {
            parts: [
              contentPart,
              { text: geminiPrompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });
    } catch (modelErr: any) {
      // Fallback model if primary has issues
      console.warn('[Gemini] Retrying with fallback model gemini-3.6-flash...', modelErr.message);
      geminiResponse = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: [
          {
            parts: [
              contentPart,
              { text: geminiPrompt },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          temperature: 0.1,
        },
      });
    }

    const modelLatency = Math.round(performance.now() - modelStartTime);
    console.log(`[TataTele] [${index + 1}/${total}] Gemini model latency: ${modelLatency}ms`);

    const rawText = geminiResponse.text || '';
    const parsed = extractJsonFromText(rawText);

    return {
      url,
      callId,
      status: 'ok',
      durationSec,
      transcript: parsed.transcript || '',
      audioQuality: {
        clarity: parsed.audioQuality?.clarity || 'high',
        noiseLevel: parsed.audioQuality?.noiseLevel || 'low',
        dropouts: parsed.audioQuality?.dropouts ?? 0,
        silenceRatio: typeof parsed.audioQuality?.silenceRatio === 'number' ? parsed.audioQuality.silenceRatio : 0.05,
      },
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
      score: typeof parsed.score === 'number' ? parsed.score : 90,
    };
  } catch (err: any) {
    console.error(`[TataTele] [${index + 1}/${total}] Processing exception:`, err.message);
    return {
      url,
      callId,
      status: 'error',
      code: 'ANALYSIS_FAILED',
      message: err.message || 'Analysis failed',
    };
  } finally {
    // Cleanup temporary files
    try {
      if (fs.existsSync(tempInputPath)) await fs.promises.unlink(tempInputPath);
    } catch {}
    try {
      if (fs.existsSync(tempWavPath)) await fs.promises.unlink(tempWavPath);
    } catch {}
  }
}

/**
 * Handle POST /api/audit/tata-tele
 */
async function handleTataTeleAudit(req: Request, res: Response): Promise<void> {
  const reqStart = performance.now();
  const body = req.body || {};
  const customApiKey = (req.headers['x-gemini-api-key'] as string) || body.apiKey || body.customApiKey;

  const uid = typeof body.uid === 'string' && body.uid.trim() ? body.uid.trim() : (body.callId || `CALL-${Date.now()}`);

  let recordings: string[] = [];
  if (Array.isArray(body.recordings)) {
    recordings = body.recordings.filter((u: any) => typeof u === 'string' && u.trim().length > 0);
  } else if (typeof body.recording === 'string' && body.recording.trim()) {
    recordings = [body.recording.trim()];
  } else if (typeof body.recordingUrl === 'string' && body.recordingUrl.trim()) {
    recordings = [body.recordingUrl.trim()];
  } else if (typeof body.url === 'string' && body.url.trim()) {
    recordings = [body.url.trim()];
  }

  console.log(`[TataTele] Starting audit for UID: ${uid} with ${recordings.length} recording(s)`);

  const results: TataTeleRecordingResult[] = [];

  for (let i = 0; i < recordings.length; i++) {
    const recResult = await auditSingleRecording(recordings[i], i, recordings.length, customApiKey);
    results.push(recResult);
  }

  const okCount = results.filter((r) => r.status === 'ok').length;
  const errorCount = results.filter((r) => r.status === 'error').length;
  const totalDurationSec = Number(
    results.reduce((acc, r) => acc + (r.durationSec || 0), 0).toFixed(1)
  );
  const scores = results
    .filter((r) => r.status === 'ok' && typeof r.score === 'number')
    .map((r) => r.score as number);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  const summary = {
    total: recordings.length,
    ok: okCount,
    error: errorCount,
    totalDurationSec,
    avgScore,
  };

  const durationMs = Math.round(performance.now() - reqStart);
  console.log(`[TataTele] Audit finished for UID: ${uid} in ${durationMs}ms. Summary:`, summary);

  // Store in audit logs for UI inspection
  const logEntry: AuditLogEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    uid,
    source: (req.headers['x-forwarded-for'] as string) || req.ip || 'api/tata-tele',
    recordingsCount: recordings.length,
    status: okCount > 0 ? (errorCount === 0 ? 'COMPLETED' : 'PARTIAL_OK') : 'FAILED',
    okCount,
    errorCount,
    avgScore,
    totalDurationSec,
    durationMs,
    results,
  };
  auditLogs.unshift(logEntry);
  if (auditLogs.length > MAX_LOGS) auditLogs.pop();

  const responsePayload: TataTeleAuditResponse = {
    uid,
    results,
    summary,
  };

  res.status(200).json(responsePayload);
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // CORS Middleware & Explicit Headers
  app.use(cors());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-gemini-api-key');
    if (req.method === 'OPTIONS') {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));

  // Request logger
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) {
      console.log(`[API ${req.method}] ${req.path}`);
    }
    next();
  });

  // Health check
  app.get('/api/health', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'Tata Tele Call Recording Quality Analyst AI API',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
    });
  });

  // Primary Endpoint CONTRACT: POST /api/audit/tata-tele
  app.post('/api/audit/tata-tele', handleTataTeleAudit);
  app.post('/api/audit/call-recording', handleTataTeleAudit);
  app.post('/api/audit/call-recordings', handleTataTeleAudit);

  // Endpoint to retrieve server audit logs (queried by frontend UI)
  app.get('/api/audit/logs', (req: Request, res: Response) => {
    const limit = Math.min(100, Number(req.query.limit) || 50);
    const search = ((req.query.search as string) || '').toLowerCase();
    const status = (req.query.status as string) || 'ALL';

    let filtered = auditLogs;
    if (status && status !== 'ALL') {
      filtered = filtered.filter((l) => l.status === status);
    }
    if (search) {
      filtered = filtered.filter(
        (l) =>
          l.uid.toLowerCase().includes(search) ||
          l.results.some((r) => (r.transcript && r.transcript.toLowerCase().includes(search)) || r.url.toLowerCase().includes(search))
      );
    }

    res.json({
      total: filtered.length,
      logs: filtered.slice(0, limit),
    });
  });

  // Endpoint to get real-time statistics of audits processed by server
  app.get('/api/audit/stats', (req: Request, res: Response) => {
    const totalRequests = auditLogs.length;
    const okAudits = auditLogs.filter((l) => l.status === 'COMPLETED' || l.status === 'PARTIAL_OK').length;
    const errorAudits = auditLogs.filter((l) => l.status === 'FAILED').length;
    const totalRecordings = auditLogs.reduce((acc, l) => acc + (l.recordingsCount || 0), 0);
    const avgDuration =
      totalRequests > 0
        ? Math.round(auditLogs.reduce((acc, l) => acc + (l.durationMs || 0), 0) / totalRequests)
        : 0;

    res.json({
      totalRequests,
      okAudits,
      errorAudits,
      totalRecordings,
      successRatePercent: totalRequests > 0 ? Math.round((okAudits / totalRequests) * 100) : 100,
      avgDurationMs: avgDuration,
    });
  });

  // Clear in-memory audit logs
  app.post('/api/audit/logs/clear', (req: Request, res: Response) => {
    auditLogs.length = 0;
    res.json({ success: true, message: 'Server audit logs cleared' });
  });

  // Vite middleware for development vs Production build serving
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] Audit API & App running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('[Server Startup Error]:', err);
});
