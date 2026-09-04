import { GripVerticalIcon } from "lucide-react";
import { Button } from "@/components";

export const DragButton = () => {
  return (
    <Button
      variant="ghost"
      size="icon"
      className={`-ml-[2px] w-fit cursor-grab active:cursor-grabbing`}
      data-tauri-drag-region={true}
      title="Drag to move"
    >
      <GripVerticalIcon className="h-4 w-4" />
    </Button>
  );
};
