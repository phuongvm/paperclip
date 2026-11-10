/**
 * Environment test for the Hermes Agent adapter.
 *
 * Verifies that Hermes Agent is installed, accessible, and configured
 * before allowing the adapter to be used.
 */

import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { HERMES_CLI, ADAPTER_TYPE, VALID_PROVIDERS } from "../shared/constants.js";
import { computePolicy, loadHermesCatalog, type HermesCatalog } from "./catalog.js";
import { detectModel, resolveHermesHome, resolveProvider } from "./detect-model.js";
import { resolveHermesCommand } from "./execute.js";
import { resolveHermesInvocation } from "./resolver.js";

const execFileAsync = promisify(execFile);

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function buildExecEnv(config: Record<string, unknown>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const envConfig =
    config.env && typeof config.env === "object" && !Array.isArray(config.env)
      ? (config.env as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkCliInstalled(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    // Try to run the command to see if it exists
    await execFileAsync(command, ["--version"], { timeout: 10_000, env });
    return null; // OK — it ran successfully
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      return {
        level: "error",
        message: `Hermes CLI "${command}" not found in PATH`,
        hint: "Install Hermes Agent: pip install hermes-agent",
        code: "hermes_cli_not_found",
      };
    }
    // Command exists but --version might have failed for some reason
    // Still consider it installed
    return null;
  }
}

async function checkCliVersion(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<AdapterEnvironmentCheck | null> {
  try {
    const { stdout } = await execFileAsync(command, ["--version"], {
      timeout: 10_000,
      env,
    });
    const version = stdout.trim();
    if (version) {
      return {
        level: "info",
        message: `Hermes Agent version: ${version}`,
        code: "hermes_version",
      };
    }
    return {
      level: "warn",
      message: "Could not determine Hermes Agent version",
      code: "hermes_version_unknown",
    };
  } catch {
    return {
      level: "warn",
      message:
        "Could not determine Hermes Agent version (hermes --version failed)",
      hint: "Make sure the hermes CLI is properly installed and functional",
      code: "hermes_version_failed",
    };
  }
}

function discoverManagedPythonCandidates(config: Record<string, unknown>): string[] {
  const candidates: string[] = [];
  try {
    const hermesHome = resolveHermesHome(config);
    const toolsDir = join(hermesHome, "tools");
    if (existsSync(toolsDir)) {
      for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("python-")) continue;
        const winPy = join(toolsDir, entry.name, "python.exe");
        const posixPy = join(toolsDir, entry.name, "bin", "python3");
        if (existsSync(winPy)) candidates.push(winPy);
        if (existsSync(posixPy)) candidates.push(posixPy);
      }
    }
  } catch {
    // ignore discovery errors
  }
  return candidates;
}

async function checkPython(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  cliVersionMessage?: string,
): Promise<AdapterEnvironmentCheck | null> {
  const embeddedMatch = cliVersionMessage?.match(/Python:\s*(\d+)\.(\d+)/i);
  if (embeddedMatch) {
    const major = parseInt(embeddedMatch[1], 10);
    const minor = parseInt(embeddedMatch[2], 10);
    if (major < 3 || (major === 3 && minor < 10)) {
      return {
        level: "error",
        message: `Python ${major}.${minor} found — Hermes requires Python 3.10+`,
        hint: "Upgrade Python to 3.10 or later",
        code: "hermes_python_old",
      };
    }
    return null;
  }

  const candidates = [
    ...discoverManagedPythonCandidates(config),
    "python3",
    "python",
    ...(asString(config.hermesCommand) === process.execPath ? [process.execPath] : []),
  ];
  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"], {
        timeout: 5_000,
        env,
      });
      const version = stdout.trim();
      const match = version.match(/(\d+)\.(\d+)/);
      if (match) {
        const major = parseInt(match[1], 10);
        const minor = parseInt(match[2], 10);
        if (major < 3 || (major === 3 && minor < 10)) {
          return {
            level: "error",
            message: `Python ${version} found — Hermes requires Python 3.10+`,
            hint: "Upgrade Python to 3.10 or later",
            code: "hermes_python_old",
          };
        }
        return null; // OK
      }
    } catch {
      // Try next candidate
    }
  }
  return {
    level: "warn",
    message: "python3 not found in PATH",
    hint: "Hermes Agent requires Python 3.10+. Install it from python.org",
    code: "hermes_python_missing",
  };
}

