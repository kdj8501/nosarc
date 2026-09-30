const state = { series: [], reader: null, detailSeriesId: null, watchedJobs: new Set(), processingJobId: null, processingChapterId: null };
const $ = (selector) => document.querySelector(selector);

const JOB_LABELS = { ingest: '페이지 준비', ocr: 'OCR', auto_translate: '자동 역식', render: '이미지 렌더링' };
const STAGE_LABELS = {
  preparing: '페이지 준비 중', extracting: '페이지 압축 해제 중', rendering: '원문을 지우고 번역문을 식자하는 중',
  ocr: 'OCR 읽는 중', detecting: '텍스트 영역을 찾는 중', recognizing: 'OCR로 원문을 읽는 중',
  translation: '문장을 번역하는 중', completed: '처리 완료', failed: '처리 실패', cancelled: '처리 취소됨',
};
const PIPELINE_STEPS = ['페이지 준비', 'OCR 읽기', '자동 번역', '식자·읽기'];

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
  document.querySelectorAll('[data-dialog-cancel]').forEach((button) => button.addEventListener('click', () => button.closest('dialog')?.close('cancel')));
  $('#series-dialog').addEventListener('close', () => $('#series-form').reset());
  $('#chapter-dialog').addEventListener('close', () => $('#chapter-form').reset());
  $('#chapter-dialog').addEventListener('cancel', () => $('#chapter-form').reset());
  $('#series-detail-close').addEventListener('click', () => $('#series-detail-dialog').close());
  $('#series-delete').addEventListener('click', () => state.detailSeriesId && deleteSeries(state.detailSeriesId, $('#series-detail-title').textContent));
  $('#glossary-form').addEventListener('submit', saveGlossaryTerm);
  $('#reader-close').addEventListener('click', () => $('#reader-dialog').close());
  $('#reader-original').addEventListener('click', () => setReaderMode('original'));
  $('#reader-translated').addEventListener('click', () => setReaderMode('translated'));
  $('#reader-editor-toggle').addEventListener('click', toggleTranslationEditor);
  $('#reader-render').addEventListener('click', renderReaderImages);
  $('#search').addEventListener('input', () => loadSeries($('#search').value));
  $('#processing-close').addEventListener('click', closeProcessingDialog);
  $('#processing-cancel').addEventListener('click', () => state.processingJobId && cancelJob(state.processingJobId));
  $('#processing-read').addEventListener('click', () => {
    if (!state.processingChapterId) return;
    const chapterId = state.processingChapterId;
    closeProcessingDialog();
    openReader(chapterId, 'translated');
  });
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
  $('#series-list').innerHTML = series.length ? series.map(renderSeries).join('') : '<div class="series-card empty-state"><p class="muted">아직 작품이 없습니다.<br />첫 작품을 추가해 보세요.</p></div>';
  document.querySelectorAll('[data-upload]').forEach((button) => button.addEventListener('click', () => openChapter(button.dataset.upload, button.dataset.title)));
  document.querySelectorAll('[data-open]').forEach((button) => button.addEventListener('click', () => openSeries(button.dataset.open)));
  document.querySelectorAll('[data-delete-series]').forEach((button) => button.addEventListener('click', () => deleteSeries(button.dataset.deleteSeries, button.dataset.title)));
  await refreshProcessingJobs();
}

function renderSeries(item) {
  const tags = item.tags ? item.tags.split(', ').map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') : '';
  return `<article class="series-card"><p class="eyebrow">${escapeHtml(item.status)}</p><h3>${escapeHtml(item.title)}</h3>${item.original_title ? `<p class="muted">${escapeHtml(item.original_title)}</p>` : ''}<div>${tags}</div><div class="series-meta"><span>${item.chapter_count}개 권</span><span>${escapeHtml(item.target_language)}</span></div><div class="card-actions"><button class="button ghost" data-upload="${item.id}" data-title="${escapeHtml(item.title)}">권 업로드</button><button class="button ghost" data-open="${item.id}">상세</button><button class="button small danger" data-delete-series="${item.id}" data-title="${escapeHtml(item.title)}">삭제</button></div></article>`;
}

