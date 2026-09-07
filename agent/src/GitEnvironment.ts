import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config } from "./Config";
import { ExecFileError, extractErrorDetail, runCli } from "./CliUtils";
import { OTelLogger, OTelTracer } from "./OTelContext";

const logger = OTelLogger().createModuleLogger("git-environment");

const CLI_TIMEOUT_MS = 60000;
const SSH_KEY_FILE_NAME = "id_github";

// Official GitHub SSH host keys (https://docs.github.com/en/authentication/
// keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints) so that
// SSH works with StrictHostKeyChecking yes and no trust-on-first-use prompt.
const GITHUB_KNOWN_HOSTS = [
  "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
  "ssh.github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
  "ssh.github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=",
].join("\n");

const GPG_PRESET_PASSPHRASE_CANDIDATES = [
  "/usr/lib/gnupg/gpg-preset-passphrase",
  "/usr/libexec/gnupg/gpg-preset-passphrase",
];

/**
 * Prepares the container for Git and GitHub operations from configuration:
 *
 * - git identity (user name / email)
 * - GitHub token exposed as GH_TOKEN and used by git as an HTTPS credential
 *   helper through the gh CLI
 * - additional GitHub tokens scoped by organization (GITHUB_TOKENS), applied
 *   as per-organization HTTPS credential helpers
 * - SSH private key for git@github.com SSH authentication, with the GitHub
 *   host keys pinned in known_hosts
 * - GPG private key imported for headless commit signing (passphrase cached
 *   in gpg-agent when provided)
 * - optional SSH-based commit signing
 *
 * Everything is optional and enabled purely from what the configuration
 * provides; when nothing is configured the environment is left untouched.
 */
export class GitEnvironment {
  private config: Config;
  private homeDir: string;

  constructor(config: Config, homeDir?: string) {
    this.config = config;
    this.homeDir = homeDir || os.homedir();
  }

  public async prepare(): Promise<void> {
    const span = OTelTracer().startSpan("git-environment.prepare");
    try {
      const githubToken = this.config.GITHUB_TOKEN.trim();
      const githubTokenEntries = this.config.githubTokenEntries();
      const sshKey = normalizeKeyContent(this.config.GIT_SSH_PRIVATE_KEY);
      const gpgKey = normalizeKeyContent(this.config.GIT_GPG_PRIVATE_KEY);
      const sshSigning = this.config.GIT_SSH_SIGNING === "true";

      if (
        githubToken.length === 0 &&
        githubTokenEntries.length === 0 &&
        sshKey.length === 0 &&
        gpgKey.length === 0
      ) {
        logger.info(
          "Git environment not configured (no GitHub token, SSH key or GPG key)",
        );
        return;
      }

      // Fail fast on obviously invalid values instead of discovering the
      // misconfiguration from inside a task execution.
      if (githubToken.length > 0 && githubToken.length < 20) {
        throw new Error("GITHUB_TOKEN is too short to be a valid GitHub token");
      }
      for (const entry of githubTokenEntries) {
        if (entry.token.length < 20) {
          throw new Error(
            `GITHUB_TOKENS token for organization '${entry.organization}' is too short to be a valid GitHub token`,
          );
        }
      }
      if (sshKey.length > 0 && !sshKey.includes("PRIVATE KEY-----")) {
        throw new Error(
          "GIT_SSH_PRIVATE_KEY does not look like a private key (expected an OpenSSH or PEM 'PRIVATE KEY' block)",
        );
      }
      if (gpgKey.length > 0 && !gpgKey.includes("PGP PRIVATE KEY BLOCK")) {
        throw new Error(
          "GIT_GPG_PRIVATE_KEY is not an armored PGP private key (expected a 'PGP PRIVATE KEY BLOCK' armor header)",
        );
      }
      if (sshSigning && sshKey.length === 0) {
        throw new Error(
          "GIT_SSH_SIGNING is enabled but GIT_SSH_PRIVATE_KEY is not set",
        );
      }

      const configured: string[] = [];

      // Git must never hang waiting for interactive credential input.
      process.env.GIT_TERMINAL_PROMPT = "0";

      // GitHub token: expose it as GH_TOKEN for the gh CLI (the agent
      // process environment is inherited by git, gh and the qoder child
      // processes) and use gh as the git credential helper for HTTPS.
      if (githubToken.length > 0) {
        if (!process.env.GH_TOKEN) {
          process.env.GH_TOKEN = githubToken;
        }
        await this.checkGhCli();
        configured.push("GitHub token (gh CLI and git HTTPS credentials)");
      }

      if (githubTokenEntries.length > 0) {
        configured.push(
          `GitHub organization tokens (${githubTokenEntries
            .map((entry) => entry.organization)
            .join(", ")})`,
        );
      }

      let sshPublicKey = "";
      if (sshKey.length > 0) {
        sshPublicKey = await this.setupSsh(sshKey, sshSigning);
        configured.push(`SSH key (~/.ssh/${SSH_KEY_FILE_NAME})`);
      }

      let gpgKeyId = "";
      if (gpgKey.length > 0) {
        gpgKeyId = await this.setupGpg(gpgKey);
        configured.push(`GPG commit signing key (${gpgKeyId})`);
      }

      await this.writeGitConfig(githubToken, sshPublicKey, gpgKeyId, sshSigning);

      logger.info(`Git environment prepared: ${configured.join(", ")}`);
    } catch (error) {
      span.recordException(error as Error);
      throw new Error(
        `Git environment preparation failed:\n${extractErrorDetail(error as ExecFileError)}`,
        { cause: error },
      );
    } finally {
      span.end();
    }
  }

