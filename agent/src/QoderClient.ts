import { execFile } from "child_process";
import { promisify } from "util";
import { Config } from "./Config";
import { OTelTracer } from "./OTelContext";

const execFileAsync = promisify(execFile);

const CHECK_TIMEOUT_MS = 120000;
const PROBE_PROMPT = "Reply with exactly: OK";

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  stderr?: string;
  stdout?: string;
}

export class QoderClient {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  public async checkAuthentication(): Promise<void> {
    const span = OTelTracer().startSpan("qoder-client.check-authentication");
    try {
      await execFileAsync(
        this.config.QODER_CLI,
        ["-p", PROBE_PROMPT],
        { timeout: CHECK_TIMEOUT_MS, windowsHide: true },
      );
    } catch (error) {
      const execError = error as ExecFileError;
      span.recordException(execError);
      if (execError.code === "ENOENT") {
        throw new Error(
          `Qoder CLI '${this.config.QODER_CLI}' not found in PATH`,
          { cause: error },
        );
      }
      if (execError.killed) {
        throw new Error(
          `Qoder authentication check timed out after ${CHECK_TIMEOUT_MS / 1000} seconds`,
          { cause: error },
        );
      }
      throw new Error(
        `Qoder authentication check failed:\n${extractErrorDetail(execError)}`,
        { cause: error },
      );
    } finally {
      span.end();
    }
  }
}

function extractErrorDetail(error: ExecFileError): string {
  const output = [error.stderr, error.stdout]
    .filter((value) => value && value.trim().length > 0)
    .join("\n");
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !line.startsWith("at ") &&
        !line.startsWith("DeprecationWarning") &&
        !line.includes("--trace-deprecation"),
    )
    .slice(0, 5);
  return lines.length > 0 ? lines.join("\n") : error.message;
}