function checkModel(
  config: Record<string, unknown>,
): AdapterEnvironmentCheck | null {
  const model = asString(config.model);
  if (!model) {
    return {
      level: "info",
      message: "No model specified — Hermes will use its configured default model",
      hint: "Set a model explicitly in Paperclip only if you want to override your local Hermes configuration.",
      code: "hermes_configured_default_model",
    };
  }
  return {
    level: "info",
    message: `Model: ${model}`,
    code: "hermes_model_configured",
  };
}

async function checkApiKeys(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
  catalog?: HermesCatalog,
): Promise<AdapterEnvironmentCheck | null> {
  // The server resolves secret refs into config.env before calling testEnvironment,
  // so we check config.env first (adapter-configured secrets), then fall back to
  // process.env (server/host environment), then ~/.hermes/.env (Hermes local config).
  const envConfig = (config.env ?? {}) as Record<string, unknown>;
  const resolvedEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(envConfig)) {
    if (typeof value === "string" && value.length > 0) resolvedEnv[key] = value;
  }

  // Also read ~/.hermes/.env — Hermes stores API keys there by default and does
  // not export them to the parent process, so Paperclip's process.env won't
  // contain them.  Parsing this file ensures the environment test reports
  // accurate results for keys that Hermes already knows about.
  const hermesEnvKeys: Record<string, string> = {};
  try {
    const hermesEnvPath = join(resolveHermesHome(config), ".env");
    const content = readFileSync(hermesEnvPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim();
        if (value.length > 0) hermesEnvKeys[key] = value;
      }
    }
  } catch {
    // <HERMES_HOME>/.env may not exist — that's fine
  }

  const has = (key: string): boolean =>
    !!(resolvedEnv[key] ?? process.env[key] ?? hermesEnvKeys[key]);

  const hasAnthropic = has("ANTHROPIC_API_KEY");
  const hasOpenRouter = has("OPENROUTER_API_KEY");
  const hasOpenAI = has("OPENAI_API_KEY");
  const hasZai = has("ZAI_API_KEY");
  const hasKimi = has("KIMI_API_KEY");
  const hasMiniMax = has("MINIMAX_API_KEY");

  const providers: string[] = [];
  if (hasAnthropic) providers.push("Anthropic");
  if (hasOpenRouter) providers.push("OpenRouter");
  if (hasOpenAI) providers.push("OpenAI");
  if (hasZai) providers.push("Z.AI");
  if (hasKimi) providers.push("Kimi");
  if (hasMiniMax) providers.push("MiniMax");

  if (providers.length > 0) {
    return {
      level: "info",
      message: `API keys found: ${providers.join(", ")}`,
      code: "hermes_api_keys_found",
    };
  }

  const requestedModel = asString(config.model);

  const supportedProviders = VALID_PROVIDERS as readonly string[];
  const modelMatchesRequested =
    !!detectedConfig?.model &&
    (!requestedModel || detectedConfig.model.toLowerCase() === requestedModel.toLowerCase());

  const hasProviderKeyEnv = Boolean(
    catalog?.providers.some((p) => p.keyEnv && has(p.keyEnv)),
  );
  const hasConfiguredKey = Boolean(
    detectedConfig?.hasApiKey ||
      (detectedConfig?.keyEnv && has(detectedConfig.keyEnv)) ||
      hasProviderKeyEnv,
  );
  const matchingHermesConfigApiKey =
    hasConfiguredKey &&
    (modelMatchesRequested || hasProviderKeyEnv);

  if (matchingHermesConfigApiKey && detectedConfig) {
    const providerLabel = detectedConfig.provider.trim();

    if (!providerLabel) {
      return {
        level: "info",
        message: "Hermes config includes an API key for the requested model via ~/.hermes/config.yaml without an explicit provider",
        hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
        code: "hermes_api_key_in_config",
      };
    }

    if (!supportedProviders.includes(providerLabel)) {
      return {
        level: "info",
        message: `Hermes config includes runtime settings for unsupported adapter provider "${providerLabel}" via ~/.hermes/config.yaml`,
        hint: "Skipping the built-in API-key warning because Hermes can resolve this provider at runtime.",
        code: "hermes_custom_provider_config",
      };
    }

    return {
      level: "info",
      message: `Hermes config includes an API key for provider "${providerLabel}" via ~/.hermes/config.yaml`,
      hint: "Skipping the built-in API-key warning because Hermes can use model.api_key from the local Hermes config.",
      code: "hermes_api_key_in_config",
    };
  }

  return {
    level: "warn",
    message: "No LLM API keys found in environment",
    hint: "Set API keys in the agent's env secrets or ~/.hermes/.env. Hermes supports: ANTHROPIC_API_KEY, OPENROUTER_API_KEY, OPENAI_API_KEY, ZAI_API_KEY, KIMI_API_KEY, MINIMAX_API_KEY",
    code: "hermes_no_api_keys",
  };
}