function openChapter(id, title) {
  $('#chapter-form').reset();
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
  renderSeriesGlossary(series.glossary || []);
  $('#chapter-list').innerHTML = series.chapters.length ? series.chapters.map(renderChapter).join('') : '<p class="muted">등록된 권이 없습니다.</p>';
  if (!$('#series-detail-dialog').open) $('#series-detail-dialog').showModal();
  $('#series-delete').dataset.seriesId = series.id;
  document.querySelectorAll('[data-read]').forEach((button) => button.addEventListener('click', () => openReader(button.dataset.read)));
  document.querySelectorAll('[data-retry]').forEach((button) => button.addEventListener('click', () => retryJob(button.dataset.retry)));
  document.querySelectorAll('[data-cancel]').forEach((button) => button.addEventListener('click', () => cancelJob(button.dataset.cancel)));
  document.querySelectorAll('[data-delete-chapter]').forEach((button) => button.addEventListener('click', () => deleteChapter(button.dataset.deleteChapter, button.dataset.title)));
  document.querySelectorAll('[data-ocr]').forEach((button) => button.addEventListener('click', () => startOcr(button.dataset.ocr)));
  document.querySelectorAll('[data-reprocess-ocr]').forEach((button) => button.addEventListener('click', () => startOcr(button.dataset.reprocessOcr, { replaceExisting: true })));
  document.querySelectorAll('[data-auto-translate]').forEach((button) => button.addEventListener('click', () => startAutoTranslate(button.dataset.autoTranslate)));
  document.querySelectorAll('[data-delete-glossary]').forEach((button) => button.addEventListener('click', () => deleteGlossaryTerm(button.dataset.deleteGlossary)));
  series.chapters.filter((chapter) => ['queued', 'running'].includes(chapter.job_status)).forEach((chapter) => watchJob(chapter.job_id));
}

function renderSeriesGlossary(terms) {
  $('#series-glossary-count').textContent = `${terms.length}개`;
  $('#series-glossary-list').innerHTML = terms.length ? terms.map((term) => {
    const kind = ({ person: '인물', place: '장소', organization: '단체', series_term: '작품 용어' })[term.kind] || '작품 용어';
    const aliases = Array.isArray(term.aliases) && term.aliases.length ? ` · 별칭 ${escapeHtml(term.aliases.join(', '))}` : '';
    const reading = term.source_reading ? ` · ${escapeHtml(term.source_reading)}` : '';
    const notes = term.notes ? `<p class="muted">${escapeHtml(term.notes)}</p>` : '';
    return `<article class="glossary-item"><div><strong>${escapeHtml(term.source_term)}</strong><span class="muted">${reading} → ${escapeHtml(term.target_term)} · ${kind}${aliases}</span>${notes}</div><button class="button small ghost" type="button" data-delete-glossary="${term.id}">삭제</button></article>`;
  }).join('') : '<p class="muted">등록한 용어가 없습니다.</p>';
}

async function saveGlossaryTerm(event) {
  event.preventDefault();
  if (!state.detailSeriesId) return;
  const aliases = $('#glossary-aliases').value.split(/[,\n]/u).map((value) => value.trim()).filter(Boolean);
  const result = await request(`/api/series/${state.detailSeriesId}/glossary`, {
    method: 'PUT',
    body: {
      sourceTerm: $('#glossary-source').value,
      sourceReading: $('#glossary-reading').value,
      targetTerm: $('#glossary-target').value,
      kind: $('#glossary-kind').value,
      aliases,
      notes: $('#glossary-notes').value,
    },
  });
  if (!result?.id) return;
  $('#glossary-form').reset();
  await openSeries(state.detailSeriesId);
  showNotice('작품 용어집을 저장했습니다. 다음 번역부터 적용됩니다.');
}

async function deleteGlossaryTerm(termId) {
  if (!state.detailSeriesId || !window.confirm('이 작품 용어집 항목을 삭제할까요?')) return;
  const result = await request(`/api/series/${state.detailSeriesId}/glossary/${termId}`, { method: 'DELETE' });
  if (!result?.deleted) return;
  await openSeries(state.detailSeriesId);
  showNotice('작품 용어집 항목을 삭제했습니다.');
}

