# GitHub Copilot — project instructions

**Read `AGENTS.md` in the repo root for full project context** (architecture, Xero API facts,
conventions, status). It is the single source of truth for how this project works.

Critical rules:
- Project time entries use the **Xero Projects REST API** (no MCP covers Projects).
  `POST /Projects/{id}/Time` needs `userId`, `taskId`, `dateUtc`, `duration` (**minutes**).
- One org Xero connection + a `Teams user → { xeroUserId, allowedProjectIds }` map; no per-user OAuth.
- Grounding must **validate** LLM output against the person's allowed projects/tasks — never invent a
  project/task or guess a missing duration; flag it instead.
- Secrets only in `.env` (git-ignored). Never write real values into `.env.example`.