  /**
   * Warns (without failing) when the gh CLI is missing: the credential
   * helper is only useful once the CLI is available.
   */
  private async checkGhCli(): Promise<void> {
    try {
      await runCli("gh", ["--version"], {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      });
    } catch (error) {
      const execError = error as ExecFileError;
      if (execError.code === "ENOENT") {
        logger.warn(
          "gh CLI not found: HTTPS authentication with the GitHub token will not work",
        );
      }
    }
  }

  /**
   * Writes the SSH private key and the SSH client configuration for
   * github.com, and returns the derived public key (used for SSH signing).
   */
  private async setupSsh(sshKey: string, sshSigning: boolean): Promise<string> {
    const sshDir = path.join(this.homeDir, ".ssh");
    const keyFile = path.join(sshDir, SSH_KEY_FILE_NAME);
    const knownHostsFile = path.join(sshDir, "known_hosts");
    await fse.ensureDir(sshDir, 0o700);
    await fse.writeFile(keyFile, sshKey, { mode: 0o600 });
    await fse.writeFile(knownHostsFile, `${GITHUB_KNOWN_HOSTS}\n`, {
      mode: 0o644,
    });

    // Derive the public key from the private key; this also validates that
    // the key content is actually usable.
    const publicKey = (
      await runCli("ssh-keygen", ["-y", "-f", keyFile], {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      })
    ).stdout.trim();
    await fse.writeFile(`${keyFile}.pub`, `${publicKey}\n`, { mode: 0o644 });
    await fse.writeFile(path.join(sshDir, "config"), renderSshConfig(keyFile, knownHostsFile), {
      mode: 0o600,
    });

    if (sshSigning) {
      // Local verification of SSH-signed commits requires an allowed
      // signers file mapping the committer identity to the public key.
      await fse.writeFile(
        path.join(sshDir, "allowed_signers"),
        `${this.config.GIT_USER_EMAIL} namespaces=* ${publicKey}\n`,
        { mode: 0o644 },
      );
    }
    return publicKey;
  }