function renderChapter(chapter) {
  const readable = chapter.page_count > 0 && chapter.processing_status === 'completed';
  const active = ['queued', 'running'].includes(chapter.job_status);
  const failed = chapter.job_status === 'failed' || chapter.processing_status === 'failed';
  const progress = Number.isFinite(Number(chapter.job_progress)) ? Math.max(0, Math.min(100, Number(chapter.job_progress))) : 0;
  const status = active
    ? `${JOB_LABELS[chapter.job_type] || '자동 처리'} · ${stageLabel(chapter.job_type, chapter.job_stage)} · ${progress}%`
    : failed
      ? `${JOB_LABELS[chapter.job_type] || '처리'} 실패`
      : readable
        ? `${chapter.page_count}페이지${chapter.ocr_block_count && chapter.translation_count >= chapter.ocr_block_count ? ' · 번역 완료' : ''}`
        : processingStatusLabel(chapter.processing_status);
  const progressMarkup = active ? `<div class="chapter-progress"><progress max="100" value="${progress}"></progress></div>` : '';
  const readAction = readable ? `<button class="button small primary" data-read="${chapter.id}">읽기</button>` : '';
  const processAction = active && chapter.job_id
    ? `<button class="button small ghost" data-cancel="${chapter.job_id}">취소</button>`
    : failed && chapter.job_id
      ? `<button class="button small ghost" data-retry="${chapter.job_id}">다시 처리</button>`
      : !readable && chapter.job_id
        ? `<button class="button small ghost" disabled>준비 중</button>`
        : '';
  const fallbackAction = !active && !failed && readable && !chapter.ocr_block_count
    ? `<button class="button small ghost" data-ocr="${chapter.id}">다시 분석</button>`
    : !active && !failed && readable && chapter.ocr_block_count
      ? `<button class="button small ghost" data-auto-translate="${chapter.id}">${chapter.translation_count ? '번역 다시 실행' : '자동 역식'}</button>`
      : '';
  const reprocessAction = !active && !failed && readable && chapter.ocr_block_count
    ? `<button class="button small ghost" data-reprocess-ocr="${chapter.id}">\uC5ED\uC2DD \uB2E4\uC2DC \uC2E4\uD589</button>`
    : '';
  const deleteAction = `<button class="button small danger" data-delete-chapter="${chapter.id}" data-title="${escapeHtml(`${chapter.number_label}${chapter.title ? ` · ${chapter.title}` : ''}`)}">삭제</button>`;
  return `<article class="chapter-row"><div class="chapter-info"><strong>${escapeHtml(chapter.number_label)}${chapter.title ? ` · ${escapeHtml(chapter.title)}` : ''}</strong><span class="muted">${escapeHtml(status)}${chapter.ocr_block_count ? ` · OCR ${chapter.ocr_block_count}개${chapter.translation_count ? ` · 번역 ${chapter.translation_count}개` : ''}` : ''}</span>${progressMarkup}</div><div class="chapter-actions">${readAction}${processAction}${fallbackAction}${reprocessAction}${deleteAction}</div></article>`;
}

function processingStatusLabel(status) {
  return { queued: '대기 중', preparing: '페이지 준비 중', failed: '실패', cancelled: '취소됨', completed: '준비 완료' }[status] || status || '상태 확인 중';
}

function stageLabel(type, stage) {
  if (type === 'auto_translate' && stage === 'translation') return '자동 번역 중';
  return STAGE_LABELS[stage] || JOB_LABELS[type] || '처리 중';
}

async function retryJob(jobId) {
  const result = await request(`/api/jobs/${jobId}/retry`, { method: 'POST' });
  if (!result) return;
  showNotice('작업을 다시 접수했습니다.');
  if (state.detailSeriesId) await openSeries(state.detailSeriesId);
  watchJob(jobId, { showDialog: state.processingJobId === jobId });
}

async function cancelJob(jobId) {
  const result = await request(`/api/jobs/${jobId}/cancel`, { method: 'POST' });
  if (!result) return;
  showNotice('작업을 취소했습니다.');
  if (state.detailSeriesId) await openSeries(state.detailSeriesId);
  await refreshProcessingJobs();
}

async function deleteChapter(chapterId, label = '이 권') {
  if (!window.confirm(`'${label}'을(를) 삭제할까요? 원본 파일과 OCR·번역 결과도 모두 삭제됩니다.`)) return;
  const result = await request(`/api/chapters/${chapterId}`, { method: 'DELETE' });
  if (!result?.deleted) return;
  if (state.reader?.chapter?.id === chapterId) {
    $('#reader-dialog').close();
    state.reader = null;
  }
  showNotice('권을 삭제했습니다.');
  if (state.detailSeriesId) await openSeries(state.detailSeriesId);
  else await loadSeries($('#search').value);
}

