import { BaseLLMProvider } from './base.js';

// User-configurable connection-phase timeout. Read from browser.storage.local
// under `requestTimeoutMs`. Default 60s; configurable via Settings → Display
// → "LLM request timeout". Cached at module scope and live-refreshed on
// storage changes so the user can bump it without reloading the extension.
//
// Local providers (lmstudio / ollama) route through this file too — they
// have `type: 'openai'` in their config — so this single change picks them
// up. anthropic.js / llamacpp.js on Firefox don't currently set a timeout
// at all; that's a separate gap.
let _cachedTimeoutMs = 60000;
let _timeoutInitialized = false;
const TIMEOUT_FLOOR_MS = 5000;
const TIMEOUT_CEILING_MS = 600000;

async function _ensureTimeoutInitialized() {
  if (_timeoutInitialized) return;
  _timeoutInitialized = true;
  try {
    const api = (typeof browser !== 'undefined' && browser?.storage)
      ? browser
      : ((typeof chrome !== 'undefined' && chrome?.storage) ? chrome : null);
    if (!api?.storage?.local?.get) return;
    const stored = await api.storage.local.get(['requestTimeoutMs']);
    const v = stored?.requestTimeoutMs;
    if (typeof v === 'number' && v >= TIMEOUT_FLOOR_MS && v <= TIMEOUT_CEILING_MS) {
      _cachedTimeoutMs = v;
    }
    if (api.storage.onChanged?.addListener) {
      api.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.requestTimeoutMs) return;
        const next = changes.requestTimeoutMs.newValue;
        if (typeof next === 'number' && next >= TIMEOUT_FLOOR_MS && next <= TIMEOUT_CEILING_MS) {
          _cachedTimeoutMs = next;
        } else if (next == null) {
          _cachedTimeoutMs = 60000;
        }
      });
    }
  } catch { /* keep the hardcoded default */ }
}

/**
 * fetch() wrapper that aborts only the connection / time-to-headers phase.
 * Once headers arrive the timer is cleared, so streaming bodies can run as
 * long as needed. Without this, a stalled endpoint hangs the UI forever.
 */
async function fetchWithTimeout(url, options) {
  await _ensureTimeoutInitialized();
  const timeoutMs = _cachedTimeoutMs;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return res;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      throw new Error(
        `Request to ${url} timed out after ${timeoutMs}ms. ` +
        `The endpoint may be unreachable, blocked by CORS, or stalled.`
      );
    }
    throw e;
  }
}

/**
 * Provider for OpenAI-compatible APIs (ChatGPT, OpenRouter, any OpenAI-compatible endpoint).
 */
export class OpenAICompatibleProvider extends BaseLLMProvider {
  get name() {
    return this.config.providerName || 'openai';
  }

  get baseUrl() {
    return this.config.baseUrl || 'https://api.openai.com/v1';
  }

  get model() {
    return this.config.model || 'gpt-5';
  }

  get supportsTools() {
    return true;
  }

  get supportsVision() {
    if (this.config.supportsVision != null) return !!this.config.supportsVision;
    const m = (this.config.model || '').toLowerCase();
    return /gpt-4o|gpt-4\.1|gpt-4-turbo|gpt-5|claude|gemini|llava|qwen.*vl|qwen2.*vl|qwen3.*vl|pixtral|llama.*vision|gemma.*vision|gemma-?[34]/.test(m);
  }

  _headers() {
    const headers = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    // OpenRouter-specific headers
    if (this.config.providerName === 'openrouter') {
      headers['HTTP-Referer'] = this.config.siteUrl || 'https://github.com/esokullu/webbrain';
      headers['X-Title'] = 'WebBrain';
    }
    return headers;
  }

  /**
   * GPT-5 / gpt-4.1 / o1 / o3 / o4 use a different API contract:
   *   - require max_completion_tokens instead of max_tokens
   *   - reject any temperature other than the default (1)
   */
  _isNewOpenAIContract() {
    const m = (this.config.model || '').toLowerCase();
    if (this.config.providerName === 'lmstudio') return false;
    return /^(gpt-5|gpt-4\.1|o1|o3|o4)/.test(m);
  }

  _addMaxTokens(body, options) {
    const max = options.maxTokens ?? 4096;
    if (this._isNewOpenAIContract()) {
      body.max_completion_tokens = max;
    } else {
      body.max_tokens = max;
    }
  }

  _addTemperature(body, options) {
    if (this._isNewOpenAIContract()) return;
    body.temperature = options.temperature ?? 0.7;
  }

  _formatHttpError(status, body) {
    // Ollama enforces an Origin allowlist; browser extensions hit it with a
    // moz-extension:// or chrome-extension:// origin that isn't on the
    // default list, producing a 403 with an empty body.
    if (status === 403 && this.config.providerName === 'ollama') {
      return (
        (body ? body + '\n\n' : '') +
        'Ollama rejected the extension origin. Restart Ollama with OLLAMA_ORIGINS allowing extensions, e.g.:\n' +
        '  OLLAMA_ORIGINS="*" ollama serve\n' +
        '(or OLLAMA_ORIGINS="moz-extension://*,chrome-extension://*" for a tighter allowlist).'
      );
    }
    return body;
  }

  async chat(messages, options = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    if (options.extraBody && typeof options.extraBody === 'object') {
      Object.assign(body, options.extraBody);
    }

    const url = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${url} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} error ${res.status}: ${this._formatHttpError(res.status, err)}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    const message = choice?.message;

    return {
      content: message?.content || '',
      toolCalls: message?.tool_calls || null,
      usage: data.usage || null,
      raw: data,
    };
  }

  async *chatStream(messages, options = {}) {
    const body = {
      model: this.model,
      messages,
      stream: true,
    };
    this._addTemperature(body, options);
    this._addMaxTokens(body, options);

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const streamUrl = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetchWithTimeout(streamUrl, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new Error(`${this.name} network error — could not reach ${streamUrl} (${e.message}). Is the server running?`);
    }

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`${this.name} stream error ${res.status}: ${this._formatHttpError(res.status, err)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') {
          yield { type: 'done', content: '' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta;
          if (delta?.content) {
            yield { type: 'text', content: delta.content };
          }
          if (delta?.tool_calls) {
            yield { type: 'tool_call', content: delta.tool_calls };
          }
        } catch {
          // skip
        }
      }
    }
    yield { type: 'done', content: '' };
  }
}
