/**
 * Incremental parser for a Server-Sent Events stream. Chunks from `fetch`
 * can end anywhere - mid-line, mid-character, between "\r" and "\n" - so
 * bytes are decoded as a stream and a message is only emitted once its
 * blank line has arrived. Comment lines (": ping") are ignored.
 */
export interface SseMessage {
  event: string;
  data: string;
}

export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";

  /** Feed raw bytes (or already-decoded text); returns the messages completed by this chunk. */
  push(chunk: Uint8Array | string): SseMessage[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.decode(chunk, { stream: true });
    // Normalise line endings; a lone "\r" at the very end may be half of "\r\n".
    this.buffer = this.buffer.replace(/\r\n/g, "\n");
    const messages: SseMessage[] = [];
    let end: number;
    while ((end = this.buffer.indexOf("\n\n")) !== -1) {
      const message = parseBlock(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end + 2);
      if (message) messages.push(message);
    }
    return messages;
  }
}

function parseBlock(block: string): SseMessage | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { event, data: data.join("\n") } : undefined;
}
