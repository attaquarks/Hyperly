import localVqeGlueUrl from "/localvqe/localvqe-glue.mjs?url";

interface WorkerScope {
  location: Location;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  close(): void;
}

interface WorkerRequest {
  type: "load" | "process" | "reset" | "dispose";
  id?: number;
  mic?: Float32Array;
  ref?: Float32Array;
  gap?: boolean;
}

type WorkerResponse =
  | { type: "ready"; sampleRate: number; hop: number; fft: number }
  | { type: "processed"; id: number; samples: ArrayBuffer; rc: 0 }
  | { type: "reset" }
  | { type: "disposed" }
  | { type: "error"; id?: number; message: string };

interface LocalVqeModule {
  cwrap(name: string, returnType: string | null, argTypes: string[]): (...args: unknown[]) => unknown;
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    unlink(path: string): void;
  };
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
}

type LocalVqeFactory = (options: {
  locateFile: (path: string, prefix: string) => string;
}) => Promise<LocalVqeModule>;

interface LocalVqeApi {
  optionsNew: () => number;
  optionsSetModel: (options: number, path: string) => number;
  optionsSetThreads: (options: number, threads: number) => number;
  newWithOptions: (options: number) => number;
  optionsFree: (options: number) => void;
  lastError: (context: number) => string | null;
  sampleRate: (context: number) => number;
  hopLength: (context: number) => number;
  fftSize: (context: number) => number;
  reset: (context: number) => void;
  processFrame: (
    context: number,
    mic: number,
    ref: number,
    hop: number,
    output: number
  ) => number;
  free: (context: number) => void;
}

const scope = self as unknown as WorkerScope;
const MODEL_URL = "/localvqe/localvqe-pi-aec-v1-49k-f32.gguf";
const MODEL_PATH = "/model.gguf";

let modulePromise: Promise<LocalVqeModule> | null = null;
let moduleInstance: LocalVqeModule | null = null;
let api: LocalVqeApi | null = null;
let context = 0;

const bind = <T extends (...args: never[]) => unknown>(
  module: LocalVqeModule,
  name: string,
  returnType: string | null,
  argTypes: string[]
): T => module.cwrap(name, returnType, argTypes) as unknown as T;

async function loadModule(): Promise<LocalVqeModule> {
  if (!modulePromise) {
    const pending = (async () => {
      const glueModule = (await import(/* @vite-ignore */ localVqeGlueUrl)) as {
        default?: LocalVqeFactory;
      };
      if (typeof glueModule.default !== "function") {
        throw new Error("LocalVQE ESM glue did not expose createLocalVQEModule");
      }
      const factory = glueModule.default;
      const module = await factory({
        locateFile: (path) => new URL(path, new URL("/localvqe/", scope.location.origin)).href,
      });
      moduleInstance = module;
      api = {
          optionsNew: bind(module, "localvqe_options_new", "number", []),
          optionsSetModel: bind(module, "localvqe_options_set_model_path", "number", ["number", "string"]),
          optionsSetThreads: bind(module, "localvqe_options_set_threads", "number", ["number", "number"]),
          newWithOptions: bind(module, "localvqe_new_with_options", "number", ["number"]),
          optionsFree: bind(module, "localvqe_options_free", null, ["number"]),
          lastError: bind(module, "localvqe_last_error", "string", ["number"]),
          sampleRate: bind(module, "localvqe_sample_rate", "number", ["number"]),
          hopLength: bind(module, "localvqe_hop_length", "number", ["number"]),
          fftSize: bind(module, "localvqe_fft_size", "number", ["number"]),
          reset: bind(module, "localvqe_reset", null, ["number"]),
          processFrame: bind(module, "localvqe_process_frame_f32", "number", [
            "number",
            "number",
            "number",
            "number",
            "number",
          ]),
          free: bind(module, "localvqe_free", null, ["number"]),
      };
      return module;
    })();
    modulePromise = pending;
    void pending.catch(() => {
      if (modulePromise === pending) modulePromise = null;
    });
  }
  return modulePromise;
}

