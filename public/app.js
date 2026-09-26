const state = { series: [], reader: null, detailSeriesId: null };
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
  $('#series-detail-close').addEventListener('click', () => $('#series-detail-dialog').close());
  $('#reader-close').addEventListener('click', () => $('#reader-dialog').close());
  $('#reader-original').addEventListener('click', () => setReaderMode('original'));
  $('#reader-translated').addEventListener('click', () => setReaderMode('translated'));
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
  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openSeries(button.dataset.open)));
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

async function openSeries(id) {
  const series = await request(`/api/series/${id}`);
  if (!series) return;
  state.detailSeriesId = id;
  $('#series-detail-title').textContent = series.title;
  $('#series-detail-description').textContent = series.description || '작품 설명이 없습니다.';
  $('#series-detail-tags').innerHTML = series.tags ? series.tags.split(', ').map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '';
  $('#series-detail-count').textContent = `${series.chapters.length}개`;
  $('#chapter-list').innerHTML = series.chapters.length ? series.chapters.map(renderChapter).join('') : '<p class="muted">등록된 권이 없습니다.</p>';
  $('#series-detail-dialog').showModal();
  document.querySelectorAll('[data-read]').forEach((button) => button.addEventListener('click', () => openReader(button.dataset.read)));
  document.querySelectorAll('[data-retry]').forEach((button) => button.addEventListener('click', () => retryJob(button.dataset.retry)));
  document.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => cancelJob(button.dataset.cancel)));
}

function renderChapter(chapter) {
  const readable = chapter.page_count > 0 && chapter.processing_status === 'completed';
  const statusLabels = { queued: '대기 중', preparing: '변환 중', failed: '실패', cancelled: '취소됨' };
  const status = readable ? `${chapter.page_count}페이지` : statusLabels[chapter.processing_status] || chapter.processing_status;
  const action = readable ? `<button class="button small primary" data-read="${chapter.id}">읽기</button>` : chapter.processing_status === 'failed' && chapter.job_id ? `<button class="button small primary" data-retry="${chapter.job_id}">재시도</button>` : ['queued', 'preparing'].includes(chapter.processing_status) && chapter.job_id ? `<button class="button small ghost" data-cancel="${chapter.job_id}">취소</button>` : `<button class="button small ghost" disabled>준비 중</button>`;
  return `<article class="chapter-row"><div><strong>${escapeHtml(chapter.number_label)}${chapter.title ? ` · ${escapeHtml(chapter.title)}` : ''}</strong><span class="muted">${escapeHtml(status)}</span></div>${action}</article>`;
}

async function retryJob(jobId) {
  const result = await request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
  if (!result) return;
  showNotice('작업을 다시 접수했습니다.');
  await openSeries(state.detailSeriesId);
  watchJob(jobId);
}

async function cancelJob(jobId) {
  const result = await request(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!result) return;
  showNotice('작업을 취소했습니다.');
  await openSeries(state.detailSeriesId);
}

async function openReader(id) {
  const chapter = await request(`/api/chapters/${id}`);
  if (!chapter) return;
  state.reader = { chapter, mode: 'original' };
  $('#reader-dialog').showModal();
  renderReader();
}

function setReaderMode(mode) {
  if (!state.reader) return;
  if (mode === 'translated') {
    const hasTranslation = state.reader.chapter.pages.some((page) => page.lettering_layers?.length);
    if (!hasTranslation) { showNotice('이 권에는 아직 번역 데이터가 없습니다.'); return; }
  }
  state.reader.mode = mode;
  renderReader();
}

