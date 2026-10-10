import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

/** A read-only value with a copy button: API keys, invite links, commands. */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard needs a secure context (https or localhost); the value is
      // still selectable by hand.
    }
  };
  return (
    <div className="flex items-start gap-2">
      <code
        aria-label={label}
        className="min-w-0 flex-1 rounded-md border bg-muted px-3 py-2 font-mono text-xs break-all select-all"
      >
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={copy}
        aria-label={`Copy ${label}`}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}
