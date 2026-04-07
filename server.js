import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const port = Number(process.env.PORT || 3000);

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store'
  });
  res.end(body);
}

function dedupeAndRank(candidates) {
  const map = new Map();
  for (const item of candidates) {
    const key = (item.text || '').trim().toLowerCase();
    if (!key) continue;
    if (!map.has(key) || map.get(key).score < item.score) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score).slice(0, 6);
}

async function googleTranslate(text, targetLang) {
  const url = new URL('https://translate.googleapis.com/translate_a/single');
  url.searchParams.set('client', 'gtx');
  url.searchParams.set('sl', 'auto');
  url.searchParams.set('tl', targetLang);
  url.searchParams.set('dt', 't');
  url.searchParams.set('dt', 'bd');
  url.searchParams.set('q', text);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Google translate failed (${response.status})`);
  const data = await response.json();

  const translated = (data[0] || []).map((chunk) => chunk[0]).join('');
  const sourceLang = data?.[2] || 'auto';
  const candidates = [];

  if (Array.isArray(data?.[1])) {
    for (const block of data[1]) {
      if (Array.isArray(block?.[1])) {
        for (const c of block[1]) {
          if (typeof c === 'string') candidates.push({ text: c, score: 0.9, source: 'google' });
        }
      }
    }
  }
  if (translated) candidates.unshift({ text: translated, score: 1, source: 'google' });

  return { translated, sourceLang, candidates };
}

function rewriteAttributeUrls(html, baseUrl, proxyOrigin) {
  const shouldSkipUrl = (value) => {
    if (!value) return true;
    const lowered = value.trim().toLowerCase();
    return (
      lowered.startsWith('#') ||
      lowered.startsWith('data:') ||
      lowered.startsWith('javascript:') ||
      lowered.startsWith('mailto:') ||
      lowered.startsWith('tel:') ||
      lowered.startsWith('blob:') ||
      lowered.startsWith('about:')
    );
  };

  const toAbsolute = (value) => {
    if (shouldSkipUrl(value)) return value;
    try {
      return new URL(value, baseUrl).toString();
    } catch {
      return value;
    }
  };

  const toProxyUrl = (value) => {
    const absolute = toAbsolute(value);
    if (absolute === value && shouldSkipUrl(value)) return value;
    return `${proxyOrigin}/proxy?url=${encodeURIComponent(absolute)}`;
  };

  const rewriteSrc = (value) => {
    if (!value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('javascript:')) {
      return value;
    }
    return toAbsolute(value);
  };

  const srcRe = /(src\s*=\s*["'])([^"']+)(["'])/gi;
  const hrefRe = /(href\s*=\s*["'])([^"']+)(["'])/gi;
  const actionRe = /(action\s*=\s*["'])([^"']+)(["'])/gi;

  return html
    .replace(srcRe, (_, p1, url, p3) => `${p1}${rewriteSrc(url)}${p3}`)
    .replace(hrefRe, (_, p1, url, p3) => `${p1}${toProxyUrl(url)}${p3}`)
    .replace(actionRe, (_, p1, url, p3) => `${p1}${toProxyUrl(url)}${p3}`);
}

function injectBase(html, baseUrl) {
  if (/<base\s/i.test(html)) {
    return html.replace(/<base\s+[^>]*>/i, `<base href="${baseUrl}">`);
  }
  return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}">`);
}

