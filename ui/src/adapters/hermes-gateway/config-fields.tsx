import { configFieldsForSection } from "../config-sections";
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import type { AdapterConfigFieldsProps, CreateConfigValues } from "../types";
import { useConfigSchema } from "../schema-config-fields";
import {
  DraftInput,
  DraftNumberInput,
  DraftTextarea,
  Field,
  ToggleField,
} from "../../components/agent-config-primitives";

const GATEWAY_PROFILE_GRAMMAR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

const DEFAULT_SESSION_KEY_STRATEGY = "issue";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_EVENT_RECONNECT_MS = 2000;

type SecretRef = {
  type: "secret_ref";
  secretId: string;
  version?: number | "latest";
};

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

function readCreateValue(values: CreateConfigValues | null, key: string, fallback: unknown): unknown {
  return values?.adapterSchemaValues?.[key] ?? fallback;
}

function writeCreateValue(
  values: CreateConfigValues | null,
  set: ((patch: Partial<CreateConfigValues>) => void) | null,
  key: string,
  value: unknown,
) {
  set?.({
    adapterSchemaValues: {
      ...values?.adapterSchemaValues,
      [key]: value,
    },
  });
}

function stringifyHeaders(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  return "";
}

function SecretField({
  label,
  value,
  onCommit,
  placeholder,
  stored,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  stored?: boolean;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label}>
      <div className="relative">
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          aria-label={visible ? `Hide ${label}` : `Show ${label}`}
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </button>
        <DraftInput
          value={value}
          onCommit={onCommit}
          immediate
          type={visible ? "text" : "password"}
          className={inputClass + " pl-8"}
          placeholder={stored ? "Stored secret; enter a new value to replace it" : placeholder}
        />
      </div>
    </Field>
  );
}

