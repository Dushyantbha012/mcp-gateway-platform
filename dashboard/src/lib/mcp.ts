/** The server slug of an aggregated tool name (`<slug>__<tool>`); the slug never contains "_". */
export function slugOfTool(name: string): string {
  const i = name.indexOf("__");
  return i > 0 ? name.slice(0, i) : "";
}

export const KEY_PLACEHOLDER = "<your API key>";

export function claudeCodeCommand(mcpUrl: string, key = KEY_PLACEHOLDER): string {
  return `claude mcp add --transport http gateway ${mcpUrl} --header "Authorization: Bearer ${key}"`;
}
