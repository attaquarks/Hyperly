declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

declare function registerProcessor(
  name: string,
  processorCtor: new (...args: never[]) => AudioWorkletProcessor
): void;

declare const sampleRate: number;
