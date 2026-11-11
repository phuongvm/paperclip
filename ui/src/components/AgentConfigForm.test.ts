import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import {
  composeHermesOptionId,
  resolveHermesModelDropdownChange,
  resolvePaperclipRunnerTransitionModel,
  selectionFromOption,
  shouldGroupModelsByProvider,
  supportsAdapterModelRefresh,
} from "./AgentConfigForm";
import { resolveForcedKubernetesEnvironment } from "../lib/forced-kubernetes-environment";

describe("supportsAdapterModelRefresh", () => {
  it("enables the model refresh action for Claude and Codex adapters", () => {
    expect(supportsAdapterModelRefresh("claude_local")).toBe(true);
    expect(supportsAdapterModelRefresh("codex_local")).toBe(true);
    expect(supportsAdapterModelRefresh("acpx_local")).toBe(false);
  });

  it("keeps the refresh action hidden for adapters without a live refresh hook", () => {
    expect(supportsAdapterModelRefresh("opencode_local")).toBe(true);
    expect(supportsAdapterModelRefresh("paperclip_runner")).toBe(true);
    expect(supportsAdapterModelRefresh("hermes_local")).toBe(true);
    expect(supportsAdapterModelRefresh("hermes_gateway")).toBe(false);
    expect(supportsAdapterModelRefresh("process")).toBe(false);
  });
});

describe("hermes_local UI parity (groupByProvider, selectionFromOption, composeHermesOptionId)", () => {
  const sampleModels = [
    {
      id: "ai-router/cb-gemini-flash-high",
      label: "cb-gemini-flash-high",
      providerId: "ai-router",
      providerLabel: "9Router Proxy",
      rawModelId: "cb-gemini-flash-high",
      isUserDefined: true,
    },
    {
      id: "ai-router/cc/claude-sonnet-5",
      label: "cc/claude-sonnet-5",
      providerId: "ai-router",
      providerLabel: "9Router Proxy",
      rawModelId: "cc/claude-sonnet-5",
      isUserDefined: true,
    },
    {
      id: "ai-router/ai-router/native",
      label: "ai-router/native",
      providerId: "ai-router",
      providerLabel: "9Router Proxy",
      rawModelId: "ai-router/native",
      isUserDefined: true,
    },
    {
      id: "headroom-proxy/cb-opus-4.6-thinking",
      label: "cb-opus-4.6-thinking",
      providerId: "headroom-proxy",
      providerLabel: "Headroom Proxy",
      rawModelId: "cb-opus-4.6-thinking",
      isUserDefined: true,
    },
  ];

  it("enables groupByProvider for hermes_local and keeps hermes_gateway false", () => {
    expect(shouldGroupModelsByProvider("hermes_local", false)).toBe(true);
    expect(shouldGroupModelsByProvider("hermes_local", true)).toBe(false);
    expect(shouldGroupModelsByProvider("hermes_gateway", false)).toBe(false);
  });

  it("decodes option by id via selectionFromOption without splitting on '/' and keeps free text verbatim", () => {
    expect(
      selectionFromOption(sampleModels[1]!),
    ).toEqual({
      provider: "ai-router",
      model: "cc/claude-sonnet-5",
    });

    expect(
      resolveHermesModelDropdownChange(
        "ai-router/ai-router/native",
        sampleModels,
        "headroom-proxy",
      ),
    ).toEqual({
      provider: "ai-router",
      model: "ai-router/native",
      matchedOption: true,
    });

    // Free text with a slash is never split when no option id matches
    expect(
      resolveHermesModelDropdownChange(
        "anthropic/claude-sonnet-4",
        sampleModels,
        "ai-router",
      ),
    ).toEqual({
      provider: "ai-router",
      model: "anthropic/claude-sonnet-4",
      matchedOption: false,
    });
  });

  it("composes display option id from normalized {provider, model} and falls back to raw model for custom free text", () => {
    expect(
      composeHermesOptionId(
        { provider: "ai-router", model: "cc/claude-sonnet-5" },
        sampleModels,
      ),
    ).toBe("ai-router/cc/claude-sonnet-5");

    expect(
      composeHermesOptionId(
        { provider: "auto", model: "cb-opus-4.6-thinking" },
        sampleModels,
      ),
    ).toBe("headroom-proxy/cb-opus-4.6-thinking");

    expect(
      composeHermesOptionId(
        { provider: "ai-router", model: "my-experimental-model" },
        sampleModels,
      ),
    ).toBe("my-experimental-model");
  });
});

describe("resolvePaperclipRunnerTransitionModel", () => {
  it("preserves Claude custom model IDs", () => {
    expect(resolvePaperclipRunnerTransitionModel("claude_local", "custom-claude-model")).toBe("custom-claude-model");
  });
  it("preserves an explicit model from codex_local", () => {
    expect(resolvePaperclipRunnerTransitionModel("codex_local", "gpt-5.5"))
      .toBe("gpt-5.5");
  });

  it("uses the current Codex default when the source model is blank", () => {
    expect(resolvePaperclipRunnerTransitionModel("codex_local", ""))
      .toBe("gpt-6.1-sol");
  });
});

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Env",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const localEnv = makeEnvironment({ id: "local-1", name: "Local", driver: "local" });
const k8sEnv = makeEnvironment({
  id: "k8s-1",
  name: "Managed K8s",
  driver: "sandbox",
  config: { provider: "kubernetes" },
});

describe("resolveForcedKubernetesEnvironment", () => {
  it("does not force when executionMode is 'any' (full picker / unchanged)", () => {
    const result = resolveForcedKubernetesEnvironment("any", [localEnv, k8sEnv]);
    expect(result.forced).toBe(false);
    expect(result.kubernetesEnvironment).toBeNull();
  });

  it("does not force when executionMode is absent (self-hoster default)", () => {
    const result = resolveForcedKubernetesEnvironment(undefined, [localEnv, k8sEnv]);
    expect(result.forced).toBe(false);
    expect(result.kubernetesEnvironment).toBeNull();
  });

  it("forces and selects the Kubernetes sandbox when executionMode is 'kubernetes'", () => {
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv, k8sEnv]);
    expect(result.forced).toBe(true);
    expect(result.kubernetesEnvironment?.id).toBe("k8s-1");
  });

  it("forces but reports no environment when none is the Kubernetes sandbox", () => {
    const fakeSandbox = makeEnvironment({
      id: "fake-1",
      driver: "sandbox",
      config: { provider: "fake" },
    });
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv, fakeSandbox]);
    expect(result.forced).toBe(true);
    expect(result.kubernetesEnvironment).toBeNull();
  });
});
