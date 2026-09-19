import { useCompletion } from "@/hooks";
import { Screenshot } from "./Screenshot";
import { Files } from "./Files";
import { Audio } from "./Audio";
import { Input } from "./Input";

export const Completion = ({
  isHidden,
  capturing = false,
}: {
  isHidden: boolean;
  capturing?: boolean;
}) => {
  const completion = useCompletion(capturing);

  return (
    <>
      <Audio {...completion} />
      <Input {...completion} isHidden={isHidden} />
      <Screenshot {...completion} />
      <Files {...completion} />
    </>
  );
};
