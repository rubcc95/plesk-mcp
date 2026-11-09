import type { PleskClient, PleskCliResult } from "./client.js";

export interface NodeUpdateOptions {
  appRoot?: string;
  startupFile?: string;
  nodeVersion?: string;
  appMode?: "production" | "development";
  packageManager?: "npm" | "pnpm" | "yarn";
  documentRoot?: string;
}

/**
 * Adaptador de `plesk ext nodejs`.
 *
 * Los nombres exactos de los flags se validan en la fase 0 contra
 * `plesk ext nodejs --help` y `GET /cli/extension/ref`.
 */
export class NodeAdapter {
  constructor(private readonly client: PleskClient) {}

  list(): Promise<PleskCliResult> {
    return this.call("--list");
  }

  info(domain: string): Promise<PleskCliResult> {
    return this.call("--info", "-domain", domain);
  }

  autoConfigure(domain: string): Promise<PleskCliResult> {
    return this.call("--auto-configure", "-domain", domain);
  }

  update(domain: string, options: NodeUpdateOptions): Promise<PleskCliResult> {
    const args = ["--update", "-domain", domain];
    if (options.appRoot) args.push("-app-root", options.appRoot);
    if (options.startupFile) args.push("-startup-file", options.startupFile);
    if (options.nodeVersion) args.push("-node-version", options.nodeVersion);
    if (options.appMode) args.push("-app-mode", options.appMode);
    if (options.packageManager) {
      args.push("-package-manager", options.packageManager);
    }
    if (options.documentRoot) args.push("-document-root", options.documentRoot);
    return this.call(...args);
  }

  envList(domain: string): Promise<PleskCliResult> {
    return this.call("--env", "-domain", domain);
  }

  envSet(
    domain: string,
    key: string,
    value: string,
    secret = false
  ): Promise<PleskCliResult> {
    const args = ["--set-env", "-domain", domain, "-name", key, "-value", value];
    if (secret) args.push("-secret", "true");
    return this.call(...args);
  }

  envUnset(domain: string, key: string): Promise<PleskCliResult> {
    return this.call("--unset-env", "-domain", domain, "-name", key);
  }

  install(domain: string): Promise<PleskCliResult> {
    return this.call("--install-dependencies", "-domain", domain);
  }

  runScript(domain: string, script: string): Promise<PleskCliResult> {
    return this.call("--run-script", "-domain", domain, "-script", script);
  }

  restart(domain: string): Promise<PleskCliResult> {
    return this.call("--restart", "-domain", domain);
  }

  start(domain: string): Promise<PleskCliResult> {
    return this.call("--start", "-domain", domain);
  }

  stop(domain: string): Promise<PleskCliResult> {
    return this.call("--stop", "-domain", domain);
  }

  status(domain: string): Promise<PleskCliResult> {
    return this.call("--status", "-domain", domain);
  }

  private call(...args: string[]): Promise<PleskCliResult> {
    return this.client.cliCall("extension", ["--exec", "nodejs", ...args]);
  }
}
