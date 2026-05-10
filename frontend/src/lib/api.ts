/**
 * API client for the Ferrocrete backend.
 *
 * Usage:
 *   import { api } from "@/lib/api";
 *   const projects = await api.get<Project[]>("/projects");
 *   const newProject = await api.post<Project>("/projects", { name, project_no });
 *
 * Auth: automatically attaches the Supabase access token from the current session.
 * Errors: throws ApiError with .status and .detail on non-2xx responses.
 */

import { createClient } from "@/lib/supabase/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL;
if (!API_URL && typeof window !== "undefined") {
  console.error("NEXT_PUBLIC_API_URL is not set");
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public detail: string,
    public body?: unknown
  ) {
    super(detail);
    this.name = "ApiError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface RequestOptions {
  signal?: AbortSignal;
  /** Send body as multipart/form-data instead of JSON. Used for file uploads. */
  formData?: FormData;
}

async function getAccessToken(): Promise<string | null> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session?.access_token ?? null;
}

async function request<T = unknown>(
  method: Method,
  path: string,
  body?: unknown,
  options: RequestOptions = {}
): Promise<T> {
  if (!API_URL) {
    throw new ApiError(0, "API URL not configured");
  }

  const url = `${API_URL}${path}`;
  const token = await getAccessToken();

  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let payload: BodyInit | undefined;
  if (options.formData) {
    payload = options.formData; // browser sets multipart boundary header
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: options.signal,
  });

  // 204 No Content
  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let parsed: unknown = undefined;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    const detail =
      (parsed as { detail?: string } | undefined)?.detail ??
      (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
    throw new ApiError(res.status, detail, parsed);
  }

  return parsed as T;
}

export const api = {
  get<T = unknown>(path: string, opts?: RequestOptions) {
    return request<T>("GET", path, undefined, opts);
  },
  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>("POST", path, body, opts);
  },
  patch<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>("PATCH", path, body, opts);
  },
  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return request<T>("PUT", path, body, opts);
  },
  delete<T = unknown>(path: string, opts?: RequestOptions) {
    return request<T>("DELETE", path, undefined, opts);
  },
};