function injectWebtrOverlay(html, baseUrl) {
  const overlay = `
<style id="webtr-style">
  #webtr-panel {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    width: 360px;
    max-height: calc(100vh - 32px);
    overflow: auto;
    background: #f9fbff;
    border: 1px solid #d9dce4;
    border-radius: 12px;
    box-shadow: 0 14px 35px rgba(21, 36, 64, 0.22);
    padding: 0.85rem;
    font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    color: #111;
    line-height: 1.35;
    font-size: 14px;
  }
  #webtr-panel h2 { margin: 0; font-size: 16px; }
  #webtr-panel h3 { margin: 0; font-size: 13px; color: #273247; }
  #webtr-panel p { margin: 0.35rem 0; }
  #webtr-toggle {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    border: 0;
    border-radius: 999px;
    background: #315efb;
    color: #fff;
    padding: 0.45rem 0.7rem;
    font: 600 13px/1 Inter, system-ui, sans-serif;
    cursor: pointer;
    display: none;
  }
  #webtr-panel.webtr-collapsed { display: none; }
  #webtr-panel .webtr-row { margin-top: 0.8rem; border-top: 1px solid #dde3f1; padding-top: 0.7rem; }
  #webtr-panel .webtr-url-form { display: flex; gap: 0.35rem; margin-top: 0.65rem; }
  #webtr-panel .webtr-url-form input {
    flex: 1; min-width: 0; border: 1px solid #c9ced9; border-radius: 8px; padding: 0.45rem 0.5rem;
  }
  #webtr-panel .webtr-url-form button,
  #webtr-panel .webtr-button {
    border: 0; border-radius: 8px; background: #315efb; color: #fff; padding: 0.45rem 0.65rem; cursor: pointer;
  }
  #webtr-panel .webtr-header { display: flex; align-items: center; justify-content: space-between; gap: 0.45rem; }
  #webtr-translations { margin: 0.45rem 0 0; padding-left: 1.2rem; }
  .webtr-token-highlight { outline: 2px solid #ffce52 !important; background: rgba(255, 206, 82, 0.24) !important; }
</style>
<button id="webtr-toggle" type="button">Show webtr</button>
<aside id="webtr-panel" aria-live="polite">
  <div class="webtr-header">
    <h2>webtr</h2>
    <button class="webtr-button" id="webtr-hide" type="button">Hide</button>
  </div>
  <p>Hover words to translate in context.</p>
  <form id="webtr-url-form" class="webtr-url-form">
    <input id="webtr-url-input" type="url" placeholder="Open URL" required />
    <button type="submit">Open</button>
  </form>

  <div class="webtr-row"><h3>Word in context</h3><p id="webtr-word">—</p></div>
  <div class="webtr-row"><h3>Other translations</h3><ol id="webtr-translations"></ol></div>
  <div class="webtr-row"><h3>Providers used</h3><p id="webtr-providers">—</p></div>
</aside>
<script id="webtr-script">
(() => {
  const SOURCE_URL = ${JSON.stringify(baseUrl)};
  const panel = document.getElementById('webtr-panel');
  const toggle = document.getElementById('webtr-toggle');
  const hideButton = document.getElementById('webtr-hide');
  const urlForm = document.getElementById('webtr-url-form');
  const urlInput = document.getElementById('webtr-url-input');

  const wordText = document.getElementById('webtr-word');
  const translationsEl = document.getElementById('webtr-translations');
  const providersText = document.getElementById('webtr-providers');

  let hoverTimer = null;
  let lastPayloadKey = '';
  let currentHighlight = null;

  const normalizeInputUrl = (value) => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^https?:\\/\\//i.test(trimmed)) return trimmed;
    return 'https://' + trimmed;
  };

  const clearPanel = () => {
    wordText.textContent = '—';
    providersText.textContent = '—';
    translationsEl.innerHTML = '';
  };

  const updatePanel = (data) => {
    wordText.textContent = data.word && data.wordTranslation ? data.word + ': ' + data.wordTranslation : '—';

    translationsEl.innerHTML = '';
    if (Array.isArray(data.translations) && data.translations.length > 0) {
      for (const item of data.translations) {
        const li = document.createElement('li');
        li.textContent = item.text + ' (' + Math.round(item.score * 100) + '%, ' + item.source + ')';
        translationsEl.appendChild(li);
      }
    } else {
      const li = document.createElement('li');
      li.textContent = 'No ranked suggestions available.';
      translationsEl.appendChild(li);
    }

    const used = [];
    if (data.providersUsed?.google) used.push('Google Translate (unofficial endpoint)');
    providersText.textContent = used.join(' + ') || '—';
  };

  const removeHighlight = () => {
    if (currentHighlight) {
      currentHighlight.classList.remove('webtr-token-highlight');
      currentHighlight = null;
    }
  };

  const getHoveredWordInfo = (event) => {
    const range = document.caretRangeFromPoint
      ? document.caretRangeFromPoint(event.clientX, event.clientY)
      : document.caretPositionFromPoint
        ? (() => {
            const pos = document.caretPositionFromPoint(event.clientX, event.clientY);
            if (!pos) return null;
            const r = document.createRange();
            r.setStart(pos.offsetNode, pos.offset);
            r.collapse(true);
            return r;
          })()
        : null;

    if (!range || !range.startContainer || range.startContainer.nodeType !== Node.TEXT_NODE) {
      return null;
    }

    const node = range.startContainer;
    const text = node.textContent || '';
    if (!text.trim()) return null;

    const index = Math.max(0, Math.min(range.startOffset, text.length - 1));
    const isWordChar = (char) => /[\\p{L}\\p{N}\\-']/u.test(char);

    if (!isWordChar(text[index]) && !isWordChar(text[index - 1] || '')) {
      return null;
    }

    let start = index;
    while (start > 0 && isWordChar(text[start - 1])) start -= 1;

    let end = index;
    while (end < text.length && isWordChar(text[end])) end += 1;

    const word = text.slice(start, end).trim();
    if (!word) return null;

    const wrapper = document.createElement('span');
    wrapper.className = 'webtr-token-highlight';

    const highlightRange = document.createRange();
    highlightRange.setStart(node, start);
    highlightRange.setEnd(node, end);

    removeHighlight();

    try {
      highlightRange.surroundContents(wrapper);
      currentHighlight = wrapper;
    } catch {
      // Skip highlighting if range cannot be wrapped.
    }

    return { word };
  };

  const requestTranslation = async (word) => {
    const payloadKey = word + '||en';
    if (payloadKey === lastPayloadKey) return;
    lastPayloadKey = payloadKey;

    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ word, targetLang: 'en' })
    });

    if (!response.ok) {
      throw new Error('Translation API error (' + response.status + ')');
    }

    const data = await response.json();
    updatePanel(data);
  };

  document.addEventListener('mousemove', (event) => {
    const target = event.target;
    if (panel.contains(target) || target === toggle) return;

    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(async () => {
      const info = getHoveredWordInfo(event);
      if (!info) return;

      try {
        await requestTranslation(info.word);
      } catch (error) {
        providersText.textContent = 'Translation failed: ' + error.message;
      }
    }, 250);
  }, true);

  document.addEventListener('mouseleave', () => {
    removeHighlight();
  });

  const toProxyUrl = (value) => '/proxy?url=' + encodeURIComponent(value);

  urlForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const target = normalizeInputUrl(urlInput.value || '');
    if (!target) return;
    window.location.assign(toProxyUrl(target));
  });

  urlInput.value = SOURCE_URL;
  clearPanel();

  hideButton.addEventListener('click', () => {
    panel.classList.add('webtr-collapsed');
    toggle.style.display = 'inline-flex';
  });

  toggle.addEventListener('click', () => {
    panel.classList.remove('webtr-collapsed');
    toggle.style.display = 'none';
  });
})();
</script>`;

  if (/<\/body>/i.test(html)) {
    return html.replace(/<\/body>/i, `${overlay}</body>`);
  }
  return `${html}${overlay}`;
}

