const urlForm = document.getElementById('urlForm');
const urlInput = document.getElementById('urlInput');

function normalizeInputUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

urlForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  const targetUrl = normalizeInputUrl(urlInput?.value || '');
  if (!targetUrl) return;
  window.location.assign(`/proxy?url=${encodeURIComponent(targetUrl)}`);
});

if (urlInput) {
  urlInput.value = 'https://yle.fi';
}
