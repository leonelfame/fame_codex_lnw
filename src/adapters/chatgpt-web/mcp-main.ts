import { join, resolve } from "node:path";
import { expandUserPath, getConfigDir } from "../../config";
import { runChatGptMcpServer } from "./mcp-server";

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1]?.trim();
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

export async function runChatGptMcpMain(args: string[]): Promise<void> {
  const brokerSocketPath = resolve(expandUserPath(option(
    args,
    "--broker-socket",
    join(getConfigDir(), "runtime", "turn-broker.sock"),
  )));
  await runChatGptMcpServer({ brokerSocketPath });
}
