/* ============================================
   人脈管理 — 主邏輯（列表 / 篩選 / 搜尋 / Toast）
============================================ */

(function () {
  'use strict';

  // ─── 全域狀態 ───
  const state = {
    people: [],          // 從 API 取回的全部人脈（cache）
    groups: [],          // 群組 cache
    bucketFilter: ['primary', 'normal', 'watching'],  // 預設「進行中」
    roleFilter: [],      // 角色篩選（多選）
    searchTerm: '',
    extraFilters: {
      warning: false,
      stale: false,
      incomplete: false,
      agentNoAuth: false,
    },
    showMode: 'all',  // 'all' | 'people' | 'groups'
    viewMode: localStorage.getItem('people_view_mode') || 'grid',  // 'grid' | 'sections' | 'kanban'
    sellerRolesCache: {},
  };

  // ─── 角色標籤對應顯示 ───
  const ROLE_DISPLAY = {
    buyer: { label: '買方', cls: 'role-buyer' },
    seller: { label: '賣方', cls: 'role-seller' },
    introducer: { label: '介紹人', cls: 'role-introducer' },
    peer: { label: '同業', cls: 'role-peer' },
    landlord: { label: '房東', cls: 'role-landlord' },
    owner_friend: { label: '屋主朋友', cls: 'role-other' },
    friend: { label: '朋友', cls: 'role-other' },
    relative: { label: '親戚', cls: 'role-other' },
  };

  // ─── 工具函式 ───
  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function daysSince(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
  }

  function showToast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'danger' ? ' danger' : '');
    clearTimeout(el._timer);
    el._timer = setTimeout(() => { el.className = 'toast'; }, 2400);
  }
  // 全域曝露給 form 用
  window.showToast = showToast;

  function nameInitial(name) {
    if (!name) return '?';
    return name.trim().charAt(0);
  }

  // ─── API 呼叫 ───
  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined && !(body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    } else if (body instanceof FormData) {
      opts.body = body;
    }
    const r = await fetch(url, opts);
    let data = null;
    try { data = await r.json(); } catch (_) {}
    if (!r.ok) {
      const msg = (data && data.error) || `HTTP ${r.status}`;
      throw new Error(msg);
    }
    return data;
  }
  window.api = api;

  // ─── 載入：人 + 群組統一從 /api/people 來（is_group 區分）───
  async function loadPeople() {
    $('#statusBar').textContent = '載入中...';
    try {
      const data = await api('GET', '/api/people?limit=500');
      const all = data.items || [];
      state.people = all.filter(x => !x.is_group);
      state.groups = all.filter(x => x.is_group);
      $('#statusBar').textContent = `共 ${state.people.length} 位人脈、${state.groups.length} 個群組`;
      render();
    } catch (e) {
      $('#statusBar').textContent = `載入失敗：${e.message}`;
      showToast('載入失敗：' + e.message, 'danger');
    }
  }

  // ─── Sidebar 各篩選分類計數（人 + 群組總和）───
  function updateSidebarCounts() {
    const all = [...state.people, ...state.groups];
    // bucket counts
    const byBucket = {};
    for (const p of all) {
      const b = p.bucket || 'normal';
      byBucket[b] = (byBucket[b] || 0) + 1;
    }
    // 已成交 tab 是複合：bucket=closed OR has_completed_deal
    const closedCount = all.filter(p => p.bucket === 'closed' || p.has_completed_deal).length;
    const progressCount = ['primary', 'normal', 'watching'].reduce((s, b) => s + (byBucket[b] || 0), 0);

    $$('.bucket-tab').forEach(btn => {
      const buckets = (btn.dataset.bucket || '').split(',').filter(Boolean);
      let count;
      if (buckets.length === 1 && buckets[0] === 'closed') {
        count = closedCount;
      } else if (buckets.length > 1) {
        // 進行中合併 tab
        count = progressCount;
      } else if (buckets.length === 1) {
        count = byBucket[buckets[0]] || 0;
      } else {
        count = 0;
      }
      // 移掉舊 count，加新的（用 span 才能套樣式）
      const baseText = (btn.dataset.label || btn.textContent.replace(/\s*\(\d+\)\s*$/, '').trim());
      if (!btn.dataset.label) btn.dataset.label = baseText;
      btn.innerHTML = baseText + '<span class="count-suffix"> (' + count + ')</span>';
    });

    // 角色 count
    const byRole = {};
    for (const p of all) {
      for (const r of (p.active_roles || [])) {
        byRole[r] = (byRole[r] || 0) + 1;
      }
    }
    $$('.chk input[data-role]').forEach(cb => {
      const role = cb.dataset.role;
      const count = byRole[role] || 0;
      const lbl = cb.parentElement;
      // 找標籤裡的 .count-suffix；沒有就建立
      let suf = lbl.querySelector('.count-suffix');
      if (!suf) {
        suf = document.createElement('span');
        suf.className = 'count-suffix';
        lbl.appendChild(suf);
      }
      suf.textContent = ' (' + count + ')';
    });

    // 額外條件 count
    const warningCount = all.filter(p => p.warning).length;
    const staleCount = all.filter(p => {
      const d = daysSince(p.last_contact_at);
      return d != null && d >= 30;
    }).length;
    const incompleteCount = all.filter(p => (p.missing_required_count || 0) > 0).length;

    setExtraCount('filterWarning', warningCount);
    setExtraCount('filterStale', staleCount);
    setExtraCount('filterIncomplete', incompleteCount);
  }

  function setExtraCount(checkboxId, count) {
    const cb = document.getElementById(checkboxId);
    if (!cb) return;
    const lbl = cb.parentElement;
    let suf = lbl.querySelector('.count-suffix');
    if (!suf) {
      suf = document.createElement('span');
      suf.className = 'count-suffix';
      lbl.appendChild(suf);
    }
    suf.textContent = ' (' + count + ')';
  }

  // ─── 群組過濾（已是 person，bucket 一致）───
  function passesGroupFilters(g) {
    // bucket 跟人一致過濾
    if (state.bucketFilter.length > 0) {
      const isClosedOnly = state.bucketFilter.length === 1 && state.bucketFilter[0] === 'closed';
      if (isClosedOnly) {
        if (g.bucket !== 'closed' && !g.has_completed_deal) return false;
      } else if (!state.bucketFilter.includes(g.bucket)) {
        return false;
      }
    }
    if (state.searchTerm) {
      const q = state.searchTerm.toLowerCase();
      const hay = ((g.name || '') + ' ' + (g.warning || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.roleFilter.length > 0) {
      const active = g.active_roles || [];
      if (!state.roleFilter.some(r => active.includes(r))) return false;
    }
    if (state.extraFilters.warning && !g.warning) return false;
    if (state.extraFilters.stale) {
      const d = daysSince(g.last_contact_at);
      if (d == null || d < 30) return false;
    }
    return true;
  }

  // ─── 群組卡片：跟人卡同大小，但用淡黃底 + 頭像疊圖 + 👥 前綴 + 「群組」徽章 ───
  function renderGroupCard(g) {
    const memberCount = (g.members || []).length;
    const typeLabel = g.group_type === 'permanent' ? '永久' : '一次性';

    // 取前 3 位成員頭像合成
    const memberAvatars = (g.members || []).slice(0, 3).map(mid => {
      const m = state.people.find(p => p.id === mid);
      if (!m) return '<div class="g-mini-avatar">?</div>';
      const init = (m.name || '?').charAt(0);
      const av = m.avatar_b64
        ? `<img src="${m.avatar_b64.startsWith('data:') ? m.avatar_b64 : 'data:image/jpeg;base64,'+m.avatar_b64}">`
        : escapeHtml(init);
      return `<div class="g-mini-avatar">${av}</div>`;
    }).join('');

    const days = daysSince(g.last_contact_at);
    const cardClasses = ['person-card', 'group-list-card'];
    if (g.warning) cardClasses.push('has-warning');
    if (days != null && days >= 30) cardClasses.push('is-stale-red');
    else if (days != null && days >= 14) cardClasses.push('is-stale-yellow');

    const lastContactLabel = (() => {
      if (days == null) return '<span class="last-contact-badge">未互動</span>';
      if (days === 0) return '<span class="last-contact-badge">今天</span>';
      if (days >= 30) return `<span class="last-contact-badge stale-red">⚠ ${days} 天</span>`;
      if (days >= 14) return `<span class="last-contact-badge stale-yellow">${days} 天前</span>`;
      return `<span class="last-contact-badge">${days} 天前</span>`;
    })();

    return `
      <div class="${cardClasses.join(' ')}" data-kind="group" data-id="${g.id}" draggable="true">
        <span class="group-badge">👥 群組</span>
        <div class="card-top">
          <div class="avatar group-avatar">
            <div class="g-mini-stack">${memberAvatars || '👨‍👩‍👧'}</div>
          </div>
          <div class="card-name">
            <div class="card-name-title">${escapeHtml(g.name)}</div>
            <div class="card-name-sub">${memberCount} 位成員 · ${typeLabel}</div>
          </div>
        </div>
        <div class="card-bottom">
          ${lastContactLabel}
          ${g.warning ? `<span class="warning-icon" title="${escapeHtml(g.warning)}">⚠️</span>` : ''}
        </div>
      </div>
    `;
  }

  // ─── 篩選邏輯 ───
  function passesFilters(p) {
    // bucket
    if (state.bucketFilter.length > 0) {
      // 「已成交」tab 特例：bucket=closed OR has_completed_deal（任一角色 status=成交/已成交）
      const isClosedOnly = state.bucketFilter.length === 1 && state.bucketFilter[0] === 'closed';
      if (isClosedOnly) {
        if (p.bucket !== 'closed' && !p.has_completed_deal) return false;
      } else if (!state.bucketFilter.includes(p.bucket)) {
        return false;
      }
    }
    // role（任一勾選的角色都要有）
    if (state.roleFilter.length > 0) {
      const active = p.active_roles || [];
      const hasAny = state.roleFilter.some(r => active.includes(r));
      if (!hasAny) return false;
    }
    // 搜尋
    if (state.searchTerm) {
      const q = state.searchTerm.toLowerCase();
      const hay = [
        p.name || '',
        p.display_name || '',
        p.company || '',
        ...(p.contacts || []).map(c => c.value || ''),
        ...(p.addresses || []).map(a => a.value || ''),
      ].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    // 警示語
    if (state.extraFilters.warning && !p.warning) return false;
    // 30 天沒聯絡
    if (state.extraFilters.stale) {
      const d = daysSince(p.last_contact_at);
      if (d == null || d < 30) return false;
    }
    // 資訊不完整（任一必要欄位未填）
    if (state.extraFilters.incomplete && (p.missing_required_count || 0) === 0) return false;
    // 代理人缺授權書（這個比較貴，後面 render 時再判斷）
    return true;
  }

  // ─── 渲染卡片 ───
  // 取得「過濾＋排序」後的混合 items
  function getFilteredItems(forceShowAllBuckets = false) {
    const showPeople = state.showMode !== 'groups';
    const showGroups = state.showMode !== 'people';

    // 分區/看板模式時，bucket 過濾交給各區段自己處理（不靠 sidebar bucketFilter）
    const passes = forceShowAllBuckets
      ? p => passesFiltersIgnoreBucket(p)
      : passesFilters;
    const passesG = forceShowAllBuckets
      ? g => passesGroupFiltersIgnoreBucket(g)
      : passesGroupFilters;

    const peopleItems = showPeople ? state.people.filter(passes) : [];
    const groupItems  = showGroups ? state.groups.filter(passesG) : [];

    const sortKey = (it) => it.last_contact_at || it.updated_at || '';
    return [
      ...peopleItems.map(p => ({ kind: 'person', data: p })),
      ...groupItems.map(g => ({ kind: 'group', data: g })),
    ].sort((a, b) => {
      const ao = a.data.sort_order, bo = b.data.sort_order;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      return (sortKey(b.data) || '').localeCompare(sortKey(a.data) || '');
    });
  }

  // 同 passesFilters 但忽略 bucketFilter（給分區/看板用）
  function passesFiltersIgnoreBucket(p) {
    const orig = state.bucketFilter;
    state.bucketFilter = [];
    const r = passesFilters(p);
    state.bucketFilter = orig;
    return r;
  }
  function passesGroupFiltersIgnoreBucket(g) {
    const orig = state.bucketFilter;
    state.bucketFilter = [];
    const r = passesGroupFilters(g);
    state.bucketFilter = orig;
    return r;
  }

  function render() {
    updateSidebarCounts();
    // 切換 view 容器顯示
    $('#cardGrid').style.display = state.viewMode === 'grid' ? '' : 'none';
    $('#sectionsView').style.display = state.viewMode === 'sections' ? '' : 'none';
    $('#kanbanView').style.display = state.viewMode === 'kanban' ? '' : 'none';

    if (state.viewMode === 'sections') return renderSections();
    if (state.viewMode === 'kanban')  return renderKanban();
    return renderGrid();
  }

  function attachCardHandlers(scope) {
    (scope || document).querySelectorAll('.person-card').forEach(card => {
      card.addEventListener('click', onCardClick);
      card.addEventListener('dragstart', onCardDragStart);
      card.addEventListener('dragover', onCardDragOver);
      card.addEventListener('dragleave', onCardDragLeave);
      card.addEventListener('drop', onCardDrop);
      card.addEventListener('dragend', onCardDragEnd);
      card.addEventListener('touchstart', onCardTouchStart, { passive: false });
      card.addEventListener('touchmove', onCardTouchMove, { passive: false });
      card.addEventListener('touchend', onCardTouchEnd);
      card.addEventListener('touchcancel', onCardTouchEnd);
      // 桌面右鍵 → 選單
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showCardCtxMenu(card, e.clientX, e.clientY);
      });
    });
  }

  // ─── A：原有卡片網格 ───
  function renderGrid() {
    const grid = $('#cardGrid');
    const empty = $('#emptyState');
    const items = getFilteredItems(false);

    if (items.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      $('#statusBar').textContent = '此分類目前沒有資料';
      return;
    }
    empty.style.display = 'none';
    grid.innerHTML = items.map(it => it.kind === 'group' ? renderGroupCard(it.data) : renderCard(it.data)).join('');

    const peopleCount = items.filter(i => i.kind === 'person').length;
    const groupCount = items.length - peopleCount;
    $('#statusBar').textContent =
      `顯示 ${peopleCount} 位人脈 + ${groupCount} 個群組` +
      `（共 ${state.people.length} / ${state.groups.length}）`;

    attachCardHandlers(grid);
  }

  // ─── B：分區瀏覽（4 個 bucket 一頁看） ───
  const SECTION_BUCKETS = [
    { key: 'primary',  label: '⭐ 主力' },
    { key: 'normal',   label: '一般' },
    { key: 'watching', label: '👀 觀察' },
    { key: 'frozen',   label: '🧊 冷凍' },
  ];

  function renderSections() {
    const container = $('#sectionsView');
    const empty = $('#emptyState');
    empty.style.display = 'none';
    const items = getFilteredItems(true);
    // 按 bucket 分組
    const byBucket = {};
    SECTION_BUCKETS.forEach(s => byBucket[s.key] = []);
    items.forEach(it => {
      const b = it.data.bucket || 'normal';
      if (byBucket[b]) byBucket[b].push(it);
    });

    container.innerHTML = SECTION_BUCKETS.map(s => {
      const list = byBucket[s.key] || [];
      const cards = list.length
        ? list.map(it => it.kind === 'group' ? renderGroupCard(it.data) : renderCard(it.data)).join('')
        : '<div class="section-block-empty">這個分類目前沒有資料 — 拖曳卡片到這裡可改分類</div>';
      return `
        <div class="section-block" data-bucket="${s.key}">
          <div class="section-block-header">
            <div class="section-block-title">${s.label}</div>
            <span class="section-block-count">${list.length}</span>
          </div>
          <div class="section-block-grid">${cards}</div>
        </div>
      `;
    }).join('');

    $('#statusBar').textContent =
      `分區瀏覽：${SECTION_BUCKETS.map(s => `${s.label} ${byBucket[s.key].length}`).join(' · ')}`;

    attachCardHandlers(container);
    attachBucketContainerHandlers(container.querySelectorAll('.section-block'));
  }

  // ─── C：看板（4 欄並排） ───
  function renderKanban() {
    const container = $('#kanbanView');
    const empty = $('#emptyState');
    empty.style.display = 'none';
    const items = getFilteredItems(true);
    const byBucket = {};
    SECTION_BUCKETS.forEach(s => byBucket[s.key] = []);
    items.forEach(it => {
      const b = it.data.bucket || 'normal';
      if (byBucket[b]) byBucket[b].push(it);
    });

    container.innerHTML = SECTION_BUCKETS.map(s => {
      const list = byBucket[s.key] || [];
      const cards = list.length
        ? list.map(it => it.kind === 'group' ? renderGroupCard(it.data) : renderCard(it.data)).join('')
        : '<div class="kanban-col-empty">空 — 拖曳到此</div>';
      return `
        <div class="kanban-col" data-bucket="${s.key}">
          <div class="kanban-col-header">
            <div class="kanban-col-title">${s.label}</div>
            <span class="kanban-col-count">${list.length}</span>
          </div>
          ${cards}
        </div>
      `;
    }).join('');

    $('#statusBar').textContent =
      `看板：${SECTION_BUCKETS.map(s => `${s.label} ${byBucket[s.key].length}`).join(' · ')}`;

    attachCardHandlers(container);
    attachBucketContainerHandlers(container.querySelectorAll('.kanban-col'));
  }

  // 分區 / 看板的「容器」拖放：拖卡片到不同 bucket 容器 → 改 bucket
  function attachBucketContainerHandlers(containers) {
    containers.forEach(el => {
      el.addEventListener('dragover', (e) => {
        if (!_draggingId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('is-drop-target');
      });
      el.addEventListener('dragleave', (e) => {
        // 只在離開容器本身時移除（不是子元素）
        if (e.target === el) el.classList.remove('is-drop-target');
      });
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-drop-target');
        const newBucket = el.dataset.bucket;
        if (!_draggingId || !newBucket) return;
        // 若 drop 落在卡片上會走 onCardDrop，這裡只處理空白區
        if (e.target.closest('.person-card')) return;
        changeBucket(_draggingId, newBucket);
      });
    });
  }

  function renderCard(p) {
    const days = daysSince(p.last_contact_at);
    const cardClasses = ['person-card'];
    if (p.warning) cardClasses.push('has-warning');
    if (days != null && days >= 30) cardClasses.push('is-stale-red');
    else if (days != null && days >= 14) cardClasses.push('is-stale-yellow');

    const lastContactLabel = (() => {
      if (days == null) return '<span class="last-contact-badge">未聯絡</span>';
      if (days === 0) return '<span class="last-contact-badge">今天</span>';
      if (days >= 30) return `<span class="last-contact-badge stale-red">⚠ ${days} 天沒聯絡</span>`;
      if (days >= 14) return `<span class="last-contact-badge stale-yellow">${days} 天前</span>`;
      return `<span class="last-contact-badge">${days} 天前</span>`;
    })();

    const avatar = p.avatar_b64
      ? `<img src="${p.avatar_b64.startsWith('data:') ? p.avatar_b64 : 'data:image/jpeg;base64,' + p.avatar_b64}" alt="">`
      : escapeHtml(nameInitial(p.name));

    const pills = (p.active_roles || []).map(r => {
      const cfg = ROLE_DISPLAY[r] || { label: r, cls: 'role-other' };
      return `<span class="role-pill ${cfg.cls}">${escapeHtml(cfg.label)}</span>`;
    }).join('');

    const subline = (() => {
      const parts = [];
      if (p.display_name) parts.push(p.display_name);
      const phone = (p.contacts || []).find(c => c.type === 'mobile' || c.type === 'home' || c.type === 'work');
      if (phone) parts.push(phone.value);
      return parts.join(' · ');
    })();

    // 卡片底色（hex 色碼，例 #d6f5d6）
    const colorStyle = p.card_color ? ` style="background:${escapeHtml(p.card_color)};"` : '';

    return `
      <div class="person-card ${cardClasses.slice(1).join(' ')}" data-id="${p.id}" draggable="true"${colorStyle}>
        <div class="card-top">
          <div class="avatar">${avatar}</div>
          <div class="card-name">
            <div class="card-name-title">${escapeHtml(p.name)}</div>
            ${subline ? `<div class="card-name-sub">${escapeHtml(subline)}</div>` : ''}
          </div>
        </div>
        ${pills ? `<div class="card-pills">${pills}</div>` : ''}
        <div class="card-bottom">
          ${lastContactLabel}
          <span class="card-bottom-icons">
            ${(p.missing_required_count || 0) > 0 ? `<span class="info-incomplete-badge" title="${p.missing_required_count} 項必要資訊未填">❗ 缺 ${p.missing_required_count}</span>` : ''}
            ${p.warning ? `<span class="warning-icon" title="${escapeHtml(p.warning)}">⚠️</span>` : ''}
          </span>
        </div>
      </div>
    `;
  }

  // ═════════════════════════════════════════
  //  拖曳：reorder 卡片 + 拖到 bucket tab 改分類
  // ═════════════════════════════════════════
  let _draggingId = null;
  let _wasDragging = false;  // dragend 後短時間 true，避免 click 誤觸

  function onCardClick(e) {
    if (_wasDragging) { e.preventDefault(); return; }
    // 群組現在也是 person，URL 統一
    window.location.href = '/people/' + e.currentTarget.dataset.id;
  }

  let _draggingKind = null;  // 'person' | 'group'

  function onCardDragStart(e) {
    _draggingId = e.currentTarget.dataset.id;
    _draggingKind = e.currentTarget.dataset.kind || 'person';
    _wasDragging = false;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', _draggingId); } catch (_) {}
    e.currentTarget.classList.add('dragging');
  }

  // 清除所有插入線標記
  function clearDropIndicators() {
    $$('.drop-before, .drop-after').forEach(el => {
      el.classList.remove('drop-before', 'drop-after');
    });
  }

  function onCardDragOver(e) {
    if (!_draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const card = e.currentTarget;
    if (card.dataset.id === _draggingId) return;

    // 分區 / 看板模式 + 同類拖曳 → 顯示插入線（reorder 模式）
    // 卡片網格模式：人→人 預設是建群組，僅 Shift 時 reorder；不畫線（避免誤導）
    const targetKind = card.dataset.kind || 'person';
    const isReorderContext =
      state.viewMode !== 'grid' ||
      e.shiftKey ||
      _draggingKind === 'group' ||
      targetKind === 'group';

    if (isReorderContext) {
      const rect = card.getBoundingClientRect();
      const isUpperHalf = (e.clientY - rect.top) < (rect.height / 2);
      // 先清掉自己舊的 marker
      card.classList.remove('drop-before', 'drop-after', 'drop-target');
      card.classList.add(isUpperHalf ? 'drop-before' : 'drop-after');
    } else {
      card.classList.remove('drop-before', 'drop-after');
      card.classList.add('drop-target');
    }
  }
  function onCardDragLeave(e) {
    e.currentTarget.classList.remove('drop-target', 'drop-before', 'drop-after');
  }

  function onCardDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const card = e.currentTarget;
    const insertBefore = card.classList.contains('drop-before');
    const insertAfter = card.classList.contains('drop-after');
    card.classList.remove('drop-target', 'drop-before', 'drop-after');
    const targetId = card.dataset.id;
    const targetKind = card.dataset.kind || 'person';
    if (!_draggingId || _draggingId === targetId) return;

    // 拖人 → 群組：加成員
    if (_draggingKind === 'person' && targetKind === 'group' && !insertBefore && !insertAfter) {
      addMemberToGroup(targetId, _draggingId);
      return;
    }
    // 拖人 → 人（卡片網格模式 + 沒按 Shift）：預設建群組
    if (_draggingKind === 'person' && targetKind === 'person' && state.viewMode === 'grid' && !e.shiftKey) {
      const draggedPerson = state.people.find(p => p.id === _draggingId);
      const targetPerson = state.people.find(p => p.id === targetId);
      offerCreateGroup(draggedPerson, targetPerson);
      return;
    }
    // 其他狀況都是 reorder（含 sections / kanban view）
    // 若是分區/看板，且目標卡片所屬 bucket 與拖曳卡不同，先改 bucket 再 reorder
    const containerEl = card.closest('[data-bucket]');
    const targetBucket = containerEl ? containerEl.dataset.bucket : null;
    const dragged = state.people.find(p => p.id === _draggingId) || state.groups.find(g => g.id === _draggingId);
    if (targetBucket && dragged && dragged.bucket !== targetBucket) {
      changeBucket(_draggingId, targetBucket).then(() => {
        // bucket 變更後再 reorder
        reorderCard(_draggingId, targetId, insertAfter ? 'after' : 'before');
      });
    } else {
      reorderCard(_draggingId, targetId, insertAfter ? 'after' : 'before');
    }
  }

  async function addMemberToGroup(groupId, personId) {
    const g = state.groups.find(x => x.id === groupId);
    const p = state.people.find(x => x.id === personId);
    if (!g || !p) return;
    if ((g.members || []).includes(personId)) {
      showToast(`「${p.name}」已在此群組中`);
      return;
    }
    try {
      await api('POST', `/api/people/${groupId}/members/${personId}`);
      showToast(`✓ 已把「${p.name}」加進群組「${g.name}」`);
      await loadPeople();
    } catch (e) {
      showToast('加成員失敗：' + e.message, 'danger');
    }
  }

  async function offerCreateGroup(personA, personB) {
    if (!personA || !personB) return;
    const defaultName = `${personA.name} × ${personB.name}`;
    const name = prompt(
      `要把這兩位放成新群組嗎？\n\n• ${personA.name}\n• ${personB.name}\n\n群組名稱（可改）：`,
      defaultName
    );
    if (name === null) return;
    if (!name.trim()) {
      showToast('群組名稱不能空白', 'danger');
      return;
    }
    try {
      const data = await api('POST', '/api/people', {
        name: name.trim(),
        is_group: true,
        group_type: 'temporary',
        members: [personA.id, personB.id],
      });
      showToast(`✓ 已建立群組「${data.name || name}」`);
      await loadPeople();
    } catch (e) {
      showToast('建群組失敗：' + e.message, 'danger');
    }
  }

  function onCardDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    $$('.drop-target, .drop-before, .drop-after, .is-drop-target').forEach(el => {
      el.classList.remove('drop-target', 'drop-before', 'drop-after', 'is-drop-target');
    });
    _wasDragging = true;
    setTimeout(() => { _wasDragging = false; }, 50);
    _draggingId = null;
    _draggingKind = null;
  }

  function onBucketDragOver(e) {
    if (!_draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drop-target');
  }
  function onBucketDragLeave(e) {
    e.currentTarget.classList.remove('drop-target');
  }
  function onBucketDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove('drop-target');
    if (!_draggingId) return;
    // bucket-tab 的 data-bucket 可能是 "primary,normal"（進行中），取第一個
    const buckets = e.currentTarget.dataset.bucket.split(',').filter(Boolean);
    const targetBucket = buckets[0];
    if (!targetBucket) return;
    changeBucket(_draggingId, targetBucket);
  }

  async function reorderCard(draggedId, targetId, position = 'before') {
    // 分區/看板模式：不靠 bucketFilter（顯示 4 個 bucket），其他模式照舊
    const isMultiBucket = state.viewMode !== 'grid';
    const passes  = isMultiBucket ? passesFiltersIgnoreBucket  : passesFilters;
    const passesG = isMultiBucket ? passesGroupFiltersIgnoreBucket : passesGroupFilters;

    // 必須跟 render() 用同樣的排序邏輯，否則重新編號時會用儲存順序（亂）
    const sortKey = (x) => x.last_contact_at || x.updated_at || '';
    const sortFn = (a, b) => {
      if (a.sort_order != null && b.sort_order != null) return a.sort_order - b.sort_order;
      if (a.sort_order != null) return -1;
      if (b.sort_order != null) return 1;
      return (sortKey(b) || '').localeCompare(sortKey(a) || '');
    };
    const allVisible = [
      ...state.people.filter(passes),
      ...state.groups.filter(passesG),
    ].sort(sortFn);

    const fromIdx = allVisible.findIndex(x => x.id === draggedId);
    let toIdx = allVisible.findIndex(x => x.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = allVisible.splice(fromIdx, 1);
    // 抽掉 dragged 後重新計算 toIdx
    toIdx = allVisible.findIndex(x => x.id === targetId);
    if (toIdx < 0) toIdx = allVisible.length;
    const insertAt = position === 'after' ? toIdx + 1 : toIdx;
    allVisible.splice(insertAt, 0, moved);
    const updates = allVisible.map((it, idx) => ({ id: it.id, sort_order: (idx + 1) * 10 }));
    updates.forEach(u => {
      const p = state.people.find(x => x.id === u.id) || state.groups.find(x => x.id === u.id);
      if (p) p.sort_order = u.sort_order;
    });
    render();
    try {
      await api('POST', '/api/people/reorder', { items: updates });
    } catch (e) {
      showToast('排序儲存失敗：' + e.message, 'danger');
    }
  }

  // ─── 卡片右鍵 / 長按選單 ───
  const ROLE_TYPES_MENU = [
    { type: 'buyer', label: '買方' },
    { type: 'seller', label: '賣方' },
    { type: 'introducer', label: '介紹人' },
    { type: 'peer', label: '同業' },
    { type: 'landlord', label: '房東' },
    { type: 'owner_friend', label: '屋主朋友' },
    { type: 'friend', label: '朋友' },
    { type: 'relative', label: '親戚' },
  ];
  const BUCKETS_MENU = [
    { key: 'primary', label: '⭐ 主力' },
    { key: 'normal', label: '一般' },
    { key: 'watching', label: '👀 觀察' },
    { key: 'frozen', label: '🧊 冷凍' },
    { key: 'closed', label: '✅ 已成交' },
    { key: 'blacklist', label: '⛔ 黑名單' },
  ];
  const COLORS_MENU = [
    '', '#ffd6d6', '#ffdfc8', '#fff3c4', '#d6f5d6', '#c8f0ec',
    '#c8e8f8', '#d4d8f8', '#ead5f8', '#f8d5ec', '#ede0d4', '#e8e8e8',
  ];
  let _ctxMenu = null;
  function closeCardCtxMenu() {
    if (_ctxMenu) { _ctxMenu.remove(); _ctxMenu = null; }
  }
  function showCardCtxMenu(card, x, y) {
    closeCardCtxMenu();
    const id = card.dataset.id;
    const isGroup = card.dataset.kind === 'group';
    const data = isGroup
      ? state.groups.find(g => g.id === id)
      : state.people.find(p => p.id === id);
    if (!data) return;
    const phoneObj = (data.contacts || []).find(c => c.type === 'mobile' || c.type === 'home' || c.type === 'work');
    const phoneVal = phoneObj ? phoneObj.value : (data.phone || '');

    const menu = document.createElement('div');
    menu.className = 'card-ctx-menu';
    menu.innerHTML = `
      <div class="ccm-row" data-act="edit">✏️ <span>編輯</span></div>
      <div class="ccm-row" data-act="copy-name">📋 <span>複製姓名</span></div>
      ${phoneVal ? `<div class="ccm-row" data-act="copy-phone">📋 <span>複製電話</span></div>` : ''}
      <div class="ccm-row" data-act="open-detail">🔗 <span>開新分頁看詳情</span></div>
      <div class="ccm-row" data-act="merge">🔀 <span>合併到另一個人脈...</span></div>
      <div class="ccm-divider"></div>
      <div class="ccm-section-title">🎨 卡片顏色</div>
      <div class="ccm-colors">
        ${COLORS_MENU.map(c => `<button class="ccm-color${(data.card_color||'')===c?' selected':''}" data-color="${c}" style="${c?`background:${c}`:'background:transparent;border:1px dashed var(--border)'}" title="${c||'預設'}"></button>`).join('')}
      </div>
      <div class="ccm-divider"></div>
      <div class="ccm-section-title">📌 分類</div>
      <div class="ccm-buckets">
        ${BUCKETS_MENU.map(b => `<button class="ccm-bucket${data.bucket===b.key?' active':''}" data-bucket="${b.key}">${b.label}</button>`).join('')}
      </div>
      ${!isGroup ? `
      <div class="ccm-divider"></div>
      <div class="ccm-section-title">➕ 加角色</div>
      <div class="ccm-roles">
        ${ROLE_TYPES_MENU.map(r => {
          const has = (data.active_roles || []).includes(r.type);
          return `<button class="ccm-role${has?' has':''}" data-role="${r.type}" ${has?'disabled':''}>${r.label}</button>`;
        }).join('')}
      </div>
      ` : ''}
      <div class="ccm-divider"></div>
      <div class="ccm-row danger" data-act="delete">🗑 <span>移到垃圾桶</span></div>
    `;
    document.body.appendChild(menu);
    _ctxMenu = menu;

    // 定位（避免出格）
    const rect = menu.getBoundingClientRect();
    let left = x, top = y;
    if (left + rect.width > window.innerWidth - 8) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight - 8) top = window.innerHeight - rect.height - 8;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';

    // 防止選單內事件冒泡關閉自己
    menu.addEventListener('click', (e) => e.stopPropagation());

    menu.querySelectorAll('.ccm-row, .ccm-color, .ccm-bucket, .ccm-role').forEach(el => {
      el.addEventListener('click', async (e) => {
        e.stopPropagation();
        const act = el.dataset.act;
        const color = el.dataset.color;
        const bucket = el.dataset.bucket;
        const role = el.dataset.role;
        try {
          if (act === 'edit') {
            if (window.openPersonModal) window.openPersonModal(data);
          } else if (act === 'copy-name') {
            await navigator.clipboard.writeText(data.name || '');
            showToast(`✓ 已複製姓名：${data.name}`);
          } else if (act === 'copy-phone') {
            await navigator.clipboard.writeText(phoneVal);
            showToast(`✓ 已複製電話`);
          } else if (act === 'open-detail') {
            window.open(`/people/${id}`, '_blank');
          } else if (act === 'merge') {
            openMergePicker(data);
          } else if (act === 'delete') {
            if (!confirm(`確定移到垃圾桶：「${data.name}」？`)) return;
            await api('DELETE', `/api/people/${id}`);
            showToast('已移到垃圾桶');
            await loadPeople();
          } else if (color !== undefined) {
            await api('PATCH', `/api/people/${id}`, { card_color: color });
            data.card_color = color || null;
            render();
            showToast('✓ 已套用顏色');
          } else if (bucket !== undefined) {
            await changeBucket(id, bucket);
          } else if (role !== undefined) {
            await api('POST', `/api/people/${id}/roles/${role}`, {});
            const lbl = ROLE_TYPES_MENU.find(r => r.type === role)?.label;
            showToast(`✓ 已加角色：${lbl}`);
            await loadPeople();
          }
        } catch (err) {
          showToast('操作失敗：' + err.message, 'danger');
        } finally {
          closeCardCtxMenu();
        }
      });
    });
  }
  // 全域：點外面 / Esc / scroll / resize 關閉
  document.addEventListener('click', (e) => {
    if (_ctxMenu && !_ctxMenu.contains(e.target)) closeCardCtxMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCardCtxMenu(); });
  window.addEventListener('scroll', closeCardCtxMenu, true);
  window.addEventListener('resize', closeCardCtxMenu);

  // ═════════════════════════════════════════
  //  合併人脈（Merge）
  // ═════════════════════════════════════════
  let _mergeFromPerson = null;

  function openMergePicker(fromPerson) {
    closeCardCtxMenu();
    _mergeFromPerson = fromPerson;
    $('#mergeFromName').textContent = fromPerson.name;
    $('#mergeFromName2').textContent = fromPerson.name;
    $('#mergeSearch').value = '';
    $('#mergePickerModal').style.display = 'flex';
    renderMergeCandidates('');
    setTimeout(() => $('#mergeSearch').focus(), 50);
  }
  function closeMergePicker() {
    $('#mergePickerModal').style.display = 'none';
    _mergeFromPerson = null;
  }
  function renderMergeCandidates(filter) {
    if (!_mergeFromPerson) return;
    const fromId = _mergeFromPerson.id;
    const q = (filter || '').toLowerCase().trim();
    // 候選 = 所有非自己 + 非已軟刪 的人/群組
    const all = [
      ...state.people.filter(p => !p.deleted_at),
      ...state.groups.filter(g => !g.deleted_at),
    ].filter(p => p.id !== fromId);
    const filtered = q ? all.filter(p => {
      const hay = ((p.name||'') + ' ' + (p.display_name||'') + ' ' + (p.company||'') + ' ' + (p.phone||'')).toLowerCase();
      return hay.includes(q);
    }) : all;
    const list = filtered.slice(0, 50);
    const box = $('#mergeCandidates');
    if (!list.length) {
      box.innerHTML = '<p class="muted" style="padding:8px;font-size:13px;">沒有符合的人脈</p>';
      return;
    }
    box.innerHTML = list.map(p => {
      const av = p.avatar_b64
        ? `<img src="${p.avatar_b64.startsWith('data:') ? p.avatar_b64 : 'data:image/jpeg;base64,'+p.avatar_b64}">`
        : escapeHtml((p.name||'?').charAt(0));
      const roles = (p.active_roles || []).map(r => {
        const cfg = ROLE_DISPLAY[r] || { label: r };
        return `<span class="role-pill" style="font-size:10px;padding:1px 6px">${escapeHtml(cfg.label)}</span>`;
      }).join('');
      return `
        <button type="button" class="rel-candidate" data-id="${escapeHtml(p.id)}">
          <div class="rel-candidate-avatar">${av}</div>
          <div class="rel-candidate-info">
            <div class="rel-candidate-name">${p.is_group ? '👥 ' : ''}${escapeHtml(p.name||'')}</div>
            <div class="rel-candidate-sub">
              ${p.phone ? '📱 ' + escapeHtml(p.phone) + ' · ' : ''}${roles}
            </div>
          </div>
        </button>
      `;
    }).join('');
    box.querySelectorAll('.rel-candidate').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = list.find(p => p.id === btn.dataset.id);
        if (target) confirmMerge(_mergeFromPerson, target);
      });
    });
  }

  async function confirmMerge(fromPerson, toPerson) {
    closeMergePicker();
    // 撈雙方詳細資訊（用 GET /api/people/<id> 拿 active_roles 等；子集合分別 count）
    const [fromMeta, toMeta] = await Promise.all([
      fetchMergeMeta(fromPerson.id),
      fetchMergeMeta(toPerson.id),
    ]);
    const body = $('#mergeConfirmBody');
    const card = (label, person, meta) => {
      const av = person.avatar_b64
        ? `<img src="${person.avatar_b64.startsWith('data:') ? person.avatar_b64 : 'data:image/jpeg;base64,'+person.avatar_b64}" style="width:48px;height:48px;border-radius:50%;object-fit:cover">`
        : `<div style="width:48px;height:48px;border-radius:50%;background:var(--primary-bg);color:var(--primary-dark);display:flex;align-items:center;justify-content:center;font-weight:700">${escapeHtml((person.name||'?').charAt(0))}</div>`;
      const roleStr = (person.active_roles || []).map(r => (ROLE_DISPLAY[r]?.label || r)).join('、') || '（無角色）';
      return `
        <div style="flex:1;border:1px solid var(--border);border-radius:8px;padding:10px;background:var(--bg-elev)">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px">${label}</div>
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
            ${av}
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(person.name||'')}</div>
              ${person.phone ? `<div style="font-size:11px;color:var(--text-muted)">📱 ${escapeHtml(person.phone)}</div>` : ''}
            </div>
          </div>
          <div style="font-size:12px;line-height:1.7">
            <div>角色：${escapeHtml(roleStr)}</div>
            <div>互動 ${meta.contacts} · 附件 ${meta.files} · 物件 ${meta.properties}</div>
          </div>
        </div>
      `;
    };
    body.innerHTML = `
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 12px">
        ⚠️ 將把<b>左側「${escapeHtml(fromPerson.name)}」</b>合併到<b>右側「${escapeHtml(toPerson.name)}」</b>，<b>左側</b>會進垃圾桶（可救回）。
      </p>
      <div style="display:flex;gap:10px;align-items:stretch">
        ${card('🗑 將被合併刪除（A）', fromPerson, fromMeta)}
        <div style="display:flex;align-items:center;font-size:18px;color:var(--primary)">→</div>
        ${card('✅ 保留下來（B）', toPerson, toMeta)}
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:14px 0 0">
        合併後左側的互動記事 / 附件 / 物件 / 缺漏角色都會搬到右側。<br>
        其他人關聯到 A 的會自動改指 B。
      </p>
    `;
    $('#mergeConfirmModal').style.display = 'flex';
    $('#btnDoMerge').onclick = () => doMerge(fromPerson.id, toPerson.id);
  }

  // 取得人脈的子集合計數（給合併確認頁顯示）
  async function fetchMergeMeta(pid) {
    try {
      const [contacts, files, props] = await Promise.all([
        api('GET', `/api/people/${pid}/contacts`).catch(() => ({items:[]})),
        api('GET', `/api/people/${pid}/files`).catch(() => ({items:[]})),
        api('GET', `/api/people/${pid}/properties`).catch(() => ({items:[]})),
      ]);
      return {
        contacts: (contacts.items || []).length,
        files: (files.items || []).length,
        properties: (props.items || []).length,
      };
    } catch (_) {
      return { contacts: 0, files: 0, properties: 0 };
    }
  }

  function closeMergeConfirm() {
    $('#mergeConfirmModal').style.display = 'none';
  }

  async function doMerge(fromId, toId) {
    try {
      const r = await api('POST', `/api/people/${fromId}/merge-to/${toId}`);
      const m = r.moved || {};
      showToast(`✓ 已合併（互動 ${m.contacts||0} / 附件 ${m.files||0} / 物件 ${m.properties||0} / 角色 ${m.roles||0}）`);
      closeMergeConfirm();
      await loadPeople();
    } catch (e) {
      showToast('合併失敗：' + e.message, 'danger');
    }
  }

  // ─── 手機觸控長按拖曳（400ms 啟動）+ 800ms 跳選單 ───
  let _touchTimer = null;
  let _menuTimer = null;
  let _touchStartX = 0, _touchStartY = 0;
  let _touchCard = null;
  let _touchPreview = null;
  const LONG_PRESS_MS = 400;
  const MENU_PRESS_MS = 800;

  function onCardTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    _touchStartX = t.clientX;
    _touchStartY = t.clientY;
    _touchCard = e.currentTarget;
    clearTimeout(_touchTimer);
    clearTimeout(_menuTimer);
    closeCardCtxMenu();
    // 400ms：啟動拖曳
    _touchTimer = setTimeout(() => {
      if (!_touchCard) return;
      _draggingId = _touchCard.dataset.id;
      _touchCard.classList.add('dragging');
      _touchPreview = _touchCard.cloneNode(true);
      _touchPreview.style.position = 'fixed';
      _touchPreview.style.top = (_touchStartY - 40) + 'px';
      _touchPreview.style.left = (_touchStartX - 60) + 'px';
      _touchPreview.style.width = _touchCard.offsetWidth + 'px';
      _touchPreview.style.opacity = '0.8';
      _touchPreview.style.pointerEvents = 'none';
      _touchPreview.style.zIndex = '9000';
      _touchPreview.style.transform = 'scale(0.9)';
      _touchPreview.classList.add('touch-preview');
      document.body.appendChild(_touchPreview);
      if (navigator.vibrate) navigator.vibrate(40);
    }, LONG_PRESS_MS);
    // 800ms：若手指還沒離開 → 取消拖曳，改開選單
    _menuTimer = setTimeout(() => {
      if (!_touchCard) return;
      // 取消拖曳
      if (_touchPreview) { _touchPreview.remove(); _touchPreview = null; }
      _touchCard.classList.remove('dragging');
      _draggingId = null;
      $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
      // 開選單
      if (navigator.vibrate) navigator.vibrate([20, 50, 20]);
      showCardCtxMenu(_touchCard, _touchStartX, _touchStartY);
      _wasDragging = true;
      setTimeout(() => { _wasDragging = false; }, 300);
    }, MENU_PRESS_MS);
  }

  function onCardTouchMove(e) {
    // 還沒長按 → 若大幅移動，取消所有計時器（讓使用者正常捲動）
    if (!_draggingId) {
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - _touchStartX);
      const dy = Math.abs(t.clientY - _touchStartY);
      if (dx > 10 || dy > 10) {
        clearTimeout(_touchTimer);
        clearTimeout(_menuTimer);
        _touchCard = null;
      }
      return;
    }
    // 已啟動拖曳：取消選單 timer（手指有動作 = 想拖，不要切到選單）
    clearTimeout(_menuTimer);
    e.preventDefault();
    const t = e.touches[0];
    if (_touchPreview) {
      _touchPreview.style.top = (t.clientY - 40) + 'px';
      _touchPreview.style.left = (t.clientX - 60) + 'px';
    }
    // 清除舊高亮
    $$('.bucket-tab.drop-target, .person-card.drop-target').forEach(el => el.classList.remove('drop-target'));
    // 偵測手指下元素
    const elBelow = document.elementFromPoint(t.clientX, t.clientY);
    if (!elBelow) return;
    const bucketBtn = elBelow.closest('.bucket-tab');
    const cardBelow = elBelow.closest('.person-card');
    if (bucketBtn) {
      bucketBtn.classList.add('drop-target');
    } else if (cardBelow && cardBelow !== _touchCard && cardBelow.dataset.id !== _draggingId) {
      cardBelow.classList.add('drop-target');
    }
  }

  function onCardTouchEnd(e) {
    clearTimeout(_touchTimer);
    clearTimeout(_menuTimer);
    if (!_draggingId) {
      _touchCard = null;
      return;
    }
    // 偵測 drop target
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    if (t) {
      const elBelow = document.elementFromPoint(t.clientX, t.clientY);
      if (elBelow) {
        const bucketBtn = elBelow.closest('.bucket-tab');
        const cardBelow = elBelow.closest('.person-card');
        if (bucketBtn) {
          const buckets = bucketBtn.dataset.bucket.split(',').filter(Boolean);
          if (buckets[0]) changeBucket(_draggingId, buckets[0]);
        } else if (cardBelow && cardBelow.dataset.id !== _draggingId) {
          reorderCard(_draggingId, cardBelow.dataset.id);
        }
      }
    }
    // 清理
    if (_touchPreview) { _touchPreview.remove(); _touchPreview = null; }
    if (_touchCard) _touchCard.classList.remove('dragging');
    $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
    _draggingId = null;
    _touchCard = null;
    _wasDragging = true;
    setTimeout(() => { _wasDragging = false; }, 300);
  }

  async function changeBucket(pid, newBucket) {
    // 群組與人都在 person collection 裡，但前端分流；查兩處
    const p = state.people.find(x => x.id === pid) || state.groups.find(x => x.id === pid);
    if (!p || p.bucket === newBucket) return;
    const oldBucket = p.bucket;
    p.bucket = newBucket;  // 樂觀更新
    render();
    const labels = { primary: '⭐ 主力', normal: '一般', watching: '👀 觀察', frozen: '🧊 冷凍', closed: '✅ 已成交', blacklist: '⛔ 黑名單' };
    try {
      // PUT 需要完整 payload（後端 _build_person_payload 會驗證 name）
      await api('PUT', `/api/people/${pid}`, {
        name: p.name,
        display_name: p.display_name,
        birthday: p.birthday,
        gender: p.gender,
        company: p.company,
        contacts: p.contacts || [],
        addresses: p.addresses || [],
        bucket: newBucket,
        warning: p.warning,
        source: p.source || {},
        // 群組欄位（PUT 也要保留，否則 _build_person_payload 預設清空）
        is_group: !!p.is_group,
        group_type: p.group_type,
        members: p.members || [],
      });
      showToast(`「${p.name}」→ ${labels[newBucket] || newBucket}`);
    } catch (e) {
      p.bucket = oldBucket;
      render();
      showToast('變更分類失敗：' + e.message, 'danger');
    }
  }

  // ─── 事件綁定 ───
  // ── 篩選狀態存取（從詳情頁回來時還原）──
  function saveFilters() {
    try {
      localStorage.setItem('people_filters', JSON.stringify({
        bucketFilter: state.bucketFilter,
        roleFilter: state.roleFilter,
        extraFilters: state.extraFilters,
        searchTerm: state.searchTerm,
        showMode: state.showMode,
      }));
    } catch (_) {}
  }
  function restoreFilters() {
    try {
      const saved = JSON.parse(localStorage.getItem('people_filters') || '{}');
      if (Array.isArray(saved.bucketFilter)) state.bucketFilter = saved.bucketFilter;
      if (Array.isArray(saved.roleFilter)) state.roleFilter = saved.roleFilter;
      if (saved.extraFilters && typeof saved.extraFilters === 'object') {
        state.extraFilters = { ...state.extraFilters, ...saved.extraFilters };
      }
      if (typeof saved.searchTerm === 'string') state.searchTerm = saved.searchTerm;
      if (saved.showMode) state.showMode = saved.showMode;
    } catch (_) {}
  }
  // 把 state 同步回 UI 控制項（checkbox/active tab/search input）
  function syncFiltersToUI() {
    // bucket tab：找出 data-bucket 跟目前 state 完全一樣的 tab 設 active
    const cur = (state.bucketFilter || []).slice().sort().join(',');
    $$('.bucket-tab').forEach(b => {
      const tabBuckets = (b.dataset.bucket || '').split(',').filter(Boolean).sort().join(',');
      b.classList.toggle('active', tabBuckets === cur);
    });
    // role checkbox
    $$('.chk input[data-role]').forEach(cb => {
      cb.checked = (state.roleFilter || []).includes(cb.dataset.role);
    });
    // 額外篩選
    if ($('#filterWarning')) $('#filterWarning').checked = !!state.extraFilters.warning;
    if ($('#filterStale')) $('#filterStale').checked = !!state.extraFilters.stale;
    if ($('#filterIncomplete')) $('#filterIncomplete').checked = !!state.extraFilters.incomplete;
    if ($('#filterAgentNoAuth')) $('#filterAgentNoAuth').checked = !!state.extraFilters.agentNoAuth;
    // 搜尋
    if ($('#searchInput') && typeof state.searchTerm === 'string') $('#searchInput').value = state.searchTerm;
    // 顯示模式
    $$('.show-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.showMode));
  }

  function bindEvents() {
    // bucket tabs（點擊切換 + 接收 drop）
    $$('.bucket-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.bucket-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.bucketFilter = btn.dataset.bucket.split(',').filter(Boolean);
        saveFilters();
        render();
      });
      btn.addEventListener('dragover', onBucketDragOver);
      btn.addEventListener('dragleave', onBucketDragLeave);
      btn.addEventListener('drop', onBucketDrop);
    });

    // 角色 checkbox
    $$('.chk input[data-role]').forEach(cb => {
      cb.addEventListener('change', () => {
        state.roleFilter = $$('.chk input[data-role]:checked').map(x => x.dataset.role);
        saveFilters();
        render();
      });
    });

    // 額外篩選
    $('#filterWarning').addEventListener('change', (e) => {
      state.extraFilters.warning = e.target.checked;
      saveFilters();
      render();
    });
    $('#filterStale').addEventListener('change', (e) => {
      state.extraFilters.stale = e.target.checked;
      saveFilters();
      render();
    });
    $('#filterIncomplete').addEventListener('change', (e) => {
      state.extraFilters.incomplete = e.target.checked;
      saveFilters();
      render();
    });
    $('#filterAgentNoAuth').addEventListener('change', async (e) => {
      state.extraFilters.agentNoAuth = e.target.checked;
      if (e.target.checked) {
        showToast('代理人授權書篩選功能預計下個 session 加入', 'danger');
        e.target.checked = false;
        state.extraFilters.agentNoAuth = false;
      }
      saveFilters();
      render();
    });

    // 清除所有篩選
    $('#btnClearFilters').addEventListener('click', () => {
      state.roleFilter = [];
      state.extraFilters = { warning: false, stale: false, agentNoAuth: false };
      state.searchTerm = '';
      $$('.chk input').forEach(x => x.checked = false);
      if ($('#searchInput')) $('#searchInput').value = '';
      // bucket 不重設（保持當前 tab）
      saveFilters();
      render();
    });

    // 搜尋（debounce）
    let searchTimer;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.searchTerm = e.target.value.trim();
        saveFilters();
        render();
      }, 200);
    });

    // 新增按鈕
    $('#btnAddPerson').addEventListener('click', () => {
      if (window.openPersonModal) window.openPersonModal(null);
    });

    // 垃圾桶
    $('#btnTrash')?.addEventListener('click', openTrash);
    $('#btnCloseTrash')?.addEventListener('click', closeTrash);
    $('#btnCloseTrash2')?.addEventListener('click', closeTrash);
    $('#trashModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'trashModal') closeTrash();
    });

    // 合併人脈 modal
    $('#btnCloseMergeModal')?.addEventListener('click', closeMergePicker);
    $('#btnCancelMergeModal')?.addEventListener('click', closeMergePicker);
    $('#mergePickerModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'mergePickerModal') closeMergePicker();
    });
    $('#mergeSearch')?.addEventListener('input', (e) => renderMergeCandidates(e.target.value));
    $('#btnCloseMergeConfirm')?.addEventListener('click', closeMergeConfirm);
    $('#btnCancelMergeConfirm')?.addEventListener('click', closeMergeConfirm);
    $('#mergeConfirmModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'mergeConfirmModal') closeMergeConfirm();
    });

    // 顯示模式切換（全部 / 只看人 / 只看群組）
    $$('.show-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.show-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.showMode = btn.dataset.mode;
        saveFilters();
        render();
      });
    });

    // 檢視方式切換（卡片網格 / 分區 / 看板），存 localStorage
    $$('.view-mode-btn').forEach(btn => {
      // 還原啟動 mode 的 active 標記
      if (btn.dataset.view === state.viewMode) {
        $$('.view-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      }
      btn.addEventListener('click', () => {
        $$('.view-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.viewMode = btn.dataset.view;
        localStorage.setItem('people_view_mode', state.viewMode);
        render();
      });
    });

    // 行動版 sidebar 切換
    const sidebar = $('#sidebar');
    $('#btnFilter')?.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
    // 點擊 main 區關閉手機版 sidebar
    $('.main').addEventListener('click', () => {
      if (sidebar.classList.contains('open')) sidebar.classList.remove('open');
    });
  }

  // ─── 垃圾桶 ───
  async function openTrash() {
    $('#trashModal').style.display = 'flex';
    $('#trashList').innerHTML = '<p class="muted">載入中...</p>';
    try {
      const data = await api('GET', '/api/people/trash');
      const items = data.items || [];
      if (items.length === 0) {
        $('#trashList').innerHTML = '<p class="muted" style="text-align:center; padding:30px 0">垃圾桶是空的</p>';
        return;
      }
      $('#trashList').innerHTML = items.map(p => `
        <div class="trash-row" data-id="${p.id}">
          <div class="trash-info">
            <div class="trash-name">${escapeHtml(p.name)}</div>
            <div class="trash-meta muted">刪除於 ${escapeHtml(p.deleted_at || '?')}</div>
          </div>
          <div class="trash-actions">
            <button class="btn-tiny" data-action="restore">↩ 還原</button>
            <button class="btn-tiny btn-danger" data-action="purge">永久刪除</button>
          </div>
        </div>
      `).join('');
      $('#trashList').querySelectorAll('[data-action]').forEach(b => {
        b.addEventListener('click', async (e) => {
          const row = b.closest('.trash-row');
          const pid = row.dataset.id;
          const action = b.dataset.action;
          if (action === 'restore') {
            try {
              await api('POST', `/api/people/${pid}/restore`);
              showToast('已還原');
              row.remove();
              await loadPeople();
            } catch (e) { showToast('還原失敗：' + e.message, 'danger'); }
          } else {
            if (!confirm('永久刪除？這個動作無法復原（含所有附件、互動記事、timeline）')) return;
            try {
              await api('DELETE', `/api/people/${pid}/purge`);
              showToast('已永久刪除');
              row.remove();
            } catch (e) { showToast('刪除失敗：' + e.message, 'danger'); }
          }
        });
      });
    } catch (e) {
      $('#trashList').innerHTML = `<p class="muted" style="color:var(--danger)">載入失敗：${e.message}</p>`;
    }
  }
  function closeTrash() { $('#trashModal').style.display = 'none'; }

  // ─── 提供給 form 呼叫的「重新載入」 ───
  window.reloadPeople = loadPeople;
  window.getStateForReferrer = () => state.people; // 為了在來源下拉填入介紹人選項

  // 即時注入剛建立或更新的 doc 進 state（避免 Firestore 偶發 read-your-write 延遲）
  window.injectPerson = (p) => {
    if (!p || !p.id) return;
    const arr = p.is_group ? state.groups : state.people;
    const idx = arr.findIndex(x => x.id === p.id);
    if (idx >= 0) arr[idx] = p;   // 更新
    else arr.unshift(p);           // 新增 → 排前面
    render();
  };

  // ─── 啟動 ───
  document.addEventListener('DOMContentLoaded', () => {
    // 先還原 localStorage 中的篩選狀態（從詳情頁回來時不丟）
    restoreFilters();
    bindEvents();
    syncFiltersToUI();

    // ?show=groups → 切到「只看群組」模式（URL 參數優先於 localStorage）
    const params = new URLSearchParams(window.location.search);
    const showParam = params.get('show');
    if (showParam === 'groups' || showParam === 'people') {
      state.showMode = showParam;
      $$('.show-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === showParam));
    }

    loadPeople().then(() => {
      const editId = params.get('edit');
      if (editId && window.openPersonModal) {
        const p = state.people.find(x => x.id === editId);
        if (p) window.openPersonModal(p);
      }
      if (showParam || params.get('edit')) {
        history.replaceState({}, '', '/');
      }
    });
  });
})();