async function deleteSeries(seriesId, title = '이 작품') {
  if (!window.confirm(`'${title}'과(와) 포함된 모든 권을 삭제할까요? 원본 파일과 번역 결과도 모두 삭제됩니다.`)) return;
  const result = await request(`/api/series/${seriesId}`, { method: 'DELETE' });
  if (!result?.deleted) return;
  if (state.reader?.chapter?.series_id === seriesId) {
    $('#reader-dialog').close();
    state.reader = null;
  }
  if ($('#series-detail-dialog').open) $('#series-detail-dialog').close();
  state.detailSeriesId = null;
  showNotice('작품을 삭제했습니다.');
  await loadSeries($('#search').value);
}

async function startOcr(chapterId, { replaceExisting = false } = {}) {
  if (replaceExisting && !window.confirm('새 OCR 결과로 기존 OCR 문장, 번역 및 식자 레이어를 교체합니다. 다시 실행할까요?')) return;
  const result = await request(`/api/chapters/${chapterId}/ocr`, { method: 'POST' });
  if (!result?.id) return;
  showNotice('OCR 작업을 접수했습니다.');
  if (state.detailSeriesId) await openSeries(state.detailSeriesId);
  watchJob(result.id, { showDialog: true });
}

async function startAutoTranslate(chapterId) {
  const confirmed = window.confirm('OCR 결과를 기준으로 자동 번역과 식자 레이어를 생성합니다. 기존 번역은 새 결과로 교체됩니다. 계속할까요?');
  if (!confirmed) return;
  const result = await request(`/api/chapters/${chapterId}/auto-translate`, { method: 'POST' });
  if (!result?.id) return;
  showNotice('자동 번역·식자 작업을 접수했습니다.');
  if (state.detailSeriesId) await openSeries(state.detailSeriesId);
  watchJob(result.id, { showDialog: true });
}

async function openReader(id, preferredMode = 'original') {
  const chapter = await request(`/api/chapters/${id}`);
  if (!chapter) return;
  state.reader = { chapter, mode: preferredMode };
  $('#translation-editor').hidden = true;
  $('#reader-editor-toggle').classList.remove('active');
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
  const hasBlocks = chapter.pages.some((page) => page.ocr_blocks?.length);
  $('#reader-editor-toggle').disabled = !hasBlocks;
  $('#reader-render').disabled = !hasTranslation;
  $('#reader-notice').textContent = chapter.pages.length ? activeMode === 'translated' ? '원문을 제거하고 번역문을 이미지에 렌더링했습니다.' : '원본 페이지를 표시하고 있습니다.' : '아직 변환된 페이지가 없습니다.';
  $('#reader-stage').innerHTML = chapter.pages.length ? chapter.pages.map((page) => {
    const rendered = activeMode === 'translated' && page.translated_media_url;
    const layers = activeMode === 'translated' && !rendered ? (page.lettering_layers || []).map(renderLetteringLayer).join('') : '';
    const mediaUrl = rendered ? page.translated_media_url : page.media_url;
    return `<figure class="reader-page"><div class="reader-canvas"><img src="${mediaUrl}" alt="${escapeHtml(chapter.number_label)} 페이지 ${page.page_index + 1}" loading="lazy" />${layers}</div><figcaption>${page.page_index + 1} / ${chapter.pages.length}</figcaption></figure>`;
  }).join('') : '<div class="reader-empty"><p>페이지가 준비되면 이곳에서 읽을 수 있습니다.</p></div>';
  renderTranslationEditor();
}

