import type { LlmClient, LlmReply, LlmRequest } from "./types.js";

/**
 * A scripted model for tests: each call to `generate` returns the next
 * script entry (a reply, a function of the request, or an error to throw)
 * and records the request, so tests can assert what the model was shown.
 */
export type ScriptEntry = LlmReply | Error | ((req: LlmRequest) => LlmReply | Promise<LlmReply>);

export class FakeLlm implements LlmClient {
  readonly requests: LlmRequest[] = [];
  private i = 0;

  constructor(private readonly script: ScriptEntry[]) {}

  async generate(req: LlmRequest): Promise<LlmReply> {
    this.requests.push({ ...req, turns: structuredClone(req.turns) });
    const entry = this.script[this.i++];
    if (!entry) throw new Error("FakeLlm: script exhausted");
    if (entry instanceof Error) throw entry;
    return typeof entry === "function" ? entry(req) : entry;
  }
}

export const say = (text: string): LlmReply => ({ text, calls: [] });

export const callTools = (
  ...calls: { name: string; args?: Record<string, unknown>; id?: string }[]
): LlmReply => ({
  text: "",
  calls: calls.map((c, i) => ({ id: c.id ?? `call_${i + 1}`, name: c.name, args: c.args ?? {} })),
});
