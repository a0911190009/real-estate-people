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
      renderAll();
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
    renderFiles();
    renderTimeline();
    renderContacts();
  }

  // ═════════════════════════════════════════
  //  頭像上傳（canvas 中心裁切 160px JPEG + Cmd+V 貼上）
  // ═════════════════════════════════════════
  const AVATAR_SIZE = 160;

  async function uploadAvatarFile(file) {
    if (!file || !file.type || !file.type.startsWith('image/')) {
      showToast('請選圖片檔', 'danger');
      return;
    }
    try {
      const b64 = await processAvatar(file);
      // 樂觀更新本地預覽
      $('#detailAvatar').innerHTML = `<img src="${b64}" alt="">`;
      await api('POST', `/api/people/${PID}/avatar`, { avatar_b64: b64 });
      showToast('頭像已更新');
      await loadAll();
    } catch (e) {
      showToast('上傳失敗：' + e.message, 'danger');
    }
  }

  function processAvatar(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const reader = new FileReader();
      reader.onload = () => { img.src = reader.result; };
      reader.onerror = () => reject(new Error('讀檔失敗'));
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const ctx = canvas.getContext('2d');
        // 中心裁切：取最短邊正方形
        const minSide = Math.min(img.width, img.height);
        const sx = (img.width - minSide) / 2;
        const sy = (img.height - minSide) / 2;
        ctx.drawImage(img, sx, sy, minSide, minSide, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      };
      img.onerror = () => reject(new Error('圖片解析失敗'));
      reader.readAsDataURL(file);
    });
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
    // 點頭像 → 選檔
    $('#detailAvatar').addEventListener('click', () => fi.click());

    // Cmd/Ctrl+V 貼上：限定回饋 widget modal 沒開時才接管
    document.addEventListener('paste', (e) => {
      const fbModal = document.getElementById('fbw-modal');
      if (fbModal && fbModal.style.display !== 'none') return;
      const items = (e.clipboardData || {}).items || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') !== -1) {
          const f = it.getAsFile();
          if (f) { uploadAvatarFile(f); break; }
        }
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
      return `
        <div class="contact-item" data-id="${c.id}" data-via="${escapeHtml(c.via || 'other')}" data-at="${contactAtLocal}">
          <div class="contact-view">
            <div class="contact-meta">
              ${viaTag}
              ${voiceBadge}
              <span class="contact-time">${escapeHtml(fmtDateTime(c.contact_at))}</span>
            </div>
            <div class="contact-content">${escapeHtml(c.content)}</div>
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
    try {
      await api('POST', `/api/people/${PID}/contacts`, { content, via });
      $('#contactInput').value = '';
      showToast('已記錄');
      await loadAll();
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
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

    // 附件上傳
    $('#btnAddFile').addEventListener('click', () => $('#hiddenFileInput').click());
    $('#hiddenFileInput').addEventListener('change', (e) => {
      uploadFiles(e.target.files);
      e.target.value = '';
    });
    bindFileDropzone();

    // 錄音 Modal
    $('#btnRecordAudio').addEventListener('click', openRecordModal);
    $('#btnCloseRecModal').addEventListener('click', closeRecordModal);
    $('#btnStartRec').addEventListener('click', startRecording);
    $('#btnStopRec').addEventListener('click', () => stopRecording(false));
    $('#recordModal').addEventListener('click', (e) => {
      if (e.target.id === 'recordModal') closeRecordModal();
    });

    loadAll();
  });
})();