function injectNavigationGuard(html, baseUrl, proxyOrigin) {
  const script = `
<script id="webtr-nav-guard">
(() => {
  const skipSchemes = ['#', 'javascript:', 'data:', 'mailto:', 'tel:', 'blob:', 'about:'];

  const PROXY_ORIGIN = ${JSON.stringify(proxyOrigin)};

  const shouldSkip = (value) => {
    if (!value) return true;
    const lowered = String(value).trim().toLowerCase();
    return skipSchemes.some((item) => lowered.startsWith(item));
  };

  const isAlreadyProxyUrl = (value) => {
    if (!value) return false;
    try {
      const parsed = new URL(value, window.location.href);
      return parsed.origin === PROXY_ORIGIN && parsed.pathname === '/proxy' && parsed.searchParams.has('url');
    } catch {
      return false;
    }
  };

  const toProxyUrl = (value) => {
    if (shouldSkip(value)) return value;
    if (isAlreadyProxyUrl(value)) {
      return new URL(value, window.location.href).toString();
    }
    try {
      const absolute = new URL(value, ${JSON.stringify(baseUrl)}).toString();
      return PROXY_ORIGIN + '/proxy?url=' + encodeURIComponent(absolute);
    } catch {
      return value;
    }
  };

  const navigate = (value, replace = false) => {
    const next = toProxyUrl(value);
    if (!next || (next === value && shouldSkip(value))) return;
    if (replace) {
      window.location.replace(next);
      return;
    }
    window.location.assign(next);
  };

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const link = event.target?.closest?.('a[href], area[href]');
    if (!link || link.id?.startsWith('webtr-')) return;

    const href = link.getAttribute('href');
    if (shouldSkip(href)) return;

    event.preventDefault();
    navigate(href);
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.id === 'webtr-url-form') return;

    const action = form.getAttribute('action') || window.location.href;
    const method = (form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return;

    event.preventDefault();
    const data = new FormData(form);
    const actionUrl = new URL(action, ${JSON.stringify(baseUrl)});
    for (const [key, value] of data.entries()) {
      actionUrl.searchParams.append(key, String(value));
    }
    navigate(actionUrl.toString());
  }, true);

  const wrapHistory = (methodName) => {
    const original = history[methodName];
    history[methodName] = function patchedHistory(state, title, url) {
      if (typeof url === 'string' && !shouldSkip(url)) {
        return original.call(this, state, title, toProxyUrl(url));
      }
      return original.call(this, state, title, url);
    };
  };

  wrapHistory('pushState');
  wrapHistory('replaceState');
})();
</script>`;

  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${script}</head>`);
  }
  return `${script}${html}`;
}

async function handleProxy(req, res, parsedUrl) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) return send(res, 400, 'Missing ?url parameter');
  const forwardedProto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  const proxyOrigin = `${protocol}://${req.headers.host}`;

  let validated;
  try {
    validated = new URL(target);
    if (!['http:', 'https:'].includes(validated.protocol)) throw new Error('Bad protocol');
  } catch {
    return send(res, 400, 'Invalid target URL');
  }

  const method = req.method || 'GET';
  const hasBody = !['GET', 'HEAD'].includes(method);

  const bodyChunks = [];
  let bodySize = 0;
  if (hasBody) {
    for await (const chunk of req) {
      bodyChunks.push(chunk);
      bodySize += chunk.length;
      if (bodySize > 5e6) {
        return send(res, 413, 'Payload too large');
      }
    }
  }

  try {
    const upstreamHeaders = {
      'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (webtr proxy)',
      'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9'
    };

    if (hasBody && req.headers['content-type']) {
      upstreamHeaders['content-type'] = req.headers['content-type'];
    }

    const upstream = await fetch(validated, {
      method,
      headers: {
        ...upstreamHeaders
      },
      body: hasBody ? Buffer.concat(bodyChunks) : undefined,
      redirect: 'follow'
    });

    if (!upstream.ok) return send(res, upstream.status, `Upstream returned ${upstream.status}`);

    const contentType = upstream.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) {
      const arr = new Uint8Array(await upstream.arrayBuffer());
      res.writeHead(200, { 'content-type': contentType });
      res.end(arr);
      return;
    }

    const baseUrl = upstream.url || validated.toString();
    let html = await upstream.text();
    html = injectBase(html, baseUrl);
    html = rewriteAttributeUrls(html, baseUrl, proxyOrigin);
    html = injectNavigationGuard(html, baseUrl, proxyOrigin);
    html = injectWebtrOverlay(html, baseUrl);

    send(res, 200, html, 'text/html; charset=utf-8');
  } catch (error) {
    send(res, 502, `Proxy error: ${error.message}`);
  }
}

