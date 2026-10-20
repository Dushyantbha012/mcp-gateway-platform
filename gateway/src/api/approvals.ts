import express from "express";
import { z } from "zod";
import { principalOf, requireSession } from "../auth/middleware.js";
import { decide, listPending } from "../db/approvals.js";
import type { Db } from "../db/db.js";
import type { ToolSurface } from "../search/surface.js";
import { notFound, parse } from "./errors.js";

const idSchema = z.object({ id: z.uuid() });

/**
 * The user's own pending write requests from MCP clients. Deciding needs a
 * dashboard session (cookie + Origin check), never an API key: the client that
 * asked can't approve for itself, and neither can a leaked key.
 */
export function approvalsApi(db: Db, tools: ToolSurface) {
  const api = express.Router();
  api.use(requireSession);

  api.get("/", async (_req, res) => {
    const rows = await listPending(db, principalOf(res).userId);
    res.json(
      await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          name: r.tool_name,
          args: r.args,
          tool: (await tools.describeTool(r.tool_name)) ?? null,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        })),
      ),
    );
  });

  for (const [verb, decision] of [
    ["approve", "approved"],
    ["deny", "denied"],
  ] as const) {
    api.post(`/:id/${verb}`, async (req, res) => {
      const { id } = parse(idSchema, req.params);
      if (!(await decide(db, principalOf(res).userId, id, decision))) {
        throw notFound("approval request");
      }
      res.status(204).end();
    });
  }
  return api;
}
