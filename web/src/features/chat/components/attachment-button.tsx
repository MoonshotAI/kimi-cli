import { PromptInputButton, usePromptInputAttachments } from "@ai-elements";
import { PaperclipIcon } from "lucide-react";

export function AttachmentButton() {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton onClick={() => attachments.openFileDialog()}>
      <PaperclipIcon className="size-4" />
    </PromptInputButton>
  );
}
