import { execFile } from "child_process";
import * as fse from "fs-extra";
import * as os from "os";
import * as path from "path";
import { Config } from "./Config";
import { GitEnvironment } from "./GitEnvironment";

jest.mock("./OTelContext", () => ({
  OTelTracer: jest.fn(() => ({
    startSpan: jest.fn(() => ({
      end: jest.fn(),
      setAttribute: jest.fn(),
      recordException: jest.fn(),
    })),
  })),
  OTelLogger: jest.fn(() => ({
    createModuleLogger: jest.fn(() => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    })),
  })),
}));

jest.mock("child_process", () => ({
  execFile: jest.fn(),
}));

// Real fs-extra functions except pathExists, which is mocked to control the
// gpg-preset-passphrase binary lookup without touching system paths.
jest.mock("fs-extra", () => ({
  ...jest.requireActual("fs-extra"),
  pathExists: jest.fn(),
}));

const mockExecFile = execFile as unknown as jest.Mock;
const mockPathExists = fse.pathExists as unknown as jest.Mock;

const GITHUB_TOKEN = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
const SSH_KEY = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "ZmFrZWtleWNvbnRlbnQ=",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");
const GPG_KEY = [
  "-----BEGIN PGP PRIVATE KEY BLOCK-----",
  "ZmFrZWtleWNvbnRlbnQ=",
  "-----END PGP PRIVATE KEY BLOCK-----",
].join("\n");
const GPG_LISTING = [
  "sec:u:3072:22:ABCDEF1234567890:1700000000::::",
  "fpr:::::::::ABCDEF1234567890ABCDEF1234567890ABCDEF12:",
  "grp:::::::::KEYGRIP0123456789ABCDEF0123456789ABCDEF:",
  "uid:::::::::-:Agent Test <agent@test.example>::",
].join("\n");
const PUBLIC_KEY = "ssh-ed25519 AAAAFAKEPUBLICKEY agent@test.example";

type CliCallback = (error: Error | null, stdout: string, stderr: string) => void;

// Configure the execFile mock to invoke the handler for each command.
function mockCli(
  handler: (command: string, args: string[]) => string | undefined,
): void {
  mockExecFile.mockImplementation(
    (command: string, args: string[], _options: unknown, callback: CliCallback) => {
      callback(null, handler(command, args) ?? "", "");
    },
  );
}