function renderReader() {
  const { chapter, mode } = state.reader;
  const hasTranslation = chapter.pages.some((page) => page.lettering_layers?.length);
  if (mode === 'translated' && !hasTranslation) state.reader.mode = 'original';
  const activeMode = state.reader.mode;
  $('#reader-title').textContent = `${chapter.series_title} · ${chapter.number_label}${chapter.title ? ` · ${chapter.title}` : ''}`;
  $('#reader-original').classList.toggle('active', activeMode === 'original');
  $('#reader-translated').classList.toggle('active', activeMode === 'translated');
  $('#reader-translated').disabled = !hasTranslation;
  $('#reader-notice').textContent = chapter.pages.length ? activeMode === 'translated' ? '번역문과 식자 레이어를 표시하고 있습니다.' : '원본 페이지를 표시하고 있습니다.' : '아직 변환된 페이지가 없습니다.';
  $('#reader-stage').innerHTML = chapter.pages.length ? chapter.pages.map((page) => {
    const layers = activeMode === 'translated' ? (page.lettering_layers || []).map(renderLetteringLayer).join('') : '';
    return `<figure class="reader-page"><div class="reader-canvas"><img src="${page.media_url}" alt="${escapeHtml(chapter.number_label)} 페이지 ${page.page_index + 1}" loading="lazy" />${layers}</div><figcaption>${page.page_index + 1} / ${chapter.pages.length}</figcaption></figure>`;
  }).join('') : '<div class="reader-empty"><p>페이지가 준비되면 이곳에서 읽을 수 있습니다.</p></div>';
}

function renderLetteringLayer(layer) {
  const bounds = polygonBounds(layer.polygon);
  const style = layer.style || {};
  const fontSize = Math.min(96, Math.max(8, Number(style.fontSize) || 24));
  const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#ffffff';
  const background = /^rgba?\([0-9.,% ]+\)$/.test(style.background || '') ? style.background : 'rgba(20, 14, 25, 0.72)';
  const writingMode = ['vertical-rl', 'horizontal-tb'].includes(style.writingMode) ? style.writingMode : 'vertical-rl';
  const textAlign = ['center', 'left', 'right'].includes(style.textAlign) ? style.textAlign : 'center';
  const fontWeight = ['400', '600', '700'].includes(String(style.fontWeight)) ? style.fontWeight : '600';
  const css = `left:${bounds.left}%;top:${bounds.top}%;width:${bounds.width}%;height:${bounds.height}%;font-size:${fontSize}px;color:${color};background:${background};writing-mode:${writingMode};text-align:${textAlign};font-weight:${fontWeight};`;
  return `<div class="lettering-layer" style="${css}">${escapeHtml(layer.text).replaceAll('\n', '<br />')}</div>`;
}

function polygonBounds(polygon = []) {
  const points = polygon.filter((point) => Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)));
  if (!points.length) return { left: 0, top: 0, width: 100, height: 100 };
  const xs = points.map((point) => Number(point.x));
  const ys = points.map((point) => Number(point.y));
  const left = Math.min(...xs) * 100;
  const top = Math.min(...ys) * 100;
  return { left, top, width: Math.max(1, Math.max(...xs) * 100 - left), height: Math.max(1, Math.max(...ys) * 100 - top) };
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
  if (result.chapter?.job?.id) {
    showNotice('업로드를 접수했습니다. 페이지 변환을 시작합니다.');
    watchJob(result.chapter.job.id);
  } else {
    showNotice('업로드를 접수했습니다. 원본과 페이지를 저장했습니다.');
  }
}

async function watchJob(jobId) {
  const job = await request(`/api/jobs/${jobId}`);
  if (!job) return;
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    const message = job.status === 'completed' ? '페이지 변환이 완료되었습니다.' : job.status === 'failed' ? `페이지 변환 실패: ${job.error_message || '원인을 확인해 주세요.'}` : '페이지 변환이 취소되었습니다.';
    showNotice(message, job.status !== 'completed');
    await loadSeries($('#search').value);
    if ($('#series-detail-dialog').open && state.detailSeriesId) await openSeries(state.detailSeriesId);
    return;
  }
  setTimeout(() => watchJob(jobId), 1000);
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