function renderLetteringLayer(layer) {
  const bounds = polygonBounds(layer.polygon);
  const style = layer.style || {};
  const fontSize = Math.min(96, Math.max(8, Number(style.fontSize) || 24));
  const color = /^#[0-9a-f]{6}$/i.test(style.color || '') ? style.color : '#21121a';
  const savedBackground = /^rgba?\([0-9.,% ]+\)$/.test(style.background || '') ? style.background : 'rgba(255, 255, 255, 0)';
  const background = savedBackground === 'rgba(255, 255, 255, 0.92)' ? 'rgba(255, 255, 255, 0)' : savedBackground;
  const writingMode = ['vertical-rl', 'horizontal-tb'].includes(style.writingMode) ? style.writingMode : 'vertical-rl';
  const textAlign = ['center', 'left', 'right'].includes(style.textAlign) ? style.textAlign : 'center';
  const fontWeight = ['400', '600', '700'].includes(String(style.fontWeight)) ? style.fontWeight : '600';
  const soundEffect = style.soundEffect === true;
  const rotation = Number.isFinite(Number(style.rotation)) ? Math.min(45, Math.max(-45, Number(style.rotation))) : 0;
  const channels = color.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
  const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
  const outlineWidth = luminance >= 210
    ? 0
    : Number.isFinite(Number(style.outlineWidth))
    ? Math.min(6, Math.max(0, Number(style.outlineWidth)))
    : soundEffect ? 2.6 : 1.2;
  const fallbackOutline = luminance >= 145 ? '#19121b' : '#ffffff';
  const outlineColor = /^#[0-9a-f]{6}$/i.test(String(style.outlineColor || '')) ? style.outlineColor : fallbackOutline;
  const css = `left:${bounds.left}%;top:${bounds.top}%;width:${bounds.width}%;height:${bounds.height}%;font-size:${fontSize / 7.6}cqw;color:${color};background:${background};writing-mode:${writingMode};text-align:${textAlign};font-weight:${fontWeight};transform:rotate(${rotation}deg);-webkit-text-stroke:${outlineWidth / 7.6}cqw ${outlineColor};paint-order:stroke fill;`;
  const classes = [
    'lettering-layer',
    soundEffect ? 'lettering-effect' : '',
    style.balanceLines === true ? 'lettering-balanced' : '',
  ].filter(Boolean).join(' ');
  return `<div class="${classes}" style="${css}">${escapeHtml(layer.text).replaceAll('\n', '<br />')}</div>`;
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

function toggleTranslationEditor() {
  const editor = $('#translation-editor');
  editor.hidden = !editor.hidden;
  $('#reader-editor-toggle').classList.toggle('active', !editor.hidden);
}

function renderTranslationEditor() {
  const editor = $('#translation-editor');
  if (!state.reader) return;
  const entries = state.reader.chapter.pages.flatMap((page, pageIndex) => (page.ocr_blocks || []).map((block) => ({ page, pageIndex, block })));
  $('#translation-editor-count').textContent = `${entries.length}개 블록`;
  $('#translation-editor-list').innerHTML = entries.length ? entries.map(({ page, pageIndex, block }) => {
    const layer = (page.lettering_layers || []).find((candidate) => candidate.translation_id === block.translation?.id);
    const kind = ['dialogue', 'caption', 'sound_effect'].includes(block.translation?.content_kind)
      ? block.translation.content_kind
      : layer?.style?.soundEffect ? 'sound_effect' : 'dialogue';
    const profile = state.reader.chapter.lettering_style_profiles?.[kind] || {};
    const style = layer?.style || profile;
    const defaultWritingMode = /^(?:ko|kor)(?:[-_]|$)/i.test(state.reader.chapter.target_language || '') ? 'horizontal-tb' : 'vertical-rl';
    const writingMode = ['vertical-rl', 'horizontal-tb'].includes(style.writingMode) ? style.writingMode : defaultWritingMode;
    const color = /^#[0-9a-f]{6}$/i.test(String(style.color || '')) ? style.color : '#21121a';
    const channels = color.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16));
    const luminance = (channels[0] * 299 + channels[1] * 587 + channels[2] * 114) / 1000;
    const outlineColor = /^#[0-9a-f]{6}$/i.test(String(style.outlineColor || ''))
      ? style.outlineColor
      : luminance >= 145 ? '#19121b' : '#ffffff';
    const alignment = ['center', 'left', 'right'].includes(style.textAlign) ? style.textAlign : 'center';
    const weight = ['400', '600', '700'].includes(String(style.fontWeight)) ? String(style.fontWeight) : '600';
    return `<article class="translation-entry"><div class="translation-source"><span class="eyebrow">PAGE ${pageIndex + 1}</span><p>${escapeHtml(block.source_text)}</p><span class="muted">신뢰도 ${block.confidence == null ? '-' : `${Math.round(block.confidence * 100)}%`}</span></div><textarea data-translation-text="${block.id}" rows="2" placeholder="번역문을 입력하세요.">${escapeHtml(block.translation?.translated_text || '')}</textarea><div class="translation-controls"><select data-style-field="contentKind" data-block-id="${block.id}" aria-label="문자 유형"><option value="dialogue" ${kind === 'dialogue' ? 'selected' : ''}>대사</option><option value="caption" ${kind === 'caption' ? 'selected' : ''}>나레이션</option><option value="sound_effect" ${kind === 'sound_effect' ? 'selected' : ''}>효과음</option></select><select data-style-field="writingMode" data-block-id="${block.id}" aria-label="쓰기 방향"><option value="vertical-rl" ${writingMode !== 'horizontal-tb' ? 'selected' : ''}>세로쓰기</option><option value="horizontal-tb" ${writingMode === 'horizontal-tb' ? 'selected' : ''}>가로쓰기</option></select><input data-style-field="fontSize" data-block-id="${block.id}" type="number" min="8" max="96" value="${Number(style.fontSize) || 24}" aria-label="글자 크기" /><span class="muted">px</span><label class="muted">글자색 <input data-style-field="color" data-block-id="${block.id}" type="color" value="${color}" aria-label="글자 색" /></label><select data-style-field="fontWeight" data-block-id="${block.id}" aria-label="글자 굵기"><option value="400" ${weight === '400' ? 'selected' : ''}>보통</option><option value="600" ${weight === '600' ? 'selected' : ''}>중간</option><option value="700" ${weight === '700' ? 'selected' : ''}>굵게</option></select><select data-style-field="textAlign" data-block-id="${block.id}" aria-label="정렬"><option value="center" ${alignment === 'center' ? 'selected' : ''}>가운데</option><option value="left" ${alignment === 'left' ? 'selected' : ''}>왼쪽</option><option value="right" ${alignment === 'right' ? 'selected' : ''}>오른쪽</option></select><label class="muted">외곽선 <input data-style-field="outlineWidth" data-block-id="${block.id}" type="number" min="0" max="6" step="0.2" value="${Number.isFinite(Number(style.outlineWidth)) ? Number(style.outlineWidth) : 1.4}" aria-label="외곽선 두께" /></label><label class="muted">외곽선색 <input data-style-field="outlineColor" data-block-id="${block.id}" type="color" value="${outlineColor}" aria-label="외곽선 색" /></label><label class="muted">기울기 <input data-style-field="rotation" data-block-id="${block.id}" type="number" min="-45" max="45" value="${Number(style.rotation) || 0}" aria-label="기울기" />°</label><button class="button small primary" data-save-translation="${block.id}">번역 저장</button><button class="button small" data-save-lettering-profile="${block.id}">이 유형을 작품 기본값으로</button></div></article>`;
  }).join('') : '<p class="muted">OCR 블록이 없습니다. 먼저 OCR을 실행해 주세요.</p>';
  document.querySelectorAll('[data-save-translation]').forEach((button) => button.addEventListener('click', () => saveTranslation(button.dataset.saveTranslation)));
  document.querySelectorAll('[data-save-lettering-profile]').forEach((button) => button.addEventListener('click', () => saveLetteringProfile(button.dataset.saveLetteringProfile)));
}