async function loadModel(): Promise<void> {
  if (context) return;
  const module = await loadModule();
  const currentApi = api;
  if (!currentApi) throw new Error("LocalVQE API was not initialized");

  const response = await fetch(new URL(MODEL_URL, scope.location.origin));
  if (!response.ok) {
    throw new Error(`LocalVQE model request failed: ${response.status}`);
  }
  module.FS.writeFile(MODEL_PATH, new Uint8Array(await response.arrayBuffer()));

  const options = currentApi.optionsNew();
  if (!options) throw new Error("localvqe_options_new returned a null handle");
  try {
    const modelRc = currentApi.optionsSetModel(options, MODEL_PATH);
    if (modelRc !== 0) throw new Error(`localvqe_options_set_model_path failed: ${modelRc}`);
    const threadRc = currentApi.optionsSetThreads(options, 1);
    if (threadRc !== 0) throw new Error(`localvqe_options_set_threads failed: ${threadRc}`);
    context = currentApi.newWithOptions(options);
  } finally {
    currentApi.optionsFree(options);
  }
  if (!context) {
    throw new Error(
      `localvqe_new_with_options returned 0: ${currentApi.lastError(0) || "no error string"}`
    );
  }

  scope.postMessage({
    type: "ready",
    sampleRate: currentApi.sampleRate(context),
    hop: currentApi.hopLength(context),
    fft: currentApi.fftSize(context),
  });
}

function processFrame(id: number, mic: Float32Array, ref: Float32Array, gap: boolean): void {
  const module = moduleInstance;
  const currentApi = api;
  if (!module || !currentApi || !context) throw new Error("LocalVQE model is not loaded");
  const hop = currentApi.hopLength(context);
  if (mic.length !== hop || ref.length !== hop) {
    throw new Error(`Expected ${hop}-sample mic and reference frames`);
  }
  if (gap) currentApi.reset(context);

  const bytes = hop * Float32Array.BYTES_PER_ELEMENT;
  const pMic = module._malloc(bytes);
  const pRef = module._malloc(bytes);
  const pOut = module._malloc(bytes);
  if (!pMic || !pRef || !pOut) {
    if (pMic) module._free(pMic);
    if (pRef) module._free(pRef);
    if (pOut) module._free(pOut);
    throw new Error("LocalVQE could not allocate frame buffers");
  }

  try {
    module.HEAPF32.set(mic, pMic >> 2);
    module.HEAPF32.set(ref, pRef >> 2);
    const rc = currentApi.processFrame(context, pMic, pRef, hop, pOut);
    if (rc !== 0) {
      throw new Error(`localvqe_process_frame_f32 failed: ${currentApi.lastError(context) || rc}`);
    }
    const output = new Float32Array(hop);
    output.set(module.HEAPF32.subarray(pOut >> 2, (pOut >> 2) + hop));
    scope.postMessage({ type: "processed", id, samples: output.buffer, rc: 0 }, [output.buffer]);
  } finally {
    module._free(pMic);
    module._free(pRef);
    module._free(pOut);
  }
}

scope.onmessage = async (event) => {
  const requestId = event.data.id;
  try {
    const message = event.data;
    if (message.type === "load") {
      await loadModel();
    } else if (message.type === "process") {
      if (!message.mic || !message.ref) throw new Error("Mic and reference frames are required");
      if (!Number.isSafeInteger(message.id)) throw new Error("A mic frame id is required");
      processFrame(message.id!, message.mic, message.ref, Boolean(message.gap));
    } else if (message.type === "reset") {
      if (context && api) api.reset(context);
      scope.postMessage({ type: "reset" });
    } else if (message.type === "dispose") {
      if (context && api) api.free(context);
      context = 0;
      scope.postMessage({ type: "disposed" });
      scope.close();
    }
  } catch (error) {
    scope.postMessage({
      type: "error",
      ...(requestId === undefined ? {} : { id: requestId }),
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
