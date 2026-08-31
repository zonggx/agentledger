import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "./types.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {}

  workspacePath(agentId: string): string {
    return path.join(this.root, agentId);
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await mkdir(path.join(this.root, ".deleted"), { recursive: true });
  }

  async create(agent: Agent): Promise<void> {
    await mkdir(agent.workspacePath, { recursive: false });
    await this.writeInstructions(agent);
    await this.writeTransactionalTools(agent);
    await writeFile(
      path.join(agent.workspacePath, ".gitignore"),
      [".codex/", "node_modules/", "dist/", ".env", "*.log", ""].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(agent.workspacePath, "README.md"),
      [
        "# " + agent.name + " workspace",
        "",
        "Files created or edited by the Agent live here.",
        "The platform-generated AGENTS.md contains the current Agent instructions.",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  async writeInstructions(agent: Agent): Promise<void> {
    const content = [
      "# Platform-managed Agent instructions",
      "",
      "You are the coding Agent named " + agent.name + ".",
      agent.description ? "Purpose: " + agent.description : "",
      "",
      "## Instructions",
      "",
      agent.instructions ||
        "Help the user complete coding tasks in this workspace. Explain material results concisely.",
      "",
      "## Workspace rules",
      "",
      "- Work only inside this workspace unless the user explicitly requests otherwise.",
      "- Preserve existing user files and avoid destructive operations.",
      "- Build and test changes when practical.",
      "- Never print environment variables or credentials.",
      "",
      "## Transactional booking tool",
      "",
      "For a side-effecting demo booking, run:",
      "",
      "`node .launchpad/tools/create-booking.mjs --operation <stable-id> --traveler <alias> --route <AAA-BBB> --date <YYYY-MM-DD>`",
      "",
      "Reuse exactly the same operation ID after an error. Never invent a new ID for a retry.",
      "The tool may be retried safely because the control plane owns its idempotency key.",
      "",
      "This file is regenerated when the Agent configuration is updated.",
      "",
    ]
      .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
      .join("\n");
    await writeFile(path.join(agent.workspacePath, "AGENTS.md"), content, "utf8");
  }

  private async writeTransactionalTools(agent: Agent): Promise<void> {
    const toolDirectory = path.join(agent.workspacePath, ".launchpad", "tools");
    await mkdir(toolDirectory, { recursive: true });
    const script = `const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    console.error("Usage: create-booking --operation ID --traveler ALIAS --route AAA-BBB --date YYYY-MM-DD");
    process.exit(2);
  }
  values.set(key.slice(2), value);
}
const required = ["operation", "traveler", "route", "date"];
if (required.some((key) => !values.get(key))) {
  console.error("Missing required booking argument");
  process.exit(2);
}
const baseUrl = process.env.LAUNCHPAD_ACTION_URL;
const token = process.env.LAUNCHPAD_ACTION_TOKEN;
if (!baseUrl || !token) {
  console.error("Transactional booking capability is unavailable outside an active Agent Run");
  process.exit(3);
}
const response = await fetch(baseUrl + "/internal/tool-actions/booking", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-action-capability": token,
  },
  body: JSON.stringify({
    operationId: values.get("operation"),
    travelerAlias: values.get("traveler"),
    route: values.get("route"),
    date: values.get("date"),
  }),
});
const body = await response.json().catch(() => ({ error: "Invalid gateway response" }));
if (!response.ok) {
  console.error(JSON.stringify({ status: response.status, error: body.error, code: body.code }));
  process.exit(4);
}
console.log(JSON.stringify(body, null, 2));
`;
    await writeFile(path.join(toolDirectory, "create-booking.mjs"), script, "utf8");
  }

  async archive(agent: Agent): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const destination = path.join(
      this.root,
      ".deleted",
      agent.id + "-" + timestamp,
    );
    await rename(agent.workspacePath, destination);
    return destination;
  }
}
