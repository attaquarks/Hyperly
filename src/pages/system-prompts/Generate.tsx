import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
  Textarea,
} from "@/components";
import { useApp } from "@/contexts";
import { fetchAIResponse } from "@/lib";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";

interface GenerateSystemPromptProps {
  onGenerate: (prompt: string, promptName: string) => void;
}

interface SystemPromptResponse {
  prompt_name: string;
  system_prompt: string;
}

const GENERATE_META_PROMPT = `You generate system prompts for an AI assistant. The user describes the behavior they want. Reply with ONLY a raw JSON object (no markdown, no code fences, no commentary) in exactly this shape:
{"prompt_name": "short 2-4 word title", "system_prompt": "the full system prompt text"}`;

export const GenerateSystemPrompt = ({
  onGenerate,
}: GenerateSystemPromptProps) => {
  const { allAiProviders, selectedAIProvider } = useApp();
  const [userPrompt, setUserPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleGenerate = async () => {
    if (!userPrompt.trim()) {
      setError("Please describe what you want");
      return;
    }

    const provider = allAiProviders.find(
      (p) => p.id === selectedAIProvider.provider
    );
    if (!provider) {
      setError("No AI provider configured. Set one up in Dev space first.");
      return;
    }

    try {
      setIsGenerating(true);
      setError(null);

      let raw = "";
      for await (const chunk of fetchAIResponse({
        provider,
        selectedProvider: selectedAIProvider,
        systemPrompt: GENERATE_META_PROMPT,
        userMessage: userPrompt.trim(),
      })) {
        raw += chunk;
      }

      // Tolerate models that wrap the JSON in code fences
      const cleaned = raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
      const response: SystemPromptResponse = JSON.parse(cleaned);

      if (response.system_prompt && response.prompt_name) {
        onGenerate(response.system_prompt, response.prompt_name);
        setIsOpen(false);
        setUserPrompt("");
      } else {
        setError("The AI response was missing fields. Please try again.");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to generate prompt";
      setError(errorMessage);
      console.error("Error generating system prompt:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label="Generate with AI"
          size="sm"
          variant="outline"
          className="w-fit"
        >
          <SparklesIcon className="h-4 w-4" /> Generate with AI
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        className="w-96 p-4 border shadow-lg"
      >
        <div className="space-y-3">
          <div>
            <p className="text-sm font-medium mb-1">Generate a system prompt</p>
            <p className="text-xs text-muted-foreground">
              Describe the AI behavior you want, and we'll generate a prompt for
              you.
            </p>
          </div>

          <Textarea
            placeholder="e.g., I want an AI that helps me with code reviews and focuses on best practices..."
            className="min-h-[100px] resize-none border-1 border-input/50 focus:border-primary/50 transition-colors"
            value={userPrompt}
            onChange={(e) => {
              setUserPrompt(e.target.value);
              setError(null);
            }}
            disabled={isGenerating}
          />

          {error && <p className="text-xs text-destructive">{error}</p>}

          <Button
            className="w-full"
            onClick={handleGenerate}
            disabled={!userPrompt.trim() || isGenerating}
          >
            {isGenerating ? (
              <>
                <SparklesIcon className="h-4 w-4 animate-pulse" />
                Generating...
              </>
            ) : (
              <>
                <SparklesIcon className="h-4 w-4" />
                Generate
              </>
            )}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
};