describe("GitEnvironment", () => {
  const originalEnv = process.env;
  let homeDir: string;
  let config: Config;

  beforeEach(async () => {
    homeDir = await fse.mkdtemp(path.join(os.tmpdir(), "gitenv-spec-"));
    config = new Config();
    config.GIT_USER_NAME = "agent-test";
    config.GIT_USER_EMAIL = "agent@test.example";
    mockExecFile.mockReset();
    mockPathExists.mockResolvedValue(false);
  });

  afterEach(async () => {
    process.env = originalEnv;
    delete process.env.GH_TOKEN;
    delete process.env.GIT_TERMINAL_PROMPT;
    delete process.env.GNUPGHOME;
    jest.restoreAllMocks();
    await fse.remove(homeDir);
  });

  function run(): Promise<void> {
    return new GitEnvironment(config, homeDir).prepare();
  }

  async function readFile(relativePath: string): Promise<string> {
    return fse.readFile(path.join(homeDir, relativePath), "utf8");
  }

  function assertMode(relativePath: string, expected: number): void {
    const stats = fse.statSync(path.join(homeDir, relativePath));
    expect(stats.mode & 0o777).toBe(expected);
  }

  it("does nothing when no git configuration is provided", async () => {
    await expect(run()).resolves.toBeUndefined();

    expect(mockExecFile).not.toHaveBeenCalled();
    expect(await fse.pathExists(path.join(homeDir, ".gitconfig"))).toBe(false);
    expect(process.env.GH_TOKEN).toBeUndefined();
  });

  it("configures the git identity and GitHub token authentication", async () => {
    config.GITHUB_TOKEN = GITHUB_TOKEN;
    mockCli(() => "");

    await expect(run()).resolves.toBeUndefined();

    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).toContain("[user]");
    expect(gitconfig).toContain("\tname = agent-test");
    expect(gitconfig).toContain("\temail = agent@test.example");
    expect(gitconfig).toContain('[credential "https://github.com"]');
    expect(gitconfig).toContain("\thelper = !gh auth git-credential");
    expect(gitconfig).toContain('[url "https://github.com/"]');
    expect(gitconfig).toContain("\tinsteadOf = git@github.com:");
    expect(gitconfig).toContain("\tgpgsign = false");
    expect(gitconfig).toContain("\tdefaultBranch = main");
    assertMode(".gitconfig", 0o600);

    expect(process.env.GH_TOKEN).toBe(GITHUB_TOKEN);
    expect(process.env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(mockExecFile.mock.calls.some((call) => call[0] === "gh")).toBe(true);
  });

  it("keeps an existing GH_TOKEN", async () => {
    config.GITHUB_TOKEN = GITHUB_TOKEN;
    process.env.GH_TOKEN = "existing-token";
    mockCli(() => "");

    await expect(run()).resolves.toBeUndefined();

    expect(process.env.GH_TOKEN).toBe("existing-token");
  });

  it("writes the SSH key and pins the GitHub host keys", async () => {
    config.GIT_SSH_PRIVATE_KEY = SSH_KEY;
    mockCli((command, args) => {
      if (command === "ssh-keygen" && args[0] === "-y") {
        return PUBLIC_KEY;
      }
      return "";
    });

    await expect(run()).resolves.toBeUndefined();

    const keyFile = path.join(homeDir, ".ssh", "id_github");
    expect(await fse.readFile(keyFile, "utf8")).toBe(`${SSH_KEY}\n`);
    assertMode(".ssh/id_github", 0o600);
    assertMode(".ssh", 0o700);
    expect(await readFile(".ssh/id_github.pub")).toBe(`${PUBLIC_KEY}\n`);

    const knownHosts = await readFile(".ssh/known_hosts");
    expect(knownHosts).toContain(
      "github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
    );
    expect(knownHosts).toContain("ssh.github.com");

    const sshConfig = await readFile(".ssh/config");
    expect(sshConfig).toContain("Host github.com");
    expect(sshConfig).toContain(`IdentityFile ${keyFile}`);
    expect(sshConfig).toContain("StrictHostKeyChecking yes");
    expect(sshConfig).toContain(`UserKnownHostsFile ${path.join(homeDir, ".ssh", "known_hosts")}`);

    // No token: no credential helper and no HTTPS URL rewriting.
    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).not.toContain("credential");
    expect(gitconfig).not.toContain("insteadOf");
  });

  it("keeps SSH clone URLs when both a token and an SSH key are configured", async () => {
    config.GITHUB_TOKEN = GITHUB_TOKEN;
    config.GIT_SSH_PRIVATE_KEY = SSH_KEY;
    mockCli((command, args) => {
      if (command === "ssh-keygen" && args[0] === "-y") {
        return PUBLIC_KEY;
      }
      return "";
    });

    await expect(run()).resolves.toBeUndefined();

    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).toContain('[credential "https://github.com"]');
    expect(gitconfig).not.toContain("insteadOf");
  });

  it("configures SSH commit signing when enabled", async () => {
    config.GIT_SSH_PRIVATE_KEY = SSH_KEY;
    config.GIT_SSH_SIGNING = "true";
    mockCli((command, args) => {
      if (command === "ssh-keygen" && args[0] === "-y") {
        return PUBLIC_KEY;
      }
      return "";
    });

    await expect(run()).resolves.toBeUndefined();

    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).toContain(
      `\tsigningkey = ${path.join(homeDir, ".ssh", "id_github.pub")}`,
    );
    expect(gitconfig).toContain("\tgpgsign = true");
    expect(gitconfig).toContain("[gpg]");
    expect(gitconfig).toContain("\tformat = ssh");

    const allowedSigners = await readFile(".ssh/allowed_signers");
    expect(allowedSigners).toContain(`agent@test.example namespaces=* ${PUBLIC_KEY}`);
  });

  it("rejects a token that is too short", async () => {
    config.GITHUB_TOKEN = "short";
    mockCli(() => "");

    await expect(run()).rejects.toThrow(/too short/);
  });

  it("rejects an invalid SSH private key", async () => {
    config.GIT_SSH_PRIVATE_KEY = "not a key";
    mockCli(() => "");

    await expect(run()).rejects.toThrow(/does not look like a private key/);
  });

  it("rejects SSH signing without an SSH key", async () => {
    config.GITHUB_TOKEN = GITHUB_TOKEN;
    config.GIT_SSH_SIGNING = "true";
    mockCli(() => "");

    await expect(run()).rejects.toThrow(/GIT_SSH_SIGNING is enabled but/);
  });

  it("imports the GPG key and configures commit signing", async () => {
    config.GIT_GPG_PRIVATE_KEY = GPG_KEY;
    let importedContent = "";
    mockCli((command, args) => {
      if (command === "gpg" && args.includes("--import")) {
        importedContent = fse.readFileSync(args[args.indexOf("--import") + 1], "utf8");
        return "";
      }
      if (command === "gpg" && args.includes("--list-secret-keys")) {
        return GPG_LISTING;
      }
      return "";
    });

    await expect(run()).resolves.toBeUndefined();

    expect(importedContent).toBe(`${GPG_KEY}\n`);
    // The temporary import file is removed after the import.
    const importFile = path.join(homeDir, ".gnupg", "planner-agent-import.asc");
    expect(await fse.pathExists(importFile)).toBe(false);

    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).toContain(
      "\tsigningkey = ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    );
    expect(gitconfig).toContain("\tgpgsign = true");
    expect(gitconfig).toContain("\tformat = openpgp");

    // The signing capability is verified at startup with a throwaway
    // signature after the daemons have been launched.
    expect(
      mockExecFile.mock.calls.some(
        (call) => call[0] === "gpgconf" && call[1].includes("--launch"),
      ),
    ).toBe(true);
    const verifyCall = mockExecFile.mock.calls.find(
      (call) => call[0] === "sh" && call[1][1].includes("--clearsign"),
    );
    expect(verifyCall[1][1]).toContain(
      "--local-user 'ABCDEF1234567890ABCDEF1234567890ABCDEF12'",
    );
  });

  it("uses the explicitly configured GPG key id", async () => {
    config.GIT_GPG_PRIVATE_KEY = GPG_KEY;
    config.GIT_GPG_KEY_ID = "CUSTOMKEYID";
    mockCli(() => "");

    await expect(run()).resolves.toBeUndefined();

    const gitconfig = await readFile(".gitconfig");
    expect(gitconfig).toContain("\tsigningkey = CUSTOMKEYID");
    expect(mockExecFile.mock.calls.some((call) => call[1].includes("--list-secret-keys"))).toBe(
      false,
    );
  });

  it("caches the GPG passphrase for headless signing", async () => {
    config.GIT_GPG_PRIVATE_KEY = GPG_KEY;
    config.GIT_GPG_PASSPHRASE = "secret-passphrase";
    // Make the gpg-preset-passphrase lookup succeed without system paths.
    mockPathExists.mockResolvedValue(true);
    mockCli((command, args) => {
      if (command === "gpg" && args.includes("--list-secret-keys")) {
        return GPG_LISTING;
      }
      return "";
    });

    await expect(run()).resolves.toBeUndefined();

    expect(await readFile(".gnupg/gpg.conf")).toContain("pinentry-mode loopback");
    expect(await readFile(".gnupg/gpg-agent.conf")).toContain("allow-preset-passphrase");

    expect(
      mockExecFile.mock.calls.some(
        (call) => call[0] === "gpgconf" && call[1].includes("--kill"),
      ),
    ).toBe(true);

    const presetCall = mockExecFile.mock.calls.find(
      (call) =>
        call[0] === "sh" &&
        call[1][0] === "-c" &&
        call[1][1].includes("gpg-preset-passphrase"),
    );
    expect(presetCall).toBeDefined();
    expect(presetCall[1][1]).toContain("gpg-preset-passphrase");
    expect(presetCall[1][1]).toContain(
      "--preset 'KEYGRIP0123456789ABCDEF0123456789ABCDEF'",
    );
    expect(presetCall[2].env.GPG_PASSPHRASE).toBe("secret-passphrase");
  });

  it("rejects a non-armored GPG key", async () => {
    config.GIT_GPG_PRIVATE_KEY = "not a gpg key";
    mockCli(() => "");

    await expect(run()).rejects.toThrow(/not an armored PGP private key/);
  });
});
