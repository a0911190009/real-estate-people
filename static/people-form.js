/* ============================================
   人脈管理 — 新增 / 編輯 Modal 表單邏輯
   依賴 people.js 提供的 api / showToast / reloadPeople
============================================ */

(function () {
  'use strict';

  let editingId = null;  // 編輯時的 person_id；null = 新增

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.from(document.querySelectorAll(sel)); }

  // ─── 動態列：聯絡方式 ───
  function addContactRow(data) {
    data = data || {};
    const row = document.createElement('div');
    row.className = 'dyn-row';
    row.innerHTML = `
      <select class="c-type">
        <option value="mobile">手機</option>
        <option value="home">市話</option>
        <option value="work">公司</option>
        <option value="line_id">LINE ID</option>
        <option value="wechat">微信</option>
        <option value="email">Email</option>
        <option value="other">其他</option>
      </select>
      <input type="text" class="c-value" placeholder="號碼 / ID">
      <input type="text" class="c-label" placeholder="本人/配偶...">
      <button type="button" class="btn-rm" title="移除">✕</button>
    `;
    row.querySelector('.c-type').value = data.type || 'mobile';
    row.querySelector('.c-value').value = data.value || '';
    row.querySelector('.c-label').value = data.label || '';
    row.querySelector('.btn-rm').addEventListener('click', () => row.remove());
    $('#contactsBox').appendChild(row);
  }

  function readContactRows() {
    return $$('#contactsBox .dyn-row').map(r => ({
      type: r.querySelector('.c-type').value,
      value: r.querySelector('.c-value').value.trim(),
      label: r.querySelector('.c-label').value.trim(),
    })).filter(c => c.value);
  }

  // ─── 動態列：地址 ───
  function addAddressRow(data) {
    data = data || {};
    const row = document.createElement('div');
    row.className = 'dyn-row';
    row.innerHTML = `
      <select class="a-type">
        <option value="home">住家</option>
        <option value="office">公司</option>
        <option value="other">其他</option>
      </select>
      <input type="text" class="a-value" placeholder="完整地址" style="grid-column: span 2">
      <button type="button" class="btn-rm" title="移除">✕</button>
    `;
    row.querySelector('.a-type').value = data.type || 'home';
    row.querySelector('.a-value').value = data.value || '';
    row.querySelector('.btn-rm').addEventListener('click', () => row.remove());
    $('#addressesBox').appendChild(row);
  }

  function readAddressRows() {
    return $$('#addressesBox .dyn-row').map(r => ({
      type: r.querySelector('.a-type').value,
      value: r.querySelector('.a-value').value.trim(),
    })).filter(a => a.value);
  }

  // ─── 來源管道：channel=referral 時啟用介紹人下拉 ───
  function bindSourceChannel() {
    const ch = $('#f_source_channel');
    const ref = $('#f_source_referrer');
    function update() {
      if (ch.value === 'referral') {
        ref.disabled = false;
        // 填入所有 people（除了正在編輯的這個）
        const people = (window.getStateForReferrer && window.getStateForReferrer()) || [];
        const current = ref.value;
        ref.innerHTML = '<option value="">（選介紹人）</option>' +
          people
            .filter(p => p.id !== editingId)
            .map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`)
            .join('');
        ref.value = current;
      } else {
        ref.disabled = true;
        ref.value = '';
      }
    }
    ch.addEventListener('change', update);
    return update;  // 給 open modal 時手動觸發用
  }

  // ─── 生日 → 星座提示 ───
  function bindZodiacHint() {
    const ranges = [
      [1, 20, '摩羯'], [2, 19, '水瓶'], [3, 21, '雙魚'],
      [4, 20, '牡羊'], [5, 21, '金牛'], [6, 22, '雙子'],
      [7, 23, '巨蟹'], [8, 23, '獅子'], [9, 23, '處女'],
      [10, 24, '天秤'], [11, 23, '天蠍'], [12, 22, '射手'], [12, 31, '摩羯'],
    ];
    function calc(s) {
      if (!s) return '';
      const [y, m, d] = s.split('-').map(Number);
      if (!m || !d) return '';
      for (const [rm, rd, name] of ranges) {
        if (m < rm || (m === rm && d <= rd)) return name;
      }
      return '摩羯';
    }
    $('#f_birthday').addEventListener('change', e => {
      const z = calc(e.target.value);
      $('#f_zodiac_hint').textContent = z ? `星座：${z}` : '';
    });
  }

  // ─── 表單填值 / 取值 ───
  function fillForm(p) {
    $('#f_id').value = p ? (p.id || '') : '';
    $('#f_name').value = p ? (p.name || '') : '';
    $('#f_display_name').value = p ? (p.display_name || '') : '';
    $('#f_birthday').value = p ? (p.birthday || '') : '';
    $('#f_zodiac_hint').textContent = p && p.zodiac ? `星座：${p.zodiac}` : '';
    $('#f_gender').value = p ? (p.gender || '') : '';
    $('#f_company').value = p ? (p.company || '') : '';
    $('#f_warning').value = p ? (p.warning || '') : '';

    // bucket
    const bucket = (p && p.bucket) || 'normal';
    $$('input[name="bucket"]').forEach(r => { r.checked = (r.value === bucket); });

    // 聯絡方式
    $('#contactsBox').innerHTML = '';
    const contacts = (p && p.contacts) || [];
    if (contacts.length === 0) {
      addContactRow({ type: 'mobile' });
    } else {
      contacts.forEach(c => addContactRow(c));
    }

    // 地址
    $('#addressesBox').innerHTML = '';
    const addresses = (p && p.addresses) || [];
    addresses.forEach(a => addAddressRow(a));

    // 來源
    const src = (p && p.source) || {};
    $('#f_source_channel').value = src.channel || 'other';
    $('#f_source_note').value = src.note || '';
    // 介紹人下拉要等 channel update 完才填值
    if (src.channel === 'referral') {
      // 觸發 update 後再 set value
      setTimeout(() => { $('#f_source_referrer').value = src.referrer_person_id || ''; }, 0);
    }
  }

  function readForm() {
    const bucketEl = $$('input[name="bucket"]:checked')[0];
    return {
      name: $('#f_name').value.trim(),
      display_name: $('#f_display_name').value.trim(),
      birthday: $('#f_birthday').value || null,
      gender: $('#f_gender').value || null,
      company: $('#f_company').value.trim(),
      warning: $('#f_warning').value.trim(),
      bucket: bucketEl ? bucketEl.value : 'normal',
      contacts: readContactRows(),
      addresses: readAddressRows(),
      source: {
        channel: $('#f_source_channel').value,
        referrer_person_id: $('#f_source_referrer').value || null,
        note: $('#f_source_note').value.trim(),
      },
    };
  }

  // ─── 開啟 / 關閉 Modal ───
  let updateSourceUI = null;

  function openModal(p) {
    editingId = p ? p.id : null;
    $('#modalTitle').textContent = p ? '編輯人脈' : '新增人脈';
    $('#btnDeletePerson').style.display = p ? 'inline-block' : 'none';
    fillForm(p);
    if (updateSourceUI) updateSourceUI();
    $('#personModal').style.display = 'flex';
    setTimeout(() => $('#f_name').focus(), 100);
  }
  window.openPersonModal = openModal;

  function closeModal() {
    editingId = null;
    $('#personModal').style.display = 'none';
  }

  // ─── 儲存 ───
  async function savePerson() {
    const data = readForm();
    if (!data.name) {
      window.showToast('請填寫姓名', 'danger');
      $('#f_name').focus();
      return;
    }
    const btn = $('#btnSavePerson');
    btn.disabled = true;
    try {
      let result;
      if (editingId) {
        result = await window.api('PUT', `/api/people/${editingId}`, data);
        window.showToast('已更新');
      } else {
        result = await window.api('POST', '/api/people', data);
        window.showToast('已新增');
      }
      closeModal();
      // 直接把新/更新 doc inject 進 state（避免 GET 偶發延遲沒撈到）
      if (window.injectPerson && result) window.injectPerson(result);
      // 同時背景重撈（保持資料完整：active_roles / has_completed_deal 等由 server 算）
      window.reloadPeople();
    } catch (e) {
      window.showToast('儲存失敗：' + e.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  async function deletePerson() {
    if (!editingId) return;
    if (!confirm('確定要刪除此人脈？（軟刪除，可從資料庫還原）')) return;
    try {
      await window.api('DELETE', `/api/people/${editingId}`);
      window.showToast('已刪除');
      closeModal();
      await window.reloadPeople();
    } catch (e) {
      window.showToast('刪除失敗：' + e.message, 'danger');
    }
  }

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  // ─── 啟動 ───
  document.addEventListener('DOMContentLoaded', () => {
    $('#btnAddContact').addEventListener('click', () => addContactRow());
    $('#btnAddAddress').addEventListener('click', () => addAddressRow());
    $('#btnCloseModal').addEventListener('click', closeModal);
    $('#btnCancelModal').addEventListener('click', closeModal);
    $('#btnSavePerson').addEventListener('click', savePerson);
    $('#btnDeletePerson').addEventListener('click', deletePerson);
    // 點擊背景關閉
    $('#personModal').addEventListener('click', (e) => {
      if (e.target.id === 'personModal') closeModal();
    });
    // ESC 關閉
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && $('#personModal').style.display === 'flex') closeModal();
    });
    // form submit (Enter 鍵)
    $('#personForm').addEventListener('submit', (e) => {
      e.preventDefault();
      savePerson();
    });

    bindZodiacHint();
    updateSourceUI = bindSourceChannel();
  });
})();
