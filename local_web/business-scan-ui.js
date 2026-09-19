'use strict';
/**
 * 작전일지 — 목적지를 정하지 않는 원정
 *
 * "어디로 갈지 정하고 자리를 찾는 것은 아랫계책이요, 자리가 난 곳으로 가는 것이
 * 윗계책이라." 주공께서 이르시되 "비즈니스를 탈 수 있다면 그에 맞춰 떠날 채비가
 * 되어 있다" 하시니, 화면을 그리 고쳤다. 노선 하나를 묻지 않고 대륙을 통째로 묻는다.
 *
 * 세 가지를 덧대었다.
 *
 * 하나, 두 시간 나는 자리에 비즈니스가 무슨 소용인가. 비행시간을 재어 짧은 길은
 * 추려낸다. 다만 **시간을 모르는 공항은 남긴다.** 모르는 것과 짧은 것은 다르다.
 *
 * 둘, 갈 때만 있고 올 때가 없으면 반쪽이다. 여정의 방향을 돌려 대륙에서
 * 인천으로 돌아오는 길도 같은 방식으로 살핀다.
 *
 * 셋, 일등석은 따로 아뢴다. 다만 대한항공은 보너스와 좌석승급을 한 깃발에
 * 묶어 내걸기에, 우리도 "둘 중 하나"라 적을 뿐 지어내지 않는다.
 *
 * 오래 걸리는 것은 허물이 아니다. 주공께서 "시간이 오래 걸려도 좋으니 내가
 * 두 번 일하지 않게 하라" 하셨으므로, 조합을 제한하지 않고 한 건씩 차례로
 * 살피되 찾는 대로 즉시 올리고, 언제든 멈출 수 있게 하였다. 파발이 한두 번
 * 끊겨도 원정을 물리지 않는다(여덟 번까지 견딘다).
 *
 * 길잡이: TROUBLESHOOTING_AWARD_SCAN.md · AWARD_SCAN_ARCHITECTURE.md
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
  let catalog = null, config = null, polling = null, running = false, currentJobId = null, startedAt = 0, pollFailures = 0;
  let flightHours = {};

  function hoursFor(code) {
    return flightHours[code];
  }

  function meetsDuration(code, minimum) {
    if (!minimum) return true;
    const hours = hoursFor(code);
    // An unknown duration is not evidence of a short flight, so it stays in.
    return hours === undefined || hours >= minimum;
  }

  function clockTime(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? ''
      : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(parsed);
  }

  function elapsed() {
    if (!startedAt) return '';
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    return seconds >= 60 ? `${Math.floor(seconds / 60)}분 ${seconds % 60}초 경과` : `${seconds}초 경과`;
  }

  async function api(url, options) {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } });
    } catch {
      throw new Error('조회 프로그램에 연결할 수 없어요. 실행 창이 열려 있는지 확인해 주세요.');
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('결과를 불러오지 못했어요.');
    }
    if (!response.ok) {
      const failure = new Error(data.error?.message || '요청을 처리하지 못했어요.');
      failure.code = data.error?.code;
      throw failure;
    }
    return data;
  }

  function monthLabel(value) {
    const [year, month] = (value || '').split('-');
    return year && month ? `${year}년 ${Number(month)}월` : value;
  }

  /** The year is part of the date: results now span two of them, and "9월 14일"
   *  alone sent someone looking in the wrong year. */
  function prettyDate(value) {
    const parsed = new Date(value + 'T12:00:00+09:00');
    return Number.isNaN(parsed.getTime()) ? value
      : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(parsed);
  }

  function stamp(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '확인 불가'
      : new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
  }

  function airportName(code) {
    return catalog?.airports.get(code)?.name || code;
  }

  function setStatus(message, kind = 'info') {
    $('scan-status').dataset.kind = kind;
    $('scan-status-text').textContent = message;
  }

  function checkedValues(containerId) {
    return Array.from($(containerId).querySelectorAll('input:checked'), (input) => input.value);
  }

  function renderOrigins() {
    const korean = catalog.list.filter((airport) => airport.region === '대한민국');
    const container = $('scan-origins');
    container.replaceChildren();
    for (const airport of korean.slice(0, 6)) {
      const label = node('label', 'scan-check');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = airport.code;
      input.checked = airport.code === 'ICN';
      input.addEventListener('change', updateEstimate);
      label.append(input, node('span', null, `${airport.name} (${airport.code})`));
      container.append(label);
    }
  }

  function renderRegions() {
    const container = $('scan-regions');
    container.replaceChildren();
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
      input.addEventListener('change', updateEstimate);
      label.append(input, node('span', null, `${region} (${count}곳)`));
      container.append(label);
    }
  }

  function populateMonths() {
    const [minYear, minMonth] = config.minMonth.split('-').map(Number);
    const [maxYear, maxMonth] = config.maxMonth.split('-').map(Number);
    for (const select of [$('scan-start-month'), $('scan-end-month')]) {
      select.replaceChildren();
      for (let cursor = minYear * 12 + minMonth - 1; cursor <= maxYear * 12 + maxMonth - 1; cursor++) {
        const year = Math.floor(cursor / 12), month = (cursor % 12) + 1;
        const value = `${year}-${String(month).padStart(2, '0')}`;
        const option = node('option', null, monthLabel(value));
        option.value = value;
        select.append(option);
      }
    }
    $('scan-start-month').value = config.minMonth;
    $('scan-end-month').value = config.minMonth;
  }

  function direction() {
    return document.querySelector('input[name="scanDirection"]:checked')?.value ?? 'outbound';
  }

  /** The overseas side of the trip — chosen by region either way. Coming home it
   *  is the departure airport; going out it is the destination. */
  function overseasCodes() {
    const regions = checkedValues('scan-regions');
    const extra = $('scan-extra-destinations').value.trim().toUpperCase();
    const typed = extra ? extra.split(/[^A-Z]+/).filter((code) => /^[A-Z]{3}$/.test(code)) : [];
    const picked = new Set(typed);
    for (const airport of catalog?.list ?? []) if (regions.includes(airport.region)) picked.add(airport.code);
    const minimum = Number($('scan-min-hours').value) || 0;
    return [...picked].filter((code) => meetsDuration(code, minimum));
  }

  /** Regions are expanded here so the duration filter can drop short hops before
   *  the server ever looks them up. */
  function selection() {
    const overseas = overseasCodes();
    const shared = {
      regions: [],
      programs: checkedValues('scan-programs'),
      startMonth: $('scan-start-month').value,
      endMonth: $('scan-end-month').value,
    };
    if (direction() === 'inbound') {
      return { ...shared, origins: overseas.filter((code) => code !== 'ICN'), destinations: ['ICN'] };
    }
    const home = checkedValues('scan-origins');
    const chosen = home.length ? home : ['ICN'];
    return { ...shared, origins: chosen, destinations: overseas.filter((code) => !chosen.includes(code)) };
  }

  function monthCount(startMonth, endMonth) {
    const [startYear, startNumber] = startMonth.split('-').map(Number);
    const [endYear, endNumber] = endMonth.split('-').map(Number);
    return (endYear * 12 + endNumber) - (startYear * 12 + startNumber) + 1;
  }

  function applyDirection() {
    const inbound = direction() === 'inbound';
    $('scan-origin-block').hidden = inbound;
    $('scan-region-label').textContent = inbound ? '어느 지역에서 돌아올까요' : '가고 싶은 지역';
    $('scan-extra-label').textContent = inbound ? '특정 출발 공항 추가 (선택)' : '특정 공항 추가 (선택)';
  }

  function updateEstimate() {
    if (!catalog || !config) return;
    applyDirection();
    const picked = selection();
    const inbound = direction() === 'inbound';
    const regionCodes = new Set(inbound ? picked.origins : picked.destinations);
    const minimum = Number($('scan-min-hours').value) || 0;
    const dropped = (() => {
      let count = 0;
      const regions = checkedValues('scan-regions');
      for (const airport of catalog.list) {
        if (regions.includes(airport.region) && airport.code !== 'ICN' && !meetsDuration(airport.code, minimum)) count++;
      }
      return count;
    })();
    $('scan-hours-note').textContent = minimum
      ? `${minimum}시간 미만 노선 ${dropped}곳은 제외했어요. 비행시간을 모르는 공항은 남겨둬요.`
      : '비행시간에 관계없이 모두 조회해요.';
    const months = Math.max(0, monthCount(picked.startMonth, picked.endMonth));
    const combos = picked.origins.length * picked.destinations.length * months;
    const requests = combos * Math.max(1, picked.programs.length);
    const note = $('scan-estimate');
    if (!regionCodes.size && dropped > 0) {
      // Selected somewhere, but the flight-time filter left nothing to look up.
      note.textContent = `선택한 지역에 ${minimum}시간 이상 노선이 ${dropped}곳 모두 걸러져 남은 ${inbound ? '출발지' : '목적지'}가 없어요. 비행시간 조건을 낮추거나 다른 지역을 골라 주세요.`;
      note.dataset.kind = 'warn';
    } else if (!regionCodes.size) {
      note.textContent = '지역을 고르거나 공항 코드를 입력해 주세요.';
      note.dataset.kind = 'info';
    } else {
      const minutes = Math.ceil((requests * 15) / 60);
      const duration = minutes >= 60 ? `${Math.floor(minutes / 60)}시간 ${minutes % 60}분` : `${minutes}분`;
      note.textContent = `${inbound ? '출발지' : '목적지'} ${regionCodes.size}곳 × ${months}개월 = 조합 ${combos}건 · 요청 ${requests}회 · 예상 ${duration}쯤 걸려요. 한 번에 한 건씩 조회하고, 찾는 대로 아래에 바로 보여드려요. 중간에 멈출 수 있어요.`;
      note.dataset.kind = minutes > 90 ? 'warn' : 'info';
    }
    $('scan-button').disabled = running || !regionCodes.size || !picked.programs.length;
  }

  /** Its own notice, not the scan status line: a running sweep overwrites that
   *  on the next poll and the confirmation would vanish as the user read it. */
  function setBookingNotice(message, kind = 'success') {
    const box = $('booking-notice');
    box.hidden = false;
    box.dataset.kind = kind;
    $('booking-notice-text').textContent = message;
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Hands the date to the airline's own booking page, opened in the user's
   *  regular Chrome so their airline login applies. */
  async function openBooking(hit, program, origin, destination, card) {
    const airline = programNames[program] || program;
    const route = `${origin}→${destination} ${prettyDate(hit.date)}`;
    setBookingNotice(`${airline} 예매 화면을 여는 중이에요… (${route})`, 'busy');
    try {
      const result = await api('/api/open-booking', {
        method: 'POST',
        body: JSON.stringify({ program, origin, destination, date: hit.date }),
      });
      for (const opened of document.querySelectorAll('.date-card.opened')) opened.classList.remove('opened');
      card?.classList.add('opened');
      const stale = hit.sourceUpdatedAt
        ? ` 이 표시는 ${airline}이 ${stamp(hit.sourceUpdatedAt)}에 공개한 현황이라, 그 뒤에 팔렸으면 예매 화면에는 없을 수 있어요.`
        : ' 공개 현황은 실시간이 아니라, 그 뒤에 팔렸으면 예매 화면에는 없을 수 있어요.';
      setBookingNotice((result.prefilled
        ? `${airline} 예매 화면을 Chrome에 열었어요 (${route}). 창이 안 보이면 Chrome을 확인해 주세요. 로그인 전이면 로그인 화면이 먼저 나오니, 로그인한 뒤 이 날짜를 다시 눌러 주세요.`
        : `${airline} 마일리지 예매 화면을 Chrome에 열었어요. ${route} 조건을 직접 입력해 주세요 — 아시아나는 노선·날짜를 주소로 전달할 수 없어요.`) + stale);
    } catch (error) {
      setBookingNotice(error.message, 'error');
    }
  }

  function renderHits(job) {
    const results = $('scan-results');
    results.replaceChildren();
    const hits = job.hits || [];
    if (!hits.length) {
      const empty = node('div', 'panel empty');
      empty.append(node('div', 'empty-icon', '▦'),
        node('strong', null, job.status === 'complete' ? '비즈니스석 표시가 있는 날짜가 없어요.' : '아직 찾은 좌석이 없어요.'),
        node('p', null, job.status === 'complete'
          ? '조회한 범위에서는 공개 현황에 비즈니스 보너스 표시가 없었어요. 조회 실패나 실시간 매진을 뜻하지는 않아요.'
          : '조회가 진행되는 대로 결과가 여기에 쌓여요.'));
      results.append(empty);
      return;
    }
    // First class is grouped on its own: Korean Air prints one combined
    // "보너스/좌석승급" marker, so it is a different kind of find from business.
    const byRoute = new Map();
    for (const hit of hits) {
      for (const cabin of hit.cabins ?? ['prestige']) {
        const key = `${hit.program}|${hit.origin}|${hit.destination}|${cabin}`;
        if (!byRoute.has(key)) byRoute.set(key, []);
        byRoute.get(key).push(hit);
      }
    }
    // Newest finding first while a scan is live, so results read as they arrive.
    const ordered = [...byRoute.entries()].sort((a, b) => running
      ? String(b[1][0]?.foundAt || '').localeCompare(String(a[1][0]?.foundAt || ''))
      : b[1].length - a[1].length);
    for (const [key, routeHits] of ordered) {
      const [program, origin, destination, cabin = 'prestige'] = key.split('|');
      const first = cabin === 'first';
      const panel = node('section', 'panel leg-panel' + (first ? ' first-class' : ''));
      const top = node('div', 'leg-top'), detail = node('div');
      detail.append(node('span', 'direction' + (first ? ' first-tag' : ''),
        `${programNames[program] || program} · ${first ? '일등석' : '비즈니스'}`));
      const route = node('div', 'route-line');
      route.append(node('h3', null, origin), node('span', 'arrow', '→'), node('h3', null, destination));
      const overseas = origin === 'ICN' ? destination : origin;
      const hours = hoursFor(overseas);
      detail.append(route, node('div', 'route-details',
        `${airportName(overseas)} · ${first ? '일등석 보너스 또는 좌석승급' : '비즈니스 보너스 좌석'}${hours ? ` · 약 ${hours}시간` : ''}`));
      const count = node('div', 'result-count');
      count.append(node('strong', null, String(routeHits.length)), node('span', null, '개'),
        node('div', 'count-label', '좌석 표시가 있는 날짜'));
      top.append(detail, count);
      panel.append(top);
      // The airline's reference time is the one that matters. Ours only says when
      // we read their daily snapshot, and showing it alone reads as "live".
      const sample = routeHits[0] ?? {};
      const notes = [];
      if (sample.sourceUpdatedAt) notes.push(`대한항공 공개 기준 ${stamp(sample.sourceUpdatedAt)}`);
      if (sample.collectedAt ?? sample.foundAt) notes.push(`가져온 시각 ${stamp(sample.collectedAt ?? sample.foundAt)}`);
      if (notes.length) {
        panel.append(node('p', 'coverage-note', `${notes.join(' · ')} — 실시간 잔여석이 아니에요`));
      }
      if (first) {
        panel.append(node('p', 'coverage-note result-warning',
          '대한항공은 일등석 보너스와 좌석승급을 한 표시로 묶어서 공개해요. 둘 중 어느 쪽인지는 대한항공 화면에서 확인해 주세요.'));
      }
      const grid = node('div', 'date-grid');
      for (const hit of routeHits.sort((a, b) => a.date.localeCompare(b.date))) {
        const card = node('button', 'date-card');
        card.type = 'button';
        card.setAttribute('aria-label',
          `${hit.date} ${origin}→${destination} ${first ? '일등석' : '비즈니스'} 예매 화면 열기`);
        card.append(node('span', 'date-top', `${hit.date.slice(0, 4)}년 ${Number(hit.date.slice(5, 7))}월`),
          node('span', 'date-number', String(Number(hit.date.slice(8, 10)))),
          node('span', 'date-badge' + (first ? ' first-badge' : ''), first ? '일등석' : '비즈니스'));
        // The live answer overrides the calendar's: it is the one that can be booked.
        if (hit.live === 'available') {
          card.classList.add('live-ok');
          card.append(node('span', 'date-live ok', '실시간 확인됨'));
        } else if (hit.live === 'gone') {
          card.classList.add('live-gone');
          card.append(node('span', 'date-live gone', '방금 나갔어요'));
        } else if (hit.live === 'unchecked') {
          card.append(node('span', 'date-live unknown', '실시간 확인 못함'));
        }
        card.append(node('span', 'date-go', '예매하기 ↗'));
        card.addEventListener('click', () => void openBooking(hit, program, origin, destination, card));
        grid.append(card);
      }
      panel.append(grid);
      results.append(panel);
    }
  }

  async function poll(jobId) {
    try {
      const job = await api(`/api/business-scan/jobs/${jobId}`);
      pollFailures = 0;
      const percent = job.total ? Math.round((job.completed / job.total) * 100) : 0;
      const live = job.status === 'running' || job.status === 'queued';
      if (job.status === 'interrupted') {
        clearInterval(polling);
        polling = null;
        running = false;
        currentJobId = null;
        $('scan-cancel').hidden = true;
        $('scan-button').textContent = '비즈니스석 검색';
        setStatus(`${job.message} (${job.completed}/${job.total})`, 'error');
        renderHits(job);
        updateEstimate();
        return;
      }
      let detail = `${job.completed}/${job.total} · ${percent}%`;
      if (live && job.completed > 0) {
        const perLeg = (Date.now() - startedAt) / job.completed;
        const remaining = Math.ceil((perLeg * (job.total - job.completed)) / 60000);
        detail += ` · ${elapsed()} · 남은 시간 약 ${remaining}분`;
      }
      const found = (job.hits || []).length;
      setStatus(`${job.message || '조회 중이에요.'} (${detail}${found ? ` · 지금까지 ${found}건 발견` : ''})`,
        job.status === 'failed' ? 'error' : job.status === 'complete' ? 'success' : 'busy');
      renderHits(job);
      if (live) return;
      clearInterval(polling);
      polling = null;
      running = false;
      currentJobId = null;
      $('scan-cancel').hidden = true;
      $('scan-button').textContent = '비즈니스석 검색';
      const notes = [];
      if ((job.skipped || []).length) {
        const routes = job.skipped.slice(0, 6).map((key) => {
          const [program, origin, destination] = key.split('|');
          return `${programNames[program] || program} ${origin}→${destination}`;
        });
        notes.push(`미취항으로 확인돼 건너뛴 노선 ${job.skipped.length}개: ${routes.join(', ')}${job.skipped.length > 6 ? ' 외' : ''} (다음 검색부터 자동으로 제외해요)`);
      }
      if ((job.failures || []).length) {
        const lines = job.failures.slice(0, 5).map((f) => `${programNames[f.program] || f.program} ${f.origin || ''}${f.destination ? '→' + f.destination : ''} ${f.month || ''}`.trim());
        notes.push(`조회하지 못한 구간 ${job.failures.length}건: ${lines.join(', ')}${job.failures.length > 5 ? ' 외' : ''} — 좌석이 없다는 뜻은 아니에요.`);
      }
      $('scan-failures').textContent = notes.join(' · ');
      updateEstimate();
    } catch (error) {
      // A job the server no longer knows is gone for good — it died with the
      // process that held it. Retrying cannot bring it back, so say so plainly.
      if (error.code === 'JOB_NOT_FOUND') {
        clearInterval(polling);
        polling = null;
        running = false;
        currentJobId = null;
        $('scan-cancel').hidden = true;
        $('scan-button').textContent = '비즈니스석 검색';
        setStatus('조회 프로그램이 다시 시작되어 이번 조회는 중단됐어요. 검색을 다시 눌러 주세요.', 'error');
        updateEstimate();
        return;
      }
      // A dropped connection is different: the sweep is still running, so a
      // brief outage must not throw it away.
      pollFailures += 1;
      if (pollFailures < 8) {
        setStatus(`조회 상태를 확인하지 못했어요. 다시 시도하고 있어요… (${pollFailures}/8)`, 'busy');
        return;
      }
      clearInterval(polling);
      polling = null;
      running = false;
      currentJobId = null;
      $('scan-cancel').hidden = true;
      $('scan-button').textContent = '비즈니스석 검색';
      setStatus(`${error.message} 조회는 계속되고 있을 수 있어요. 검색을 다시 누르면 현재 상태를 확인해요.`, 'error');
      updateEstimate();
    }
  }

  async function cancelScan() {
    if (!currentJobId) return;
    $('scan-cancel').disabled = true;
    try {
      await api('/api/business-scan/cancel', { method: 'POST', body: JSON.stringify({ jobId: currentJobId }) });
      setStatus('조회를 멈추고 있어요. 진행 중인 1건이 끝나면 멈춰요.', 'busy');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      $('scan-cancel').disabled = false;
    }
  }

  async function startScan(event) {
    event.preventDefault();
    if (running) return;
    try {
      running = true;
      startedAt = Date.now();
      pollFailures = 0;
      $('scan-button').disabled = true;
      $('scan-button').textContent = '조회 중이에요…';
      $('scan-failures').textContent = '';
      setStatus('조회를 시작하고 있어요. 창은 화면 밖에서 열리므로 보이지 않아요.', 'busy');
      const { jobId } = await api('/api/business-scan', { method: 'POST', body: JSON.stringify(selection()) });
      currentJobId = jobId;
      $('scan-cancel').hidden = false;
      polling = setInterval(() => void poll(jobId), 1500);
      void poll(jobId);
    } catch (error) {
      running = false;
      currentJobId = null;
      $('scan-cancel').hidden = true;
      $('scan-button').textContent = '비즈니스석 검색';
      setStatus(error.message, 'error');
      updateEstimate();
    }
  }

  function showTab(name) {
    $('scan-tab-panel').hidden = name !== 'scan';
    $('watch-tab-panel').hidden = name !== 'watch';
    for (const section of ['search-section', 'award-area', 'results-area']) {
      const element = document.getElementById(section);
      if (element) element.hidden = name !== 'single' || element.dataset.hiddenByProgram === 'true';
    }
    for (const [id, tab] of [['tab-single', 'single'], ['tab-scan', 'scan'], ['tab-watch', 'watch']]) {
      $(id).setAttribute('aria-selected', String(name === tab));
    }
    if (name === 'watch') window.WatchesUI?.reload();
  }

  async function init() {
    $('tab-single').addEventListener('click', () => showTab('single'));
    $('tab-scan').addEventListener('click', () => showTab('scan'));
    $('tab-watch').addEventListener('click', () => showTab('watch'));
    $('scan-form').addEventListener('submit', startScan);
    $('scan-cancel').addEventListener('click', cancelScan);
    $('scan-start-month').addEventListener('change', updateEstimate);
    $('scan-end-month').addEventListener('change', updateEstimate);
    $('scan-extra-destinations').addEventListener('input', updateEstimate);
    $('scan-min-hours').addEventListener('change', updateEstimate);
    for (const input of $('scan-direction').querySelectorAll('input')) input.addEventListener('change', updateEstimate);
    for (const input of $('scan-programs').querySelectorAll('input')) input.addEventListener('change', updateEstimate);
    try {
      const [routes, appConfig, hours] = await Promise.all([
        api('/api/routes'), api('/api/config'), api('/api/flight-hours').catch(() => ({ hours: {} })),
      ]);
      flightHours = hours.hours || {};
      const airports = new Map();
      for (const airport of routes.airports) airports.set(airport.code, airport);
      catalog = { airports, list: routes.airports };
      config = appConfig;
      renderOrigins();
      renderRegions();
      populateMonths();
      updateEstimate();
      setStatus('출발 공항과 가고 싶은 지역, 기간을 고른 뒤 검색해 주세요.');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else void init();
})();
