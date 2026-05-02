/* ============================================
   群組頁主邏輯
============================================ */

(function () {
  'use strict';

  const state = {
    groups: [],
    allPeople: [],   // 加成員候選用
    editingId: null,
    members: [],     // 編輯中的群組成員 [{id, name, avatar_b64}]
  };

  function $(s) { return document.querySelector(s); }
  function $$(s) { return Array.from(document.querySelectorAll(s)); }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'", '&#039;');
  }
  function showToast(msg, kind) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = 'toast show' + (kind === 'danger' ? ' danger' : '');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.className = 'toast', 2400);
  }

  async function api(method, url, body) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const r = await fetch(url, opts);
    let data = null; try { data = await r.json(); } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }

  // ─── 載入 ───
  async function loadGroups() {
    try {
      const data = await api('GET', '/api/groups');
      state.groups = data.items || [];
      render();
    } catch (e) {
      showToast('載入失敗：' + e.message, 'danger');
    }
  }

  async function loadAllPeople() {
    if (state.allPeople.length > 0) return;
    try {
      const data = await api('GET', '/api/people?limit=500');
      state.allPeople = data.items || [];
    } catch (_) {}
  }

  function render() {
    const list = $('#groupsList');
    const empty = $('#emptyState');
    if (state.groups.length === 0) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';
    list.innerHTML = state.groups.map(renderGroupCard).join('');
    list.querySelectorAll('.group-card').forEach(c => {
      c.addEventListener('click', () => openEditModal(c.dataset.id));
    });
  }

  function renderGroupCard(g) {
    const typeLabel = g.type === 'permanent' ? '永久' : '一次性';
    const typeCls = g.type === 'permanent' ? 'g-type-perm' : 'g-type-temp';
    const memberCount = (g.member_ids || []).length;
    return `
      <div class="group-card" data-id="${escapeHtml(g.id)}">
        <div class="group-card-head">
          <h3 class="group-name">${escapeHtml(g.name)}</h3>
          <span class="g-type-pill ${typeCls}">${typeLabel}</span>
        </div>
        ${g.description ? `<p class="group-desc">${escapeHtml(g.description)}</p>` : ''}
        <div class="group-meta">
          <span>👥 ${memberCount} 位成員</span>
        </div>
      </div>
    `;
  }

  // ─── Modal 開關 ───
  async function openEditModal(gid) {
    state.editingId = gid;
    let g = null;
    if (gid) {
      try {
        g = await api('GET', `/api/groups/${gid}`);
      } catch (e) {
        showToast('載入失敗：' + e.message, 'danger');
        return;
      }
    }
    $('#grpModalTitle').textContent = gid ? '編輯群組' : '新增群組';
    $('#btnDeleteGroup').style.display = gid ? 'inline-block' : 'none';
    $('#g_id').value = gid || '';
    $('#g_name').value = g ? (g.name || '') : '';
    $('#g_description').value = g ? (g.description || '') : '';
    const gtype = g ? (g.type || 'temporary') : 'temporary';
    $$('input[name="g_type"]').forEach(r => r.checked = (r.value === gtype));
    state.members = g ? (g.members || []).map(m => ({ id: m.id, name: m.name, avatar_b64: m.avatar_b64 })) : [];
    renderMembers();
    $('#g_member_search').value = '';
    $('#g_member_candidates').innerHTML = '';
    await loadAllPeople();
    $('#groupModal').style.display = 'flex';
    setTimeout(() => $('#g_name').focus(), 50);
  }

  function closeModal() {
    $('#groupModal').style.display = 'none';
    state.editingId = null;
    state.members = [];
  }

  function renderMembers() {
    const box = $('#g_members_box');
    if (state.members.length === 0) {
      box.innerHTML = '<p class="muted" style="margin:6px 0 0; font-size:12px">尚未加入任何成員</p>';
      return;
    }
    box.innerHTML = state.members.map(m => `
      <div class="g-member-chip" data-id="${escapeHtml(m.id)}">
        <span>👤 ${escapeHtml(m.name || m.id)}</span>
        <button type="button" class="g-rm-mem" title="移除">✕</button>
      </div>
    `).join('');
    box.querySelectorAll('.g-rm-mem').forEach(b => {
      b.addEventListener('click', () => {
        const id = b.parentElement.dataset.id;
        state.members = state.members.filter(m => m.id !== id);
        renderMembers();
      });
    });
  }

  function filterMemberCandidates(query) {
    const existing = new Set(state.members.map(m => m.id));
    const q = (query || '').trim().toLowerCase();
    let list = state.allPeople.filter(p => !existing.has(p.id));
    if (q) {
      list = list.filter(p => {
        const hay = (p.name || '').toLowerCase()
          + ' ' + (p.display_name || '').toLowerCase()
          + ' ' + (p.contacts || []).map(c => c.value || '').join(' ').toLowerCase();
        return hay.includes(q);
      });
    }
    list = list.slice(0, 12);
    const cont = $('#g_member_candidates');
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
        state.members.push({ id: row.dataset.pid, name: row.dataset.name });
        renderMembers();
        $('#g_member_search').value = '';
        cont.innerHTML = '';
      });
    });
  }

  async function saveGroup() {
    const name = $('#g_name').value.trim();
    if (!name) {
      showToast('群組名稱必填', 'danger');
      $('#g_name').focus();
      return;
    }
    const typeEl = $$('input[name="g_type"]:checked')[0];
    const payload = {
      name: name,
      type: typeEl ? typeEl.value : 'temporary',
      description: $('#g_description').value.trim(),
      member_ids: state.members.map(m => m.id),
    };
    try {
      if (state.editingId) {
        await api('PUT', `/api/groups/${state.editingId}`, payload);
      } else {
        await api('POST', '/api/groups', payload);
      }
      showToast('已儲存');
      closeModal();
      await loadGroups();
    } catch (e) {
      showToast('儲存失敗：' + e.message, 'danger');
    }
  }

  async function deleteGroup() {
    if (!state.editingId) return;
    if (!confirm('封存此群組？（不會刪除成員資料）')) return;
    try {
      await api('DELETE', `/api/groups/${state.editingId}`);
      showToast('已封存');
      closeModal();
      await loadGroups();
    } catch (e) {
      showToast('封存失敗：' + e.message, 'danger');
    }
  }

  // ─── 啟動 ───
  document.addEventListener('DOMContentLoaded', () => {
    $('#btnAddGroup').addEventListener('click', () => openEditModal(null));
    $('#btnCloseGrpModal').addEventListener('click', closeModal);
    $('#btnCancelGrpModal').addEventListener('click', closeModal);
    $('#btnSaveGroup').addEventListener('click', saveGroup);
    $('#btnDeleteGroup').addEventListener('click', deleteGroup);
    $('#groupModal').addEventListener('click', (e) => {
      if (e.target.id === 'groupModal') closeModal();
    });
    $('#g_member_search').addEventListener('input', e => filterMemberCandidates(e.target.value));
    $('#g_member_search').addEventListener('focus', e => filterMemberCandidates(e.target.value));

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && $('#groupModal').style.display === 'flex') closeModal();
    });

    loadGroups();
  });
})();
