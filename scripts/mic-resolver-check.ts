// Focused check for the native-id -> WebView-id resolver in src/lib/microphone.ts.
// The module is pure browser API, so it can be exercised directly with a mocked
// navigator.mediaDevices. Run: node --experimental-strip-types scripts/mic-resolver-check.ts

import {
  getMicrophoneStream,
  enumerateMicrophoneInputs,
  primeMicrophoneLabels,
} from "../src/lib/microphone.ts";
import { answerMicConsent } from "../src/lib/mic-consent.ts";

// Phase 4 R7: microphone access sits behind the in-app consent gate, so this
// check stands in for the webview's localStorage and drives the gate the way
// the UI does. The declined-consent path is asserted below; everything else
// runs with consent granted, matching a returning user.
const consentStorage = new Map<string, string>();
const consentStorageApi = {
  getItem: (key: string) => consentStorage.get(key) ?? null,
  setItem: (key: string, value: string) => void consentStorage.set(key, value),
  removeItem: (key: string) => void consentStorage.delete(key),
};
// `safeLocalStorage` checks `window` but reads the bare `localStorage` global,
// exactly as a browser exposes it — so the stub must provide both.
Object.defineProperty(globalThis, "window", {
  value: { localStorage: consentStorageApi },
  configurable: true,
  writable: true,
});
Object.defineProperty(globalThis, "localStorage", {
  value: consentStorageApi,
  configurable: true,
  writable: true,
});

type Call = { exact?: string };

const scenarios: {
  name: string;
  // ids the WebView actually knows
  webIds: { id: string; label: string }[];
  storedId?: string;
  storedName?: string;
  expect: { kind: "exact" | "default" | "throw"; deviceId?: string; error?: string };
  failExactIds?: string[];
}[] = [
  {
    name: "stored id is a WebView id (settings re-picked the mic)",
    webIds: [
      { id: "web-mic-1", label: "Headset Microphone" },
      { id: "default", label: "Default - Microphone Array" },
    ],
    storedId: "web-mic-1",
    storedName: "Headset Microphone",
    expect: { kind: "exact", deviceId: "web-mic-1" },
  },
  {
    name: "stored id is a native WASAPI id, resolved by name",
    webIds: [
      { id: "web-mic-1", label: "Headset Microphone" },
      { id: "default", label: "Default - Microphone Array" },
    ],
    storedId: "{0.0.0.00000000}.{2b1f9c4e-0a1d-4c8e-9f77-1a2b3c4d5e6f}",
    storedName: "Headset Microphone",
    expect: { kind: "exact", deviceId: "web-mic-1" },
  },
  {
    name: "native id and a name the WebView reports with a suffix",
    webIds: [{ id: "web-mic-2", label: "Headset Microphone (2)" }],
    storedId: "{0.0.0.00000000}.{dead}",
    storedName: "headset microphone",
    expect: { kind: "exact", deviceId: "web-mic-2" },
  },
  {
    name: "id unknown and no usable name -> system default, not a crash",
    webIds: [{ id: "default", label: "Default - Microphone Array" }],
    storedId: "{0.0.0.00000000}.{dead}",
    storedName: "Some Device That Was Unplugged",
    expect: { kind: "default" },
  },
  {
    name: "no stored selection at all -> system default",
    webIds: [{ id: "default", label: "Default - Microphone Array" }],
    expect: { kind: "default" },
  },
  {
    name: "real permission denial is rethrown, never silently switched",
    webIds: [{ id: "web-mic-1", label: "Headset Microphone" }],
    storedId: "{0.0.0.00000000}.{dead}",
    storedName: "Headset Microphone",
    failExactIds: ["*"],
    expect: { kind: "throw", error: "NotAllowedError" },
  },
];

let failures = 0;