  /**
   * Imports the GPG private key and returns the signing key id.
   */
  private async setupGpg(gpgKey: string): Promise<string> {
    const gnupgDir = path.join(this.homeDir, ".gnupg");
    await fse.ensureDir(gnupgDir, 0o700);
    // Export GNUPGHOME so the gpg processes spawned by git use the prepared
    // keyring. gpg derives its agent sockets from the home: a home that
    // differs from $HOME/.gnupg gets a dedicated per-home socket directory,
    // while a home that equals $HOME/.gnupg is treated as the default home
    // and shares the session-wide agent socket.
    process.env.GNUPGHOME = path.resolve(gnupgDir);

    // Import the private key from a temporary file inside the 0700 gnupg
    // home, then remove it immediately. All gpg invocations rely on the
    // GNUPGHOME environment variable (never --homedir) so that git-spawned
    // gpg processes and this setup use the exact same daemon instances:
    // gpg derives its per-home daemon sockets from the home spelling and
    // mixed spellings yield stale daemon views of the keyring.
    const importFile = path.join(gnupgDir, "planner-agent-import.asc");
    await fse.writeFile(importFile, gpgKey, { mode: 0o600 });
    try {
      await runCli("gpg", ["--batch", "--import", importFile], {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      });
    } finally {
      await fse.remove(importFile);
    }

    // Resolve the signing key id: explicit configuration wins, otherwise use
    // the first secret key of the imported keyring.
    let keyId = this.config.GIT_GPG_KEY_ID.trim();
    if (keyId.length === 0) {
      const listing = (
        await runCli("gpg", ["--batch", "--list-secret-keys", "--with-colons"], {
          timeout: CLI_TIMEOUT_MS,
          windowsHide: true,
        })
      ).stdout;
      keyId = parseFirstSecretKeyId(listing);
      if (keyId.length === 0) {
        throw new Error(
          "Could not determine the imported GPG key id (set GIT_GPG_KEY_ID explicitly)",
        );
      }
    }

    // With a passphrase, write the headless signing configuration now; the
    // passphrase itself is preset after the agent restart below.
    const passphrase = this.config.GIT_GPG_PASSPHRASE;
    if (passphrase.length > 0) {
      await this.writeGpgPassphraseConfig(gnupgDir);
    }

    // Restart the agent so it picks up the configuration and rescans the
    // imported secret key, then verify that signing actually works. The
    // verification runs in the same environment that git will use for its
    // own gpg processes, so any daemon or keyring mismatch fails fast here
    // instead of surfacing as a misleading "No secret key" failure inside
    // a task commit.
    await runCli("gpgconf", ["--kill", "gpg-agent"], {
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    await runCli("gpgconf", ["--launch", "gpg-agent"], {
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
    });
    if (passphrase.length > 0) {
      await this.presetGpgPassphrase(passphrase);
    }
    try {
      await runCli(
        "sh",
        [
          "-c",
          `printf agent | gpg --batch --local-user '${keyId}' --clearsign > /dev/null`,
        ],
        { timeout: CLI_TIMEOUT_MS, windowsHide: true },
      );
    } catch (error) {
      throw new Error(
        `GPG signing verification failed with the imported key:\n${extractErrorDetail(error as ExecFileError)}`,
        { cause: error },
      );
    }
    return keyId;
  }

  /**
   * Writes the gpg configuration required for headless passphrase prompting.
   */
  private async writeGpgPassphraseConfig(gnupgDir: string): Promise<void> {
    await fse.writeFile(
      path.join(gnupgDir, "gpg.conf"),
      "use-agent\npinentry-mode loopback\n",
      { mode: 0o600 },
    );
    await fse.writeFile(
      path.join(gnupgDir, "gpg-agent.conf"),
      "allow-preset-passphrase\ndefault-cache-ttl 31536000\nmax-cache-ttl 31536000\n",
      { mode: 0o600 },
    );
  }

  /**
   * Presets the passphrase in the running gpg-agent (long cache TTL) so
   * commit signing never prompts in the container.
   */
  private async presetGpgPassphrase(passphrase: string): Promise<void> {
    const presetBinary = await findGpgPresetPassphrase();
    if (presetBinary.length === 0) {
      throw new Error(
        "gpg-preset-passphrase binary not found (cannot cache the GPG passphrase for headless signing)",
      );
    }
    const listing = (
      await runCli("gpg", ["--batch", "--list-secret-keys", "--with-colons", "--with-keygrip"], {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
      })
    ).stdout;
    const keygrip = parseFirstKeygrip(listing);
    if (keygrip.length === 0) {
      throw new Error("Could not determine the GPG keygrip for passphrase caching");
    }

    // Pass the passphrase through the environment instead of the command
    // line so it does not show up in the process list.
    await runCli(
      "sh",
      ["-c", `printf %s "$GPG_PASSPHRASE" | '${presetBinary}' --preset '${keygrip}'`],
      {
        timeout: CLI_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GPG_PASSPHRASE: passphrase },
      },
    );
  }

  /**
   * Writes the managed ~/.gitconfig with the identity and the
   * authentication/signing settings derived from the configuration.
   */
  private async writeGitConfig(
    githubToken: string,
    sshPublicKey: string,
    gpgKeyId: string,
    sshSigning: boolean,
  ): Promise<void> {
    // GPG signing takes precedence over SSH signing when both are configured.
    const gpgSigning = gpgKeyId.length > 0;
    const sshSigningKeyFile = path.join(this.homeDir, ".ssh", `${SSH_KEY_FILE_NAME}.pub`);
    const githubTokenEntries = this.config.githubTokenEntries();

    const lines: string[] = [];
    lines.push("[user]");
    lines.push(`\tname = ${this.config.GIT_USER_NAME}`);
    lines.push(`\temail = ${this.config.GIT_USER_EMAIL}`);
    if (gpgSigning) {
      lines.push(`\tsigningkey = ${gpgKeyId}`);
    } else if (sshSigning && sshPublicKey.length > 0) {
      lines.push(`\tsigningkey = ${sshSigningKeyFile}`);
    }
    lines.push("[init]");
    lines.push("\tdefaultBranch = main");
    lines.push("[safe]");
    lines.push("\tdirectory = /data");
    if (githubTokenEntries.length > 0) {
      // The path component must be considered for the organization scoping,
      // and the organization helpers must be written before the host-wide
      // helper: git stops at the first helper that returns a complete
      // credential.
      lines.push("[credential]");
      lines.push("\tuseHttpPath = true");
      for (const entry of githubTokenEntries) {
        lines.push(`[credential "https://github.com/${entry.organization}"]`);
        lines.push(
          `\thelper = "!f() { echo username=x-access-token; echo password=${entry.token}; }; f"`,
        );
      }
    }
    if (githubToken.length > 0) {
      lines.push('[credential "https://github.com"]');
      lines.push("\thelper = !gh auth git-credential");
    }
    if ((githubToken.length > 0 || githubTokenEntries.length > 0) && sshPublicKey.length === 0) {
      // Without an SSH key, rewrite SSH clone URLs to HTTPS so pushes still
      // authenticate with the tokens.
      lines.push('[url "https://github.com/"]');
      lines.push("\tinsteadOf = git@github.com:");
    }
    lines.push("[commit]");
    lines.push(`\tgpgsign = ${gpgSigning || sshSigning ? "true" : "false"}`);
    if (gpgSigning) {
      lines.push("[gpg]");
      lines.push("\tformat = openpgp");
    } else if (sshSigning) {
      lines.push("[gpg]");
      lines.push("\tformat = ssh");
    }
    await fse.writeFile(
      path.join(this.homeDir, ".gitconfig"),
      `${lines.join("\n")}\n`,
      { mode: 0o600 },
    );
  }
}

/**
 * Normalizes key content: supports both real newlines and literal "\n"
 * escape sequences and guarantees a trailing newline.
 */
function normalizeKeyContent(value: string): string {
  const normalized = value.replace(/\\n/g, "\n").trim();
  return normalized.length > 0 ? `${normalized}\n` : "";
}

function renderSshConfig(keyFile: string, knownHostsFile: string): string {
  const hostBlock = (host: string, extra: string[]): string =>
    [
      `Host ${host}`,
      `  HostName ${host}`,
      ...extra,
      "  User git",
      `  IdentityFile ${keyFile}`,
      "  IdentitiesOnly yes",
      "  StrictHostKeyChecking yes",
      `  UserKnownHostsFile ${knownHostsFile}`,
      "  UpdateHostKeys no",
      "",
    ].join("\n");
  return `${hostBlock("github.com", [])}\n${hostBlock("ssh.github.com", ["  Port 443"])}`;
}

/**
 * Extracts the key id of the first secret key from a gpg --with-colons
 * listing, preferring the fingerprint.
 */
function parseFirstSecretKeyId(listing: string): string {
  let secKeyId = "";
  for (const line of listing.split("\n")) {
    if (line.startsWith("fpr:")) {
      const fingerprint = line.split(":")[9];
      if (fingerprint) {
        return fingerprint;
      }
    }
    if (line.startsWith("sec:") && secKeyId.length === 0) {
      secKeyId = line.split(":")[4] || "";
    }
  }
  return secKeyId;
}

/**
 * Extracts the keygrip of the first secret key from a gpg --with-colons
 * --with-keygrip listing.
 */
function parseFirstKeygrip(listing: string): string {
  for (const line of listing.split("\n")) {
    if (line.startsWith("grp:")) {
      const keygrip = line.split(":")[9];
      if (keygrip) {
        return keygrip;
      }
    }
  }
  return "";
}

async function findGpgPresetPassphrase(): Promise<string> {
  for (const candidate of GPG_PRESET_PASSPHRASE_CANDIDATES) {
    if (await fse.pathExists(candidate)) {
      return candidate;
    }
  }
  return "";
}
