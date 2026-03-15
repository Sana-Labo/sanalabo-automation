import type { GwsCommandResult, ToolExecutor } from "../../types.js";

function getString(input: Record<string, unknown>, key: string): string {
  const val = input[key];
  if (typeof val !== "string" || val === "") {
    throw new Error(`Missing or invalid parameter: ${key}`);
  }
  return val;
}

function optString(input: Record<string, unknown>, key: string): string | undefined {
  const val = input[key];
  if (val == null) return undefined;
  return String(val);
}

async function runGws(args: string[]): Promise<GwsCommandResult> {
  const proc = Bun.spawn(["gws", ...args, "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill();
      reject(new Error("gws command timed out after 30s"));
    }, 30_000),
  );

  try {
    const { stdout, stderr, exitCode } = await Promise.race([
      Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]).then(async ([stdout, stderr]) => ({
        stdout,
        stderr,
        exitCode: await proc.exited,
      })),
      timeout,
    ]);

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
      const query = optString(input, "query");
      if (query) args.push("--query", query);
      const maxResults = optString(input, "maxResults");
      if (maxResults) args.push("--max-results", maxResults);
      return args;
    }),
  );

  executors.set(
    "gmail_get",
    gwsExecutor((input) => ["gmail", "messages", "get", getString(input, "messageId")]),
  );

  executors.set(
    "gmail_create_draft",
    gwsExecutor((input) => [
      "gmail",
      "drafts",
      "create",
      "--to",
      getString(input, "to"),
      "--subject",
      getString(input, "subject"),
      "--body",
      getString(input, "body"),
    ]),
  );

  executors.set(
    "calendar_list",
    gwsExecutor((input) => {
      const args = ["calendar", "events", "list"];
      const timeMin = optString(input, "timeMin");
      if (timeMin) args.push("--time-min", timeMin);
      const timeMax = optString(input, "timeMax");
      if (timeMax) args.push("--time-max", timeMax);
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
        getString(input, "summary"),
        "--start",
        getString(input, "start"),
        "--end",
        getString(input, "end"),
      ];
      const description = optString(input, "description");
      if (description) args.push("--description", description);
      return args;
    }),
  );

  executors.set(
    "drive_search",
    gwsExecutor((input) => ["drive", "files", "list", "--query", getString(input, "query")]),
  );

  return executors;
}
