/**
 * fetch_url tool — raw HTTP fetch with content-type-aware response.
 *
 * Ported from src/chrome/src/network/network-tools.js but with two
 * adaptations for LM Studio (Node host):
 *   1. No `credentials: 'include'` — we have no browser cookie jar
 *      to forward, and silently sending nothing is more honest than
 *      sending an empty cookie header.
 *   2. URL safety guard layered on top — an LLM that decides to GET
 *      http://169.254.169.254/latest/meta-data/ would happily exfil
 *      cloud-credential blobs from the user's machine; the guard
 *      blocks file://, RFC1918, link-local, and ULA targets by
 *      default. Opt out per-call with `allowPrivate: true`.
 */

import { assertSafeUrl } from "../util/urlGuard.js";
import { htmlToText } from "../util/htmlToText.js";

const FETCH_TEXT_LIMIT = 8000;
const FETCH_JSON_LIMIT = 16000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface FetchUrlArgs {
  url: string;
  /** GET (default), POST, PUT, PATCH, DELETE, HEAD, OPTIONS. */
  method?: string;
  /** Extra headers. User-Agent is set by Node automatically. */
  headers?: Record<string, string>;
  /** Request body for non-GET methods. */
  body?: string;
  /** ms; default 30 000, cap 120 000. */
  timeout?: number;
  /**
   * Allow URLs that target RFC1918 / loopback / link-local addresses.
   * Off by default to keep the LLM out of cloud-metadata services and
   * the user's intranet. Set to true only when you actually want the
   * plugin to talk to localhost/private services.
   */
  allowPrivate?: boolean;
}

export interface FetchUrlResult {
  success: boolean;
  /** HTTP status code, when the request reached a server. */
  status?: number;
  /** Lower-cased content-type header. */
  contentType?: string;
  /** Final URL after any redirects. */
  url?: string;
  /** Document title, when the response was HTML. */
  title?: string;
  /** Extracted text (HTML/text responses) — capped at FETCH_TEXT_LIMIT. */
  text?: string;
  /** Pretty-printed JSON (when the response was application/json). */
  json?: string;
  /** Set when text/json was clipped to a limit. */
  truncated?: boolean;
  /** Pre-clip length, so the caller knows how much they didn't get. */
  originalLength?: number;
  /** For binary responses we don't inline — bytes from Content-Length. */
  sizeBytes?: number | null;
  /** Friendly note for binary responses we declined to inline. */
  note?: string;
  /** Failure case. */
  error?: string;
}

export async function fetchUrl(args: FetchUrlArgs): Promise<FetchUrlResult> {
  if (!args?.url) return { success: false, error: "url is required" };

  let parsed: URL;
  try {
    parsed = assertSafeUrl(args.url, { allowPrivate: !!args.allowPrivate });
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }

  const timeoutMs = Math.min(
    Math.max(args.timeout ?? DEFAULT_TIMEOUT_MS, 1000),
    120_000,
  );
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(parsed.toString(), {
      method: args.method || "GET",
      headers: args.headers || {},
      body: args.body,
      redirect: "follow",
      signal: controller.signal,
    });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const status = res.status;
    const finalUrl = res.url;

    // JSON: pretty-print, cap separately (JSON is denser than prose).
    if (contentType.includes("json")) {
      const text = await res.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* leave as-is if it's not valid JSON */
      }
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        json: pretty.slice(0, FETCH_JSON_LIMIT),
        truncated: pretty.length > FETCH_JSON_LIMIT,
        originalLength: pretty.length,
      };
    }

    // HTML: strip to readable text and capture <title>.
    if (contentType.includes("html") || contentType.includes("xhtml")) {
      const html = await res.text();
      const { title, text } = htmlToText(html);
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        title,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    // Plain text family: return verbatim, just trimmed to the cap.
    if (
      contentType.startsWith("text/") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("csv") ||
      contentType.includes("markdown") ||
      contentType === ""
    ) {
      const text = await res.text();
      return {
        success: true,
        status,
        contentType,
        url: finalUrl,
        text: text.slice(0, FETCH_TEXT_LIMIT),
        truncated: text.length > FETCH_TEXT_LIMIT,
        originalLength: text.length,
      };
    }

    // Binary — don't inline (would bloat the conversation with garbage).
    const len = res.headers.get("content-length");
    return {
      success: true,
      status,
      contentType,
      url: finalUrl,
      note: "Binary content not inlined. Content-Type was " +
        contentType + ".",
      sizeBytes: len ? parseInt(len, 10) : null,
    };
  } catch (e) {
    const err = e as Error;
    if (err.name === "AbortError") {
      return { success: false, error: `Fetch timed out after ${timeoutMs} ms` };
    }
    return { success: false, error: `Fetch failed: ${err.message}` };
  } finally {
    clearTimeout(t);
  }
}
