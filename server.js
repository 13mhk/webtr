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

function normalizeWord(raw) {
  return raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
}

function guessRoot(word) {
  const w = normalizeWord(word);
  if (!w) return '';
  const suffixes = ['ing', 'ed', 'es', 's', 'mente', 'tion', 'ions'];
  for (const suffix of suffixes) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      return w.slice(0, -suffix.length);
    }
  }
  return w;
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

function normalizeLangCode(language) {
  if (!language) return '';
  const lowered = String(language).toLowerCase();
  if (lowered.startsWith('zh')) return 'zh';
  return lowered.split('-')[0];
}

async function myMemoryTranslate(text, sourceLang, targetLang) {
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${sourceLang}|${targetLang}`);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`MyMemory failed (${response.status})`);
  const data = await response.json();

  const translated = data?.responseData?.translatedText || '';
  const candidates = [];
  if (translated) {
    candidates.push({ text: translated, score: Number(data?.responseData?.match || 0.7), source: 'mymemory' });
  }
  if (Array.isArray(data?.matches)) {
    for (const match of data.matches.slice(0, 4)) {
      if (match?.translation) {
        candidates.push({ text: match.translation, score: Number(match.match || 0.5), source: 'mymemory' });
      }
    }
  }

  return { translated, sourceLang: 'auto', candidates };
}

function stripAdsAndScripts(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, '')
    .replace(/<iframe[^>]+(?:ads|doubleclick|googlesyndication)[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<[^>]+(?:id|class)=["'][^"']*(?:advert|ad-|ad_)[^"']*["'][^>]*>[\s\S]*?<\/[^>]+>/gi, '');
}

function rewriteAttributeUrls(html, baseUrl) {
  const rewrite = (value, isLink) => {
    if (!value || value.startsWith('#') || value.startsWith('data:') || value.startsWith('javascript:')) {
      return value;
    }
    try {
      const abs = new URL(value, baseUrl).toString();
      return isLink ? `/proxy?url=${encodeURIComponent(abs)}` : abs;
    } catch {
      return value;
    }
  };

  const hrefRe = /(href\s*=\s*["'])([^"']+)(["'])/gi;
  const srcRe = /(src\s*=\s*["'])([^"']+)(["'])/gi;

  let out = html.replace(hrefRe, (_, p1, url, p3) => `${p1}${rewrite(url, true)}${p3}`);
  out = out.replace(srcRe, (_, p1, url, p3) => `${p1}${rewrite(url, false)}${p3}`);
  return out;
}

function injectBase(html, baseUrl) {
  if (/<base\s/i.test(html)) {
    return html.replace(/<base\s+[^>]*>/i, `<base href="${baseUrl}">`);
  }
  return html.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}">`);
}

async function handleProxy(req, res, parsedUrl) {
  const target = parsedUrl.searchParams.get('url');
  if (!target) return send(res, 400, 'Missing ?url parameter');

  let validated;
  try {
    validated = new URL(target);
    if (!['http:', 'https:'].includes(validated.protocol)) throw new Error('Bad protocol');
  } catch {
    return send(res, 400, 'Invalid target URL');
  }

  try {
    const upstream = await fetch(validated, {
      headers: {
        'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 (webtr proxy)',
        'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9'
      },
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
    html = stripAdsAndScripts(html);
    html = injectBase(html, baseUrl);
    html = rewriteAttributeUrls(html, baseUrl);

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
      const { word, sentence } = JSON.parse(body || '{}');
      const targetLang = 'en';
      if (!word || !sentence) return send(res, 400, JSON.stringify({ error: 'word and sentence are required' }), 'application/json');

      const [wordGoogle, sentenceGoogle] = await Promise.allSettled([
        googleTranslate(word, targetLang),
        googleTranslate(sentence, targetLang)
      ]);

      const allCandidates = [];
      let detectedLanguage = 'auto';
      let wordMemory = { status: 'rejected' };

      if (wordGoogle.status === 'fulfilled') {
        allCandidates.push(...wordGoogle.value.candidates);
        detectedLanguage = wordGoogle.value.sourceLang || detectedLanguage;

        const myMemorySourceLang = normalizeLangCode(detectedLanguage);
        const allowedMyMemorySources = new Set(['fi', 'sv', 'nl', 'it']);
        if (allowedMyMemorySources.has(myMemorySourceLang)) {
          try {
            const value = await myMemoryTranslate(word, myMemorySourceLang, targetLang);
            wordMemory = { status: 'fulfilled', value };
          } catch {
            wordMemory = { status: 'rejected' };
          }
        }
      }
      if (wordMemory.status === 'fulfilled') {
        allCandidates.push(...wordMemory.value.candidates);
      }

      const response = {
        word,
        root: guessRoot(word),
        detectedLanguage,
        translations: dedupeAndRank(allCandidates),
        sentence,
        sentenceTranslation: sentenceGoogle.status === 'fulfilled' ? sentenceGoogle.value.translated : '',
        providersUsed: {
          google: wordGoogle.status === 'fulfilled' || sentenceGoogle.status === 'fulfilled',
          mymemory: wordMemory.status === 'fulfilled'
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

  if (req.method === 'GET' && parsedUrl.pathname === '/proxy') {
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
