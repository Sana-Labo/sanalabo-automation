import type { GwsCommandResult, ToolExecutor } from "../../types.js";

async function runGws(args: string[]): Promise<GwsCommandResult> {
  const proc = Bun.spawn(["gws", ...args, "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeoutId = setTimeout(() => proc.kill(), 30_000);

  try {
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;

    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      return {
        success: false,
        data: null,
        error: stderr || `gws exited with code ${exitCode}`,
      };
    }

    try {
      return { success: true, data: JSON.parse(stdout) };
    } catch {
      return { success: true, data: stdout.trim() };
    }
  } catch (e) {
    clearTimeout(timeoutId);
    return {
      success: false,
      data: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function gwsExecutor(buildArgs: (input: Record<string, unknown>) => string[]): ToolExecutor {
  return async (input) => {
    const result = await runGws(buildArgs(input));
    if (!result.success) {
      return `Error: ${result.error}`;
    }
    return typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data, null, 2);
  };
}

export function createGwsExecutors(): Map<string, ToolExecutor> {
  const executors = new Map<string, ToolExecutor>();

  executors.set(
    "gmail_list",
    gwsExecutor((input) => {
      const args = ["gmail", "messages", "list"];
      if (input["query"]) args.push("--query", String(input["query"]));
      if (input["maxResults"]) args.push("--max-results", String(input["maxResults"]));
      return args;
    }),
  );

  executors.set(
    "gmail_search",
    gwsExecutor((input) => ["gmail", "messages", "list", "--query", String(input["query"])]),
  );

  executors.set(
    "gmail_get",
    gwsExecutor((input) => ["gmail", "messages", "get", String(input["messageId"])]),
  );

  executors.set(
    "gmail_create_draft",
    gwsExecutor((input) => [
      "gmail",
      "drafts",
      "create",
      "--to",
      String(input["to"]),
      "--subject",
      String(input["subject"]),
      "--body",
      String(input["body"]),
    ]),
  );

  executors.set(
    "calendar_list",
    gwsExecutor((input) => {
      const args = ["calendar", "events", "list"];
      if (input["timeMin"]) args.push("--time-min", String(input["timeMin"]));
      if (input["timeMax"]) args.push("--time-max", String(input["timeMax"]));
      return args;
    }),
  );

  executors.set(
    "calendar_create",
    gwsExecutor((input) => {
      const args = [
        "calendar",
        "events",
        "create",
        "--summary",
        String(input["summary"]),
        "--start",
        String(input["start"]),
        "--end",
        String(input["end"]),
      ];
      if (input["description"]) args.push("--description", String(input["description"]));
      return args;
    }),
  );

  executors.set(
    "drive_search",
    gwsExecutor((input) => ["drive", "files", "list", "--query", String(input["query"])]),
  );

  return executors;
}
