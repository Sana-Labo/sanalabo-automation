import type { GwsCommandResult, ToolExecutor } from "../../types.js";
import { toErrorMessage } from "../../utils/error.js";

export interface GwsExecOptions {
  configDir: string;
}

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

async function runGws(args: string[], options: GwsExecOptions): Promise<GwsCommandResult> {
  const proc = Bun.spawn(["gws", ...args, "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GWS_CONFIG_DIR: options.configDir,
    },
  });

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      proc.kill();
      reject(new Error("gws command timed out after 30s"));
    }, 30_000);
  });

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
      error: toErrorMessage(e),
    };
  } finally {
    clearTimeout(timer!);
  }
}

function gwsExecutor(
  buildArgs: (input: Record<string, unknown>) => string[],
  options: GwsExecOptions,
): ToolExecutor {
  return async (input) => {
    const result = await runGws(buildArgs(input), options);
    if (!result.success) {
      return `Error: ${result.error}`;
    }
    return typeof result.data === "string"
      ? result.data
      : JSON.stringify(result.data, null, 2);
  };
}

const executorCache = new Map<string, Map<string, ToolExecutor>>();

export function getGwsExecutors(workspaceId: string, configDir: string): Map<string, ToolExecutor> {
  let cached = executorCache.get(workspaceId);
  if (!cached) {
    cached = createGwsExecutors({ configDir });
    executorCache.set(workspaceId, cached);
  }
  return cached;
}

export function invalidateGwsExecutors(workspaceId: string): void {
  executorCache.delete(workspaceId);
}

export function createGwsExecutors(options: GwsExecOptions): Map<string, ToolExecutor> {
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
    }, options),
  );

  executors.set(
    "gmail_get",
    gwsExecutor((input) => ["gmail", "messages", "get", getString(input, "messageId")], options),
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
    ], options),
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
    }, options),
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
    }, options),
  );

  executors.set(
    "drive_search",
    gwsExecutor((input) => ["drive", "files", "list", "--query", getString(input, "query")], options),
  );

  return executors;
}
