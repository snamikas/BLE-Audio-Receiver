// src/workers/opus-decoder.worker.ts


class OpusDecoderWorker {
  constructor() {
    this.decoder = null;
    this.wasmModule = null;
    this.inputBuffer = null;
    this.outputBuffer = null;
    this.maxFrameSize = 5760; // 120ms at 48kHz
    this.sampleRate = 48000;
    this.channels = 1;
  }

  async initialize() {
    try {
      // Load the Emscripten-generated module
      const LibOpusModule = await import('./libopus.js');
      this.wasmModule = await LibOpusModule.default();

      // Create Opus decoder
      const errorPtr = this.wasmModule._malloc(4);
      this.decoder = this.wasmModule._opus_decoder_create(
        this.sampleRate, 
        this.channels, 
        errorPtr
      );

      const errorCode = this.wasmModule.getValue(errorPtr, 'i32');
      this.wasmModule._free(errorPtr);

      if (errorCode !== 0) {
        throw new Error(`Opus decoder creation failed: ${errorCode}`);
      }

      // Allocate buffers
      this.inputBuffer = this.wasmModule._malloc(4000);
      this.outputBuffer = this.wasmModule._malloc(this.maxFrameSize * 4);

      self.postMessage({ type: 'decoder-ready' });

    } catch (error) {
      self.postMessage({ 
        type: 'decoder-error', 
        error: error.message 
      });
    }
  }

  decode(opusData) {
    if (!this.decoder || !this.wasmModule) {
      throw new Error('Decoder not initialized');
    }

    try {
      // Copy input data to WASM heap
      const inputView = new Uint8Array(
        this.wasmModule.HEAPU8.buffer, 
        this.inputBuffer, 
        opusData.length
      );
      inputView.set(opusData);

      // Decode the packet
      const samplesDecoded = this.wasmModule._opus_decode_float(
        this.decoder,
        this.inputBuffer,
        opusData.length,
        this.outputBuffer,
        this.maxFrameSize,
        0 // decode_fec
      );

      if (samplesDecoded < 0) {
        throw new Error(`Opus decode failed: ${samplesDecoded}`);
      }

      // Copy output to JavaScript array
      const outputView = new Float32Array(
        this.wasmModule.HEAPF32.buffer,
        this.outputBuffer,
        samplesDecoded
      );

      const result = new Float32Array(samplesDecoded);
      result.set(outputView);

      return result;

    } catch (error) {
      console.error('Decode error:', error);
      throw error;
    }
  }

  configure(config) {
    if (!this.decoder || !this.wasmModule) return;

    try {
      if (config.gain !== undefined) {
        const OPUS_SET_GAIN_REQUEST = 4034;
        const gainValue = Math.round(config.gain * 256);
        this.wasmModule._opus_decoder_ctl(
          this.decoder, 
          OPUS_SET_GAIN_REQUEST, 
          gainValue
        );
      }
    } catch (error) {
      console.error('Configuration error:', error);
    }
  }

  reset() {
    if (this.decoder && this.wasmModule) {
      this.wasmModule._opus_decoder_destroy(this.decoder);
      this.wasmModule._free(this.inputBuffer);
      this.wasmModule._free(this.outputBuffer);
      
      // Reinitialize
      this.initialize();
    }
  }

  destroy() {
    if (this.decoder && this.wasmModule) {
      this.wasmModule._opus_decoder_destroy(this.decoder);
      this.wasmModule._free(this.inputBuffer);
      this.wasmModule._free(this.outputBuffer);
      this.decoder = null;
    }
  }
}

// Worker message handler
const decoderWorker = new OpusDecoderWorker();

self.onmessage = async (e) => {
  const { type, data, config } = e.data;

  switch (type) {
    case 'init':
      await decoderWorker.initialize();
      break;

    case 'decode':
      if (data && data.length > 0) {
        try {
          const startTime = performance.now();
          const decodedAudio = decoderWorker.decode(data);
          const decodeTime = performance.now() - startTime;

          self.postMessage({
            type: 'decoded-audio',
            audioData: decodedAudio,
            timestamp: performance.now(),
            decodeTime,
            samplesDecoded: decodedAudio.length
          });
        } catch (error) {
          self.postMessage({ 
            type: 'decode-error', 
            error: error.message 
          });
        }
      } else {
        // Handle packet loss with silence
        const silenceBuffer = new Float32Array(480);
        self.postMessage({
          type: 'decoded-audio',
          audioData: silenceBuffer,
          timestamp: performance.now(),
          isPacketLoss: true
        });
      }
      break;

    case 'configure':
      decoderWorker.configure(config);
      break;

    case 'reset':
      decoderWorker.reset();
      break;

    case 'destroy':
      decoderWorker.destroy();
      self.postMessage({ type: 'destroyed' });
      break;
  }
};