async function handleTranslate(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 1e6) req.destroy();
  });

  req.on('end', async () => {
    try {
      const { word } = JSON.parse(body || '{}');
      const targetLang = 'en';
      if (!word) return send(res, 400, JSON.stringify({ error: 'word is required' }), 'application/json');

      const wordGoogle = await googleTranslate(word, targetLang);
      const rankedTranslations = dedupeAndRank(wordGoogle.candidates);
      const wordTranslation = rankedTranslations[0]?.text || wordGoogle.translated || '';

      const response = {
        word,
        wordTranslation,
        detectedLanguage: wordGoogle.sourceLang || 'auto',
        translations: rankedTranslations.filter((item) => item.text !== wordTranslation).slice(0, 5),
        providersUsed: {
          google: true
        }
      };

      send(res, 200, JSON.stringify(response), 'application/json');
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), 'application/json');
    }
  });
}

async function serveStatic(res, reqPath) {
  const clean = reqPath === '/' ? '/index.html' : reqPath;
  const filePath = path.join(publicDir, clean);

  if (!filePath.startsWith(publicDir)) return send(res, 403, 'Forbidden');

  try {
    const content = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
          ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';

    send(res, 200, content, type);
  } catch {
    send(res, 404, 'Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host}`);

  if (parsedUrl.pathname === '/proxy' && ['GET', 'HEAD', 'POST'].includes(req.method || 'GET')) {
    return handleProxy(req, res, parsedUrl);
  }

  if (req.method === 'POST' && parsedUrl.pathname === '/api/translate') {
    return handleTranslate(req, res);
  }

  if (req.method === 'GET') {
    return serveStatic(res, parsedUrl.pathname);
  }

  return send(res, 405, 'Method not allowed');
});

server.listen(port, () => {
  console.log(`webtr running at http://localhost:${port}`);
});