export function HermesGatewayConfigFields({
  section,
  isCreate,
  values,
  set,
  config,
  eff,
  mark,
}: AdapterConfigFieldsProps) {
  const storedApiKey = config.apiKey;
  const hasStoredApiKey = isSecretRef(storedApiKey) || typeof storedApiKey === "string";
  const editApiKeyValue = typeof storedApiKey === "string" ? String(eff("adapterConfig", "apiKey", storedApiKey)) : "";

  const configuredHeaders = stringifyHeaders(config.headers);
  const editHeaders = eff("adapterConfig", "headers", configuredHeaders);
  const [headersDraft, setHeadersDraft] = useState(String(editHeaders ?? ""));

  useEffect(() => {
    if (!isCreate) setHeadersDraft(String(editHeaders ?? ""));
  }, [editHeaders, isCreate]);

  const readValue = (key: string, fallback: unknown) =>
    isCreate ? readCreateValue(values, key, fallback) : eff("adapterConfig", key, (config[key] ?? fallback) as never);

  const writeValue = (key: string, value: unknown) => {
    if (isCreate) {
      writeCreateValue(values, set, key, value);
    } else {
      mark("adapterConfig", key, value);
    }
  };

  const apiBaseUrl = String(readValue("apiBaseUrl", "") ?? "");
  const profile = String(readValue("profile", "") ?? "");
  const provider = String(readValue("provider", "auto") ?? "auto") || "auto";
  const model = String(readValue("model", "") ?? "");
  const paperclipApiUrl = String(readValue("paperclipApiUrl", "") ?? "");
  const sessionKeyStrategy = String(readValue("sessionKeyStrategy", DEFAULT_SESSION_KEY_STRATEGY) ?? DEFAULT_SESSION_KEY_STRATEGY);
  const timeoutSec = Number(readValue("timeoutSec", DEFAULT_TIMEOUT_SEC) ?? DEFAULT_TIMEOUT_SEC);
  const eventReconnectMs = Number(readValue("eventReconnectMs", DEFAULT_EVENT_RECONNECT_MS) ?? DEFAULT_EVENT_RECONNECT_MS);
  const allowInsecureRemoteHttp = Boolean(readValue("dangerouslyAllowInsecureRemoteHttp", false));
  const instructions = String(readValue("instructions", "") ?? "");
  const headers = isCreate
    ? String(readCreateValue(values, "headers", "") ?? "")
    : headersDraft;

  const tier1Schema = useConfigSchema("hermes_gateway");
  const effectiveSchema = tier1Schema;
  const providerField = effectiveSchema?.fields.find((f) => f.key === "provider");
  const modelField = effectiveSchema?.fields.find((f) => f.key === "model");

  const providerModels =
    (modelField?.meta?.providerModels as Record<string, string[]> | undefined) ?? {};
  const allowedProviders =
    (modelField?.meta?.allowedProviders as string[] | undefined) ?? [];
  const defaultProvider =
    typeof modelField?.meta?.defaultProvider === "string"
      ? modelField.meta.defaultProvider
      : "";

  const isDefaultAllowed =
    !defaultProvider ||
    allowedProviders.length === 0 ||
    allowedProviders.includes(defaultProvider);

  const rawProviderOptions = providerField?.options ?? [
    { value: "auto", label: "Auto" },
  ];

  const [modelClearedNotice, setModelClearedNotice] = useState<string | null>(null);
  const profileInvalid =
    profile.trim().length > 0 && !GATEWAY_PROFILE_GRAMMAR.test(profile.trim());

  const activeProviderSlug = provider === "auto" ? defaultProvider : provider;
  const candidateModels = activeProviderSlug
    ? providerModels[activeProviderSlug] ?? []
    : [];

  const handleProviderChange = (nextProvider: string) => {
    const currentModel = String(readValue("model", "") ?? "");
    let shouldClearModel = false;
    if (currentModel && nextProvider !== "auto") {
      const nextList = providerModels[nextProvider] ?? [];
      if (!nextList.includes(currentModel)) {
        shouldClearModel = true;
      }
    }

    if (shouldClearModel) {
      setModelClearedNotice(
        `Model "${currentModel}" is not in ${nextProvider}'s catalog and was cleared.`,
      );
      if (isCreate) {
        set?.({
          adapterSchemaValues: {
            ...values?.adapterSchemaValues,
            provider: nextProvider,
            model: "",
          },
        });
      } else {
        mark("adapterConfig", "provider", nextProvider);
        mark("adapterConfig", "model", "");
      }
    } else {
      setModelClearedNotice(null);
      writeValue("provider", nextProvider);
    }
  };

  return configFieldsForSection(section, (
    <>
      <Field
        label="API base URL"
        hint="Hermes API server base URL that Paperclip can reach, such as http://127.0.0.1:8642 or a private HTTPS URL. Default dashboard root/chat URLs such as http://127.0.0.1:9119/chat are accepted and map to /api."
      >
        <DraftInput
          value={apiBaseUrl}
          onCommit={(v) => writeValue("apiBaseUrl", v || undefined)}
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:8642"
        />
      </Field>

      <SecretField
        label="API key"
        value={isCreate ? String(readCreateValue(values, "apiKey", "") ?? "") : editApiKeyValue}
        onCommit={(v) => writeValue("apiKey", v || undefined)}
        placeholder="Hermes API_SERVER_KEY, not PAPERCLIP_API_KEY"
        stored={!isCreate && hasStoredApiKey && !editApiKeyValue}
      />

      <Field
        label="Profile"
        hint="Optional Hermes profile slug (^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$). Routes requests through :8642/p/{profile} or :9119/api/p/{profile}."
      >
        <div className="space-y-1">
          <input
            data-testid="hermes-gateway-profile"
            type="text"
            value={profile}
            onChange={(e) => writeValue("profile", e.target.value || undefined)}
            className={inputClass}
            placeholder="coder"
          />
          {profileInvalid && (
            <p className="text-xs text-destructive">
              Invalid profile slug. Must match ^[a-zA-Z0-9][a-zA-Z0-9_-]&#123;0,63&#125;$ (no slashes, spaces, or &quot;..&quot;).
            </p>
          )}
        </div>
      </Field>

      <Field
        label="Provider"
        hint={
          providerField?.hint ??
          "Single-gateway-per-process Tier 1 catalog. Select 'Auto' or pin an allowed provider slug."
        }
      >
        <div className="space-y-1">
          <select
            data-testid="hermes-gateway-provider"
            value={provider}
            onChange={(event) => handleProviderChange(event.target.value)}
            className={inputClass}
          >
            {rawProviderOptions.map((opt) => {
              if (opt.value === "auto") {
                const autoLabel = defaultProvider
                  ? isDefaultAllowed
                    ? `Auto (${defaultProvider})`
                    : `Auto (${defaultProvider} — host default not permitted)`
                  : opt.label;
                return (
                  <option
                    key="auto"
                    value="auto"
                    disabled={!isDefaultAllowed}
                  >
                    {autoLabel}
                  </option>
                );
              }
              return (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              );
            })}
          </select>
          {!isDefaultAllowed && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Host default not permitted ({defaultProvider}); select an allowed provider.
            </p>
          )}
        </div>
      </Field>

      <Field
        label="Model"
        hint="Raw model ID for the selected provider, or leave blank for the gateway default."
      >
        <div className="space-y-1">
          <input
            data-testid="hermes-gateway-model"
            type="text"
            list="hermes-gateway-model-options"
            value={model}
            onChange={(event) => {
              setModelClearedNotice(null);
              writeValue("model", event.target.value);
            }}
            className={inputClass}
            placeholder={
              typeof modelField?.meta?.defaultModel === "string" &&
              modelField.meta.defaultModel
                ? modelField.meta.defaultModel
                : "cb-gemini-flash-high"
            }
          />
          <datalist id="hermes-gateway-model-options">
            {candidateModels.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          {modelClearedNotice && (
            <p className="text-xs text-muted-foreground">{modelClearedNotice}</p>
          )}
        </div>
      </Field>

      <Field
        label="Paperclip API URL"
        hint="Optional Paperclip API URL reachable by the Hermes host. This is not a credential."
      >
        <DraftInput
          value={paperclipApiUrl}
          onCommit={(v) => writeValue("paperclipApiUrl", v || undefined)}
          immediate
          className={inputClass}
          placeholder="http://127.0.0.1:3100"
        />
      </Field>

      <Field configSection="runPolicy"
        label="Session key strategy"
        hint="Controls X-Hermes-Session-Key. Issue scoped prevents cross-task memory bleed by default."
      >
        <select
          value={sessionKeyStrategy}
          onChange={(event) => writeValue("sessionKeyStrategy", event.target.value)}
          className={inputClass}
        >
          <option value="issue">Issue scoped</option>
          <option value="agent">Agent scoped</option>
          <option value="run">Run scoped</option>
          <option value="none">None</option>
        </select>
      </Field>

      <Field configSection="runPolicy" label="Timeout seconds">
        <DraftNumberInput
          value={Number.isFinite(timeoutSec) ? timeoutSec : DEFAULT_TIMEOUT_SEC}
          onCommit={(v) => writeValue("timeoutSec", v)}
          immediate
          className={inputClass}
        />
      </Field>

      <Field
        label="Event reconnect ms"
        hint="Delay before reconnecting the Hermes SSE events stream after a nonterminal disconnect."
      >
        <DraftNumberInput
          value={Number.isFinite(eventReconnectMs) ? eventReconnectMs : DEFAULT_EVENT_RECONNECT_MS}
          onCommit={(v) => writeValue("eventReconnectMs", v)}
          immediate
          className={inputClass}
        />
      </Field>

      <ToggleField
        label="Dangerously allow remote HTTP"
        hint="Unsafe dev-only escape hatch. Remote Hermes gateways should use HTTPS; loopback HTTP remains allowed."
        checked={allowInsecureRemoteHttp}
        onChange={(v) => writeValue("dangerouslyAllowInsecureRemoteHttp", v)}
      />

      <Field
        label="Extra headers"
        hint="Optional JSON object of extra nonsecret headers. Security-critical headers are generated by the adapter."
      >
        <textarea
          value={headers}
          onChange={(event) => {
            const next = event.target.value;
            if (isCreate) {
              writeValue("headers", next || undefined);
            } else {
              setHeadersDraft(next);
              mark("adapterConfig", "headers", next || undefined);
            }
          }}
          rows={3}
          className={inputClass}
          placeholder='{"x-custom-header": "value"}'
        />
      </Field>

      <Field label="Instructions" hint="Optional stable Hermes instructions sent separately from the wake input.">
        <DraftTextarea
          value={instructions}
          onCommit={(v) => writeValue("instructions", v || undefined)}
          immediate
          minRows={3}
        />
      </Field>
    </>
  ));
}
