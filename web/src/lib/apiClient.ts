import {
  Configuration,
  ConfigApi,
  SessionsApi,
  type RequestContext,
  type ResponseContext,
} from "./api";
import { getApiBaseUrl } from "../hooks/utils";
import { getAuthHeader } from "./auth";

/**
 * Format validation errors from FastAPI into a readable string.
 * FastAPI returns validation errors as:
 * { "detail": [{ "loc": ["body", "llm", "model"], "msg": "Field required", "type": "missing" }] }
 */
function formatValidationError(detail: unknown): string {
  if (Array.isArray(detail)) {
    return detail
      .map((err) => {
        if (err && typeof err === "object" && "msg" in err) {
          const loc = Array.isArray(err.loc) ? err.loc.slice(1).join(".") : "";
          return loc ? `${loc}: ${err.msg}` : err.msg;
        }
        return String(err);
      })
      .join("; ");
  }
  if (typeof detail === "string") {
    return detail;
  }
  return "Validation failed";
}

/**
 * Create API configuration with the current base URL.
 * Lazily evaluated to support runtime base URL changes.
 */
function createConfig(): Configuration {
  return new Configuration({
    basePath: getApiBaseUrl(),
    middleware: [
      {
        pre: async (context: RequestContext) => {
          context.init.headers = {
            ...context.init.headers,
            ...getAuthHeader(),
          };
          return context;
        },
        post: async (context: ResponseContext) => {
          if (!context.response.ok) {
            const data = await context.response.json();
            let message: string;

            if (context.response.status === 422 && data.detail) {
              // FastAPI validation error
              message = formatValidationError(data.detail);
            } else if (typeof data.detail === "string") {
              message = data.detail;
            } else if (typeof data.msg === "string") {
              message = data.msg;
            } else {
              message = "Request failed";
            }

            switch (context.response.status) {
              case 401:
                console.error("Authentication failed. Please login again.");
                break;
              case 403:
                console.error(message);
                break;
              case 404:
                console.error("The requested resource was not found.");
                break;
              default:
                console.error(message);
            }

            throw new Error(message);
          }
          return context.response;
        },
      },
    ],
  });
}

// Lazy-initialized API client that creates config on first access
let _apiClient: typeof apiClient | null = null;

export const apiClient = {
  get config() {
    return new ConfigApi(createConfig());
  },
  get sessions() {
    return new SessionsApi(createConfig());
  },
};
