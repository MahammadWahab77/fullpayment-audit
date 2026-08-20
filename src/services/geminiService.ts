import { GoogleGenAI } from "@google/genai";
import { ANALYSIS_PROMPT } from "../constants";

function getAI(customApiKey?: string) {
  const key = customApiKey || process.env.GEMINI_API_KEY;
  return new GoogleGenAI({ apiKey: key });
}

export async function transcribeAndIdentify(audioBase64: string, audioMimeType: string, framesBase64: string[], customApiKey?: string) {
  const ai = getAI(customApiKey);
  // Restore real data processing using audio and frames as agreed
  const hasAudio = audioBase64 && audioBase64.length > 100;
  const parts: any[] = [
    { text: ANALYSIS_PROMPT },
    {
      text: `AUDIO STATUS: This video ${hasAudio
        ? 'has a detectable audio track. Listen carefully for loan and document words.'
        : 'DOES NOT have an audio track — it is completely silent. You MUST set isIrrelevant: true and transcript: "NO AUDIO DETECTED".'
      }`
    },
    {
      inlineData: {
        mimeType: audioMimeType,
        data: audioBase64
      }
    }
  ];

  // Add frames
  framesBase64.forEach((frame, index) => {
    parts.push({
      inlineData: {
        mimeType: "image/jpeg",
        data: frame
      }
    });
  });

  const model = ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [{ parts }],
    config: { responseMimeType: "application/json" }
  });

  const response = await model;
  const text = response.text;
  console.log('Gemini Raw Response Text:', text);
  if (!text) throw new Error("No response from AI model");
  
  try {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON found');
    return {
      data: JSON.parse(cleaned.substring(first, last + 1)),
      usage: response.usageMetadata
    };
  } catch (e) {
    console.error('Parse failed. Raw response:', text);
    throw new Error("Invalid AI response format");
  }
}

// This function is now redundant as transcribeAndIdentify handles the full text-only analysis
// but we keep the export for compatibility with existing App.tsx logic if needed.
export async function analyzeTextOnly(transcript: string, visualContext: { videoClarity: string, faceVisible: boolean }, customApiKey?: string) {
  const ai = getAI(customApiKey);
  const model = ai.models.generateContent({
    model: "gemini-3.5-flash",
    contents: [{
      parts: [{
        text: ANALYSIS_PROMPT + 
              `\n\nVISUAL CONTEXT: Video Clarity is ${visualContext.videoClarity}. Face is ${visualContext.faceVisible ? 'Visible' : 'Not Visible'}.` +
              `\n\nTranscript:\n${transcript}`
      }]
    }],
    config: { responseMimeType: "application/json" }
  });

  const response = await model;
  const text = response.text;
  if (!text) throw new Error("No response from analysis step");
  
  try {
    const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last === -1) throw new Error('No JSON found');
    return {
      data: JSON.parse(cleaned.substring(first, last + 1)),
      usage: response.usageMetadata
    };
  } catch (e) {
    console.error('Parse failed. Raw response:', text);
    throw new Error("Invalid AI response format");
  }
}
