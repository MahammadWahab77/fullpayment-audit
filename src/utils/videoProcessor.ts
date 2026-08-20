export interface ProcessedVideo {
  frames: string[];
  audio: string;
  audioMimeType: string;
  hasAudio: boolean;
}

export async function processVideoLocally(url: string): Promise<ProcessedVideo> {
  // Fetch the video ONCE — reuse the same buffer for both frames and audio
  const controller = new AbortController();
  const fetchTimeout = setTimeout(() => controller.abort(), 300000);

  let arrayBuffer: ArrayBuffer;
  try {
    const isS3Url = (
      url.includes('nw-sales-prdm-media-static') ||
      url.includes('nw-sales-prdzn-media-static') ||
      url.includes('s3.ap-south-1') ||
      url.includes('s3.amazonaws.com')
    );

    let response: Response | null = null;
    let lastError: any = null;

    if (isS3Url) {
      // List of proxies to try sequentially
      const proxies = [
        (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`,
        (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
        (u: string) => `https://corsproxy.org/?${encodeURIComponent(u)}`
      ];

      for (let i = 0; i < proxies.length; i++) {
        try {
          const proxiedUrl = proxies[i](url);
          console.log(`VideoProcessor: Attempting fetch via proxy ${i + 1}/${proxies.length}: ${proxiedUrl}`);
          const res = await fetch(proxiedUrl, { signal: controller.signal });
          if (res.ok) {
            response = res;
            break;
          }
          throw new Error(`Proxy status: ${res.status} ${res.statusText}`);
        } catch (err: any) {
          console.warn(`VideoProcessor: Proxy option ${i + 1} failed:`, err.message || err);
          lastError = err;
        }
      }
    }

    // If proxies failed or we didn't need a proxy, try direct fetch
    if (!response) {
      console.log('VideoProcessor: Attempting direct fetch...');
      try {
        response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Direct fetch failed with status: ${response.status} ${response.statusText}`);
        }
      } catch (directErr: any) {
        if (isS3Url) {
          const errMsg = lastError ? lastError.message : directErr.message;
          throw new Error(`Failed to load video. Check S3 bucket CORS policy — allow GET from this domain. (Underlying error: ${errMsg})`);
        } else {
          throw directErr;
        }
      }
    }

    clearTimeout(fetchTimeout);
    arrayBuffer = await response.arrayBuffer();
    
    console.log('Video size:', (arrayBuffer.byteLength / 1024 / 1024).toFixed(2), 'MB');

    if (arrayBuffer.byteLength > 100 * 1024 * 1024) {
      throw new Error('Video file too large (over 100MB). Please use a compressed version.');
    }
  } catch (err: any) {
    clearTimeout(fetchTimeout);
    if (err.name === 'AbortError') {
      throw new Error('Video fetch timed out (5 min). The file may be too large or the server is slow.');
    }
    throw err;
  }

  // Extract frames using a Blob URL — no second network request
  const blob = new Blob([arrayBuffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  const frames: string[] = [];

  try {
    const video = document.createElement('video');
    video.src = blobUrl;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';

    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('Video metadata load timed out.')), 120000);
      video.onloadedmetadata = () => { clearTimeout(t); res(); };
      video.onerror = () => {
        clearTimeout(t);
        const code = video.error?.code;
        if (code === MediaError.MEDIA_ERR_DECODE) {
          rej(new Error('Video file is corrupted or format not supported. Must be MP4.'));
        } else {
          rej(new Error('Failed to load video. Ensure it is a valid MP4 file.'));
        }
      };
    });

    const duration = video.duration;
    if (!duration || !isFinite(duration)) throw new Error('Could not read video duration.');

    const timestamps = [
      Math.min(2, duration * 0.15),
      duration * 0.5,
      Math.max(duration - 2, duration * 0.85),
    ];

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const targetWidth = 480;

    for (const ts of timestamps) {
      video.currentTime = ts;
      await new Promise<void>(r => { video.onseeked = () => r(); });
      const aspectRatio = (video.videoHeight || 360) / (video.videoWidth || 640);
      canvas.width = targetWidth;
      canvas.height = Math.round(targetWidth * aspectRatio);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL('image/jpeg', 0.75).split(',')[1]);
    }

    video.src = '';
    video.load();
  } finally {
    URL.revokeObjectURL(blobUrl);
  }

  // Extract audio from the SAME ArrayBuffer — no second download
  let audio = createSilentWav();
  let hasAudio = false;

  try {
    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const bufferCopy = arrayBuffer.slice(0); // clone — decodeAudioData detaches original
    const audioBuffer = await audioCtx.decodeAudioData(bufferCopy);
    audio = audioBufferToBase64Wav(audioBuffer);
    hasAudio = true;
    await audioCtx.close();
  } catch {
    hasAudio = false;
  }

  return { frames, audio, audioMimeType: 'audio/wav', hasAudio };
}

function audioBufferToBase64Wav(buffer: AudioBuffer): string {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const numSamples = buffer.length;
  const dataSize = numSamples * numChannels * 2;
  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  const ws = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: numChannels }, (_, i) => buffer.getChannelData(i));
  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
  }

  // Chunked encoding — prevents crash on long audio
  const bytes = new Uint8Array(wavBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return window.btoa(binary);
}

function createSilentWav(): string {
  const sampleRate = 8000;
  const numSamples = sampleRate;
  const buf = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buf);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF'); view.setUint32(4, 36 + numSamples * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); ws(36, 'data'); view.setUint32(40, numSamples * 2, true);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return window.btoa(bin);
}