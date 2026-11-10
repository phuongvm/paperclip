// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { invalidateConfigSchemaCache } from "../schema-config-fields";
import { HermesGatewayConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderFields(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();
  const set = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "hermes_gateway",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark,
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <HermesGatewayConfigFields {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root, mark, set };
}

describe("HermesGatewayConfigFields", () => {
  const roots: Root[] = [];

  beforeEach(() => {
    invalidateConfigSchemaCache("hermes_gateway");
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("shows the gateway URL and runtime fields in edit mode", () => {
    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: { type: "secret_ref", secretId: "11111111-1111-4111-8111-111111111111", version: "latest" },
        paperclipApiUrl: "http://127.0.0.1:3100",
        sessionKeyStrategy: "issue",
      },
    });
    roots.push(result.root);

    const text = result.container.textContent ?? "";
    expect(text).toContain("API base URL");
    expect(text).toContain("API key");
    expect(text).toContain("Paperclip API URL");
    expect(text).toContain("Session key strategy");
    expect(text).toContain("Timeout seconds");
    expect(text).toContain("Event reconnect ms");
    expect(text).toContain("Dangerously allow remote HTTP");
    expect(text).toContain("Extra headers");
    expect(text).toContain("Instructions");

    const urlInput = result.container.querySelector<HTMLInputElement>('input[value="http://127.0.0.1:8642"]');
    expect(urlInput).toBeTruthy();

    const apiKeyInput = Array.from(result.container.querySelectorAll<HTMLInputElement>('input[type="password"]'))
      .find((input) => input.placeholder.includes("Stored secret"));
    expect(apiKeyInput).toBeTruthy();

    expect(result.container.querySelector('button[aria-label="Show API key"]')).toBeTruthy();
  });

  function makeGatewaySchema(overrides?: {
    defaultProvider?: string;
    defaultModel?: string;
    allowedProviders?: string[];
    providerModels?: Record<string, string[]>;
    providerLabels?: Record<string, string>;
  }): AdapterConfigSchema {
    const allowedProviders = overrides?.allowedProviders ?? [
      "ai-router",
      "headroom-proxy",
    ];
    const providerLabels = overrides?.providerLabels ?? {
      "ai-router": "9Router Proxy",
      "headroom-proxy": "Headroom Proxy",
    };
    const providerModels = overrides?.providerModels ?? {
      "ai-router": ["cb-gemini-flash-high", "cc/claude-sonnet-5"],
      "headroom-proxy": ["cb-gemini-flash-high", "cb-opus-4.6-thinking"],
    };
    const defaultProvider = overrides?.defaultProvider ?? "ai-router";
    const defaultModel = overrides?.defaultModel ?? "cb-gemini-flash-high";

    return {
      fields: [
        { key: "profile", label: "Profile", type: "text" },
        {
          key: "provider",
          label: "Provider",
          type: "select",
          default: "auto",
          options: [
            { value: "auto", label: "Auto" },
            ...allowedProviders.map((slug) => ({
              value: slug,
              label: `${providerLabels[slug] ?? slug} (${slug})`,
            })),
          ],
        },
        {
          key: "model",
          label: "Model",
          type: "combobox",
          meta: {
            providerModels,
            providerLabels,
            allowedProviders,
            defaultProvider,
            defaultModel,
          },
        },
      ],
    };
  }

  async function flushAsync() {
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  }

  it("renders profile, provider, and model from useConfigSchema('hermes_gateway'), shows resolved default on auto, and never renders/logs secret apiKey", async () => {
    const schema = makeGatewaySchema();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const consoleLogSpy = vi.spyOn(console, "log");

    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        apiKey: { type: "secret_ref", secretId: "sec-secret-999", version: 1 },
        profile: "coder",
        provider: "ai-router",
        model: "cb-gemini-flash-high",
      },
    });
    roots.push(result.root);
    await flushAsync();

    const providerSelect = result.container.querySelector<HTMLSelectElement>(
      'select[data-testid="hermes-gateway-provider"]',
    );
    expect(providerSelect).not.toBeNull();
    expect(Array.from(providerSelect!.options).map((o) => o.value)).toEqual([
      "auto",
      "ai-router",
      "headroom-proxy",
    ]);
    expect(providerSelect!.options[0]?.textContent).toContain("ai-router");
    expect(providerSelect!.options[0]?.disabled).toBe(false);

    const profileInput = result.container.querySelector<HTMLInputElement>(
      'input[data-testid="hermes-gateway-profile"]',
    );
    expect(profileInput).not.toBeNull();
    expect(profileInput!.value).toBe("coder");

    const modelInput = result.container.querySelector<HTMLInputElement>(
      'input[data-testid="hermes-gateway-model"]',
    );
    expect(modelInput).not.toBeNull();
    expect(modelInput!.value).toBe("cb-gemini-flash-high");

    expect(result.container.innerHTML).not.toContain("sec-secret-999");
    expect(consoleLogSpy).not.toHaveBeenCalled();
  });

  it("disables the auto option and shows 'host default not permitted' when defaultProvider is outside allowedProviders", async () => {
    const schema = makeGatewaySchema({
      defaultProvider: "anthropic",
      allowedProviders: ["ai-router", "headroom-proxy"],
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        provider: "ai-router",
        model: "cb-gemini-flash-high",
      },
    });
    roots.push(result.root);
    await flushAsync();

    const providerSelect = result.container.querySelector<HTMLSelectElement>(
      'select[data-testid="hermes-gateway-provider"]',
    );
    expect(providerSelect).not.toBeNull();
    const autoOpt = providerSelect!.options[0]!;
    expect(autoOpt.value).toBe("auto");
    expect(autoOpt.disabled).toBe(true);
    expect(autoOpt.textContent?.toLowerCase()).toContain("anthropic");
    expect(result.container.textContent?.toLowerCase()).toContain(
      "host default not permitted",
    );
  });

  it("keeps model when present in new provider's raw catalog, clears with notice when absent, and persists free text verbatim", async () => {
    const schema = makeGatewaySchema();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    let stateConfig: Record<string, unknown> = {
      apiBaseUrl: "http://127.0.0.1:8642",
      provider: "headroom-proxy",
      model: "cb-gemini-flash-high",
    };

    const result = renderFields({
      config: stateConfig,
      eff: (_g, f, orig) => (stateConfig[f] ?? orig) as never,
    });
    result.mark.mockImplementation((_g: string, f: string, v: unknown) => {
      stateConfig = { ...stateConfig, [f]: v };
    });
    roots.push(result.root);
    await flushAsync();

    const providerSelect = result.container.querySelector<HTMLSelectElement>(
      'select[data-testid="hermes-gateway-provider"]',
    )!;

    // 1. Switch headroom-proxy -> ai-router where cb-gemini-flash-high is in both -> kept!
    await act(async () => {
      providerSelect.value = "ai-router";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith("adapterConfig", "provider", "ai-router");
    expect(stateConfig.model).toBe("cb-gemini-flash-high");

    // 2. Switch with a model only in ai-router ('cc/claude-sonnet-5') to headroom-proxy -> cleared with notice
    stateConfig = {
      ...stateConfig,
      provider: "ai-router",
      model: "cc/claude-sonnet-5",
    };
    act(() => {
      result.root.render(
        <TooltipProvider>
          <HermesGatewayConfigFields
            mode="edit"
            isCreate={false}
            adapterType="hermes_gateway"
            values={null}
            set={null}
            config={stateConfig}
            eff={(_g, f, orig) => (stateConfig[f] ?? orig) as never}
            mark={result.mark}
            models={[]}
          />
        </TooltipProvider>,
      );
    });
    await flushAsync();

    const providerSelect2 = result.container.querySelector<HTMLSelectElement>(
      'select[data-testid="hermes-gateway-provider"]',
    )!;
    await act(async () => {
      providerSelect2.value = "headroom-proxy";
      providerSelect2.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith(
      "adapterConfig",
      "provider",
      "headroom-proxy",
    );
    expect(result.mark).toHaveBeenCalledWith("adapterConfig", "model", "");
    expect(result.container.textContent?.toLowerCase()).toContain("cleared");

    // 3. Free text model persisted verbatim (never split on '/')
    const modelInput = result.container.querySelector<HTMLInputElement>(
      'input[data-testid="hermes-gateway-model"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(modelInput, "custom-org/my-raw-model");
      modelInput.dispatchEvent(new Event("input", { bubbles: true }));
      modelInput.dispatchEvent(new Event("change", { bubbles: true }));
      modelInput.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });
    expect(result.mark).toHaveBeenCalledWith(
      "adapterConfig",
      "model",
      "custom-org/my-raw-model",
    );
  });

  it("displays client-side profile grammar validation hint when profile is invalid", async () => {
    const schema = makeGatewaySchema();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(schema), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = renderFields({
      config: {
        apiBaseUrl: "http://127.0.0.1:8642",
        profile: "../bad-profile",
      },
    });
    roots.push(result.root);
    await flushAsync();

    expect(result.container.textContent).toMatch(/invalid profile/i);
  });

  it("Tier 2 edit mode fetches /api/adapters/hermes_gateway/config-schema?companyId=<cid>&agentId=<id> and replaces Tier 1 schema (remote-router appears, tier1-only disappears)", async () => {
    const tier1Schema = makeGatewaySchema({
      defaultProvider: "router-a",
      allowedProviders: ["router-a", "tier1-only"],
      providerLabels: {
        "router-a": "Shared",
        "tier1-only": "Tier 1 Only",
      },
      providerModels: {
        "router-a": ["m"],
        "tier1-only": ["t1"],
      },
    });

    const tier2Schema = makeGatewaySchema({
      defaultProvider: "router-a",
      allowedProviders: ["router-a", "router-b", "remote-router"],
      providerLabels: {
        "router-a": "Shared",
        "router-b": "Shared",
        "remote-router": "Remote",
      },
      providerModels: {
        "router-a": ["m"],
        "router-b": ["m"],
        "remote-router": ["r1"],
      },
    });

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("companyId=company-1") && url.includes("agentId=agent-42")) {
          return new Response(JSON.stringify(tier2Schema), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(tier1Schema), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      });

    const result = renderFields({
      mode: "edit",
      isCreate: false,
      companyId: "company-1",
      agentId: "agent-42",
      config: {
        apiBaseUrl: "https://remote-gw.example",
        provider: "remote-router",
        model: "r1",
      },
    });
    roots.push(result.root);
    await flushAsync();

    expect(
      fetchSpy.mock.calls.some(([input]) =>
        String(input).includes(
          "/api/adapters/hermes_gateway/config-schema?companyId=company-1&agentId=agent-42",
        ),
      ),
    ).toBe(true);

    const providerSelect = result.container.querySelector<HTMLSelectElement>(
      'select[data-testid="hermes-gateway-provider"]',
    )!;
    const optionValues = Array.from(providerSelect.options).map((o) => o.value);
    const optionLabels = Array.from(providerSelect.options).map(
      (o) => o.textContent,
    );

    expect(optionValues).toEqual([
      "auto",
      "router-a",
      "router-b",
      "remote-router",
    ]);
    expect(optionValues).not.toContain("tier1-only");
    expect(optionLabels).toContain("Shared (router-a)");
    expect(optionLabels).toContain("Shared (router-b)");
    expect(optionLabels).toContain("Remote (remote-router)");
  });
});
