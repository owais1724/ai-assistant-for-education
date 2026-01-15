import { GoogleGenerativeAI } from "@google/genai";

/**
 * Creates and returns Gemini AI client
 * Works in Vite + React frontend
 */
export function getAIClient() {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;

  if (!apiKey) {
    console.error("❌ VITE_GEMINI_API_KEY missing");
    throw new Error("Gemini API key not found");
  }

  return new GoogleGenerativeAI(apiKey);
}

/**
 * Audio + base64 helpers (unchanged)
 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function decodeAudioData(
  bytes: Uint8Array,
  audioContext: AudioContext,
  sampleRate: number,
  channels: number
): Promise<AudioBuffer> {
  const buffer = audioContext.createBuffer(
    channels,
    bytes.length / 2,
    sampleRate
  );

  const dataView = new DataView(bytes.buffer);
  const channelData = buffer.getChannelData(0);

  for (let i = 0; i < channelData.length; i++) {
    channelData[i] = dataView.getInt16(i * 2, true) / 32768;
  }

  return buffer;
}
