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

  // ─── 載入人脈 + 群組 ───
  async function loadPeople() {
    $('#statusBar').textContent = '載入中...';
    try {
      const [pData, gData] = await Promise.all([
        api('GET', '/api/people?limit=500'),
        api('GET', '/api/groups').catch(() => ({ items: [] })),
      ]);
      state.people = pData.items || [];
      state.groups = (gData.items || []).filter(g => !g.archived);
      $('#statusBar').textContent = `共 ${state.people.length} 位人脈、${state.groups.length} 個群組`;
      render();
    } catch (e) {
      $('#statusBar').textContent = `載入失敗：${e.message}`;
      showToast('載入失敗：' + e.message, 'danger');
    }
  }

  // ─── 群組過濾（同 bucket / 搜尋）───
  function passesGroupFilters(g) {
    // 群組目前無 bucket 概念，沿用人的 bucket：「進行中」與「全部」顯示，其餘 tab 隱藏
    const bucketsCurrent = state.bucketFilter;
    const isProgressTab = bucketsCurrent.length >= 2;  // 進行中合併 tab
    if (!isProgressTab) return false;  // 群組只在「進行中」tab 顯示（避免出現在已成交/黑名單等）
    if (state.searchTerm) {
      const q = state.searchTerm.toLowerCase();
      const hay = ((g.name || '') + ' ' + (g.description || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (state.roleFilter.length > 0) return false;  // 群組沒有角色
    if (state.extraFilters.warning || state.extraFilters.stale ||
        state.extraFilters.incomplete || state.extraFilters.agentNoAuth) return false;
    return true;
  }

  // ─── 群組卡片 ───
  function renderGroupCard(g) {
    const memberCount = (g.member_ids || []).length;
    const typeLabel = g.type === 'permanent' ? '永久' : '一次性';
    const typeCls = g.type === 'permanent' ? 'g-type-perm' : 'g-type-temp';
    return `
      <div class="person-card group-list-card" data-kind="group" data-id="${g.id}" draggable="true">
        <div class="card-top">
          <div class="avatar group-avatar">👨‍👩‍👧</div>
          <div class="card-name">
            <div class="card-name-title">${escapeHtml(g.name)}</div>
            <div class="card-name-sub">👥 ${memberCount} 位成員</div>
          </div>
        </div>
        <div class="card-pills">
          <span class="g-type-pill ${typeCls}">${typeLabel}</span>
        </div>
        <div class="card-bottom">
          <span class="last-contact-badge muted">群組</span>
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
  function render() {
    const grid = $('#cardGrid');
    const empty = $('#emptyState');

    // 人 + 群組依 showMode 混合
    const showPeople = state.showMode !== 'groups';
    const showGroups = state.showMode !== 'people';
    const peopleItems = showPeople ? state.people.filter(passesFilters) : [];
    const groupItems = showGroups ? state.groups.filter(passesGroupFilters) : [];

    // 統一排序鍵：sort_order 優先；否則 last_contact_at（人）或 updated_at（群組）
    const sortKey = (it) => it.last_contact_at || it.updated_at || '';
    const items = [
      ...peopleItems.map(p => ({ kind: 'person', data: p })),
      ...groupItems.map(g => ({ kind: 'group', data: g })),
    ].sort((a, b) => {
      const ao = a.data.sort_order, bo = b.data.sort_order;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      return (sortKey(b.data) || '').localeCompare(sortKey(a.data) || '');
    });

    if (items.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      $('#statusBar').textContent = '此分類目前沒有資料';
      return;
    }

    empty.style.display = 'none';
    grid.innerHTML = items.map(it => it.kind === 'group' ? renderGroupCard(it.data) : renderCard(it.data)).join('');
    $('#statusBar').textContent =
      `顯示 ${peopleItems.length} 位人脈` +
      (showGroups ? ` + ${groupItems.length} 個群組` : '') +
      `（共 ${state.people.length} / ${state.groups.length}）`;

    // 點卡片：人 → 詳情頁、群組 → 群組頁；拖曳處理
    $$('.person-card').forEach(card => {
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

    return `
      <div class="person-card ${cardClasses.slice(1).join(' ')}" data-id="${p.id}" draggable="true">
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
    const card = e.currentTarget;
    if (card.dataset.kind === 'group') {
      window.location.href = '/groups#' + card.dataset.id;
    } else {
      window.location.href = '/people/' + card.dataset.id;
    }
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

  function onCardDragOver(e) {
    if (!_draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (e.currentTarget.dataset.id !== _draggingId) {
      e.currentTarget.classList.add('drop-target');
    }
  }
  function onCardDragLeave(e) {
    e.currentTarget.classList.remove('drop-target');
  }

  function onCardDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.classList.remove('drop-target');
    const targetId = e.currentTarget.dataset.id;
    const targetKind = e.currentTarget.dataset.kind || 'person';
    if (!_draggingId || _draggingId === targetId) return;

    // 拖人 → 群組：加成員
    if (_draggingKind === 'person' && targetKind === 'group') {
      addMemberToGroup(targetId, _draggingId);
      return;
    }
    // 拖人 → 人：建群組
    if (_draggingKind === 'person' && targetKind === 'person') {
      const draggedPerson = state.people.find(p => p.id === _draggingId);
      const targetPerson = state.people.find(p => p.id === targetId);
      // 若使用者按住 Shift，則維持原本的 reorder 行為；否則優先建群組
      if (e.shiftKey) {
        reorderCard(_draggingId, targetId);
      } else {
        offerCreateGroup(draggedPerson, targetPerson);
      }
      return;
    }
    // 群組 → 群組 / 群組 → 人：純 reorder
    reorderCard(_draggingId, targetId);
  }

  async function addMemberToGroup(groupId, personId) {
    const g = state.groups.find(x => x.id === groupId);
    const p = state.people.find(x => x.id === personId);
    if (!g || !p) return;
    if ((g.member_ids || []).includes(personId)) {
      showToast(`「${p.name}」已在此群組中`);
      return;
    }
    try {
      const updated = {
        name: g.name,
        type: g.type,
        description: g.description || '',
        member_ids: [...(g.member_ids || []), personId],
      };
      await api('PUT', `/api/groups/${groupId}`, updated);
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
      showToast('未取消，但群組名稱不能空白', 'danger');
      return;
    }
    try {
      const data = await api('POST', '/api/groups', {
        name: name.trim(),
        type: 'temporary',
        description: '',
        member_ids: [personA.id, personB.id],
      });
      showToast(`✓ 已建立群組「${data.name || name}」`);
      await loadPeople();
    } catch (e) {
      showToast('建群組失敗：' + e.message, 'danger');
    }
  }

  function onCardDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
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

  async function reorderCard(draggedId, targetId) {
    const visibleItems = state.people.filter(passesFilters);
    const fromIdx = visibleItems.findIndex(x => x.id === draggedId);
    const toIdx = visibleItems.findIndex(x => x.id === targetId);
    if (fromIdx < 0 || toIdx < 0) return;
    const [moved] = visibleItems.splice(fromIdx, 1);
    visibleItems.splice(toIdx, 0, moved);
    // 重新分配 sort_order（10, 20, 30...，留間隔便於將來插入）
    const updates = visibleItems.map((it, idx) => ({ id: it.id, sort_order: (idx + 1) * 10 }));
    // 樂觀更新本地
    updates.forEach(u => {
      const p = state.people.find(x => x.id === u.id);
      if (p) p.sort_order = u.sort_order;
    });
    render();
    try {
      await api('POST', '/api/people/reorder', { items: updates });
    } catch (e) {
      showToast('排序儲存失敗：' + e.message, 'danger');
    }
  }

  // ─── 手機觸控長按拖曳（400ms 啟動，避免干擾捲動）───
  let _touchTimer = null;
  let _touchStartX = 0, _touchStartY = 0;
  let _touchCard = null;
  let _touchPreview = null;
  const LONG_PRESS_MS = 400;

  function onCardTouchStart(e) {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    _touchStartX = t.clientX;
    _touchStartY = t.clientY;
    _touchCard = e.currentTarget;
    clearTimeout(_touchTimer);
    _touchTimer = setTimeout(() => {
      // 長按啟動拖曳
      if (!_touchCard) return;
      _draggingId = _touchCard.dataset.id;
      _touchCard.classList.add('dragging');
      // 建浮動預覽
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
      // 觸覺回饋
      if (navigator.vibrate) navigator.vibrate(40);
    }, LONG_PRESS_MS);
  }

  function onCardTouchMove(e) {
    // 還沒長按 → 若大幅移動，取消長按計時器（讓使用者正常捲動）
    if (!_draggingId) {
      const t = e.touches[0];
      const dx = Math.abs(t.clientX - _touchStartX);
      const dy = Math.abs(t.clientY - _touchStartY);
      if (dx > 10 || dy > 10) {
        clearTimeout(_touchTimer);
        _touchCard = null;
      }
      return;
    }
    // 已啟動拖曳：跟手指 + 偵測下方元素
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
    const p = state.people.find(x => x.id === pid);
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
      });
      showToast(`「${p.name}」→ ${labels[newBucket] || newBucket}`);
    } catch (e) {
      p.bucket = oldBucket;
      render();
      showToast('變更分類失敗：' + e.message, 'danger');
    }
  }

  // ─── 事件綁定 ───
  function bindEvents() {
    // bucket tabs（點擊切換 + 接收 drop）
    $$('.bucket-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.bucket-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.bucketFilter = btn.dataset.bucket.split(',').filter(Boolean);
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
        render();
      });
    });

    // 額外篩選
    $('#filterWarning').addEventListener('change', (e) => {
      state.extraFilters.warning = e.target.checked;
      render();
    });
    $('#filterStale').addEventListener('change', (e) => {
      state.extraFilters.stale = e.target.checked;
      render();
    });
    $('#filterIncomplete').addEventListener('change', (e) => {
      state.extraFilters.incomplete = e.target.checked;
      render();
    });
    $('#filterAgentNoAuth').addEventListener('change', async (e) => {
      state.extraFilters.agentNoAuth = e.target.checked;
      if (e.target.checked) {
        showToast('代理人授權書篩選功能預計下個 session 加入', 'danger');
        e.target.checked = false;
        state.extraFilters.agentNoAuth = false;
      }
      render();
    });

    // 清除所有篩選
    $('#btnClearFilters').addEventListener('click', () => {
      state.roleFilter = [];
      state.extraFilters = { warning: false, stale: false, agentNoAuth: false };
      $$('.chk input').forEach(x => x.checked = false);
      // bucket 不重設（保持當前 tab）
      render();
    });

    // 搜尋（debounce）
    let searchTimer;
    $('#searchInput').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.searchTerm = e.target.value.trim();
        render();
      }, 200);
    });

    // 新增按鈕
    $('#btnAddPerson').addEventListener('click', () => {
      if (window.openPersonModal) window.openPersonModal(null);
    });

    // 顯示模式切換（全部 / 只看人 / 只看群組）
    $$('.show-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.show-mode-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.showMode = btn.dataset.mode;
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

  // ─── 提供給 form 呼叫的「重新載入」 ───
  window.reloadPeople = loadPeople;
  window.getStateForReferrer = () => state.people; // 為了在來源下拉填入介紹人選項

  // ─── 啟動 ───
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    loadPeople().then(() => {
      // 從詳情頁帶回的 ?edit=<id> 自動開啟編輯 modal
      const params = new URLSearchParams(window.location.search);
      const editId = params.get('edit');
      if (editId && window.openPersonModal) {
        const p = state.people.find(x => x.id === editId);
        if (p) window.openPersonModal(p);
        // 清掉 query 避免重整又開
        history.replaceState({}, '', '/');
      }
    });
  });
})();
