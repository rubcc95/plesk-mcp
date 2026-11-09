import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli.js";
import { loadRegistry } from "./config/load.js";
import { createToolContext } from "./tools/context.js";
import { registerDepsTools } from "./tools/deps.js";
import { registerFileTools } from "./tools/files.js";
import { registerLogTools } from "./tools/logs.js";
import { registerNodeTools } from "./tools/node.js";
import { createToolRegistrar, resolveAccessMode } from "./tools/policy.js";
import { registerConfigErrorTools, registerProjectTools } from "./tools/project.js";
import { registerSqlTools } from "./sql/tools.js";
import { asAppError } from "./util/errors.js";

const VERSION = __PKG_VERSION__;

const CLI_COMMANDS = new Set(["init", "doctor", "servers", "project-info"]);
const CLI_FLAGS = new Set(["--help", "-h", "--version", "-V"]);

function isCliInvocation(argv: string[]): boolean {
  return argv.some((arg) => CLI_COMMANDS.has(arg) || CLI_FLAGS.has(arg));
}

async function main(): Promise<void> {
  if (isCliInvocation(process.argv.slice(2))) {
    await runCli(process.argv);
    return;
  }

  const server = new McpServer({ name: "plesk-mcp", version: VERSION });
  const accessMode = resolveAccessMode();
  const registrar = createToolRegistrar(server, accessMode);
  console.error(`[plesk-mcp] access=${accessMode}`);

  try {
    const loaded = await loadRegistry();
    const ctx = createToolContext(loaded, accessMode);
    registerProjectTools(registrar, ctx);
    registerFileTools(registrar, ctx);
    registerNodeTools(registrar, ctx);
    registerDepsTools(registrar, ctx);
    registerLogTools(registrar, ctx);
    registerSqlTools(registrar, ctx);
  } catch (error) {
    const appError = asAppError(error);
    console.error(`[plesk-mcp] ${appError.code}: ${appError.message}`);
    registerConfigErrorTools(registrar, appError);
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  const appError = asAppError(error);
  console.error(`[plesk-mcp] ${appError.code}: ${appError.message}`);
  process.exit(1);
});
