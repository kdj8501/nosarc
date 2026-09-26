const state = { series: [] };
const $ = (selector) => document.querySelector(selector);

document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const session = await request('/api/session', { allowUnauthorized: true });
  if (session?.authenticated) showApp();
  else showLogin();
  $('#login-form').addEventListener('submit', login);
  $('#logout').addEventListener('click', logout);
  $('#new-series').addEventListener('click', () => $('#series-dialog').showModal());
  $('#series-form').addEventListener('submit', createSeries);
  $('#chapter-form').addEventListener('submit', uploadChapter);
  $('#search').addEventListener('input', () => loadSeries($('#search').value));
}

async function login(event) {
  event.preventDefault();
  const result = await request('/auth/login', { method: 'POST', body: { password: $('#password').value }, allowUnauthorized: true });
  if (!result?.authenticated) { $('#login-error').textContent = result?.error || '로그인에 실패했습니다.'; return; }
  $('#password').value = '';
  $('#login-error').textContent = '';
  showApp();
}

async function logout() {
  await request('/auth/logout', { method: 'POST', allowUnauthorized: true });
  showLogin();
}

function showLogin() { $('#login').hidden = false; $('#app').hidden = true; }
function showApp() { $('#login').hidden = true; $('#app').hidden = false; loadSeries(); }

async function loadSeries(search = '') {
  const series = await request(`/api/series?search=${encodeURIComponent(search)}`);
  if (!series) return;
  state.series = series;
  $('#series-list').innerHTML = series.length ? series.map(renderSeries).join('') : '<div class="series-card"><p class="muted">아직 작품이 없습니다. 첫 작품을 추가해 보세요.</p></div>';
  document.querySelectorAll('[data-upload]').forEach((button) => button.addEventListener('click', () => openChapter(button.dataset.upload, button.dataset.title)));
}

function renderSeries(item) {
  const tags = item.tags ? item.tags.split(', ').map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '';
  return `<article class="series-card"><p class="eyebrow">${escapeHtml(item.status)}</p><h3>${escapeHtml(item.title)}</h3>${item.original_title ? `<p class="muted">${escapeHtml(item.original_title)}</p>` : ''}<div>${tags}</div><div class="series-meta"><span>${item.chapter_count}개 권</span><span>${escapeHtml(item.target_language)}</span></div><div class="card-actions"><button class="button ghost" data-upload="${item.id}" data-title="${escapeHtml(item.title)}">권 업로드</button><button class="button ghost" data-open="${item.id}">상세</button></div></article>`;
}

function openChapter(id, title) {
  $('#chapter-series-id').value = id;
  $('#chapter-dialog-title').textContent = `${title} · 권 업로드`;
  $('#chapter-dialog').showModal();
}

async function createSeries(event) {
  event.preventDefault();
  const result = await request('/api/series', { method: 'POST', body: { title: $('#series-title').value, originalTitle: $('#series-original-title').value, description: $('#series-description').value, tags: $('#series-tags').value.split(',') } });
  if (!result?.id) return;
  $('#series-dialog').close();
  event.target.reset();
  await loadSeries();
  showNotice('작품을 추가했습니다.');
}

async function uploadChapter(event) {
  event.preventDefault();
  const form = new FormData();
  form.append('numberLabel', $('#chapter-number').value);
  form.append('title', $('#chapter-title').value);
  for (const file of $('#chapter-files').files) form.append('files', file);
  const result = await request(`/api/series/${$('#chapter-series-id').value}/chapters`, { method: 'POST', form });
  if (!result?.id) return;
  $('#chapter-dialog').close();
  event.target.reset();
  await loadSeries($('#search').value);
  showNotice('업로드를 접수했습니다. 원본과 페이지를 저장했습니다.');
}

async function request(url, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.form) init.body = options.form;
  else if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
  const response = await fetch(url, init);
  if (response.status === 401 && !options.allowUnauthorized) { showLogin(); return null; }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && data?.error) showNotice(data.error, true);
  return data;
}

function showNotice(message, isError = false) { const notice = $('#notice'); notice.textContent = message; notice.style.color = isError ? '#ff9c9c' : ''; setTimeout(() => { notice.textContent = ''; }, 4500); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