/**
 * Check provider/model consistency.
 * Warns if the configured provider might be wrong for the model.
 */
async function checkProviderConsistency(
  config: Record<string, unknown>,
  detectedConfig: Awaited<ReturnType<typeof detectModel>> | null,
  catalog: HermesCatalog,
): Promise<AdapterEnvironmentCheck[]> {
  const checks: AdapterEnvironmentCheck[] = [];
  const model = asString(config.model);
  const explicitProvider = asString(config.provider);
  const policy = computePolicy(catalog, process.env);

  const resolution = resolveHermesInvocation({
    configModel: model,
    configProvider: explicitProvider,
    catalog,
    policy,
  });

  if (!resolution.ok) {
    checks.push({
      level: "error",
      message: `Provider authorization failed (${resolution.errorCode}): provider="${resolution.provider ?? "unverified"}"${resolution.reason ? ` reason=${resolution.reason}` : ""}`,
      hint: "Select an allowed provider from your Hermes configuration or update PAPERCLIP_HERMES_ALLOWED_PROVIDERS.",
      code: resolution.errorCode,
    });
    return checks;
  }

  for (const warningCode of resolution.warnings) {
    if (warningCode === "hermes_model_not_in_provider_catalog") {
      checks.push({
        level: "warn",
        message: `Model "${model ?? ""}" is not listed in the catalog for provider "${resolution.provider ?? "auto"}"`,
        hint: "The model will still be passed verbatim to Hermes at runtime.",
        code: "hermes_model_not_in_provider_catalog",
      });
    } else if (warningCode === "hermes_model_ambiguous_legacy_composite") {
      checks.push({
        level: "warn",
        message: `Model "${model ?? ""}" matches both a direct provider catalog entry and a legacy composite prefix; using the direct catalog entry`,
        hint: "Save an explicit provider in the agent configuration to disambiguate.",
        code: "hermes_model_ambiguous_legacy_composite",
      });
    }
  }

  if (!model) return checks;

  if (policy.mode === "restrictive") {
    return checks;
  }

  const { provider: resolved, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    detectedBaseUrl: detectedConfig?.baseUrl,
    detectedHasApiKey: detectedConfig?.hasApiKey,
    detectedApiMode: detectedConfig?.apiMode,
    model,
  });

  // If provider was explicitly set but doesn't match what Hermes config says,
  // that's worth flagging.
  if (explicitProvider && detectedConfig?.provider && explicitProvider !== detectedConfig.provider) {
    checks.push({
      level: "warn",
      message: `Provider mismatch: adapterConfig has "${explicitProvider}" but ~/.hermes/config.yaml has "${detectedConfig.provider}". Using adapterConfig value.`,
      hint: `Model "${model}" may not work correctly with provider "${explicitProvider}". Consider aligning with your Hermes config or removing the explicit provider to use auto-detection.`,
      code: "hermes_provider_mismatch",
    });
    return checks;
  }

  // If Hermes config matches the requested model but uses an adapter-unsupported
  // provider such as "custom", do not report a false provider inference.
  if (!explicitProvider && resolvedFrom.startsWith("hermesConfigUnsupported:")) {
    const unsupportedProvider = resolvedFrom.split(":", 2)[1] || detectedConfig?.provider || "unknown";
    checks.push({
      level: "info",
      message: `Hermes config uses unsupported adapter provider "${unsupportedProvider}" for model "${model}" — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_unsupported",
    });
    return checks;
  }

  // If matching Hermes config provides runtime signals without an explicit provider,
  // also defer to Hermes rather than inventing a provider from the model name.
  if (!explicitProvider && resolvedFrom === "hermesConfigRuntime") {
    checks.push({
      level: "info",
      message: `Hermes config provides runtime settings for model "${model}" without an explicit adapter provider — deferring to Hermes auto-detection`,
      hint: "Paperclip will avoid model-name provider inference here and let Hermes resolve the provider from ~/.hermes/config.yaml at runtime.",
      code: "hermes_provider_runtime_config",
    });
    return checks;
  }

  // If provider was auto-detected (not explicitly set), log what was resolved
  if (!explicitProvider && resolvedFrom !== "auto") {
    checks.push({
      level: "info",
      message: `Provider auto-detected as "${resolved}" (from ${resolvedFrom}) for model "${model}"`,
      code: "hermes_provider_detected",
    });
    return checks;
  }

  // If we couldn't resolve any provider, warn
  if (resolvedFrom === "auto" && !explicitProvider) {
    checks.push({
      level: "warn",
      message: `Could not determine provider for model "${model}" — will use Hermes auto-detection`,
      hint: "Set an explicit provider in the agent config or ensure ~/.hermes/config.yaml has a matching provider for this model.",
      code: "hermes_provider_unknown",
    });
    return checks;
  }

  return checks;
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = (ctx.config ?? {}) as Record<string, unknown>;
  const command = resolveHermesCommand(config);
  const checks: AdapterEnvironmentCheck[] = [];

  // Managed connections must prove the selected destination with the isolated
  // runtime environment. Host credentials and ~/.hermes are not evidence.
  if (config.managedAiRouting) {
    const remote = ctx.executionTarget?.kind === "remote";
    if (remote) {
      checks.push({ level: "error", code: "hermes_remote_probe_unsupported", message: "Hermes connection testing requires a local execution environment." });
    } else {
      const env = { ...process.env };
      for (const [key, value] of Object.entries((config.env ?? {}) as Record<string, unknown>)) {
        if (typeof value === "string") env[key] = value;
      }
      const args = ["chat", "-Q", "-q", "Respond with hello. Do not use tools.", "--max-turns", "1"];
      if (asString(config.model)) args.push("-m", asString(config.model)!);
      const provider = asString(config.provider);
      if (provider && provider !== "auto") args.push("--provider", provider);
      try {
        const { stdout } = await execFileAsync(command, args, {
          env, cwd: asString(config.cwd), timeout: 45_000, maxBuffer: 1024 * 1024,
        });
        if (!/\bhello\b/i.test(stdout)) throw new Error("No hello response");
        checks.push({ level: "info", code: "hermes_hello_probe_passed", message: "Hermes responded through the selected connection." });
      } catch {
        checks.push({ level: "error", code: "hermes_hello_probe_failed", message: "Hermes could not complete a request through this connection.", hint: "Check the Hermes installation, endpoint, credential, and model, then test again." });
      }
    }
    return { adapterType: ADAPTER_TYPE, status: checks.some(check => check.level === "error") ? "fail" : "pass", checks, testedAt: new Date().toISOString() };
  }

  const execEnv = buildExecEnv(config);

  // 1. CLI installed?
  const cliCheck = await checkCliInstalled(command, execEnv);
  if (cliCheck) {
    checks.push(cliCheck);
    if (cliCheck.level === "error") {
      return {
        adapterType: ADAPTER_TYPE,
        status: "fail",
        checks,
        testedAt: new Date().toISOString(),
      };
    }
  }

  // 2. CLI version
  const versionCheck = await checkCliVersion(command, execEnv);
  if (versionCheck) checks.push(versionCheck);

  // 3. Python available?
  const pythonCheck = await checkPython(config, execEnv, versionCheck?.message);
  if (pythonCheck) checks.push(pythonCheck);

  // 4. Model config
  const modelCheck = checkModel(config);
  if (modelCheck) checks.push(modelCheck);

  // 5. Detect Hermes config once for the remaining checks.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  try {
    detectedConfig = await detectModel(undefined, config);
  } catch {
    // Non-fatal
  }

  const catalog = await loadHermesCatalog(config);

  // 6. API keys (check config.env — server resolves secrets before calling us)
  const apiKeyCheck = await checkApiKeys(config, detectedConfig, catalog);
  if (apiKeyCheck) checks.push(apiKeyCheck);

  // 7. Provider/model consistency & authorization
  const providerChecks = await checkProviderConsistency(config, detectedConfig, catalog);
  checks.push(...providerChecks);

  // Determine overall status
  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarnings = checks.some((c) => c.level === "warn");

  return {
    adapterType: ADAPTER_TYPE,
    status: hasErrors ? "fail" : hasWarnings ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