// Consent gate, declined first: the request must resolve as a refusal with no
// device interaction at all.
{
  const opened: number[] = [];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          opened.push(1);
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    },
    configurable: true,
    writable: true,
  });

  let outcome = "";
  let ok = false;
  const pending = getMicrophoneStream("web-mic-1", "Headset Microphone");
  await answerMicConsent(false);
  try {
    await pending;
    outcome = "FAIL — resolved despite a declined consent";
  } catch (error) {
    ok = (error as Error).name === "NotAllowedError" && opened.length === 0;
    outcome = ok
      ? "ok    consent declined -> NotAllowedError, no device opened"
      : `FAIL — threw ${(error as Error).name}, device calls ${opened.length}`;
  }
  if (!ok) failures += 1;
  console.log(`  ${outcome}  <- consent gate: declined`);
}

// Grant consent the way the dialog does; the device scenarios below need it.
await answerMicConsent(true);

for (const s of scenarios) {
  const seen: Call[] = [];
  const domException = (name: string) => {
    const e = new Error(name);
    e.name = name;
    return e;
  };

  // Node 21+ ships a read-only global `navigator`, so it has to be redefined
  // rather than assigned (ESM is strict mode and would throw).
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: async () =>
          s.webIds.map((d) => ({
            kind: "audioinput",
            deviceId: d.id,
            label: d.label,
            groupId: "g",
          })),
        getUserMedia: async (constraints: any) => {
          const exact = constraints?.audio?.deviceId?.exact as string | undefined;
          seen.push({ exact });
          if (
            s.failExactIds?.includes("*") ||
            (exact && s.failExactIds?.includes(exact))
          ) {
            throw domException("NotAllowedError");
          }
          if (exact && !s.webIds.some((d) => d.id === exact)) {
            // Mirrors a real WebView: an id it does not know is over-constrained.
            throw domException("OverconstrainedError");
          }
          return { getTracks: () => [{ stop() {} }] };
        },
      },
    },
    configurable: true,
    writable: true,
  });

  let outcome: string;
  let ok = false;
  try {
    const stream = await getMicrophoneStream(s.storedId, s.storedName);
    const used = seen[seen.length - 1]?.exact;
    void stream;
    if (s.expect.kind === "throw") {
      outcome = `FAIL — expected a throw, resolved with ${used ?? "default"}`;
    } else if (s.expect.kind === "default") {
      ok = used === undefined;
      outcome = ok
        ? "ok    fell back to the system default"
        : `FAIL — expected the default, used ${used}`;
    } else {
      ok = used === s.expect.deviceId;
      outcome = ok
        ? `ok    used ${used}`
        : `FAIL — expected ${s.expect.deviceId}, used ${used}`;
    }
  } catch (error) {
    if (s.expect.kind === "throw" && (error as Error).name === s.expect.error) {
      ok = true;
      outcome = "ok    rethrew NotAllowedError";
    } else {
      outcome = `FAIL — threw ${(error as Error).name ?? error}`;
    }
  }

  if (!ok) failures += 1;
  console.log(`  ${outcome}  <- ${s.name}`);
}

// The settings list must return WebView ids, and priming must release its stream.
{
  const stopped: number[] = [];
  const webIds = [
    { id: "web-mic-1", label: "Headset Microphone" },
    { id: "default", label: "Default - Microphone Array" },
  ];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      mediaDevices: {
        enumerateDevices: async () =>
          webIds.map((d) => ({
            kind: "audioinput",
            deviceId: d.id,
            label: d.label,
            groupId: "g",
          })),
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => stopped.push(1) }],
        }),
      },
    },
    configurable: true,
    writable: true,
  });
  const inputs = await enumerateMicrophoneInputs();
  await primeMicrophoneLabels();
  const allWeb = inputs.every((i) => !i.id.startsWith("{0.0.0."));
  if (allWeb && inputs.length === 2 && stopped.length === 1) {
    console.log("  ok    settings list is WebView ids, priming released its stream");
  } else {
    failures += 1;
    console.log(
      `  FAIL — settings list ids=${inputs.map((i) => i.id).join(",")} stopped=${stopped.length}`
    );
  }
}

console.log("");
console.log(failures === 0 ? "PASS" : `FAIL — ${failures} scenario(s) failed`);
process.exit(failures === 0 ? 0 : 1);