async function saveTranslation(blockId) {
  const text = document.querySelector(`[data-translation-text="${blockId}"]`).value.trim();
  const style = readLetteringStyle(blockId);
  const result = await request(`/api/ocr-blocks/${blockId}/translations`, { method: 'POST', body: { translatedText: text, targetLanguage: state.reader.chapter.target_language, contentKind: style.contentKind, style } });
  if (!result) return;
  state.reader.chapter = await request(`/api/chapters/${state.reader.chapter.id}`);
  renderReader();
  $('#translation-editor').hidden = false;
  $('#reader-editor-toggle').classList.add('active');
  showNotice('번역과 식자 레이어를 저장했습니다.');
}

async function saveLetteringProfile(blockId) {
  const style = readLetteringStyle(blockId);
  const { contentKind, ...profile } = style;
  const result = await request(`/api/series/${state.reader.chapter.series_id}/lettering-style-profiles/${contentKind}`, {
    method: 'PUT',
    body: { style: profile },
  });
  if (!result) return;
  state.reader.chapter = await request(`/api/chapters/${state.reader.chapter.id}`);
  const editor = $('#translation-editor');
  editor.hidden = false;
  renderReader();
  editor.hidden = false;
  $('#reader-editor-toggle').classList.add('active');
  showNotice('이 작품의 해당 유형 기본값으로 저장했습니다. 다음 자동 식자부터 적용됩니다.');
}

