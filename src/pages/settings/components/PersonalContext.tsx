import { useEffect, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Header,
  Label,
  Switch,
  Textarea,
} from "@/components";
import {
  composeSystemPromptWithContext,
  getPersonalContext,
  isInterviewContextEnabled,
  setInterviewContextEnabled,
  setPersonalContext,
} from "@/lib";
import { DEFAULT_PERSONAL_CONTEXT } from "@/config/constants";
import { RotateCcw, Save, UserCircle2 } from "lucide-react";

/**
 * PersonalContext
 * Lets the user write down their background (skills, target role, etc.)
 * which the assistant will use to answer interview / meeting questions.
 *
 * The text is stored in localStorage and is automatically prepended to
 * the system prompt of every AI request when the toggle is on.
 */
export const PersonalContext = () => {
  const [enabled, setEnabled] = useState<boolean>(isInterviewContextEnabled());
  const [text, setText] = useState<string>("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [preview, setPreview] = useState<string>("");

  // Load on mount
  useEffect(() => {
    setText(getPersonalContext());
  }, []);

  // Keep the preview in sync so the user can see what the AI actually
  // receives.
  useEffect(() => {
    setPreview(
      composeSystemPromptWithContext(
        "You are a helpful AI assistant. Be concise, accurate, and friendly in your responses"
      ) ?? ""
    );
  }, [text, enabled]);

  const handleSave = async () => {
    setPersonalContext(text);
    setInterviewContextEnabled(enabled);
    setSavedAt(Date.now());
    // Trigger a custom event so other windows pick up the change
    // immediately without a full reload.
    window.dispatchEvent(
      new CustomEvent("personal-context-updated", { detail: { text, enabled } })
    );
  };

  const handleReset = () => {
    setText(DEFAULT_PERSONAL_CONTEXT);
    setPersonalContext(DEFAULT_PERSONAL_CONTEXT);
    setSavedAt(Date.now());
  };

  const handleClear = () => {
    setText("");
    setPersonalContext("");
    setSavedAt(Date.now());
  };

  return (
    <div id="personal-context" className="space-y-3">
      <Header
        title="Personal Context"
        description="The assistant uses this on every answer so it knows who you are, what you do, and what role you are interviewing for."
        isMainTitle
      />

      <Card className="border border-input/50">
        <CardHeader className="p-4 pb-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <UserCircle2 className="size-4 text-muted-foreground" />
              <CardTitle className="text-sm">Inject on every AI request</CardTitle>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={(v) => {
                setEnabled(v);
                setInterviewContextEnabled(v);
              }}
            />
          </div>
          <CardDescription className="text-xs">
            When on, this text is prepended to the system prompt of every
            chat and live-listening request. You can disable it temporarily
            for a one-off conversation without deleting the text.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-2 space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Context</Label>
            <Textarea
              className="min-h-[280px] font-mono text-xs leading-relaxed"
              value={text}
              onChange={(e) =>
                setText(typeof e === "string" ? e : (e.target as HTMLTextAreaElement).value)
              }
              placeholder="Paste or write your background, skills, target role, and any guidance for the assistant here."
            />
            <p className="text-[10px] text-muted-foreground leading-relaxed">
              Tip: include the role you are interviewing for, your top 3-5
              skills with proof points, 1-2 flagship projects, and any
              behavioural anchors (strengths, growth areas, working style).
              The more concrete, the better the answers.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleSave} size="sm">
              <Save className="size-3.5" />
              Save
            </Button>
            <Button onClick={handleReset} variant="outline" size="sm">
              <RotateCcw className="size-3.5" />
              Reset to template
            </Button>
            <Button onClick={handleClear} variant="ghost" size="sm">
              Clear
            </Button>
            {savedAt && (
              <span className="text-[10px] text-muted-foreground">
                Saved {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="border border-input/50">
        <CardHeader className="p-4 pb-2">
          <CardTitle className="text-sm">Live preview</CardTitle>
          <CardDescription className="text-xs">
            Exactly what the AI sees as the system prompt, given your
            current context and a default base prompt. The assistant will
            obey instructions in this combined text over everything else
            in the conversation.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-4 pt-2">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-input/50 bg-muted/40 p-3 text-[10px] leading-relaxed">
            {preview || "(Empty)"}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
};
