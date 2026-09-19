'use strict';
// "자동 알림" tab: standing watches that the scheduled cloud scan runs every hour.
(() => {
  const $ = (id) => document.getElementById(id);
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  const programNames = { 'korean-air': '대한항공', 'asiana-club': '아시아나' };
  let catalog = null, watches = [], editingId = null;

  async function api(url, options) {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
    } catch {
      throw new Error('조회 프로그램에 연결할 수 없어요.');
    }
    let data;
    try { data = await response.json(); } catch { throw new Error('응답을 읽지 못했어요.'); }
    if (!response.ok) throw new Error(data.error?.message || '요청을 처리하지 못했어요.');
    return data;
  }

  function setStatus(message, kind = 'info') {
    $('watch-status').dataset.kind = kind;
    $('watch-status-text').textContent = message;
  }

  function checkedValues(containerId) {
    return Array.from($(containerId).querySelectorAll('input:checked'), (input) => input.value);
  }

  function renderPickers() {
    const origins = $('watch-origins');
    origins.replaceChildren();
    for (const airport of catalog.list.filter((a) => a.region === '대한민국').slice(0, 4)) {
      const label = node('label', 'scan-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = airport.code;
      input.checked = airport.code === 'ICN';
      label.append(input, node('span', null, `${airport.name} (${airport.code})`));
      origins.append(label);
    }
    const regions = $('watch-regions');
    regions.replaceChildren();
    const counts = new Map();
    for (const airport of catalog.list) {
      if (airport.region === '대한민국') continue;
      counts.set(airport.region, (counts.get(airport.region) || 0) + 1);
    }
    for (const [region, count] of counts) {
      const label = node('label', 'scan-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = region;
      label.append(input, node('span', null, `${region} (${count}곳)`));
      regions.append(label);
    }
  }

  function formValues() {
    const extra = $('watch-destinations').value.trim().toUpperCase();
    return {
      id: editingId,
      label: $('watch-label').value.trim(),
      origins: checkedValues('watch-origins'),
      destinations: extra ? extra.split(/[^A-Z]+/).filter((c) => /^[A-Z]{3}$/.test(c)) : [],
      regions: checkedValues('watch-regions'),
      startDate: $('watch-start').value,
      endDate: $('watch-end').value,
      programs: checkedValues('watch-programs'),
      enabled: true,
    };
  }

  function fillForm(watch) {
    editingId = watch?.id ?? null;
    $('watch-label').value = watch?.label ?? '';
    $('watch-destinations').value = (watch?.destinations ?? []).join(' ');
    $('watch-start').value = watch?.startDate ?? '';
    $('watch-end').value = watch?.endDate ?? '';
    for (const input of $('watch-origins').querySelectorAll('input')) input.checked = watch ? watch.origins.includes(input.value) : input.value === 'ICN';
    for (const input of $('watch-regions').querySelectorAll('input')) input.checked = Boolean(watch?.regions.includes(input.value));
    for (const input of $('watch-programs').querySelectorAll('input')) input.checked = watch ? watch.programs.includes(input.value) : true;
    $('watch-save').textContent = editingId ? '수정 내용 저장' : '알림 신청 추가';
    $('watch-cancel-edit').hidden = !editingId;
  }

  function describe(watch) {
    const where = [...watch.destinations, ...watch.regions].join(', ') || '지정 없음';
    return `${watch.origins.join('/')} → ${where} · ${watch.startDate} ~ ${watch.endDate} · ${watch.programs.map((p) => programNames[p] || p).join('/')}`;
  }

  function renderWatches() {
    const list = $('watch-list');
    list.replaceChildren();
    if (!watches.length) {
      const empty = node('div', 'panel empty');
      empty.append(node('div', 'empty-icon', '🔔'), node('strong', null, '신청한 알림이 없어요.'),
        node('p', null, '위에서 노선과 날짜를 골라 신청하면, GitHub에서 매시간 자동으로 확인하고 좌석이 나오면 텔레그램으로 알려줘요.'));
      list.append(empty);
      return;
    }
    for (const watch of watches) {
      const row = node('div', 'watch-row');
      const info = node('div');
      info.append(node('strong', null, watch.label), node('div', 'watch-detail', describe(watch)));
      const actions = node('div', 'watch-actions');
      const edit = node('button', 'watch-button', '수정');
      edit.type = 'button';
      edit.addEventListener('click', () => { fillForm(watch); $('watch-label').focus(); });
      const remove = node('button', 'watch-button danger', '삭제');
      remove.type = 'button';
      remove.addEventListener('click', () => void deleteWatch(watch));
      actions.append(edit, remove);
      row.append(info, actions);
      list.append(row);
    }
  }

  function renderSync(sync) {
    const pending = sync?.pendingChanges || (sync?.unpushedCommits ?? 0) > 0;
    $('watch-sync').hidden = false;
    $('watch-sync').textContent = pending ? 'GitHub에 반영하기 (변경 있음)' : 'GitHub에 반영됨';
    $('watch-sync').disabled = !pending;
    $('watch-sync-note').textContent = pending
      ? '아직 GitHub에 올리지 않은 변경이 있어요. 반영해야 매시간 자동 조회에 적용돼요.'
      : '신청 내용이 GitHub에 반영되어 있어요.';
  }

  async function loadWatches() {
    const data = await api('/api/watches');
    watches = data.watches || [];
    renderWatches();
    renderSync(data.sync);
  }

  async function saveWatch(event) {
    event.preventDefault();
    try {
      $('watch-save').disabled = true;
      const data = await api('/api/watches/save', { method: 'POST', body: JSON.stringify(formValues()) });
      watches = data.watches;
      editingId = null;
      fillForm(null);
      renderWatches();
      renderSync(data.sync);
      setStatus('저장했어요. "GitHub에 반영하기"를 눌러야 자동 조회에 적용돼요.', 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      $('watch-save').disabled = false;
    }
  }

  async function deleteWatch(watch) {
    try {
      const data = await api('/api/watches/delete', { method: 'POST', body: JSON.stringify({ id: watch.id }) });
      watches = data.watches;
      if (editingId === watch.id) { editingId = null; fillForm(null); }
      renderWatches();
      renderSync(data.sync);
      setStatus(`"${watch.label}" 신청을 지웠어요. GitHub에 반영해 주세요.`, 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  async function syncWatches() {
    try {
      $('watch-sync').disabled = true;
      setStatus('GitHub에 올리는 중이에요…', 'busy');
      const data = await api('/api/watches/sync', { method: 'POST', body: JSON.stringify({}) });
      renderSync(data.sync);
      setStatus(data.message || 'GitHub에 반영했어요.', 'success');
      void loadCloud();
    } catch (error) {
      setStatus(error.message, 'error');
      $('watch-sync').disabled = false;
    }
  }

  function when(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('ko-KR',
      { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
  }

  async function loadCloud() {
    const box = $('watch-cloud');
    try {
      const data = await api('/api/watches/cloud');
      box.replaceChildren();
      if (!data.available) {
        box.append(node('p', 'program-hint', 'GitHub 실행 상태를 확인하지 못했어요 (gh CLI 필요). 저장소의 Actions 탭에서 확인해 주세요.'));
        return;
      }
      if (!data.runs.length) {
        box.append(node('p', 'program-hint', '아직 실행 기록이 없어요.'));
        return;
      }
      for (const run of data.runs) {
        const running = run.status !== 'completed';
        const label = running ? '지금 실행 중' : run.conclusion === 'success' ? '성공' : '실패';
        const row = node('div', 'watch-run');
        row.append(node('span', 'watch-run-dot' + (running ? ' live' : run.conclusion === 'success' ? ' ok' : ' bad')),
          node('span', null, `${when(run.createdAt)} 시작 · ${label}`));
        box.append(row);
      }
    } catch (error) {
      box.replaceChildren(node('p', 'program-hint', error.message));
    }
  }

  async function init() {
    $('watch-form').addEventListener('submit', saveWatch);
    $('watch-sync').addEventListener('click', syncWatches);
    $('watch-cancel-edit').addEventListener('click', () => fillForm(null));
    $('watch-refresh').addEventListener('click', () => { void loadWatches(); void loadCloud(); });
    try {
      const routes = await api('/api/routes');
      catalog = { list: routes.airports };
      renderPickers();
      fillForm(null);
      await loadWatches();
      void loadCloud();
      setStatus('노선과 날짜를 고르고 신청하면 매시간 자동으로 확인해요.');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else void init();
  window.WatchesUI = { reload: () => { void loadWatches(); void loadCloud(); } };
})();
