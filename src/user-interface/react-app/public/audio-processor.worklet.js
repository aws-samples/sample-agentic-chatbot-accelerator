// AudioWorklet processor for capturing microphone audio and converting to PCM Int16
// Runs on a separate audio thread for better performance.
// Used by the useVoiceAgent hook for voice-to-voice conversations.
class AudioCaptureProcessor extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const inputData = input[0]; // Float32 mono channel

        // Convert Float32 [-1.0, 1.0] to Int16 [-32768, 32767]
        const pcmData = new Int16Array(inputData.length);
        for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send PCM data to the main thread
        this.port.postMessage({ type: "audio", data: pcmData });
        return true;
    }
}

registerProcessor("audio-capture-processor", AudioCaptureProcessor);
