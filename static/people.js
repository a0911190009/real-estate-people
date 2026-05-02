/* ============================================
   人脈管理 — 主邏輯（列表 / 篩選 / 搜尋 / Toast）
============================================ */

(function () {
  'use strict';

  // ─── 全域狀態 ───
  const state = {
    people: [],          // 從 API 取回的全部人脈（cache）
    bucketFilter: ['primary', 'normal'],  // 預設「進行中」
    roleFilter: [],      // 角色篩選（多選）
    searchTerm: '',
    extraFilters: {
      warning: false,
      stale: false,
      agentNoAuth: false,
    },
    sellerRolesCache: {},  // person_id → seller role doc（為了判斷 agent_no_auth）
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

  // ─── 載入人脈列表 ───
  async function loadPeople() {
    $('#statusBar').textContent = '載入中...';
    try {
      const data = await api('GET', '/api/people?limit=500');
      state.people = data.items || [];
      $('#statusBar').textContent = `共 ${state.people.length} 位人脈`;
      // 預載入所有 seller roles（為了「代理人缺授權書」篩選）
      // 採延遲載入：只在使用者勾選那個篩選時才查
      render();
    } catch (e) {
      $('#statusBar').textContent = `載入失敗：${e.message}`;
      showToast('載入失敗：' + e.message, 'danger');
    }
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
    // 代理人缺授權書（這個比較貴，後面 render 時再判斷）
    return true;
  }

  // ─── 渲染卡片 ───
  function render() {
    const grid = $('#cardGrid');
    const empty = $('#emptyState');
    let items = state.people.filter(passesFilters);

    // 排序：sort_order 升冪優先（拖曳過的排前面），其餘按 last_contact_at 降冪
    items.sort((a, b) => {
      const ao = a.sort_order;
      const bo = b.sort_order;
      const aHasOrder = ao != null;
      const bHasOrder = bo != null;
      if (aHasOrder && bHasOrder) return ao - bo;
      if (aHasOrder) return -1;
      if (bHasOrder) return 1;
      const da = a.last_contact_at || '';
      const dbb = b.last_contact_at || '';
      return dbb.localeCompare(da);
    });

    if (items.length === 0) {
      grid.innerHTML = '';
      empty.style.display = 'block';
      $('#statusBar').textContent = '此分類目前沒有資料';
      return;
    }

    empty.style.display = 'none';
    grid.innerHTML = items.map(renderCard).join('');
    $('#statusBar').textContent = `顯示 ${items.length} 位（共 ${state.people.length}）`;

    // 點卡片：跳到詳情頁；拖曳：reorder 或改 bucket
    $$('.person-card').forEach(card => {
      card.addEventListener('click', onCardClick);
      card.addEventListener('dragstart', onCardDragStart);
      card.addEventListener('dragover', onCardDragOver);
      card.addEventListener('dragleave', onCardDragLeave);
      card.addEventListener('drop', onCardDrop);
      card.addEventListener('dragend', onCardDragEnd);
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
          ${p.warning ? `<span class="warning-icon" title="${escapeHtml(p.warning)}">⚠️</span>` : ''}
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
    window.location.href = '/people/' + e.currentTarget.dataset.id;
  }

  function onCardDragStart(e) {
    _draggingId = e.currentTarget.dataset.id;
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
    if (!_draggingId || _draggingId === targetId) return;
    reorderCard(_draggingId, targetId);
  }

  function onCardDragEnd(e) {
    e.currentTarget.classList.remove('dragging');
    $$('.drop-target').forEach(el => el.classList.remove('drop-target'));
    _wasDragging = true;
    setTimeout(() => { _wasDragging = false; }, 50);
    _draggingId = null;
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

  async function changeBucket(pid, newBucket) {
    const p = state.people.find(x => x.id === pid);
    if (!p || p.bucket === newBucket) return;
    const oldBucket = p.bucket;
    p.bucket = newBucket;  // 樂觀更新
    render();
    const labels = { primary: '⭐ 主力', normal: '一般', frozen: '🧊 冷凍', closed: '✅ 已成交', blacklist: '⛔ 黑名單' };
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
