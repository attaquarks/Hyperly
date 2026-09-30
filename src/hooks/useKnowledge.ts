import { useCallback, useState } from "react";
import { KnowledgeFile } from "@/types/system-audio";

// The Library button's real job: the user points Hyperly at a folder, picks
// one file from it inside the overlay, and that file's text rides along as
// knowledge on the next AI prompt. Files live in memory only — a picked
// folder can't be re-opened across restarts without picking it again.

// Cap on injected knowledge so a large document can't blow up the prompt.
const MAX_KNOWLEDGE_CHARS = 12000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "csv", "log",
  "js", "jsx", "ts", "tsx", "py", "rs", "java", "c", "cpp", "h",
  "html", "css", "xml", "yaml", "yml", "toml", "ini", "sql", "sh",
]);

export type LibraryEntry = {
  name: string;
  file: File;
};

const extractText = async (file: File): Promise<string> => {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

  if (ext === "pdf") {
    // Lazy-loaded so the parser only ships when a PDF is actually picked.
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url
    ).toString();
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() })
      .promise;
    let text = "";
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent();
      text +=
        content.items
          .map((item: any) => ("str" in item ? item.str : ""))
          .join(" ") + "\n";
    }
    return text.trim();
  }

  if (TEXT_EXTENSIONS.has(ext) || file.type.startsWith("text/")) {
    return (await file.text()).trim();
  }

  throw new Error(`Can't read "${file.name}" — pick a text file or a PDF.`);
};

export const useKnowledge = () => {
  const [folderName, setFolderName] = useState("");
  const [folderFiles, setFolderFiles] = useState<LibraryEntry[]>([]);
  const [knowledgeFile, setKnowledgeFile] = useState<KnowledgeFile | null>(
    null
  );
  const [isReading, setIsReading] = useState(false);
  const [readError, setReadError] = useState("");

  // Bound to the hidden folder input's onChange.
  const pickFolder = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    const first = files[0] as File & { webkitRelativePath?: string };
    const folder = first.webkitRelativePath?.split("/")[0] ?? "Folder";
    setFolderName(folder);
    setFolderFiles(files.map((file) => ({ name: file.name, file })));
    setKnowledgeFile(null);
    setReadError("");
  }, []);

  const selectFile = useCallback(
    async (name: string) => {
      const entry = folderFiles.find((e) => e.name === name);
      if (!entry) return;
      setIsReading(true);
      setReadError("");
      try {
        const text = await extractText(entry.file);
        const truncated = text.length > MAX_KNOWLEDGE_CHARS;
        setKnowledgeFile({
          name: entry.name,
          folderName,
          text: truncated ? text.slice(0, MAX_KNOWLEDGE_CHARS) : text,
          truncated,
        });
      } catch (err) {
        console.error("Failed to read knowledge file:", err);
        setKnowledgeFile(null);
        setReadError(
          err instanceof Error ? err.message : "Failed to read file"
        );
      } finally {
        setIsReading(false);
      }
    },
    [folderFiles, folderName]
  );

  const clearKnowledge = useCallback(() => {
    setKnowledgeFile(null);
    setReadError("");
  }, []);

  return {
    folderName,
    folderFiles,
    knowledgeFile,
    isReading,
    readError,
    pickFolder,
    selectFile,
    clearKnowledge,
  };
};