function readLetteringStyle(blockId) {
  const read = (field) => document.querySelector(`[data-style-field="${field}"][data-block-id="${blockId}"]`).value;
  return {
    contentKind: read('contentKind'),
    writingMode: read('writingMode'),
    fontSize: Number(read('fontSize')),
    color: read('color'),
    outlineColor: read('outlineColor'),
    fontWeight: read('fontWeight'),
    textAlign: read('textAlign'),
    outlineWidth: Number(read('outlineWidth')),
    rotation: Number(read('rotation')),
  };
}

async function renderReaderImages() {
  if (!state.reader) return;
  const result = await request(`/api/chapters/${state.reader.chapter.id}/render`, { method: 'POST' });
  if (!result?.id) return;
  showNotice('원문 제거와 이미지 렌더링을 시작했습니다.');
  watchReaderRender(result.id);
}

async function watchReaderRender(jobId) {
  const job = await request(`/api/jobs/${jobId}`);
  if (!job || !state.reader) return;
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    if (job.status === 'completed') {
      state.reader.chapter = await request(`/api/chapters/${state.reader.chapter.id}`);
      renderReader();
      showNotice('번역 이미지 렌더링이 완료되었습니다.');
    } else if (job.status === 'failed') {
      showNotice(`이미지 렌더링 실패: ${job.error_message || '원인을 확인해 주세요.'}`, true);
    }
    return;
  }
  setTimeout(() => watchReaderRender(jobId), 1000);
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
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const form = new FormData();
    form.append('numberLabel', $('#chapter-number').value);
    form.append('title', $('#chapter-title').value);
    for (const file of $('#chapter-files').files) form.append('files', file);
    const result = await request(`/api/series/${$('#chapter-series-id').value}/chapters`, { method: 'POST', form });
    if (!result?.id) return;
    const jobId = result.chapter?.job?.id || result.job_id;
    $('#chapter-dialog').close();
    event.target.reset();
    await loadSeries($('#search').value);
    if (jobId) {
      watchJob(jobId);
    } else {
      showNotice('업로드를 접수했습니다.');
    }
  } finally {
    if (submit) submit.disabled = false;
  }
}

async function refreshProcessingJobs() {
  const jobs = await request('/api/jobs/active');
  if (!Array.isArray(jobs)) return;
  $('#activity-panel').hidden = !jobs.length;
  $('#activity-list').innerHTML = jobs.map(renderActivityJob).join('');
  document.querySelectorAll('[data-open-activity]').forEach((button) => button.addEventListener('click', () => openSeries(button.dataset.openActivity)));
  jobs.forEach((job) => watchJob(job.id));
}

function renderActivityJob(job) {
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  return `<article class="activity-item"><div class="activity-title"><strong>${escapeHtml(job.series_title)} · ${escapeHtml(job.number_label)}</strong><span>${escapeHtml(JOB_LABELS[job.type] || '자동 처리')} · ${escapeHtml(stageLabel(job.type, job.current_stage))}</span></div><div class="progress-wrap"><progress max="100" value="${progress}"></progress><strong>${progress}%</strong></div><button class="button small ghost" data-open-activity="${job.series_id}">상세</button></article>`;
}

function updateChapterProgress(job) {
  const row = [...document.querySelectorAll('.chapter-row')].find((candidate) => candidate.querySelector('[data-cancel]')?.dataset.cancel === job.id);
  if (!row) return;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const status = row.querySelector('.chapter-info .muted');
  if (status) {
    if (!status.dataset.metadata) status.dataset.metadata = status.textContent.match(/\s·\sOCR\b[\s\S]*/u)?.[0] || '';
    status.textContent = job.status === 'queued'
      ? `${JOB_LABELS[job.type] || '작업'} · 대기 중 · ${progress}%${status.dataset.metadata}`
      : `${JOB_LABELS[job.type] || '작업'} · ${stageLabel(job.type, job.current_stage)} · ${progress}%${status.dataset.metadata}`;
  }
  let progressBar = row.querySelector('.chapter-progress progress');
  if (!progressBar) {
    const wrap = document.createElement('div');
    wrap.className = 'chapter-progress';
    progressBar = document.createElement('progress');
    progressBar.max = 100;
    wrap.append(progressBar);
    row.querySelector('.chapter-info')?.append(wrap);
  }
  if (progressBar) progressBar.value = progress;
}

function showProcessingDialog(job) {
  state.processingJobId = job.id;
  state.processingChapterId = job.chapter_id;
  if (!$('#processing-dialog').open) $('#processing-dialog').showModal();
  updateProcessingDialog(job);
}

