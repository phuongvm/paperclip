import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_HERMES_DASHBOARD_PORT = "9119";
const HERMES_DASHBOARD_API_PATHS = new Set(["", "/", "/chat"]);
export const GATEWAY_PROFILE_GRAMMAR = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type GatewayTargetErrorCode =
  | "hermes_gateway_url_invalid"
  | "hermes_gateway_profile_invalid"
  | "hermes_gateway_profile_conflict";

export type GatewayTargetResolution =
  | {
      ok: true;
      root: URL;
      normalizedRoot: string;
      profile?: string;
      mappedDefaultDashboardRoot: boolean;
      url(path: string): string;
    }
  | {
      ok: false;
      errorCode: GatewayTargetErrorCode;
      message: string;
    };

export function isValidGatewayProfile(profile: string): boolean {
  return typeof profile === "string" && GATEWAY_PROFILE_GRAMMAR.test(profile);
}

function isDefaultDashboardApiEntry(url: URL): boolean {
  const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
  return (
    url.port === DEFAULT_HERMES_DASHBOARD_PORT &&
    HERMES_DASHBOARD_API_PATHS.has(normalizedPath)
  );
}

export function resolveGatewayTarget(
  config: Record<string, unknown>,
): GatewayTargetResolution {
  const apiBaseUrlValue = asString(config.apiBaseUrl ?? config.url, "").trim();
  if (!apiBaseUrlValue) {
    return {
      ok: false,
      errorCode: "hermes_gateway_url_invalid",
      message: "Hermes gateway adapter requires apiBaseUrl.",
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(apiBaseUrlValue);
  } catch {
    return {
      ok: false,
      errorCode: "hermes_gateway_url_invalid",
      message: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      errorCode: "hermes_gateway_url_invalid",
      message: `Invalid Hermes gateway apiBaseUrl: ${apiBaseUrlValue}`,
    };
  }

  const mappedDefaultDashboardRoot = isDefaultDashboardApiEntry(parsedUrl);
  let path = mappedDefaultDashboardRoot
    ? "/api"
    : parsedUrl.pathname.replace(/\/+$/, "");

  // Check explicit config.profile (first-class field takes precedence over payloadTemplate)
  let configProfile: string | undefined;
  if (config.profile !== undefined && config.profile !== null) {
    if (typeof config.profile !== "string") {
      return {
        ok: false,
        errorCode: "hermes_gateway_profile_invalid",
        message: "Invalid Hermes gateway profile.",
      };
    }
    const rawProfile = config.profile;
    const trimmedProfile = rawProfile.trim();
    if (
      rawProfile !== trimmedProfile ||
      !isValidGatewayProfile(trimmedProfile)
    ) {
      return {
        ok: false,
        errorCode: "hermes_gateway_profile_invalid",
        message: `Invalid Hermes gateway profile: ${rawProfile}`,
      };
    }
    configProfile = trimmedProfile;
  } else {
    const payloadTemplate = parseObject(config.payloadTemplate);
    if (
      typeof payloadTemplate.profile === "string" &&
      payloadTemplate.profile.trim().length > 0
    ) {
      const tplProfile = payloadTemplate.profile.trim();
      if (isValidGatewayProfile(tplProfile)) {
        configProfile = tplProfile;
      }
    }
  }

  // Check if path contains a /p/{x} suffix
  let rootPath = path;
  let effectiveProfile = configProfile;

  const pSegmentIdx = path.indexOf("/p/");
  if (pSegmentIdx >= 0) {
    const prefix = path.slice(0, pSegmentIdx);
    const urlProfilePart = path.slice(pSegmentIdx + 3);
    if (!isValidGatewayProfile(urlProfilePart)) {
      return {
        ok: false,
        errorCode: "hermes_gateway_profile_invalid",
        message: `Invalid Hermes gateway profile in apiBaseUrl: ${urlProfilePart}`,
      };
    }
    if (configProfile !== undefined && configProfile !== urlProfilePart) {
      return {
        ok: false,
        errorCode: "hermes_gateway_profile_conflict",
        message: `Hermes gateway profile conflict: apiBaseUrl specifies '/p/${urlProfilePart}' but profile field is '${configProfile}'.`,
      };
    }
    rootPath = prefix;
    effectiveProfile = urlProfilePart;
  }

  const rootUrl = new URL(parsedUrl.origin);
  rootUrl.pathname = rootPath || "/";
  rootUrl.search = "";
  rootUrl.hash = "";

  const normalizedRoot = `${rootUrl.origin}${rootPath}`;

  return {
    ok: true,
    root: rootUrl,
    normalizedRoot,
    ...(effectiveProfile ? { profile: effectiveProfile } : {}),
    mappedDefaultDashboardRoot,
    url(subPath: string): string {
      const suffix = subPath.startsWith("/") ? subPath : `/${subPath}`;
      const profilePrefix = effectiveProfile
        ? `/p/${encodeURIComponent(effectiveProfile)}`
        : "";
      return `${normalizedRoot}${profilePrefix}${suffix}`;
    },
  };
}
