/* ============================================
   人脈管理 — 詳情頁主邏輯
   依賴 window.PERSON_ID（由 detail.html 注入）
============================================ */

(function () {
  'use strict';

  const PID = window.PERSON_ID;
  const state = {
    person: null,
    roles: [],          // 含 archived 的全部
    timeline: [],
    contacts: [],
    showArchived: false,
    expandedRole: null, // 目前展開哪個 role_type
    introducerStats: null,
    files: [],
    allPeopleForPicker: [], // 加關聯時用的人脈下拉選項
    selectedRelCandidate: null,
    // 群組相關
    memberDetails: [],   // is_group 時：成員 person doc list
    mentionedItems: [],  // 一般人：被提到的紀錄
  };

  // ─── Role 顯示對應 ───
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

  // ─── 工具 ───
  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.from(document.querySelectorAll(s)); }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
  }
  function nameInitial(name) { return name ? name.trim().charAt(0) : '?'; }

  function showToast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'danger' ? ' danger' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.className = 'toast', 2400);
  }

  function fmtDateTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

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
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }

  // ═════════════════════════════════════════
  //  分頁身份：標題 + favicon 換成這位客戶
  // ═════════════════════════════════════════

  // 把 64x64 canvas 設成分頁 favicon（移除舊的 icon link，換新的 PNG）
  function applyFavicon(canvas) {
    try {
      const url = canvas.toDataURL('image/png');
      document.querySelectorAll('link[rel~="icon"]').forEach(l => l.remove());
      const link = document.createElement('link');
      link.rel = 'icon';
      link.type = 'image/png';
      link.href = url;
      document.head.appendChild(link);
    } catch (_) { /* 失敗就維持預設 favicon，不影響功能 */ }
  }

  // 沒有頭像時：用「卡片顏色當底 + 姓名首字」畫一個圓形 favicon
  function drawLetterFavicon(name, bgColor) {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = bgColor || '#6366f1';   // 預設靛藍
    ctx.beginPath();
    ctx.arc(32, 32, 32, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 38px -apple-system, "PingFang TC", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((name || '?').trim().charAt(0) || '?', 32, 36);
    applyFavicon(c);
  }

  function setPageIdentity(person) {
    const name = person.name || person.display_name || '人脈';
    // 分頁標題：客戶名在前，多分頁時看得到是誰
    document.title = `${name}${person.is_group ? '（群組）' : ''} — 人脈詳情`;

    const raw = person.avatar_b64;
    if (raw) {
      // 有頭像 → 載入後裁成正方形畫進 64x64 canvas（轉 PNG 當 favicon 最穩）
      const src = raw.startsWith('data:') ? raw : 'data:image/jpeg;base64,' + raw;
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        const s = Math.min(img.width, img.height);          // 取中間正方形
        ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
        applyFavicon(c);
      };
      img.onerror = () => drawLetterFavicon(name, person.card_color);
      img.src = src;
    } else {
      drawLetterFavicon(name, person.card_color);
    }
  }

  // ═════════════════════════════════════════
  //  載入資料
  // ═════════════════════════════════════════

  async function loadAll() {
    try {
      const [person, rolesData, tlData, ctData] = await Promise.all([
        api('GET', `/api/people/${PID}`),
        api('GET', `/api/people/${PID}/roles?include_archived=1`),
        api('GET', `/api/people/${PID}/timeline?limit=200`),
        api('GET', `/api/people/${PID}/contacts`),
      ]);
      state.person = person;
      // 分頁標題 + favicon 換成這位客戶（同時開多人分頁時一眼分辨是誰）
      setPageIdentity(person);
      // 第一次點開看詳情 → 標記已看過，回列表就會從「最近新增」置頂帶歸位
      // （fire-and-forget，不阻塞畫面；不算互動，不影響聯絡時間/排序）
      if (!person.opened_at) {
        api('POST', `/api/people/${PID}/mark-opened`).catch(() => {});
        person.opened_at = new Date().toISOString();
      }
      state.roles = rolesData.items || [];
      state.timeline = tlData.items || [];
      state.contacts = ctData.items || [];
      // 若是介紹人，撈統計
      if (state.roles.find(r => r.role_type === 'introducer' && !r.archived_at)) {
        try {
          state.introducerStats = await api('GET', `/api/people/${PID}/roles/introducer/stats`);
        } catch (_) { state.introducerStats = null; }
      } else {
        state.introducerStats = null;
      }
      // 撈附件清單
      try {
        const fr = await api('GET', `/api/people/${PID}/files`);
        state.files = fr.items || [];
      } catch (_) { state.files = []; }

      // 群組：撈成員詳細資料
      if (person.is_group && (person.members || []).length > 0) {
        const memberData = await Promise.all(
          person.members.map(mid => api('GET', `/api/people/${mid}`).catch(() => null))
        );
        state.memberDetails = memberData.filter(m => m && !m.deleted_at);
      } else {
        state.memberDetails = [];
      }

      // 一般人：撈「被提到的紀錄」
      if (!person.is_group) {
        try {
          const md = await api('GET', `/api/people/${PID}/mentions`);
          state.mentionedItems = md.items || [];
        } catch (_) { state.mentionedItems = []; }
      } else {
        state.mentionedItems = [];
      }

      // 撈物件清單（賣方視角）
      try {
        const pr = await api('GET', `/api/people/${PID}/properties`);
        state.properties = pr.items || [];
      } catch (_) { state.properties = []; }

      renderAll();
      autoFixAvatarWhitespace();          // 自動修掉舊圖純色空白邊（fire-and-forget）
    } catch (e) {
      $('#detailTitle').textContent = '載入失敗';
      showToast('載入失敗：' + e.message, 'danger');
    }
  }

  function renderAll() {
    renderHeader();
    renderWarning();
    renderHero();
    renderQuickActions();
    renderInfoGrid();
    renderRoles();
    renderRelations();
    renderMembers();
    renderProperties();
    renderMentioned();
    renderFiles();
    renderTimeline();
    renderContacts();
  }

  // ═════════════════════════════════════════
  //  物件清單（賣方視角）
  // ═════════════════════════════════════════
  function renderProperties() {
    const sec = $('#propertiesSection');
    const list = $('#propertiesList');
    const cnt = $('#propertiesCount');
    if (!sec || !list) return;

    // 群組：動態聯集成員的 properties
    if (state.person.is_group) {
      renderGroupProperties(sec, list, cnt);
      return;
    }

    const items = state.properties || [];
    // 沒物件且不是賣方角色就不顯示
    const isSeller = (state.person.active_roles || []).includes('seller');
    if (items.length === 0 && !isSeller) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = 'block';
    cnt.textContent = items.length ? `（${items.length} 件）` : '';
    if (items.length === 0) {
      list.innerHTML = '<p class="muted" style="padding:8px;font-size:13px;">尚無物件</p>';
      return;
    }
    list.innerHTML = items.map(p => renderPropertyRow(p)).join('');
  }

  function renderPropertyRow(p, ownerLabel) {
    const sellingBadge = p.is_selling
      ? '<span class="prop-badge selling">銷售中</span>'
      : '<span class="prop-badge inactive">已下架</span>';
    const LIBRARY_URL = 'https://real-estate-library-334765337861.asia-east1.run.app';
    const sourceBadge = p.source === 'company_property' && p.source_ref
      ? `<a class="prop-source-link" href="${LIBRARY_URL}/?tab=company&cp=${encodeURIComponent(p.source_ref)}" target="_blank" rel="noopener" title="跳到物件庫看此物件">📦 物件庫 ↗</a>`
      : (p.source === 'seller_prospect' ? '<span class="prop-source-link">🌱 培養中</span>' : '<span class="prop-source-link">✏️ 手動</span>');
    const cat = p.category ? `<span class="prop-cat">[${escapeHtml(p.category)}]</span>` : '';
    const price = p.price != null ? `${p.price}萬` : '?';
    const ownerTag = ownerLabel ? `<span class="prop-owner-tag">📍 來自：${escapeHtml(ownerLabel)}</span>` : '';
    return `
      <div class="prop-row" data-id="${escapeHtml(p.id || '')}">
        <div class="prop-row-top">
          ${cat}
          <span class="prop-name">${escapeHtml(p.case_name || p.address || '(無案名)')}</span>
          <span class="prop-price">${price}</span>
        </div>
        <div class="prop-row-meta">
          ${sellingBadge}
          ${sourceBadge}
          ${ownerTag}
          ${p.address ? `<span class="prop-addr">${escapeHtml(p.address)}</span>` : ''}
        </div>
      </div>
    `;
  }

  // 群組詳情頁的物件清單：動態撈所有成員的 properties，合併去重
  async function renderGroupProperties(sec, list, cnt) {
    const memberIds = state.person.members || [];
    if (memberIds.length === 0) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = 'block';
    cnt.textContent = '（載入中…）';
    list.innerHTML = '<p class="muted" style="padding:8px;font-size:13px;">載入成員物件中...</p>';
    try {
      // 並行撈每位成員的 properties
      const results = await Promise.all(
        memberIds.map(mid => api('GET', `/api/people/${mid}/properties`).catch(() => ({ items: [] })))
      );
      // 平面化 + 加上「來自誰」標籤
      const merged = [];
      results.forEach((res, idx) => {
        const owner = state.memberDetails?.[idx];
        const ownerName = owner?.name || '?';
        (res.items || []).forEach(p => {
          merged.push({ ...p, _ownerName: ownerName });
        });
      });
      // 去重（依 source_ref / case_name）
      const seen = new Set();
      const dedup = [];
      for (const p of merged) {
        const key = p.source_ref || p.case_name || p.id;
        if (seen.has(key)) continue;
        seen.add(key);
        dedup.push(p);
      }
      // 銷售中優先排序
      dedup.sort((a, b) => (a.is_selling ? 0 : 1) - (b.is_selling ? 0 : 1));

      cnt.textContent = dedup.length ? `（${dedup.length} 件 · 來自 ${memberIds.length} 位成員）` : '';
      if (dedup.length === 0) {
        list.innerHTML = '<p class="muted" style="padding:8px;font-size:13px;">成員都沒有物件</p>';
        return;
      }
      list.innerHTML = dedup.map(p => renderPropertyRow(p, p._ownerName)).join('');
    } catch (e) {
      list.innerHTML = `<p class="muted" style="padding:8px;color:var(--danger)">載入失敗：${escapeHtml(e.message)}</p>`;
    }
  }

  // ═════════════════════════════════════════
  //  群組成員區（僅 is_group 顯示）
  // ═════════════════════════════════════════
  function renderMembers() {
    const sec = $('#membersSection');
    if (!state.person.is_group) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = 'block';
    const grid = $('#membersGrid');
    if (state.memberDetails.length === 0) {
      grid.innerHTML = '<p class="muted">尚無成員，點上方「＋ 加成員」</p>';
      $('#membersRelationsSvg').innerHTML = '';
      return;
    }
    grid.innerHTML = state.memberDetails.map((m, idx) => {
      const av = m.avatar_b64
        ? `<img src="${m.avatar_b64.startsWith('data:') ? m.avatar_b64 : 'data:image/jpeg;base64,'+m.avatar_b64}" alt="">`
        : escapeHtml((m.name || '?').charAt(0));
      const roles = (m.active_roles || []).map(r => {
        const cfg = ROLE_DISPLAY[r] || { label: r, cls: 'role-other' };
        return `<span class="role-pill ${cfg.cls}" style="font-size:10px">${escapeHtml(cfg.label)}</span>`;
      }).join('');
      return `
        <div class="member-card" data-id="${m.id}" data-idx="${idx}">
          <div class="member-avatar">${av}</div>
          <div class="member-name">${escapeHtml(m.name)}</div>
          <div class="member-roles">${roles}</div>
          <button type="button" class="member-rm" title="移除成員" data-id="${m.id}">✕</button>
        </div>
      `;
    }).join('');
    grid.querySelectorAll('.member-card').forEach(card => {
      card.addEventListener('click', (e) => {
        if (e.target.closest('.member-rm')) return;
        window.location.href = '/people/' + card.dataset.id;
      });
    });
    grid.querySelectorAll('.member-rm').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('移除此成員？')) return;
        try {
          await api('DELETE', `/api/people/${PID}/members/${btn.dataset.id}`);
          showToast('已移除');
          await loadAll();
        } catch (e) { showToast('失敗：' + e.message, 'danger'); }
      });
    });
    // 畫關係線
    setTimeout(drawRelationLines, 50);
  }

  function drawRelationLines() {
    const svg = $('#membersRelationsSvg');
    const grid = $('#membersGrid');
    if (!svg || !grid) return;
    const gridRect = grid.getBoundingClientRect();
    svg.setAttribute('width', gridRect.width);
    svg.setAttribute('height', gridRect.height);
    svg.style.width = gridRect.width + 'px';
    svg.style.height = gridRect.height + 'px';
    svg.style.top = grid.offsetTop + 'px';
    svg.style.left = grid.offsetLeft + 'px';

    const lines = [];
    const seen = new Set();
    state.memberDetails.forEach((m, i) => {
      (m.relations || []).forEach(rel => {
        const targetIdx = state.memberDetails.findIndex(x => x.id === rel.person_id);
        if (targetIdx < 0 || targetIdx === i) return;
        const key = [i, targetIdx].sort().join('-');
        if (seen.has(key)) return;
        seen.add(key);
        lines.push({ from: i, to: targetIdx, relation: rel.relation });
      });
    });
    if (lines.length === 0) {
      svg.innerHTML = '';
      return;
    }
    const cards = grid.querySelectorAll('.member-card');
    const RELATION_LABELS = {
      spouse: '配偶', parent: '父母', child: '子女', sibling: '兄弟姊妹',
      friend: '朋友', partner: '合夥人', introduced_by: '介紹', introduced: '介紹', other: '關聯',
    };
    svg.innerHTML = lines.map(l => {
      const a = cards[l.from], b = cards[l.to];
      if (!a || !b) return '';
      const ar = a.getBoundingClientRect();
      const br = b.getBoundingClientRect();
      const x1 = ar.left - gridRect.left + ar.width / 2;
      const y1 = ar.top - gridRect.top + ar.height / 2;
      const x2 = br.left - gridRect.left + br.width / 2;
      const y2 = br.top - gridRect.top + br.height / 2;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      return `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4,3"/>
        <rect x="${mx-22}" y="${my-10}" width="44" height="20" rx="10" fill="#fff" stroke="#cbd5e1"/>
        <text x="${mx}" y="${my+4}" font-size="11" fill="#475569" text-anchor="middle">${escapeHtml(RELATION_LABELS[l.relation] || l.relation)}</text>
      `;
    }).join('');
  }
  window.addEventListener('resize', drawRelationLines);

  // ═════════════════════════════════════════
  //  「被提到的紀錄」區（一般人，read-only）
  // ═════════════════════════════════════════
  // 加成員：開啟 modal（搜尋既有 + 新增）
  async function openMemberPicker() {
    if (state.allPeopleForPicker.length === 0) {
      try {
        const data = await api('GET', '/api/people?limit=500');
        state.allPeopleForPicker = data.items || [];
      } catch (_) {}
    }
    $('#memberPickerModal').style.display = 'flex';
    $('#memberSearch').value = '';
    $('#memberNewName').value = '';
    renderMemberCandidates('');
    setTimeout(() => $('#memberSearch').focus(), 50);
  }

  function closeMemberPicker() {
    $('#memberPickerModal').style.display = 'none';
  }

  function renderMemberCandidates(filter) {
    const memberIds = state.person.members || [];
    const q = (filter || '').toLowerCase().trim();
    const candidates = state.allPeopleForPicker.filter(p => {
      if (p.id === PID || p.is_group || memberIds.includes(p.id)) return false;
      if (!q) return true;
      const hay = ((p.name || '') + ' ' + (p.display_name || '') + ' ' + (p.company || '')).toLowerCase();
      return hay.includes(q);
    }).slice(0, 50);
    const box = $('#memberCandidates');
    if (candidates.length === 0) {
      box.innerHTML = '<p class="muted" style="padding:8px;">沒有符合的人脈</p>';
      return;
    }
    box.innerHTML = candidates.map(p => `
      <button type="button" class="rel-candidate" data-id="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name || '')}">
        <div class="rel-candidate-avatar">${p.avatar_b64 ? `<img src="${p.avatar_b64.startsWith('data:') ? p.avatar_b64 : 'data:image/jpeg;base64,'+p.avatar_b64}">` : escapeHtml(nameInitial(p.name))}</div>
        <div class="rel-candidate-info">
          <div class="rel-candidate-name">${escapeHtml(p.name || '')}</div>
          ${p.display_name || p.company ? `<div class="rel-candidate-sub">${escapeHtml([p.display_name, p.company].filter(Boolean).join(' · '))}</div>` : ''}
        </div>
      </button>
    `).join('');
    box.querySelectorAll('.rel-candidate').forEach(btn => {
      btn.addEventListener('click', () => addExistingMember(btn.dataset.id, btn.dataset.name));
    });
  }

  async function addExistingMember(personId, personName) {
    try {
      await api('POST', `/api/people/${PID}/members/${personId}`);
      showToast(`已加入「${personName}」`);
      closeMemberPicker();
      await loadAll();
    } catch (e) { showToast('失敗：' + e.message, 'danger'); }
  }

  async function createAndAddMember() {
    const name = ($('#memberNewName').value || '').trim();
    if (!name) {
      showToast('請輸入姓名', 'danger');
      $('#memberNewName').focus();
      return;
    }
    try {
      // 1. 建立新人脈（一般分類，預設）
      const newPerson = await api('POST', '/api/people', {
        name,
        bucket: 'normal',
        is_group: false,
      });
      // 2. 加入此群組
      await api('POST', `/api/people/${PID}/members/${newPerson.id}`);
      showToast(`已新增並加入「${name}」`);
      // 3. 同步更新 picker cache，讓搜尋看得到新人
      state.allPeopleForPicker.push(newPerson);
      closeMemberPicker();
      await loadAll();
    } catch (e) { showToast('失敗：' + e.message, 'danger'); }
  }

  function renderMentioned() {
    const sec = $('#mentionedSection');
    if (state.person.is_group || state.mentionedItems.length === 0) {
      sec.style.display = 'none';
      return;
    }
    sec.style.display = 'block';
    $('#mentionedList').innerHTML = state.mentionedItems.map(m => `
      <div class="mentioned-item">
        <div class="mentioned-meta">
          <a href="/people/${escapeHtml(m.from_person_id)}" class="mentioned-from">
            ${m.from_is_group ? '👥' : '👤'} ${escapeHtml(m.from_person_name)}
          </a>
          <span class="muted" style="font-size:11px">${escapeHtml(fmtDateTime(m.contact_at))}</span>
        </div>
        <div class="mentioned-content">${renderMentionContent(m.content, m.mentions || [])}</div>
      </div>
    `).join('');
  }

  function renderMentionContent(content, mentions) {
    if (!mentions || mentions.length === 0) return escapeHtml(content || '');
    // 把 mentions 在 content 中的位置變藍色 link
    // 簡化：直接把所有 @姓名 的子字串轉成 link（不管 start/end）
    let html = escapeHtml(content || '');
    const sorted = mentions.slice().sort((a, b) => (b.name || '').length - (a.name || '').length);
    for (const m of sorted) {
      const name = escapeHtml(m.name || '');
      if (!name || !m.person_id) continue;
      const re = new RegExp('@' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'g');
      html = html.replace(re, `<a class="mention-link" href="/people/${escapeHtml(m.person_id)}">@${name}</a>`);
    }
    return html;
  }

  // ═════════════════════════════════════════
  //  頭像上傳：縮放/拖曳裁切框（所見即所得，保證填滿圓不留白）
  // ═════════════════════════════════════════
  const AVATAR_SIZE = 160;        // 最終存檔尺寸
  const CROP_V = 260;             // 裁切框（顯示）尺寸
  // 裁切狀態：img 原圖、scale 目前縮放、minScale 剛好填滿圓的縮放（下限）
  const _crop = { img: null, scale: 1, minScale: 1, ox: 0, oy: 0, drag: false, lx: 0, ly: 0 };

  // 任何上傳入口（點頭像/Cmd+V/貼上選單/拖檔）都先進這裡開裁切框
  function uploadAvatarFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      showToast('請選圖片檔', 'danger');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => showToast('讀檔失敗', 'danger');
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => showToast('圖片解析失敗', 'danger');
      img.onload = () => openAvatarCropper(img);
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  }

  // 逐邊裁掉「整條都是同一純色」的空白邊（白/黑/透明/灰皆可），
  // 不靠四角同色——所以「只有右邊白」「只有四周灰」都抓得到；
  // 一般照片的邊緣不是純色 → 不裁。回傳主體 box（原圖座標）或 null。
  // 只用來決定裁切框初始位置（非破壞性，使用者仍可手動調整）。
  function detectContentBox(img) {
    try {
      const DET = 420;
      const s = Math.min(1, DET / Math.max(img.width, img.height));
      const dw = Math.max(1, Math.round(img.width * s));
      const dh = Math.max(1, Math.round(img.height * s));
      const dc = document.createElement('canvas');
      dc.width = dw; dc.height = dh;
      const x2 = dc.getContext('2d', { willReadFrequently: true });
      x2.drawImage(img, 0, 0, dw, dh);
      const d = x2.getImageData(0, 0, dw, dh).data;
      const idx = (x, y) => (y * dw + x) * 4;

      // 一條線（整列或整欄）是不是「幾乎純色」：
      // 取線上像素 RGB 的極差總和，夠小＝平坦（空白邊）；全透明也算。
      const FLAT = 38;          // 極差容忍（越小越嚴）
      function lineIsFlat(getXY, n) {
        let mnR=255,mnG=255,mnB=255,mxR=0,mxG=0,mxB=0, opaque=0;
        for (let t = 0; t < n; t++) {
          const [x, y] = getXY(t);
          const i = idx(x, y);
          if (d[i+3] < 24) continue;                 // 透明像素不計（透明邊照樣算平坦）
          opaque++;
          const r=d[i], g=d[i+1], b=d[i+2];
          if (r<mnR)mnR=r; if (r>mxR)mxR=r;
          if (g<mnG)mnG=g; if (g>mxG)mxG=g;
          if (b<mnB)mnB=b; if (b>mxB)mxB=b;
        }
        if (opaque === 0) return true;               // 整條透明 → 平坦
        return (mxR-mnR) + (mxG-mnG) + (mxB-mnB) <= FLAT;
      }
      const colFlat = (x) => lineIsFlat((t) => [x, t], dh);
      const rowFlat = (y) => lineIsFlat((t) => [t, y], dw);

      const capX = Math.floor(dw * 0.45);            // 每邊最多裁 45%，避免裁過頭
      const capY = Math.floor(dh * 0.45);
      let L = 0, R = 0, T = 0, B = 0;
      while (L < capX && colFlat(L)) L++;
      while (R < capX && colFlat(dw - 1 - R)) R++;
      while (T < capY && rowFlat(T)) T++;
      while (B < capY && rowFlat(dh - 1 - B)) B++;
      if (L + R + T + B === 0) return null;           // 沒有純色邊 → 一般照片，不對焦

      const bw = dw - L - R, bh = dh - T - B;
      if (bw < dw * 0.1 || bh < dh * 0.1) return null;          // 偵測異常（主體過小）
      if (bw > dw * 0.97 && bh > dh * 0.97) return null;        // 幾乎沒邊可裁

      const pad = 0.05, inv = 1 / s;                  // 留一點呼吸空間，換回原圖座標
      return {
        x: Math.max(0, (L - bw*pad) * inv),
        y: Math.max(0, (T - bh*pad) * inv),
        w: Math.min(img.width,  (bw * (1+pad*2)) * inv),
        h: Math.min(img.height, (bh * (1+pad*2)) * inv),
      };
    } catch (_) { return null; }
  }

  function openAvatarCropper(img) {
    _crop.img = img;
    // minScale：圖片較短邊縮到剛好等於裁切框 → 圓一定被填滿，永遠不可能留白
    _crop.minScale = CROP_V / Math.min(img.width, img.height);

    // 預設：自動對焦到主體（裁掉四周空白），讓「直接按確定」就填滿
    const box = detectContentBox(img);
    if (box) {
      // 讓主體 box 的較長邊剛好塞滿裁切框（再不可小於 minScale 以免露白）
      _crop.scale = Math.max(_crop.minScale, CROP_V / Math.min(box.w, box.h));
      const bcx = box.x + box.w / 2, bcy = box.y + box.h / 2;   // 主體中心
      _crop.ox = CROP_V / 2 - bcx * _crop.scale;
      _crop.oy = CROP_V / 2 - bcy * _crop.scale;
    } else {
      _crop.scale = _crop.minScale;                             // 一般照片：整張置中填滿
      _crop.ox = (CROP_V - img.width  * _crop.scale) / 2;
      _crop.oy = (CROP_V - img.height * _crop.scale) / 2;
    }
    clampCrop();

    const zoom = $('#cropZoom');
    if (zoom) {
      const mult = _crop.scale / _crop.minScale;                // 目前是 minScale 的幾倍
      zoom.min = 1; zoom.step = 0.01;
      zoom.max = Math.max(4, Math.ceil(mult) + 1);              // 自動對焦若超過 4 倍就延伸滑桿
      zoom.value = mult;
    }
    $('#avatarCropModal').style.display = 'flex';
    drawCrop();
  }

  // 限制平移範圍：圖片邊界不可進入裁切框內（保證滿版）
  function clampCrop() {
    const dw = _crop.img.width * _crop.scale;
    const dh = _crop.img.height * _crop.scale;
    _crop.ox = Math.min(0, Math.max(CROP_V - dw, _crop.ox));
    _crop.oy = Math.min(0, Math.max(CROP_V - dh, _crop.oy));
  }

  function drawCrop() {
    const c = $('#cropCanvas');
    if (!c || !_crop.img) return;
    c.width = CROP_V; c.height = CROP_V;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, CROP_V, CROP_V);
    clampCrop();
    ctx.drawImage(_crop.img, _crop.ox, _crop.oy,
      _crop.img.width * _crop.scale, _crop.img.height * _crop.scale);
  }

  // 滑桿縮放：value 1~4 代表「填滿的 1~4 倍」，並以中心為基準縮放
  function setCropZoom(mult) {
    const cx = CROP_V / 2, cy = CROP_V / 2;
    const ix = (cx - _crop.ox) / _crop.scale;
    const iy = (cy - _crop.oy) / _crop.scale;
    _crop.scale = _crop.minScale * mult;
    _crop.ox = cx - ix * _crop.scale;
    _crop.oy = cy - iy * _crop.scale;
    drawCrop();
  }

  function closeCrop() {
    $('#avatarCropModal').style.display = 'none';
    _crop.img = null;
  }

  async function confirmCrop() {
    if (!_crop.img) return;
    const k = AVATAR_SIZE / CROP_V;               // 裁切框 → 160 的比例
    const cv = document.createElement('canvas');
    cv.width = AVATAR_SIZE; cv.height = AVATAR_SIZE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';                    // 透明圖鋪白底（JPEG 否則變黑）
    ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    ctx.drawImage(_crop.img, _crop.ox * k, _crop.oy * k,
      _crop.img.width * _crop.scale * k, _crop.img.height * _crop.scale * k);
    const b64 = cv.toDataURL('image/jpeg', 0.9);
    closeCrop();
    try {
      $('#detailAvatar').innerHTML = `<img src="${b64}" alt="">`;   // 樂觀預覽
      await api('POST', `/api/people/${PID}/avatar`, { avatar_b64: b64 });
      showToast('頭像已更新');
      await loadAll();
    } catch (e) {
      showToast('上傳失敗：' + e.message, 'danger');
    }
  }

  // 打開客戶頁時，自動偵測並修掉「烤進存檔圖的純色空白邊」（白/灰/黑/透明）。
  // 只動真的有純色邊的舊壞圖；正常照片邊緣非純色 → detectContentBox 回 null → 不碰。
  // 修一次即止：修完的新圖沒有純色邊，下次不會再觸發（天然冪等）。
  let _avatarFixDone = false;
  async function autoFixAvatarWhitespace() {
    if (_avatarFixDone) return;
    const p = state.person;
    if (!p || p.is_group || !p.avatar_b64) return;
    _avatarFixDone = true;
    const raw = p.avatar_b64;
    const src = raw.startsWith('data:') ? raw : 'data:image/jpeg;base64,' + raw;
    const img = await new Promise((res) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    });
    if (!img) return;
    const box = detectContentBox(img);
    if (!box) return;                                   // 沒純色空白邊（正常照片）→ 不動
    if (box.w > img.width * 0.9 && box.h > img.height * 0.9) return;  // 邊太小，不值得動

    const OUT = AVATAR_SIZE;
    const scale = OUT / Math.min(box.w, box.h);         // 主體較短邊填滿 → 一定無白
    const drawW = img.width * scale, drawH = img.height * scale;
    let ox = OUT / 2 - (box.x + box.w / 2) * scale;
    let oy = OUT / 2 - (box.y + box.h / 2) * scale;
    ox = Math.min(0, Math.max(OUT - drawW, ox));        // 夾住，保證鋪滿
    oy = Math.min(0, Math.max(OUT - drawH, oy));
    const cv = document.createElement('canvas');
    cv.width = OUT; cv.height = OUT;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUT, OUT);
    ctx.drawImage(img, ox, oy, drawW, drawH);
    const b64 = cv.toDataURL('image/jpeg', 0.9);
    try {
      await api('POST', `/api/people/${PID}/avatar`, { avatar_b64: b64 });
      state.person.avatar_b64 = b64;
      renderHero();
      if (typeof setPageIdentity === 'function') setPageIdentity(state.person);
      showToast('已自動修正頭像空白邊');
    } catch (_) { /* 失敗無妨，使用者仍可手動點頭像用裁切框 */ }
  }

  // 裁切框拖曳（滑鼠 + 觸控統一用 pointer 事件）
  function bindCropDrag() {
    const stage = $('#cropStage');
    if (!stage) return;
    stage.addEventListener('pointerdown', (e) => {
      if (!_crop.img) return;
      _crop.drag = true; _crop.lx = e.clientX; _crop.ly = e.clientY;
      stage.setPointerCapture(e.pointerId);
      stage.style.cursor = 'grabbing';
    });
    stage.addEventListener('pointermove', (e) => {
      if (!_crop.drag) return;
      _crop.ox += e.clientX - _crop.lx;
      _crop.oy += e.clientY - _crop.ly;
      _crop.lx = e.clientX; _crop.ly = e.clientY;
      drawCrop();
    });
    const end = () => { _crop.drag = false; const s = $('#cropStage'); if (s) s.style.cursor = 'grab'; };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
  }

  function bindAvatarUpload() {
    // 隱藏 file input
    let fi = document.getElementById('hiddenAvatarInput');
    if (!fi) {
      fi = document.createElement('input');
      fi.type = 'file';
      fi.id = 'hiddenAvatarInput';
      fi.accept = 'image/*';
      fi.style.display = 'none';
      fi.addEventListener('change', (e) => {
        if (e.target.files[0]) uploadAvatarFile(e.target.files[0]);
        e.target.value = '';
      });
      document.body.appendChild(fi);
    }
    // 點頭像：已有頭像 → 直接載入目前這張進裁切框重新調整（免再找原檔）；
    //         還沒頭像 → 開檔案選擇器。（要換成別張圖：用旁邊 📋 貼上或拖曳）
    $('#detailAvatar').addEventListener('click', () => {
      const raw = state.person && state.person.avatar_b64;
      if (raw) {
        const img = new Image();
        img.onerror = () => fi.click();          // 載入失敗就退回選檔
        img.onload = () => openAvatarCropper(img);
        img.src = raw.startsWith('data:') ? raw : 'data:image/jpeg;base64,' + raw;
      } else {
        fi.click();
      }
    });

    // Cmd/Ctrl+V 貼圖：依當前可見區決定去處
    // - 焦點在 textarea/input → 不接管（貼文字）
    // - 只有頭像在視窗中 → 換頭像
    // - 只有附件在視窗中 → 進附件
    // - 兩個都在 → 跳 picker 問
    // - 兩個都不在 → 預設附件
    function isInViewport(el) {
      if (!el || el.offsetParent === null) return false;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      // 至少有 30% 高度可見才算在視窗中
      const visibleHeight = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      return visibleHeight >= Math.min(r.height, 30);
    }

    let _pendingPasteFiles = null;

    document.addEventListener('paste', (e) => {
      const fbModal = document.getElementById('fbw-modal');
      if (fbModal && fbModal.style.display !== 'none') return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'TEXTAREA' || tag === 'INPUT') return;
      const items = (e.clipboardData || {}).items || [];
      const files = [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') !== -1) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length === 0) return;
      e.preventDefault();

      const heroEl = document.querySelector('.detail-hero');
      const filesSection = document.querySelector('#filesList')?.closest('.detail-section')
                         || document.querySelector('#fileDropZone')?.closest('.detail-section');
      const heroVisible = isInViewport(heroEl);
      const filesVisible = isInViewport(filesSection);

      if (heroVisible && !filesVisible && files.length === 1) {
        uploadAvatarFile(files[0]);
      } else if (filesVisible && !heroVisible) {
        uploadFiles(files);
      } else if (heroVisible && filesVisible) {
        // 兩者都在 → 跳 picker
        _pendingPasteFiles = files;
        $('#pasteTargetModal').style.display = 'flex';
        setTimeout(() => $('#btnPasteAttach').focus(), 50);
      } else {
        // 兩者都不在（很罕見）→ 預設附件
        uploadFiles(files);
      }
    });

    // Picker 按鈕（注意：id 用 btnPickAvatar，不可與頭像旁的 📋 icon
    //「btnPasteAvatar」撞名，否則事件會綁到第一個同 id 的 icon 上）
    $('#btnPickAvatar')?.addEventListener('click', () => {
      const fs = _pendingPasteFiles;
      _pendingPasteFiles = null;
      $('#pasteTargetModal').style.display = 'none';
      if (fs && fs.length >= 1) uploadAvatarFile(fs[0]);
    });
    $('#btnPasteAttach')?.addEventListener('click', () => {
      const fs = _pendingPasteFiles;
      _pendingPasteFiles = null;
      $('#pasteTargetModal').style.display = 'none';
      if (fs && fs.length) uploadFiles(fs);
    });
    $('#btnClosePasteModal')?.addEventListener('click', () => {
      _pendingPasteFiles = null;
      $('#pasteTargetModal').style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
      if ($('#pasteTargetModal').style.display === 'flex') {
        if (e.key === 'Escape') {
          _pendingPasteFiles = null;
          $('#pasteTargetModal').style.display = 'none';
        }
      }
    });
    $('#pasteTargetModal').addEventListener('click', (e) => {
      if (e.target.id === 'pasteTargetModal') {
        _pendingPasteFiles = null;
        $('#pasteTargetModal').style.display = 'none';
      }
    });
  }

  // ═════════════════════════════════════════
  //  Header / Warning / Hero
  // ═════════════════════════════════════════

  function renderHeader() {
    const p = state.person;
    $('#detailTitle').textContent = p.name || '人脈詳情';
    document.title = `${p.name} — 人脈管理`;
  }

  function renderWarning() {
    const w = state.person.warning;
    const bar = $('#warningBar');
    if (w) {
      bar.style.display = 'flex';
      bar.innerHTML = `<span>⚠️</span><span>${escapeHtml(w)}</span>`;
    } else {
      bar.style.display = 'none';
    }
  }

  function renderHero() {
    const p = state.person;
    const av = $('#detailAvatar');
    if (p.avatar_b64) {
      av.innerHTML = `<img src="${p.avatar_b64.startsWith('data:') ? p.avatar_b64 : 'data:image/jpeg;base64,' + p.avatar_b64}" alt="">`;
    } else {
      av.textContent = nameInitial(p.name);
    }
    $('#detailName').textContent = p.name + (p.display_name ? ` (${p.display_name})` : '');

    const subParts = [];
    if (p.zodiac) subParts.push('♌ ' + p.zodiac);
    if (p.company) subParts.push(p.company);
    if (p.bucket && p.bucket !== 'normal') {
      const labels = { primary: '⭐ 主力', watching: '👀 觀察', frozen: '🧊 冷凍', closed: '✅ 已成交', blacklist: '⛔ 黑名單' };
      subParts.push(labels[p.bucket] || p.bucket);
    }
    $('#detailSubline').textContent = subParts.join(' · ');

    // 標籤膠囊
    const active = p.active_roles || [];
    $('#detailPills').innerHTML = active.map(r => {
      const cfg = ROLE_DISPLAY[r] || { label: r, cls: 'role-other' };
      return `<span class="role-pill ${cfg.cls}">${escapeHtml(cfg.label)}</span>`;
    }).join('');

    // 卡片顏色選擇器（群組不顯示）
    if (!p.is_group) {
      renderColorPicker(p.card_color || '');
    } else {
      $('#colorPickerRow').style.display = 'none';
    }
  }

  // ═════════════════════════════════════════
  //  卡片顏色選擇器
  // ═════════════════════════════════════════
  const CARD_COLORS = [
    { color: '',         name: '預設' },
    { color: '#ffd6d6',  name: '淡玫瑰' },
    { color: '#ffdfc8',  name: '淡桃' },
    { color: '#fff3c4',  name: '淡黃' },
    { color: '#d6f5d6',  name: '淡綠' },
    { color: '#c8f0ec',  name: '淡薄荷' },
    { color: '#c8e8f8',  name: '淡水藍' },
    { color: '#d4d8f8',  name: '淡藍紫' },
    { color: '#ead5f8',  name: '淡紫' },
    { color: '#f8d5ec',  name: '淡粉紫' },
    { color: '#ede0d4',  name: '奶茶' },
    { color: '#e8e8e8',  name: '淡灰' },
  ];

  function renderColorPicker(currentColor) {
    const row = $('#colorPickerRow');
    const dots = $('#colorDots');
    if (!row || !dots) return;
    row.style.display = '';
    dots.innerHTML = CARD_COLORS.map(c => {
      const selected = (c.color || '') === (currentColor || '') ? 'selected' : '';
      const bg = c.color ? `background:${c.color};` : 'background:transparent;border:1px dashed var(--border);';
      return `<button type="button" class="color-dot ${selected}" data-color="${c.color}" title="${c.name}" style="${bg}"></button>`;
    }).join('');
    dots.querySelectorAll('.color-dot').forEach(btn => {
      btn.addEventListener('click', () => saveCardColor(btn.dataset.color || ''));
    });
  }

  async function saveCardColor(color) {
    try {
      const r = await fetch(`/api/people/${PID}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ card_color: color || '' }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      state.person.card_color = color || null;
      // 更新 UI：選中標記 + 即時套用到 hero（讓使用者馬上看到）
      renderColorPicker(state.person.card_color || '');
      showToast(color ? '✅ 已套用顏色' : '已移除顏色', 'success');
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  Quick Actions（電話 / LINE / 導航）
  // ═════════════════════════════════════════

  function renderQuickActions() {
    const p = state.person;
    const contacts = p.contacts || [];
    const addresses = p.addresses || [];
    const buttons = [];

    contacts.forEach(c => {
      const label = c.label ? `(${c.label})` : '';
      if (c.type === 'mobile' || c.type === 'home' || c.type === 'work') {
        buttons.push(`<a class="qa-btn" href="tel:${encodeURIComponent(c.value)}"><span class="qa-btn-emoji">📞</span> ${escapeHtml(c.value)} ${escapeHtml(label)}</a>`);
      } else if (c.type === 'line_id') {
        buttons.push(`<a class="qa-btn" href="https://line.me/ti/p/~${encodeURIComponent(c.value)}" target="_blank"><span class="qa-btn-emoji">💬</span> LINE ${escapeHtml(label)}</a>`);
      } else if (c.type === 'email') {
        buttons.push(`<a class="qa-btn" href="mailto:${encodeURIComponent(c.value)}"><span class="qa-btn-emoji">✉️</span> ${escapeHtml(c.value)}</a>`);
      }
    });
    addresses.forEach(a => {
      buttons.push(`<a class="qa-btn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(a.value)}" target="_blank"><span class="qa-btn-emoji">🗺</span> 導航 ${escapeHtml(a.value)}</a>`);
    });

    $('#quickActions').innerHTML = buttons.join('');
  }

  // ═════════════════════════════════════════
  //  Info Grid
  // ═════════════════════════════════════════

  function renderInfoGrid() {
    const p = state.person;
    const rows = [];

    // 聯絡方式（每個一行）
    const contacts = p.contacts || [];
    if (contacts.length) {
      const items = contacts.map(c => {
        const typeLabels = { mobile: '手機', home: '市話', work: '公司', line_id: 'LINE', wechat: '微信', email: 'Email', other: '其他' };
        const label = c.label ? `(${c.label})` : '';
        return `${typeLabels[c.type] || '其他'}：${escapeHtml(c.value)} ${escapeHtml(label)}`;
      }).join('<br>');
      rows.push(infoRow('📱 聯絡方式', items, true));
    }

    if ((p.addresses || []).length) {
      const items = p.addresses.map(a => {
        const types = { home: '住家', office: '公司', other: '其他' };
        return `${types[a.type] || ''}：${escapeHtml(a.value)}`;
      }).join('<br>');
      rows.push(infoRow('🏠 地址', items, true));
    }

    if (p.birthday) {
      rows.push(infoRow('🎂 生日', `${p.birthday}${p.zodiac ? ' ・ ' + p.zodiac + '座' : ''}`));
    }
    if (p.gender) {
      const g = { M: '男', F: '女', other: '其他' };
      rows.push(infoRow('性別', g[p.gender] || p.gender));
    }
    if (p.company) rows.push(infoRow('🏢 公司', escapeHtml(p.company)));

    // 來源
    const src = p.source || {};
    if (src.channel && src.channel !== 'other') {
      const channels = { referral: '介紹', ad: '廣告', walk_in: '路過', phone_in: '來電', peer: '同業', company: '公司分配' };
      let val = channels[src.channel] || src.channel;
      if (src.channel === 'referral' && src.referrer_person_id) {
        val += ` (<a href="/people/${src.referrer_person_id}">介紹人</a>)`;
      }
      if (src.note) val += ` — ${escapeHtml(src.note)}`;
      rows.push(infoRow('📋 來源', val, true));
    }

    if ((p.relations || []).length) {
      const RELATION_LABELS = { spouse: '配偶', parent: '父母', child: '子女', sibling: '兄弟姊妹', friend: '朋友', partner: '合夥人', introduced_by: '介紹我', introduced: '我介紹', other: '其他' };
      const items = p.relations.map(r => {
        const lab = RELATION_LABELS[r.relation] || r.relation;
        return `<a href="/people/${r.person_id}">${lab}</a>${r.note ? ' — ' + escapeHtml(r.note) : ''}`;
      }).join(' / ');
      rows.push(infoRow('👥 關聯人', items, true));
    }

    if (p.last_contact_at) {
      rows.push(infoRow('🕓 上次聯絡', fmtDateTime(p.last_contact_at)));
    }

    // 電話（從 BUYER/LIBRARY 同步來的單一電話欄位；contacts[] 是 PEOPLE 自己的多筆格式）
    if (p.phone && !contacts.length) {
      rows.push(infoRow('📱 電話', escapeHtml(p.phone)));
    }

    // 備註（BUYER/LIBRARY 同步而來，或 PEOPLE 自己加）
    if (p.note) {
      rows.push(infoRow('📝 備註', escapeHtml(p.note).replace(/\n/g, '<br>'), true));
    }

    if (rows.length === 0) {
      rows.push(`<div class="info-row"><span class="info-val muted">尚未填寫資料</span></div>`);
    }

    $('#infoGrid').innerHTML = rows.join('');
  }

  function infoRow(key, val, isHtml) {
    return `<div class="info-row"><span class="info-key">${escapeHtml(key)}</span><span class="info-val">${isHtml ? val : escapeHtml(val)}</span></div>`;
  }

  // ═════════════════════════════════════════
  //  角色（Roles）
  // ═════════════════════════════════════════

  function renderRoles() {
    let roles = state.roles;
    if (!state.showArchived) {
      roles = roles.filter(r => !r.archived_at);
    }
    if (roles.length === 0) {
      $('#rolesContainer').innerHTML = '<p class="muted" style="margin:0">尚未掛任何角色，從上方下拉選單加入。</p>';
      return;
    }
    $('#rolesContainer').innerHTML = roles.map(renderRolePanel).join('');

    // 綁定事件（先 innerHTML 後綁，因為 DOM 重建）
    $$('.role-panel').forEach(panel => {
      const head = panel.querySelector('.role-head');
      head.addEventListener('click', (e) => {
        if (e.target.closest('.role-action-btn')) return;
        toggleRolePanel(panel.dataset.roleType);
      });
      panel.querySelector('.btn-save-role')?.addEventListener('click', () => saveRole(panel.dataset.roleType));
      panel.querySelector('.btn-archive-role')?.addEventListener('click', () => archiveRole(panel.dataset.roleType));
      panel.querySelector('.btn-upload-auth')?.addEventListener('click', () => triggerUploadAuth());
    });
  }

  function toggleRolePanel(roleType) {
    state.expandedRole = (state.expandedRole === roleType) ? null : roleType;
    renderRoles();
  }

  // ─── 角色 schema：欄位定義 + 資訊缺口三級 ───
  const ROLE_SCHEMAS = {
    buyer: {
      title: '買方',
      statusOptions: ['洽談中', '持續看物件', '暫無需求', '保持連繫', '成交', '流失'],
      fields: [
        { key: 'budget_max',   label: '預算上限（萬）',   type: 'number', level: 'required' },
        { key: 'category_pref', label: '類別偏好',        type: 'multi-tag', level: 'required',
          options: ['透天','別墅','農舍','公寓','華廈','套房','建地','農地','店面','店住','房屋'] },
        { key: 'area_pref',    label: '區域偏好',         type: 'tag-list', level: 'required' },
        { key: 'decision_maker', label: '主要決策者',     type: 'text', level: 'required',
          placeholder: '夫妻誰拍板、需徵詢誰' },
        { key: 'motivation',   label: '搬家動機',         type: 'text', level: 'recommended' },
        { key: 'family_composition', label: '家庭組成',  type: 'text', level: 'recommended',
          placeholder: '同住成員、有無小孩/長輩' },
        { key: 'urgency',      label: '急迫度',          type: 'select', level: 'recommended',
          options: [['','—'],['high','高'],['medium','中'],['low','低']] },
        { key: 'size_indoor.min', label: '室內坪數下限', type: 'number', level: 'recommended' },
        { key: 'size_indoor.max', label: '室內坪數上限', type: 'number', level: 'recommended' },
        { key: 'loan_plan',    label: '貸款規劃',        type: 'text', level: 'recommended' },
        { key: 'cash_available', label: '可動用現金（萬）', type: 'number', level: 'recommended' },
        { key: 'area_avoid',   label: '不要的區域',      type: 'tag-list', level: 'bonus' },
        { key: 'rooms',        label: '房間數',          type: 'number', level: 'bonus' },
        { key: 'bathrooms',    label: '衛浴數',          type: 'number', level: 'bonus' },
        { key: 'special_needs', label: '特殊需求',       type: 'text', level: 'bonus',
          placeholder: '大地坪、有車庫、電梯、坐向、特定樓層、停車方便...' },
        { key: 'commute_route', label: '上下班路線',     type: 'text', level: 'bonus' },
        { key: 'school_district', label: '學區需求',     type: 'text', level: 'bonus' },
      ],
      // 資訊缺口 11 項（用於進度條）
      infoGap: [
        { key: 'budget_max',         label: '預算上限', level: 'required' },
        { key: 'category_pref',      label: '類別偏好', level: 'required' },
        { key: 'area_pref',          label: '區域偏好', level: 'required' },
        { key: 'decision_maker',     label: '決策者',   level: 'required' },
        { key: 'motivation',         label: '搬家動機', level: 'recommended' },
        { key: 'family_composition', label: '家庭組成', level: 'recommended' },
        { key: 'urgency',            label: '急迫度',   level: 'recommended' },
        { key: 'size_indoor',        label: '坪數',     level: 'recommended' },
        { key: 'loan_plan',          label: '貸款規劃', level: 'recommended' },
        { key: 'rooms',              label: '房間數',   level: 'bonus' },
        { key: 'special_needs',      label: '特殊需求', level: 'bonus' },
      ],
    },
    seller: {
      title: '賣方',
      statusOptions: ['培養中', '已報價', '已簽委託', '已成交', '放棄'],
      fields: [
        { key: 'property_address', label: '物件地址',     type: 'text', level: 'required', full: true },
        { key: 'land_number',      label: '地號',         type: 'text', level: 'required' },
        { key: 'category',         label: '類別',         type: 'select', level: 'required',
          options: [['','—'],['透天','透天'],['別墅','別墅'],['農舍','農舍'],
                    ['公寓','公寓'],['華廈','華廈'],['套房','套房'],
                    ['建地','建地'],['農地','農地'],
                    ['店面','店面'],['店住','店住'],['房屋','房屋'],['其他','其他']] },
        { key: 'identity',         label: '賣方身份',     type: 'select', level: 'required',
          options: [['','—'],['sole_owner','唯一屋主'],['co_owner','共有人之一'],['agent','代理人']] },
        { key: 'co_owners',        label: '其他共有人',   type: 'text', level: 'recommended',
          placeholder: '僅 identity=共有人 時填' },
        { key: 'owner_price',      label: '屋主開價（萬）', type: 'number', level: 'required' },
        { key: 'bottom_price',     label: '底價（萬）',   type: 'number', level: 'recommended' },
        { key: 'size_indoor',      label: '室內坪數',     type: 'number', level: 'required' },
        { key: 'size_land',        label: '土地坪數',     type: 'number', level: 'recommended' },
        { key: 'age',              label: '屋齡',         type: 'number', level: 'recommended' },
        { key: 'decoration_status', label: '裝潢狀況',    type: 'select', level: 'bonus',
          options: [['','—'],['毛胚','毛胚'],['裝潢','裝潢'],['自住','自住'],['租出','租出']] },
        { key: 'current_use',      label: '目前使用',     type: 'select', level: 'recommended',
          options: [['','—'],['self','自住'],['rent','出租中'],['empty','閒置']] },
        { key: 'has_tenant',       label: '有租客',       type: 'checkbox', level: 'recommended' },
        { key: 'tenant_lease_end', label: '租約到期日',   type: 'date', level: 'recommended' },
        { key: 'has_mortgage',     label: '有貸款',       type: 'checkbox', level: 'recommended' },
        { key: 'mortgage_balance', label: '貸款餘額（萬）', type: 'number', level: 'recommended' },
        { key: 'motivation',       label: '出售動機',     type: 'text', level: 'recommended' },
        { key: 'urgency',          label: '急迫度',       type: 'select', level: 'recommended',
          options: [['','—'],['high','高'],['medium','中'],['low','低']] },
        { key: 'showing_availability', label: '帶看時段配合', type: 'text', level: 'bonus' },
      ],
      infoGap: [
        { key: 'property_address', label: '地址 + 地號', level: 'required' },
        { key: 'category',         label: '類別/坪數',   level: 'required' },
        { key: 'identity',         label: '身份',        level: 'required' },
        { key: 'owner_price',      label: '屋主開價',    level: 'required' },
        { key: 'current_use',      label: '使用狀況',    level: 'recommended' },
        { key: 'has_tenant',       label: '租約狀況',    level: 'recommended', isBoolean: true },
        { key: 'has_mortgage',     label: '貸款狀況',    level: 'recommended', isBoolean: true },
        { key: 'motivation',       label: '出售動機',    level: 'recommended' },
        { key: 'bottom_price',     label: '底價',        level: 'recommended' },
        { key: 'urgency',          label: '急迫度',      level: 'recommended' },
        { key: 'showing_availability', label: '帶看配合', level: 'bonus' },
      ],
    },
    introducer: { title: '介紹人', statusOptions: [], fields: [{ key: 'note', label: '備註', type: 'textarea', level: 'bonus', full: true }], infoGap: [] },
    landlord:   { title: '房東', statusOptions: [],
      fields: [
        { key: 'rental_property', label: '出租物件', type: 'text', level: 'recommended', full: true },
        { key: 'rent_amount',     label: '月租金',   type: 'number', level: 'recommended' },
        { key: 'current_tenant',  label: '現任房客', type: 'text', level: 'bonus' },
        { key: 'note',            label: '備註',     type: 'textarea', level: 'bonus', full: true },
      ], infoGap: [] },
    peer:       { title: '同業', statusOptions: [],
      fields: [
        { key: 'position',         label: '職稱',     type: 'text', level: 'recommended' },
        { key: 'cooperation_note', label: '合作備註', type: 'textarea', level: 'bonus', full: true },
      ], infoGap: [] },
    owner_friend: { title: '屋主朋友', statusOptions: [], fields: [{ key: 'note', label: '備註', type: 'textarea', level: 'bonus', full: true }], infoGap: [] },
    friend:       { title: '朋友',     statusOptions: [], fields: [{ key: 'note', label: '備註', type: 'textarea', level: 'bonus', full: true }], infoGap: [] },
    relative:     { title: '親戚',     statusOptions: [], fields: [{ key: 'note', label: '備註', type: 'textarea', level: 'bonus', full: true }], infoGap: [] },
  };

  function renderRolePanel(role) {
    const t = role.role_type;
    const schema = ROLE_SCHEMAS[t] || { title: t, fields: [], infoGap: [] };
    const expanded = state.expandedRole === t;
    const archived = !!role.archived_at;

    // 進度條（只 buyer/seller 有）
    let progressHtml = '';
    if (schema.infoGap.length > 0) {
      const filled = schema.infoGap.filter(g => isFilled(role, g.key, g.isBoolean)).length;
      const total = schema.infoGap.length;
      const requiredFilled = schema.infoGap.filter(g => g.level === 'required' && isFilled(role, g.key, g.isBoolean)).length;
      const requiredTotal = schema.infoGap.filter(g => g.level === 'required').length;
      const pct = Math.round(filled / total * 100);
      let cls = '';
      if (requiredFilled < requiredTotal) cls = 'danger';
      else if (filled < total * 0.7) cls = 'warn';
      progressHtml = `
        <div class="role-progress" title="必要 ${requiredFilled}/${requiredTotal} ・ 全部 ${filled}/${total}">
          <div class="role-progress-bar ${cls}"><span style="width:${pct}%"></span></div>
          <span>${pct}%</span>
        </div>
      `;
    }

    // 警示（賣方代理人無授權書）
    let blockingHtml = '';
    if (role.has_blocking_warning && role.blocking_reason) {
      blockingHtml = `<div class="role-blocking">⛔ ${escapeHtml(role.blocking_reason)} <button type="button" class="btn-add btn-upload-auth" style="margin:8px 0 0 0; width:auto; display:inline-block;">📎 上傳授權書</button></div>`;
    }

    const cfg = ROLE_DISPLAY[t] || { label: schema.title, cls: 'role-other' };
    const status = role.status || '';

    return `
      <div class="role-panel ${expanded ? 'expanded' : ''} ${archived ? 'archived' : ''}" data-role-type="${t}">
        <div class="role-head">
          <div class="role-head-left">
            <span class="role-pill ${cfg.cls}">${escapeHtml(cfg.label)}</span>
            ${status ? `<span class="role-status">${escapeHtml(status)}</span>` : ''}
            ${archived ? '<span class="role-status" style="color:var(--text-muted)">已封存</span>' : ''}
          </div>
          ${progressHtml}
          <span class="role-chevron">▶</span>
        </div>
        <div class="role-body">
          ${blockingHtml}
          ${t === 'introducer' ? renderIntroducerStats() : ''}
          ${renderInfoChecklist(role, schema)}
          ${renderRoleForm(role, schema)}
          <div class="role-actions">
            ${!archived ? `<button type="button" class="btn btn-danger btn-archive-role role-action-btn">封存此角色</button>` : ''}
            <button type="button" class="btn btn-primary btn-save-role role-action-btn">💾 儲存</button>
          </div>
        </div>
      </div>
    `;
  }

  function isFilled(role, key, isBoolean) {
    const v = getNested(role, key);
    if (isBoolean) return v === true || v === false;  // 有明確指定 true/false 才算填
    if (v == null || v === '') return false;
    if (Array.isArray(v) && v.length === 0) return false;
    if (typeof v === 'object' && Object.keys(v).length === 0) return false;
    return true;
  }
  function getNested(obj, path) {
    return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
  }

  function renderIntroducerStats() {
    const s = state.introducerStats;
    if (!s) return '';
    const intro = s.introduced || [];
    const ratePct = Math.round((s.deal_rate || 0) * 100);
    const list = intro.length ? intro.map(i => {
      const dealMark = i.is_deal ? '<span class="intro-deal">✅ 成交</span>' : '<span class="intro-pending">⏳ 進行中</span>';
      const roles = (i.active_roles || []).map(r => {
        const cfg = ROLE_DISPLAY[r] || { label: r, cls: 'role-other' };
        return `<span class="role-pill ${cfg.cls}" style="font-size:10px">${escapeHtml(cfg.label)}</span>`;
      }).join('');
      return `<a class="intro-row" href="/people/${i.id}">
        <span class="intro-name">${escapeHtml(i.name || '')}</span>
        ${roles}
        ${dealMark}
      </a>`;
    }).join('') : '<div class="muted" style="padding:8px 0">尚無介紹紀錄</div>';

    return `
      <div class="intro-stats">
        <div class="intro-numbers">
          <div class="intro-number"><div class="intro-num-val">${s.introduced_count}</div><div class="intro-num-lbl">介紹過</div></div>
          <div class="intro-number"><div class="intro-num-val intro-deal-color">${s.deal_count}</div><div class="intro-num-lbl">已成交</div></div>
          <div class="intro-number"><div class="intro-num-val">${ratePct}%</div><div class="intro-num-lbl">成交率</div></div>
        </div>
        <div class="intro-list">${list}</div>
      </div>
    `;
  }

  function renderInfoChecklist(role, schema) {
    if (schema.infoGap.length === 0) return '';
    const items = schema.infoGap.map(g => {
      const filled = isFilled(role, g.key, g.isBoolean);
      const cls = filled ? '' : `unfilled ${g.level === 'required' ? 'required' : ''}`;
      const dotCls = g.level;
      const mark = filled ? '☑' : '☐';
      return `<div class="checklist-item ${cls}">${mark} <span class="level-dot ${dotCls}"></span> ${escapeHtml(g.label)}</div>`;
    }).join('');
    return `<div class="role-info-checklist">${items}</div>`;
  }

  function renderRoleForm(role, schema) {
    const status = role.status || (schema.statusOptions[0] || '');
    const fieldsHtml = schema.fields.map(f => renderField(role, f)).join('');
    let html = '<div class="field-grid">';
    if (schema.statusOptions && schema.statusOptions.length) {
      html += `
        <div class="field field-full">
          <label class="field-label">狀態</label>
          <select data-field="status">
            ${schema.statusOptions.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>`;
    }
    html += fieldsHtml;
    html += '</div>';
    return html;
  }

  function renderField(role, f) {
    const v = getNested(role, f.key);
    const dot = `<span class="level-dot ${f.level}" title="${{required:'必要',recommended:'建議',bonus:'加分'}[f.level]}"></span>`;
    const label = `<label class="field-label">${dot} ${escapeHtml(f.label)}${f.level === 'required' ? ' <span class="field-required-mark">*</span>' : ''}</label>`;
    const fullCls = f.full ? 'field-full' : '';
    let input = '';
    const placeholder = f.placeholder ? `placeholder="${escapeHtml(f.placeholder)}"` : '';

    if (f.type === 'text') {
      input = `<input type="text" data-field="${f.key}" value="${escapeHtml(v == null ? '' : v)}" ${placeholder}>`;
    } else if (f.type === 'number') {
      input = `<input type="number" step="any" data-field="${f.key}" value="${v == null || v === '' ? '' : v}" ${placeholder}>`;
    } else if (f.type === 'date') {
      input = `<input type="date" data-field="${f.key}" value="${v || ''}">`;
    } else if (f.type === 'checkbox') {
      input = `<label style="display:flex;gap:6px;align-items:center;font-size:13px;"><input type="checkbox" data-field="${f.key}" ${v ? 'checked' : ''}> 是</label>`;
    } else if (f.type === 'textarea') {
      input = `<textarea data-field="${f.key}" rows="2" ${placeholder}>${escapeHtml(v || '')}</textarea>`;
    } else if (f.type === 'select') {
      input = `<select data-field="${f.key}">` +
        f.options.map(opt => {
          const [val, lbl] = Array.isArray(opt) ? opt : [opt, opt];
          return `<option value="${val}" ${String(val) === String(v == null ? '' : v) ? 'selected' : ''}>${escapeHtml(lbl)}</option>`;
        }).join('') + `</select>`;
    } else if (f.type === 'multi-tag') {
      const cur = Array.isArray(v) ? v : [];
      input = `<div data-field="${f.key}" data-type="multi-tag">` +
        f.options.map(opt => {
          const checked = cur.includes(opt);
          return `<label class="radio" style="margin-right:4px;margin-bottom:4px;font-size:12px;padding:3px 8px;"><input type="checkbox" value="${opt}" ${checked ? 'checked' : ''}> ${opt}</label>`;
        }).join('') + `</div>`;
    } else if (f.type === 'tag-list') {
      // 自由輸入逗號分隔
      const cur = Array.isArray(v) ? v.join('、') : '';
      input = `<input type="text" data-field="${f.key}" data-type="tag-list" value="${escapeHtml(cur)}" placeholder="多筆用「、」分隔">`;
    }

    return `<div class="field ${fullCls}">${label}${input}</div>`;
  }

  // ─── 角色儲存 ───
  async function saveRole(roleType) {
    const panel = document.querySelector(`.role-panel[data-role-type="${roleType}"]`);
    if (!panel) return;
    const data = {};
    panel.querySelectorAll('[data-field]').forEach(el => {
      const key = el.dataset.field;
      const dataType = el.dataset.type;
      let val;
      if (dataType === 'multi-tag') {
        val = Array.from(el.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
      } else if (dataType === 'tag-list') {
        val = el.value.split(/[、,]/).map(s => s.trim()).filter(Boolean);
      } else if (el.tagName === 'INPUT' && el.type === 'checkbox') {
        val = el.checked;
      } else if (el.tagName === 'INPUT' && el.type === 'number') {
        val = el.value === '' ? null : Number(el.value);
      } else {
        val = el.value;
      }
      // 處理 dot-notation key（size_indoor.min）
      if (key.includes('.')) {
        const [parent, child] = key.split('.');
        if (!data[parent]) data[parent] = {};
        if (val !== '' && val !== null && val !== undefined) data[parent][child] = val;
      } else {
        data[key] = val;
      }
    });

    try {
      // 用 POST，後端會視情況新增或更新（已存在會 set merge）
      await api('POST', `/api/people/${PID}/roles/${roleType}`, data);
      showToast('角色已儲存');
      await loadAll();  // 重新載入以更新 active_roles 和 timeline
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  async function archiveRole(roleType) {
    if (!confirm(`確定封存「${ROLE_SCHEMAS[roleType]?.title || roleType}」角色嗎？\n（不會刪除歷史，可隨時重新啟用）`)) return;
    try {
      await api('DELETE', `/api/people/${PID}/roles/${roleType}`);
      showToast('已封存');
      await loadAll();
    } catch (e) {
      showToast('封存失敗：' + e.message, 'danger');
    }
  }

  async function addRole(roleType) {
    if (!ROLE_SCHEMAS[roleType]) return;
    try {
      // 用空資料新增（之後使用者填完按儲存才更新）
      await api('POST', `/api/people/${PID}/roles/${roleType}`, {});
      showToast(`已加 ${ROLE_SCHEMAS[roleType].title} 角色`);
      state.expandedRole = roleType;
      await loadAll();
    } catch (e) {
      showToast('加角色失敗：' + e.message, 'danger');
    }
  }

  // ─── 賣方授權書上傳（hidden file input） ───
  function triggerUploadAuth() {
    let inp = document.getElementById('hiddenAuthFileInput');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'hiddenAuthFileInput';
      inp.style.display = 'none';
      inp.accept = 'image/*,.pdf';
      inp.addEventListener('change', uploadAuthFile);
      document.body.appendChild(inp);
    }
    inp.value = '';
    inp.click();
  }
  async function uploadAuthFile(ev) {
    const f = ev.target.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      await api('POST', `/api/people/${PID}/roles/seller/auth-file`, fd);
      showToast('授權書已上傳');
      await loadAll();
    } catch (e) {
      showToast('上傳失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  關聯人（Modal）
  // ═════════════════════════════════════════
  const RELATION_LABELS = {
    spouse: '配偶', parent: '父母', child: '子女', sibling: '兄弟姊妹',
    friend: '朋友', partner: '合夥人',
    introduced_by: '介紹我', introduced: '我介紹', other: '其他',
  };

  function renderRelations() {
    const rels = state.person.relations || [];
    const list = $('#relationsList');
    if (rels.length === 0) {
      list.innerHTML = '<p class="muted" style="margin:0">尚無關聯人</p>';
      return;
    }
    list.innerHTML = rels.map(r => `
      <div class="relation-row" data-pid="${escapeHtml(r.person_id)}" data-rel="${escapeHtml(r.relation)}">
        <a href="/people/${escapeHtml(r.person_id)}" class="relation-name">👤 ${escapeHtml(r.note ? '— ' : '')}<span class="rel-display-name" data-id="${escapeHtml(r.person_id)}">…</span></a>
        <span class="relation-type">${escapeHtml(RELATION_LABELS[r.relation] || r.relation)}</span>
        <button type="button" class="btn-rm-rel" title="移除此關聯">✕</button>
      </div>
    `).join('');
    // 每個關聯人 fetch 名字（avoid bulk fetch - 用 cache）
    list.querySelectorAll('.rel-display-name').forEach(async el => {
      const pid = el.dataset.id;
      try {
        const data = await api('GET', `/api/people/${pid}`);
        el.textContent = data.name || pid;
      } catch (_) { el.textContent = '(找不到)'; }
    });
    list.querySelectorAll('.btn-rm-rel').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const row = b.closest('.relation-row');
        const otherPid = row.dataset.pid;
        const rel = row.dataset.rel;
        if (!confirm('移除此關聯？（雙方都會移除）')) return;
        try {
          await api('DELETE', `/api/people/${PID}/relations?person_id=${encodeURIComponent(otherPid)}&relation=${encodeURIComponent(rel)}`);
          showToast('已移除關聯');
          await loadAll();
        } catch (e) {
          showToast('移除失敗：' + e.message, 'danger');
        }
      });
    });
  }

  async function openRelationModal() {
    state.selectedRelCandidate = null;
    $('#relSearch').value = '';
    $('#relCandidates').innerHTML = '';
    $('#relType').value = 'spouse';
    $('#relNote').value = '';
    // 載入所有人脈當候選（除去自己 + 已有關聯）
    if (state.allPeopleForPicker.length === 0) {
      try {
        const data = await api('GET', '/api/people?limit=500');
        state.allPeopleForPicker = data.items || [];
      } catch (_) {}
    }
    $('#relationModal').style.display = 'flex';
    setTimeout(() => $('#relSearch').focus(), 50);
  }

  function closeRelationModal() {
    $('#relationModal').style.display = 'none';
    state.selectedRelCandidate = null;
  }

  function filterRelCandidates(query) {
    const existingPids = new Set((state.person.relations || []).map(r => r.person_id));
    existingPids.add(PID);
    const q = (query || '').trim().toLowerCase();
    let list = state.allPeopleForPicker.filter(p => !existingPids.has(p.id));
    if (q) {
      list = list.filter(p => {
        const hay = (p.name || '').toLowerCase()
          + ' ' + (p.display_name || '').toLowerCase()
          + ' ' + (p.contacts || []).map(c => c.value || '').join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    list = list.slice(0, 12);
    const cont = $('#relCandidates');
    if (list.length === 0) {
      cont.innerHTML = '<div class="rel-cand-row" style="color:var(--text-muted)">沒有匹配的人脈</div>';
      return;
    }
    cont.innerHTML = list.map(p => `
      <div class="rel-cand-row" data-pid="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}">
        ${escapeHtml(p.name)}${p.display_name ? ` (${escapeHtml(p.display_name)})` : ''}
      </div>
    `).join('');
    cont.querySelectorAll('.rel-cand-row[data-pid]').forEach(row => {
      row.addEventListener('click', () => {
        cont.querySelectorAll('.rel-cand-row').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        state.selectedRelCandidate = { id: row.dataset.pid, name: row.dataset.name };
        $('#relSearch').value = row.dataset.name;
      });
    });
  }

  async function saveRelation() {
    if (!state.selectedRelCandidate) {
      showToast('請先選擇對象', 'danger');
      return;
    }
    try {
      await api('POST', `/api/people/${PID}/relations`, {
        person_id: state.selectedRelCandidate.id,
        relation: $('#relType').value,
        note: $('#relNote').value.trim(),
      });
      showToast('已加關聯');
      closeRelationModal();
      await loadAll();
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  附件（File upload + list）
  // ═════════════════════════════════════════
  function renderFiles() {
    const list = $('#filesList');
    if (state.files.length === 0) {
      list.innerHTML = '<p class="muted" style="margin:0">尚無附件</p>';
      return;
    }
    list.innerHTML = state.files.map(f => {
      const mime = f.mime_type || '';
      const isImg = mime.startsWith('image/');
      const isAudio = mime.startsWith('audio/');
      const isPdf = mime === 'application/pdf';
      const url = `/people-file/${encodeURI(f.gcs_path)}`;
      const fname = f.filename || '';

      // 音訊：直接內嵌 <audio controls>，不用點擊跳出
      if (isAudio) {
        const summaryLine = f.summary ? `<div class="file-item-name" title="${escapeHtml(f.summary)}">🎙️ ${escapeHtml(f.summary.slice(0, 60))}</div>` : `<div class="file-item-name">🎙️ ${escapeHtml(fname)}</div>`;
        return `
          <div class="file-item file-audio" data-id="${escapeHtml(f.id)}" style="aspect-ratio:auto;padding:8px;">
            <audio controls src="${url}" preload="metadata" style="width:100%;display:block;"></audio>
            ${summaryLine}
            <button type="button" class="file-rm" title="刪除" data-id="${escapeHtml(f.id)}">✕</button>
          </div>
        `;
      }

      const icon = isPdf ? '📄' : fname.match(/\.(doc|docx)$/i) ? '📝' : '📎';
      const inner = isImg
        ? `<img src="${url}" alt="${escapeHtml(fname)}" loading="lazy">`
        : `<div class="file-item-icon">${icon}</div>`;
      return `
        <a href="${url}" target="_blank" class="file-item" data-id="${escapeHtml(f.id)}">
          ${inner}
          <div class="file-item-name">${escapeHtml(fname)}</div>
          <button type="button" class="file-rm" title="刪除" data-id="${escapeHtml(f.id)}">✕</button>
        </a>
      `;
    }).join('');
    list.querySelectorAll('.file-rm').forEach(b => {
      b.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const fid = b.dataset.id;
        if (!confirm('確定刪除這個附件？')) return;
        try {
          await api('DELETE', `/api/people/${PID}/files/${fid}`);
          showToast('附件已刪除');
          await loadAll();
        } catch (e) {
          showToast('刪除失敗：' + e.message, 'danger');
        }
      });
    });
  }

  // 上傳一個檔案，回傳 Promise，含進度回呼
  function uploadOneFile(file, endpoint = `/api/people/${PID}/files`, fieldName = 'file') {
    return new Promise((resolve, reject) => {
      const isAudio = (file.type || '').startsWith('audio/');
      const row = document.createElement('div');
      row.className = 'upload-row';
      row.innerHTML = `
        <span class="upr-name">${escapeHtml(file.name)}</span>
        <span class="upr-bar"><span style="width:0%"></span></span>
        <span class="upr-status">準備上傳…</span>
      `;
      $('#uploadProgress').appendChild(row);
      const bar = row.querySelector('.upr-bar > span');
      const status = row.querySelector('.upr-status');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', endpoint);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = Math.round((e.loaded / e.total) * 100);
          bar.style.width = pct + '%';
          status.textContent = pct + '%';
        }
      });
      xhr.upload.addEventListener('load', () => {
        bar.style.width = '100%';
        if (isAudio) {
          row.classList.add('transcribing');
          status.textContent = '🤖 AI 轉檔中…';
        } else {
          status.textContent = '處理中…';
        }
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          row.classList.remove('transcribing');
          row.classList.add('done');
          let txt = '✓ 完成';
          try {
            const j = JSON.parse(xhr.responseText);
            if (j && j.transcribed) txt = '✓ 已轉逐字稿';
          } catch (_) {}
          status.textContent = txt;
          setTimeout(() => row.remove(), 2500);
          resolve();
        } else {
          row.classList.add('error');
          status.textContent = '✗ 失敗';
          setTimeout(() => row.remove(), 4000);
          reject(new Error(`HTTP ${xhr.status}`));
        }
      });
      xhr.addEventListener('error', () => {
        row.classList.add('error');
        status.textContent = '✗ 連線失敗';
        setTimeout(() => row.remove(), 4000);
        reject(new Error('network'));
      });

      const fd = new FormData();
      fd.append(fieldName, file, file.name || 'upload');
      xhr.withCredentials = true;
      xhr.send(fd);
    });
  }

  async function uploadFiles(fileList) {
    const files = Array.from(fileList);
    if (files.length === 0) return;
    let ok = 0, fail = 0;
    for (const f of files) {
      try {
        await uploadOneFile(f);
        ok++;
      } catch (_) { fail++; }
    }
    if (fail) showToast(`完成 ${ok}/${files.length}（${fail} 失敗）`, 'danger');
    else showToast(`已上傳 ${ok} 個檔案`);
    await loadAll();
  }

  // 從剪貼簿貼上（顯式按鈕）
  async function pasteFromClipboard() {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) {
        showToast('此瀏覽器不支援剪貼簿讀取（試 Chrome 或 Cmd+V 直接貼）', 'danger');
        return;
      }
      const items = await navigator.clipboard.read();
      const files = [];
      for (const it of items) {
        const imgType = it.types.find(t => t.startsWith('image/'));
        if (imgType) {
          const blob = await it.getType(imgType);
          const ext = imgType.split('/')[1] || 'png';
          files.push(new File([blob], `clipboard-${Date.now()}.${ext}`, { type: imgType }));
        }
      }
      if (files.length === 0) {
        showToast('剪貼簿沒有圖片', 'danger');
        return;
      }
      uploadFiles(files);
    } catch (e) {
      showToast('讀取失敗：' + e.message + '（瀏覽器可能要求許可）', 'danger');
    }
  }

  // 拖曳上傳：bind 到 dropzone 與 detail-section
  function bindFileDropzone() {
    const dz = $('#fileDropZone');
    if (!dz) return;
    ['dragenter', 'dragover'].forEach(ev => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.add('hover');
      });
    });
    ['dragleave', 'drop'].forEach(ev => {
      dz.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.remove('hover');
      });
    });
    dz.addEventListener('drop', (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) uploadFiles(files);
    });
    dz.addEventListener('click', () => $('#hiddenFileInput').click());
  }

  // ═════════════════════════════════════════
  //  瀏覽器錄音（MediaRecorder）
  // ═════════════════════════════════════════
  let _recState = null; // {recorder, stream, chunks, startedAt, timerId}
  const REC_MAX_MS = 5 * 60 * 1000;

  function openRecordModal() {
    $('#recordModal').style.display = 'flex';
    resetRecModal();
  }
  function closeRecordModal() {
    if (_recState) stopRecording(true);
    $('#recordModal').style.display = 'none';
  }
  function resetRecModal() {
    $('#recPulse').className = 'rec-pulse idle';
    $('#recPulse').textContent = '🎤';
    $('#recTime').textContent = '00:00';
    $('#recStatus').textContent = '點下方「開始錄音」（最長 5 分鐘）';
    $('#btnStartRec').style.display = 'inline-block';
    $('#btnStopRec').style.display = 'none';
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // 偵測 MIME（webm 在桌機 Chrome / Android、mp4 在 iOS Safari）
      let mime = '';
      const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/mpeg'];
      for (const c of candidates) {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) { mime = c; break; }
      }
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => uploadRecordedAudio(chunks, recorder.mimeType || 'audio/webm');
      recorder.start();

      const startedAt = Date.now();
      _recState = { recorder, stream, chunks, startedAt };
      _recState.timerId = setInterval(() => {
        const ms = Date.now() - startedAt;
        const s = Math.floor(ms / 1000);
        $('#recTime').textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
        if (ms > REC_MAX_MS) stopRecording();
      }, 250);

      $('#recPulse').className = 'rec-pulse';
      $('#recPulse').textContent = '🔴';
      $('#recStatus').textContent = '錄音中…說話告一段落後點停止';
      $('#btnStartRec').style.display = 'none';
      $('#btnStopRec').style.display = 'inline-block';
    } catch (e) {
      showToast('無法存取麥克風：' + e.message, 'danger');
    }
  }

  function stopRecording(skipUpload) {
    if (!_recState) return;
    const st = _recState;
    _recState = null;
    clearInterval(st.timerId);
    if (skipUpload) {
      try { st.recorder.ondataavailable = null; st.recorder.onstop = null; } catch(_){}
    }
    try { st.recorder.stop(); } catch(_){}
    try { st.stream.getTracks().forEach(t => t.stop()); } catch(_){}
  }

  async function uploadRecordedAudio(chunks, mimeType) {
    if (chunks.length === 0) {
      showToast('沒有錄到聲音', 'danger');
      resetRecModal();
      return;
    }
    const blob = new Blob(chunks, { type: mimeType });
    const ext = mimeType.includes('mp4') ? 'm4a' : (mimeType.includes('webm') ? 'webm' : 'audio');
    const filename = `voice-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.${ext}`;
    const file = new File([blob], filename, { type: mimeType });

    $('#recStatus').textContent = '上傳中…';
    $('#btnStopRec').style.display = 'none';

    try {
      await uploadOneFile(file, `/api/people/${PID}/contacts/voice`, 'audio');
      $('#recStatus').textContent = '✓ 已建立互動記事';
      showToast('已上傳並轉檔');
      setTimeout(() => closeRecordModal(), 800);
      await loadAll();
    } catch (e) {
      $('#recStatus').textContent = '✗ 失敗：' + e.message;
      showToast('上傳失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  Timeline
  // ═════════════════════════════════════════

  // 重大事件類型（永遠不折疊）
  const TL_MAJOR_TYPES = new Set([
    'role_added', 'role_archived', 'role_reactivated',
    'status_changed', 'warning_set',
    'legacy_linked', 'person_created',
    'voice_contact_added', 'screenshot_contact_added',
    'auth_file_uploaded', 'person_restored',
  ]);

  function renderTimeline() {
    const items = state.timeline.slice().sort((a, b) =>
      (b.occurred_at || '').localeCompare(a.occurred_at || ''));
    if (items.length === 0) {
      $('#timelineList').innerHTML = '<p class="muted" style="margin:0">尚無事件</p>';
      return;
    }

    // 按月份分組（YYYY-MM）
    const groups = [];  // [{key, label, major:[], minor:[]}]
    const groupMap = new Map();
    const todayKey = new Date().toISOString().slice(0, 7);
    for (const e of items) {
      const iso = e.occurred_at || '';
      const key = iso.slice(0, 7) || '0000-00';
      if (!groupMap.has(key)) {
        const label = key === '0000-00' ? '時間不明' :
                      key === todayKey ? `${key} ・ 本月` : key;
        const g = { key, label, items: [] };
        groupMap.set(key, g);
        groups.push(g);
      }
      groupMap.get(key).items.push(e);
    }

    // 最近 3 個月預設展開
    const monthsSorted = groups.map(g => g.key).filter(k => k !== '0000-00');
    const expandedKeys = new Set(monthsSorted.slice(0, 3));

    $('#timelineList').innerHTML = groups.map(g => {
      const major = g.items.filter(e => TL_MAJOR_TYPES.has(e.type));
      const minor = g.items.filter(e => !TL_MAJOR_TYPES.has(e.type));
      const minorCount = minor.length;
      const isExpanded = expandedKeys.has(g.key);
      const expandedCls = isExpanded ? ' expanded' : '';

      const majorHtml = major.map(e => `
        <div class="tl-item tl-major">
          <div class="tl-time">${escapeHtml(fmtDateTime(e.occurred_at))}</div>
          <div class="tl-text">${escapeHtml(e.display_text || e.type)}</div>
        </div>
      `).join('');

      const minorHtml = minor.map(e => `
        <div class="tl-item">
          <div class="tl-time">${escapeHtml(fmtDateTime(e.occurred_at))}</div>
          <div class="tl-text">${escapeHtml(e.display_text || e.type)}</div>
        </div>
      `).join('');

      return `
        <div class="tl-group${expandedCls}" data-key="${escapeHtml(g.key)}">
          <div class="tl-group-head">📅 ${escapeHtml(g.label)} ・ 共 ${g.items.length} 件</div>
          ${majorHtml}
          ${minorCount ? `
            <div class="tl-fold-wrap">
              <button class="tl-fold-btn" type="button" data-count="${minorCount}">${isExpanded ? '▼ 收合' : '▶ 展開'}其他 ${minorCount} 件</button>
              <div class="tl-fold-body">${minorHtml}</div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');

    // 綁折疊按鈕
    $$('.tl-fold-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const grp = btn.closest('.tl-group');
        const expanded = grp.classList.toggle('expanded');
        const num = btn.dataset.count || '0';
        btn.textContent = `${expanded ? '▼ 收合' : '▶ 展開'}其他 ${num} 件`;
      });
    });
  }

  // ═════════════════════════════════════════
  //  互動記事
  // ═════════════════════════════════════════

  function renderContacts() {
    const list = $('#contactList');
    if (state.contacts.length === 0) {
      list.innerHTML = '<p class="muted" style="margin:0">尚無互動記事</p>';
      return;
    }
    const VIA_LABEL = { phone: '📞 電話', line: '💬 LINE', meet: '🤝 見面', showing: '🏠 帶看', other: '其他' };
    list.innerHTML = state.contacts.map(c => {
      const viaTag = `<span>${escapeHtml(VIA_LABEL[c.via] || '其他')}</span>`;
      const voiceBadge = c.voice_recorded ? `<span class="contact-voice-badge">🎙️ 錄音</span>`
        : (c.from_screenshot ? `<span class="contact-voice-badge" style="background:#dcfce7;color:#166534">💬 對話截圖</span>` : '');
      const keywords = (c.keywords || []).length
        ? `<div class="contact-keywords">${c.keywords.map(k => `<span class="contact-kw">${escapeHtml(k)}</span>`).join('')}</div>`
        : '';
      const audio = c.audio_gcs_path
        ? `<audio class="contact-audio-player" controls preload="metadata" src="/people-file/${encodeURI(c.audio_gcs_path)}"></audio>`
        : '';
      const screenshot = c.screenshot_gcs_path
        ? `<a href="/people-file/${encodeURI(c.screenshot_gcs_path)}" target="_blank"><img class="contact-screenshot" src="/people-file/${encodeURI(c.screenshot_gcs_path)}" alt="對話截圖" loading="lazy" style="max-width:240px;border-radius:6px;border:1px solid var(--border);margin-top:6px;cursor:zoom-in;"></a>`
        : '';
      const transcriptLabel = c.from_screenshot ? '📜 完整對話' : '📜 完整逐字稿';
      const transcript = c.transcript
        ? `<details class="contact-transcript"><summary>${transcriptLabel}</summary><pre>${escapeHtml(c.transcript)}</pre></details>`
        : '';
      // contact_at 轉成 datetime-local 用的格式（YYYY-MM-DDTHH:MM）
      let contactAtLocal = '';
      if (c.contact_at) {
        const d = new Date(c.contact_at);
        if (!isNaN(d.getTime())) {
          const pad = n => String(n).padStart(2, '0');
          contactAtLocal = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
        }
      }
      const renderedContent = (c.mentions && c.mentions.length)
        ? renderMentionContent(c.content, c.mentions)
        : escapeHtml(c.content);
      return `
        <div class="contact-item" data-id="${c.id}" data-via="${escapeHtml(c.via || 'other')}" data-at="${contactAtLocal}">
          <div class="contact-view">
            <div class="contact-meta">
              ${viaTag}
              ${voiceBadge}
              <span class="contact-time">${escapeHtml(fmtDateTime(c.contact_at))}</span>
            </div>
            <div class="contact-content">${renderedContent}</div>
            ${keywords}
            ${audio}
            ${screenshot}
            ${transcript}
            <div class="contact-actions">
              ${c.transcript || c.audio_gcs_path || c.screenshot_gcs_path ? '' : `<button class="link-btn" data-action="edit-contact">✏️ 編輯</button>`}
              <button class="link-btn danger" data-action="del-contact">刪除</button>
            </div>
          </div>
          <div class="contact-edit" style="display:none">
            <div class="contact-edit-row">
              <select class="contact-edit-via">
                <option value="phone">📞 電話</option>
                <option value="line">💬 LINE</option>
                <option value="meet">🤝 見面</option>
                <option value="showing">🏠 帶看</option>
                <option value="other">其他</option>
              </select>
              <input type="datetime-local" class="contact-edit-at" value="${contactAtLocal}">
            </div>
            <textarea class="contact-edit-content" rows="3">${escapeHtml(c.content)}</textarea>
            <div class="contact-actions" style="justify-content:flex-end">
              <button class="link-btn" data-action="cancel-edit">取消</button>
              <button class="link-btn" style="color:var(--primary)" data-action="save-edit">儲存</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    list.querySelectorAll('[data-action]').forEach(b => {
      b.addEventListener('click', () => contactAction(b));
    });
  }

  function contactAction(btn) {
    const item = btn.closest('.contact-item');
    if (!item) return;
    const cid = item.dataset.id;
    const action = btn.dataset.action;
    if (action === 'del-contact') {
      deleteContact(cid);
    } else if (action === 'edit-contact') {
      // 進入編輯模式：set 預設值（HTML 已有，但 select 要 setValue）
      item.querySelector('.contact-edit-via').value = item.dataset.via || 'other';
      item.querySelector('.contact-view').style.display = 'none';
      item.querySelector('.contact-edit').style.display = 'block';
    } else if (action === 'cancel-edit') {
      item.querySelector('.contact-edit').style.display = 'none';
      item.querySelector('.contact-view').style.display = 'block';
    } else if (action === 'save-edit') {
      saveContactEdit(item, cid);
    }
  }

  async function saveContactEdit(item, cid) {
    const via = item.querySelector('.contact-edit-via').value;
    const atVal = item.querySelector('.contact-edit-at').value;  // YYYY-MM-DDTHH:MM
    const content = item.querySelector('.contact-edit-content').value.trim();
    if (!content) {
      showToast('內容不能空白', 'danger');
      return;
    }
    const payload = { content, via };
    if (atVal) {
      // 轉成 ISO 字串（含本地時區）
      const d = new Date(atVal);
      if (!isNaN(d.getTime())) payload.contact_at = d.toISOString();
    }
    try {
      await api('PUT', `/api/people/${PID}/contacts/${cid}`, payload);
      showToast('已更新');
      await loadAll();
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  async function addContact() {
    const content = $('#contactInput').value.trim();
    if (!content) return showToast('請輸入互動內容', 'danger');
    const via = $('#contactVia').value;
    // 從輸入內容中找出 @mention（依當前 mention 建議池）
    const mentions = collectMentionsFromText(content);
    try {
      await api('POST', `/api/people/${PID}/contacts`, { content, via, mentions });
      $('#contactInput').value = '';
      _mentionState.activeMentions = [];
      showToast('已記錄');
      await loadAll();
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  // ─── @mention 自動完成 ───
  const _mentionState = {
    candidates: [],     // 群組成員 + @all（群組頁）；個人關聯人（一般人頁）
    activeMentions: [], // 已加進這次輸入的 mentions（記錄使用過的）
    triggerStart: -1,   // @ 起始位置
    selectedIdx: 0,
  };

  function getMentionCandidates() {
    // 群組頁：成員 + @all
    if (state.person.is_group) {
      const cands = state.memberDetails.map(m => ({
        person_id: m.id, name: m.name,
        avatar_b64: m.avatar_b64,
      }));
      cands.push({ person_id: '@all', name: 'all', label: '@all（全部成員）' });
      return cands;
    }
    // 一般人頁：自己的關聯人
    return (state.person.relations || []).map(r => {
      const p = state.allPeopleForPicker.find(x => x.id === r.person_id);
      return p ? { person_id: p.id, name: p.name, avatar_b64: p.avatar_b64 } : null;
    }).filter(Boolean);
  }

  function bindMentionInput() {
    const input = $('#contactInput');
    const dropdown = $('#mentionDropdown');
    if (!input || !dropdown) return;

    async function ensureCandidates() {
      _mentionState.candidates = getMentionCandidates();
      // 如果是一般人頁但 allPeopleForPicker 還沒撈，去撈
      if (!state.person.is_group && state.allPeopleForPicker.length === 0) {
        try {
          const data = await api('GET', '/api/people?limit=500');
          state.allPeopleForPicker = data.items || [];
          _mentionState.candidates = getMentionCandidates();
        } catch (_) {}
      }
    }

    input.addEventListener('input', async (e) => {
      const val = input.value;
      const pos = input.selectionStart || val.length;
      // 找最近的 @
      const before = val.slice(0, pos);
      const atIdx = before.lastIndexOf('@');
      if (atIdx < 0) {
        dropdown.style.display = 'none';
        _mentionState.triggerStart = -1;
        return;
      }
      // @ 後不能含空白
      const afterAt = before.slice(atIdx + 1);
      if (/\s/.test(afterAt)) {
        dropdown.style.display = 'none';
        _mentionState.triggerStart = -1;
        return;
      }
      _mentionState.triggerStart = atIdx;
      await ensureCandidates();
      const q = afterAt.toLowerCase();
      const matches = _mentionState.candidates.filter(c =>
        (c.name || '').toLowerCase().includes(q)
      ).slice(0, 8);
      if (matches.length === 0) {
        dropdown.style.display = 'none';
        return;
      }
      _mentionState.selectedIdx = 0;
      dropdown.innerHTML = matches.map((c, i) => {
        const av = c.avatar_b64
          ? `<div class="mention-cand-avatar"><img src="${c.avatar_b64.startsWith('data:') ? c.avatar_b64 : 'data:image/jpeg;base64,'+c.avatar_b64}"></div>`
          : `<div class="mention-cand-avatar">${escapeHtml((c.name || '?').charAt(0))}</div>`;
        return `<div class="mention-cand ${i === 0 ? 'active' : ''}" data-pid="${escapeHtml(c.person_id)}" data-name="${escapeHtml(c.name)}">${av} ${escapeHtml(c.label || '@' + c.name)}</div>`;
      }).join('');
      dropdown.style.display = 'block';
      dropdown.querySelectorAll('.mention-cand').forEach(el => {
        el.addEventListener('mousedown', (ev) => {
          ev.preventDefault();
          insertMention(el.dataset.pid, el.dataset.name);
        });
      });
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.style.display === 'none') return;
      const cands = dropdown.querySelectorAll('.mention-cand');
      if (cands.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _mentionState.selectedIdx = (_mentionState.selectedIdx + 1) % cands.length;
        cands.forEach((c, i) => c.classList.toggle('active', i === _mentionState.selectedIdx));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        _mentionState.selectedIdx = (_mentionState.selectedIdx - 1 + cands.length) % cands.length;
        cands.forEach((c, i) => c.classList.toggle('active', i === _mentionState.selectedIdx));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        const sel = cands[_mentionState.selectedIdx];
        if (sel) {
          e.preventDefault();
          insertMention(sel.dataset.pid, sel.dataset.name);
        }
      } else if (e.key === 'Escape') {
        dropdown.style.display = 'none';
        _mentionState.triggerStart = -1;
      }
    });

    input.addEventListener('blur', () => {
      // delay 一下讓 mousedown 能 fire
      setTimeout(() => { dropdown.style.display = 'none'; }, 150);
    });
  }

  function insertMention(personId, name) {
    const input = $('#contactInput');
    if (_mentionState.triggerStart < 0) return;
    const val = input.value;
    const pos = input.selectionStart || val.length;
    const before = val.slice(0, _mentionState.triggerStart);
    const after = val.slice(pos);
    const insert = `@${name} `;
    input.value = before + insert + after;
    const newPos = before.length + insert.length;
    input.setSelectionRange(newPos, newPos);
    // 記錄這次使用的 mention（後端寫入時會用）
    _mentionState.activeMentions.push({
      person_id: personId, name: name,
      start: before.length, end: before.length + insert.length - 1,
    });
    $('#mentionDropdown').style.display = 'none';
    _mentionState.triggerStart = -1;
    input.focus();
  }

  function collectMentionsFromText(text) {
    // 從 _mentionState.activeMentions 中過濾還在文中的
    const result = [];
    for (const m of _mentionState.activeMentions) {
      const tag = '@' + m.name;
      const idx = text.indexOf(tag);
      if (idx >= 0) {
        result.push({ person_id: m.person_id, name: m.name, start: idx, end: idx + tag.length });
      }
    }
    // dedupe by person_id
    const seen = new Set();
    return result.filter(m => {
      if (seen.has(m.person_id)) return false;
      seen.add(m.person_id);
      return true;
    });
  }
  async function deleteContact(cid) {
    if (!confirm('刪除這筆互動記事？')) return;
    try {
      await api('DELETE', `/api/people/${PID}/contacts/${cid}`);
      showToast('已刪除');
      await loadAll();
    } catch (e) {
      showToast('刪除失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  Header 動作
  // ═════════════════════════════════════════

  async function deletePerson() {
    if (!confirm(`確定刪除「${state.person.name}」？\n（軟刪除，可從 Firestore 還原）`)) return;
    try {
      await api('DELETE', `/api/people/${PID}`);
      showToast('已刪除，返回列表');
      setTimeout(() => window.location.href = '/', 800);
    } catch (e) {
      showToast('刪除失敗：' + e.message, 'danger');
    }
  }

  // ═════════════════════════════════════════
  //  事件綁定 + 啟動
  // ═════════════════════════════════════════

  document.addEventListener('DOMContentLoaded', () => {
    bindAvatarUpload();
    $('#btnDeleteDetail').addEventListener('click', deletePerson);
    $('#btnEditDetail').addEventListener('click', () => {
      // 暫時：跳回列表頁開啟編輯 modal（或 future 直接 inline 編輯）
      // 簡化：用 query string 通知列表頁
      window.location.href = '/?edit=' + PID;
    });

    $('#roleTypeSelect').addEventListener('change', (e) => {
      const t = e.target.value;
      e.target.value = '';
      if (t) addRole(t);
    });

    $('#showArchivedRoles').addEventListener('change', (e) => {
      state.showArchived = e.target.checked;
      renderRoles();
    });

    $('#btnAddContact').addEventListener('click', addContact);
    $('#contactInput').addEventListener('keydown', (e) => {
      // Cmd/Ctrl+Enter 送出
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        addContact();
      }
    });

    // 關聯人 Modal
    $('#btnAddRelation').addEventListener('click', openRelationModal);
    $('#btnCloseRelModal').addEventListener('click', closeRelationModal);
    $('#btnCancelRelModal').addEventListener('click', closeRelationModal);
    $('#btnSaveRelation').addEventListener('click', saveRelation);
    $('#relSearch').addEventListener('input', (e) => filterRelCandidates(e.target.value));
    $('#relSearch').addEventListener('focus', (e) => filterRelCandidates(e.target.value));
    $('#relationModal').addEventListener('click', (e) => {
      if (e.target.id === 'relationModal') closeRelationModal();
    });

    // @mention 自動完成
    bindMentionInput();

    // 加成員按鈕（群組頁）
    $('#btnAddMember')?.addEventListener('click', openMemberPicker);
    $('#btnCloseMemberModal')?.addEventListener('click', closeMemberPicker);
    $('#btnCancelMemberModal')?.addEventListener('click', closeMemberPicker);
    $('#memberPickerModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'memberPickerModal') closeMemberPicker();
    });
    $('#memberSearch')?.addEventListener('input', (e) => renderMemberCandidates(e.target.value));
    $('#btnCreateMember')?.addEventListener('click', createAndAddMember);
    $('#memberNewName')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); createAndAddMember(); }
    });

    // 附件上傳
    $('#btnAddFile').addEventListener('click', () => $('#hiddenFileInput').click());
    $('#hiddenFileInput').addEventListener('change', (e) => {
      uploadFiles(e.target.files);
      e.target.value = '';
    });
    $('#btnPasteFile')?.addEventListener('click', pasteFromClipboard);
    bindFileDropzone();

    // 頭像旁的「📋 貼上」icon
    $('#btnPasteAvatar')?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.UploadMenu) {
        window.UploadMenu.paste({
          multiple: false,
          onFiles: (files) => { if (files[0]) uploadAvatarFile(files[0]); },
        });
      }
    });

    // 右鍵 / 長按選單：頭像 + 附件區
    if (window.UploadMenu) {
      window.UploadMenu.attach($('#detailAvatar'), {
        paste: true, file: true, camera: true,
        accept: 'image/*', multiple: false,
        onFiles: (files) => { if (files[0]) uploadAvatarFile(files[0]); },
      });
      window.UploadMenu.attach($('#fileDropZone'), {
        paste: true, file: true, camera: true, audio: true,
        accept: '*/*', multiple: true,
        onFiles: (files) => uploadFiles(files),
        onAudio: () => openRecordModal(),
      });
    }

    // 錄音 Modal
    $('#btnRecordAudio').addEventListener('click', openRecordModal);
    $('#btnCloseRecModal').addEventListener('click', closeRecordModal);
    $('#btnStartRec').addEventListener('click', startRecording);
    $('#btnStopRec').addEventListener('click', () => stopRecording(false));
    $('#recordModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordModal') closeRecordModal();
    });

    // 頭像裁切 Modal
    bindCropDrag();
    $('#btnCloseCrop')?.addEventListener('click', closeCrop);
    $('#btnCancelCrop')?.addEventListener('click', closeCrop);
    $('#btnConfirmCrop')?.addEventListener('click', confirmCrop);
    $('#cropZoom')?.addEventListener('input', (e) => setCropZoom(parseFloat(e.target.value)));
    $('#avatarCropModal')?.addEventListener('click', (e) => {
      if (e.target.id === 'avatarCropModal') closeCrop();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#avatarCropModal')?.style.display === 'flex') closeCrop();
    });

    loadAll();
  });
})();
