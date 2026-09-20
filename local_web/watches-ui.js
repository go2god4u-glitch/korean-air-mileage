'use strict';
/**
 * 작전일지 — 봉수대(烽燧臺)
 *
 * 척후를 풀어두어도 명(命)이 없으면 어디를 살필지 모른다. 이 화면이 그 명을
 * 적는 곳이다. 노선과 날짜를 적어두면 구름 위의 척후가 매시간 대신 돌아보고,
 * 자리가 열리면 봉화를 올린다. 내 집의 등불이 꺼져 있어도 봉수는 오른다.
 *
 * 한 가지를 반드시 새길 것. **적는 것과 내리는 것은 다르다.** 화면에서 적은
 * 명은 아직 이 컴퓨터 안에만 있고, "GitHub에 반영하기"를 눌러야 비로소
 * 척후에게 닿는다. 지난날 주공께서 지우신 명이 지워지지 않은 채 남아 있어
 * 뜻하지 않은 곳을 살핀 일이 있었으니, 그 일을 잊지 않기 위해 화면 맨 위에
 * 경고를 붙이고 미반영이면 단추에 표를 띄운다.
 *
 * 아울러 지금 구름 위에서 무엇이 돌고 있는지도 함께 보인다. 보이지 않는
 * 군사를 믿으라 하는 것은 장수의 도리가 아니기 때문이다.
 *
 * 길잡이: AWARD_SCAN_ARCHITECTURE.md §5.2 · TROUBLESHOOTING_AWARD_SCAN.md §5.2
 */
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

  let releaseConfig = { windows: { 'korean-air': 360, 'asiana-club': 364 }, releaseHour: 9 };
  let releaseTimer = null;

  function releaseDateFor(target) {
    const parsed = new Date(target + 'T09:00:00+09:00');
    if (Number.isNaN(parsed.getTime())) return null;
    // Each airline sells a different distance ahead, so the morning a date opens
    // differs too — Asiana's window is four days longer than Korean Air's.
    const program = $('release-program').value;
    parsed.setDate(parsed.getDate() - (releaseConfig.windows[program] ?? 360));
    return parsed;
  }

  /** Says plainly when the airline opens the chosen date, so nobody waits on a
   *  morning that has already passed or is a year away. */
  function describeRelease() {
    const target = $('release-date').value;
    const note = $('release-when');
    const opens = target && releaseDateFor(target);
    if (!opens) { note.textContent = ''; note.dataset.kind = 'info'; return; }
    const day = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(opens);
    const hours = (opens.getTime() - Date.now()) / 3_600_000;
    if (hours < -0.5) {
      note.textContent = `${day} 오전 ${releaseConfig.releaseHour}시에 이미 열린 날짜예요. 위 검색으로 바로 확인해 주세요.`;
      note.dataset.kind = 'warn';
    } else {
      const left = hours < 24 ? `${Math.max(0, Math.round(hours))}시간 뒤` : `${Math.round(hours / 24)}일 뒤`;
      note.textContent = `${day} 오전 ${releaseConfig.releaseHour}시에 열려요 — ${left}. 그때 맥이 켜져 있어야 해요.`;
      note.dataset.kind = 'info';
    }
  }

  /** Asiana publishes economy and business only, so first class is not offered. */
  function syncReleaseCabins() {
    const asiana = $('release-program').value === 'asiana-club';
    const first = $('release-cabin').querySelector('option[value="first"]');
    first.disabled = asiana;
    first.textContent = asiana ? '일등석 (아시아나 미제공)' : '일등석';
    if (asiana && $('release-cabin').value === 'first') $('release-cabin').value = 'business';
  }

  const accountNames = { default: '기본', main: '계정 1', second: '계정 2' };

  function releaseKind(status) {
    if (status === 'found') return 'success';
    if (['failed', 'missed', 'interrupted'].includes(status)) return 'error';
    return ['waiting', 'sniping'].includes(status) ? 'busy' : 'info';
  }

  /** Every standby gets its own row: several can wait at once, on different
   *  airlines and different accounts, and one status line cannot show that. */
  function renderRelease(jobs) {
    const list = $('release-list');
    list.replaceChildren();
    const live = jobs.filter((job) => ['waiting', 'sniping'].includes(job.status));
    if (!jobs.length) {
      const empty = node('div', 'panel empty');
      empty.append(node('div', 'empty-icon', '⏰'), node('strong', null, '대기 중인 예매가 없어요.'),
        node('p', null, '타려는 날짜를 넣고 추가하면, 그날 9시에 맞춰 대기하다가 좌석까지 선택해 드려요.'));
      list.append(empty);
    }
    for (const job of jobs) {
      const row = node('div', 'watch-row');
      const info = node('div');
      const airline = programNames[job.program] || job.program;
      const account = accountNames[job.account] || job.account;
      info.append(node('strong', null, `${airline} · ${account} · ${job.origin}→${job.destination} ${job.date}`),
        node('div', 'watch-detail', `${job.opensOn} 오전 9시 · ${job.message}`));
      const detail = (job.flights ?? []).join(' · ');
      if (detail) info.append(node('div', 'date-live ok', detail));
      const actions = node('div', 'watch-actions');
      const dot = node('span', 'watch-run-dot ' + (job.status === 'found' ? 'ok' : releaseKind(job.status) === 'error' ? 'bad' : 'live'));
      actions.append(dot);
      if (['waiting', 'sniping'].includes(job.status)) {
        const stop = node('button', 'watch-button danger', '멈추기');
        stop.type = 'button';
        stop.addEventListener('click', () => void cancelRelease(job.id));
        actions.append(stop);
      }
      row.append(info, actions);
      list.append(row);
    }
    $('release-start').disabled = live.length >= 6;
    $('release-status').dataset.kind = live.length ? 'busy' : 'info';
    $('release-status-text').textContent = live.length
      ? `${live.length}건 대기 중이에요. 9시에 각각 ${Math.max(1, Math.min(3, Math.floor(6 / live.length)))}개 탭으로 동시에 잡아요.`
      : '타려는 날짜를 넣고 추가해 주세요.';
  }

  async function loadRelease() {
    try {
      const data = await api('/api/release-watch');
      releaseConfig = { windows: data.windows ?? releaseConfig.windows, releaseHour: data.releaseHour };
      renderRelease(data.jobs ?? (data.job ? [data.job] : []));
      syncReleaseCabins();
      describeRelease();
    } catch { /* the panel simply stays as it is */ }
  }

  /** Each account signs in once, in its own Chrome profile. */
  async function openReleaseLogin() {
    const program = $('release-program').value;
    const account = $('release-account').value;
    try {
      await api('/api/open-booking', {
        method: 'POST',
        body: JSON.stringify({ program, account, badge: `${programNames[program]} · ${accountNames[account] || account}`,
          origin: 'ICN', destination: 'NRT', date: $('release-date').value || '2027-01-01' }),
      });
      $('release-status').dataset.kind = 'info';
      $('release-status-text').textContent = `${programNames[program]} 로그인 창을 열었어요 (${accountNames[account] || account}). 로그인한 뒤 대기를 추가해 주세요.`;
    } catch (error) {
      $('release-status').dataset.kind = 'error';
      $('release-status-text').textContent = error.message;
    }
  }

  async function startRelease(event) {
    event.preventDefault();
    try {
      $('release-start').disabled = true;
      const data = await api('/api/release-watch/start', {
        method: 'POST',
        body: JSON.stringify({
          origin: $('release-origin').value.trim().toUpperCase(),
          destination: $('release-destination').value.trim().toUpperCase(),
          date: $('release-date').value,
          cabin: $('release-cabin').value,
          program: $('release-program').value,
          account: $('release-account').value,
        }),
      });
      await loadRelease();
    } catch (error) {
      $('release-status').dataset.kind = 'error';
      $('release-status-text').textContent = error.message;
      $('release-start').disabled = false;
    }
  }

  async function cancelRelease(id) {
    try {
      await api('/api/release-watch/cancel', { method: 'POST', body: JSON.stringify(id ? { id } : {}) });
      void loadRelease();
    } catch (error) {
      $('release-status').dataset.kind = 'error';
      $('release-status-text').textContent = error.message;
    }
  }

  async function init() {
    $('watch-form').addEventListener('submit', saveWatch);
    $('watch-sync').addEventListener('click', syncWatches);
    $('watch-cancel-edit').addEventListener('click', () => fillForm(null));
    $('watch-refresh').addEventListener('click', () => { void loadWatches(); void loadCloud(); });
    $('release-form').addEventListener('submit', startRelease);
    $('release-login').addEventListener('click', () => void openReleaseLogin());
    $('release-date').addEventListener('change', describeRelease);
    $('release-program').addEventListener('change', () => { syncReleaseCabins(); describeRelease(); });
    // A standby runs for hours, so its state is polled rather than shown once.
    releaseTimer = setInterval(() => void loadRelease(), 15000);
    void loadRelease();
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
  window.WatchesUI = { reload: () => { void loadWatches(); void loadCloud(); void loadRelease(); } };
})();