function closeProcessingDialog() {
  if ($('#processing-dialog').open) $('#processing-dialog').close();
  state.processingJobId = null;
  state.processingChapterId = null;
}

function updateProcessingDialog(job) {
  if (!job) return;
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  $('#processing-title').textContent = job.series_title ? `${job.series_title} · ${job.number_label || ''}` : '만화를 처리하고 있습니다';
  $('#processing-progress').value = progress;
  $('#processing-percent').textContent = `${progress}%`;
  $('#processing-stage').textContent = job.status === 'queued' ? '작업 대기 중입니다. 곧 처리를 시작합니다.' : stageLabel(job.type, job.current_stage);
  $('#processing-error').textContent = job.error_message || '';
  $('#processing-cancel').hidden = !['queued', 'running'].includes(job.status);
  $('#processing-read').hidden = !(job.status === 'completed' && job.type === 'auto_translate');
  const activeIndex = pipelineIndex(job);
  $('#processing-pipeline').innerHTML = PIPELINE_STEPS.map((label, index) => `<span class="pipeline-step ${index < activeIndex ? 'done' : index === activeIndex ? 'active' : ''}">${label}</span>`).join('');
}

function pipelineIndex(job) {
  if (job.status === 'completed') return PIPELINE_STEPS.length;
  if (job.type === 'ingest') return 0;
  if (job.type === 'ocr') return 1;
  if (job.type === 'auto_translate' && job.current_stage === 'rendering') return 3;
  if (job.type === 'auto_translate') return 2;
  return 0;
}

function watchJob(jobId, options = {}) {
  if (!jobId || state.watchedJobs.has(jobId)) return;
  state.watchedJobs.add(jobId);
  let pollFailures = 0;
  const poll = async () => {
    try {
    const job = await request(`/api/jobs/${jobId}`, { silentErrors: true });
    if (!job?.id) throw new Error('Job status response is unavailable.');
    pollFailures = 0;
    if (options.showDialog || state.processingJobId === jobId) showProcessingDialog(job);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      updateChapterProgress(job);
      await refreshProcessingJobs();
      setTimeout(poll, 1000);
      return;
    }

    state.watchedJobs.delete(jobId);
    await loadSeries($('#search').value);
    if ($('#series-detail-dialog').open && state.detailSeriesId) await openSeries(state.detailSeriesId);
    const chapter = await request(`/api/chapters/${job.chapter_id}`);
    const nextJob = chapter?.job;
    if (job.status === 'completed' && nextJob && nextJob.id !== jobId && ['queued', 'running'].includes(nextJob.status)) {
      watchJob(nextJob.id, { showDialog: state.processingJobId === jobId });
      return;
    }

    const jobLabel = JOB_LABELS[job.type] || '작업';
    const message = job.status === 'completed' ? `${jobLabel}이 완료되었습니다.` : job.status === 'failed' ? `${jobLabel} 실패: ${job.error_message || '원인을 확인해 주세요.'}` : `${jobLabel}이 취소되었습니다.`;
    const completedMessage = job.status === 'completed' && job.error_message
      ? `${message} ${job.error_message}`
      : message;
    showNotice(completedMessage, job.status !== 'completed');
    if (job.status === 'completed' && job.type === 'auto_translate' && options.showDialog) {
      if ($('#series-detail-dialog').open) $('#series-detail-dialog').close();
      closeProcessingDialog();
      await openReader(job.chapter_id, 'translated');
    } else {
      updateProcessingDialog(job);
    }
    await refreshProcessingJobs();
    } catch {
      pollFailures += 1;
      state.watchedJobs.add(jobId);
      if (pollFailures === 5) showNotice('진행 현황 연결이 불안정합니다. 다시 연결을 시도하고 있습니다.', true);
      setTimeout(poll, Math.min(8000, 1000 + pollFailures * 1000));
    }
  };
  void poll();
}

async function request(url, options = {}) {
  const init = { method: options.method || 'GET', headers: {} };
  if (options.form) init.body = options.form;
  else if (options.body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(options.body); }
  const response = await fetch(url, init);
  if (response.status === 401 && !options.allowUnauthorized) { showLogin(); return null; }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok && data?.error && !options.silentErrors) showNotice(data.error, true);
  return data;
}

function showNotice(message, isError = false) { const notice = $('#notice'); notice.textContent = message; notice.style.color = isError ? '#ff9c9c' : ''; setTimeout(() => { notice.textContent = ''; }, 4500); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])); }
