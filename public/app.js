const urlForm = document.getElementById('urlForm');
const urlInput = document.getElementById('urlInput');
const targetLangSelect = document.getElementById('targetLang');
const readerFrame = document.getElementById('readerFrame');

const wordText = document.getElementById('wordText');
const rootText = document.getElementById('rootText');
const translationsEl = document.getElementById('translations');
const sentenceText = document.getElementById('sentenceText');
const sentenceTranslationText = document.getElementById('sentenceTranslationText');
const providersText = document.getElementById('providers');

let hoverTimer = null;
let lastPayloadKey = '';
let currentHighlight = null;

function normalizeInputUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function setFrameUrl(targetUrl) {
  readerFrame.src = `/proxy?url=${encodeURIComponent(targetUrl)}`;
}

function clearPanel() {
  wordText.textContent = '—';
  rootText.textContent = '—';
  translationsEl.innerHTML = '';
  sentenceText.textContent = '—';
  sentenceTranslationText.textContent = '—';
  providersText.textContent = '—';
}

function updatePanel(data) {
  wordText.textContent = data.word || '—';
  rootText.textContent = data.root || '—';
  sentenceText.textContent = data.sentence || '—';
  sentenceTranslationText.textContent = data.sentenceTranslation || '—';

  translationsEl.innerHTML = '';
  if (Array.isArray(data.translations) && data.translations.length > 0) {
    for (const item of data.translations) {
      const li = document.createElement('li');
      li.textContent = `${item.text} (${Math.round(item.score * 100)}%, ${item.source})`;
      translationsEl.appendChild(li);
    }
  } else {
    const li = document.createElement('li');
    li.textContent = 'No ranked suggestions available.';
    translationsEl.appendChild(li);
  }

  const used = [];
  if (data.providersUsed?.google) used.push('Google Translate (unofficial endpoint)');
  if (data.providersUsed?.mymemory) used.push('MyMemory');
  providersText.textContent = used.join(' + ') || '—';
}

function removeHighlight() {
  if (currentHighlight) {
    currentHighlight.classList.remove('token-highlight');
    currentHighlight = null;
  }
}

function getSentenceAround(container, offset) {
  const text = container.textContent || '';
  const endMarks = /[.!?。！？]/;

  let start = offset;
  while (start > 0 && !endMarks.test(text[start - 1])) start -= 1;

  let end = offset;
  while (end < text.length && !endMarks.test(text[end])) end += 1;
  if (end < text.length) end += 1;

  return text.slice(start, end).trim();
}

function getHoveredWordInfo(doc, event) {
  const range = doc.caretRangeFromPoint
    ? doc.caretRangeFromPoint(event.clientX, event.clientY)
    : doc.caretPositionFromPoint
      ? (() => {
          const pos = doc.caretPositionFromPoint(event.clientX, event.clientY);
          if (!pos) return null;
          const r = doc.createRange();
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

  const isWordChar = (char) => /[\p{L}\p{N}\-']/u.test(char);

  if (!isWordChar(text[index]) && !isWordChar(text[index - 1] || '')) {
    return null;
  }

  let start = index;
  while (start > 0 && isWordChar(text[start - 1])) start -= 1;

  let end = index;
  while (end < text.length && isWordChar(text[end])) end += 1;

  const word = text.slice(start, end).trim();
  if (!word) return null;

  const wrapper = doc.createElement('span');
  wrapper.className = 'token-highlight';

  const highlightRange = doc.createRange();
  highlightRange.setStart(node, start);
  highlightRange.setEnd(node, end);

  removeHighlight();

  try {
    highlightRange.surroundContents(wrapper);
    currentHighlight = wrapper;
  } catch {
    // If range is not suitable for surroundContents.
  }

  const sentence = getSentenceAround(node, start);
  return { word, sentence: sentence || text.trim().slice(0, 220) };
}

async function requestTranslation(word, sentence) {
  const payloadKey = `${word}||${sentence}||${targetLangSelect.value}`;
  if (payloadKey === lastPayloadKey) return;
  lastPayloadKey = payloadKey;

  const response = await fetch('/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ word, sentence, targetLang: targetLangSelect.value })
  });

  if (!response.ok) {
    throw new Error(`Translation API error (${response.status})`);
  }

  const data = await response.json();
  updatePanel(data);
}

function attachHoverLogic() {
  const doc = readerFrame.contentDocument;
  if (!doc) return;

  doc.addEventListener('mousemove', (event) => {
    if (hoverTimer) clearTimeout(hoverTimer);

    hoverTimer = setTimeout(async () => {
      const info = getHoveredWordInfo(doc, event);
      if (!info) return;

      try {
        await requestTranslation(info.word, info.sentence);
      } catch (err) {
        providersText.textContent = `Translation failed: ${err.message}`;
      }
    }, 250);
  });

  doc.addEventListener('mouseleave', () => {
    removeHighlight();
  });
}

urlForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const targetUrl = normalizeInputUrl(urlInput.value);
  if (!targetUrl) return;
  clearPanel();
  setFrameUrl(targetUrl);
});

readerFrame.addEventListener('load', () => {
  lastPayloadKey = '';
  removeHighlight();
  attachHoverLogic();
});

setFrameUrl('https://www.bbc.com/mundo');
urlInput.value = 'https://www.bbc.com/mundo';
