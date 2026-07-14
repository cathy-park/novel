const STORAGE_KEY = 'munjang-novel-writer-v3';
// --- 강제 캐시 초기화 (Service Worker 킬러) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function (registrations) {
    for (let registration of registrations) { registration.unregister(); }
  });
  if (window.caches) {

    caches.keys().then(function (names) {
      for (let name of names) { caches.delete(name); }
    });
  }
}



const DEFAULT_COVER_COLOR = '#6B5CE7';
const COVER_COLORS = ['#17141F', '#6B5CE7', '#6D9DF6', '#5CB6C9', '#46A57F', '#F39AB9', '#F5B86C', '#B4A5FF', '#8C91A5', '#E4E6ED'];

const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
let quill = null; let dialogTimer = null;
let saveTimer, toastTimer, draggedId = null, libraryFilter = 'serializing', coverTargetProjectId = null;
let importTempData = null;
let state = { schemaVersion: 6, currentProjectId: null, projects: [] };
let isAppInitialized = false;

// UI Ephemeral State
let isFocusMode = false;
let isPlanDrawerOpen = false;
let episodeScrollState = new Map();
let currentFrontCoverObj = null;
let currentBackCoverObj = null;

function uid(prefix = 'id') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function defaultEpisode(type = 'prologue', index = 0) { return { id: uid('ep'), type, title: '', status: 'idea', plan: '', body: '', versions: [], lastVersionAt: Date.now(), _dirty: true }; }
function defaultPlanSection(title = '새 기획 항목', body = '') { return { id: uid('plan'), title, body, open: true }; }

// ── 이미지 클라이언트 압축 (Canvas API) ──────────────────────
function compressImage(file, maxWidth = 1200, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일 읽기 실패'));
    reader.onload = (ev) => {
      const img = new Image();
      img.onerror = () => reject(new Error('이미지 디코딩 실패'));
      img.onload = () => {
        let w = img.width, h = img.height;
        if (w > maxWidth) {
          h = Math.round(h * maxWidth / w);
          w = maxWidth;
        }
        const cvs = document.createElement('canvas');
        cvs.width = w;
        cvs.height = h;
        const ctx = cvs.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        // WebP 우선, 미지원 시 JPEG fallback
        let dataUrl = cvs.toDataURL('image/webp', quality);
        if (dataUrl.startsWith('data:image/webp')) {
          resolve(dataUrl);
        } else {
          dataUrl = cvs.toDataURL('image/jpeg', quality);
          resolve(dataUrl);
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}


// --- File System Access API Logic ---
// --- Supabase Cloud Logic ---
const SUPABASE_URL = 'https://vsmqtpavcvabalrveqma.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZzbXF0cGF2Y3ZhYmFscnZlcW1hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NDEzNjksImV4cCI6MjA5NzQxNzM2OX0.TFvpFln-1QunLVpxAZgQIHcfsJjsK6Anal8kI4zETNk';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
let currentUser = null;

function autoRescue() {
  let rescued = 0;
  state.projects.forEach(p => {
    (p.episodes || []).forEach(ep => {
      if (!cleanText(ep.body) && ep.versions && ep.versions.length > 0) {
        ep.body = ep.versions[0].body;
        rescued++;
      }
    });
  });
  if (rescued > 0) {
    queueSaveFS();
    setTimeout(() => alert(`에러 발생으로 보이지 않던 ${rescued}개의 회차 본문 데이터를 안전하게 자동 복구했습니다!`), 500);
  }
}

async function initApp() {


  // OAuth 리다이렉트 후 세션 감지를 위한 리스너



  sb.auth.onAuthStateChange(async (event, session) => {


    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') && session && !currentUser) {
      localStorage.removeItem('novel_emergency_backup'); // 불필요해진 로컬 백업 삭제
      showToast('로그인 성공! 서재를 불러옵니다...');
      currentUser = session.user;
      $('#welcomeScreen').style.display = 'none';
      try {
        await Promise.race([
          migrateFromLocalStorage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Migration Timeout')), 15000))
        ]);
      } catch (err) {
        console.error('Migration failed or timed out:', err);
      }
      try {
        await Promise.race([
          loadStateSupabase(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Load DB Timeout')), 30000))
        ]);
      } catch (err) {
        console.error('DB Load failed or timed out:', err);
        showToast('DB 로딩 지연. 새로고침 해주세요.');
      }
      autoRescue();
      renderLibrary();
    } else if (event === 'SIGNED_OUT') {
      showToast('로그아웃 되었습니다.');
      currentUser = null;
      window.location.href = window.location.origin;
    } else if (event === 'INITIAL_SESSION' && !session) {
      $('#welcomeScreen').style.display = 'flex';
    } else if (event === 'SIGNED_IN' && !session) {
      showToast('로그인 이벤트 발생했으나 세션이 없습니다.');
    }
  });

  // 새로고침 시 INITIAL_SESSION이 누락되는 경우를 대비한 수동 세션 복구
  sb.auth.getSession().then(async ({ data: { session }, error }) => {
    if (error) {
      console.error("getSession error:", error);
      if ($('#authError')) {
        $('#authError').innerHTML = '세션 확인 에러: ' + error.message;
        $('#authError').style.display = 'block';
      }
    }
    if (session && !currentUser) {

      showToast('세션을 복구했습니다. 서재를 불러옵니다...');
      currentUser = session.user;
      $('#welcomeScreen').style.display = 'none';
      try { await migrateFromLocalStorage(); } catch (e) { }
      try { await loadStateSupabase(); } catch (e) { showToast('DB 로딩 지연. 새로고침 해주세요.'); }
      autoRescue();
      renderLibrary();
    } else if (!session && !currentUser) {
      $('#welcomeScreen').style.display = 'flex';
    }
  });
}

if ($('#googleLoginBtn')) {
  $('#googleLoginBtn').onclick = async () => {
    $('#googleLoginBtn').style.opacity = '0.7';
    $('#googleLoginBtn').textContent = '로그인 중...';
    try {
      const { data, error } = await sb.auth.signInWithOAuth({
        provider: 'google'
      });
      if (error) throw error;
    } catch (err) {
      console.error(err);
      $('#googleLoginBtn').style.opacity = '1';
      $('#googleLoginBtn').innerHTML = 'Google 계정으로 시작하기';
      if ($('#authError')) $('#authError').innerHTML = '구글 로그인 실패: ' + err.message;
    }
  };
}

if ($('#logoutBtn')) {
  $('#logoutBtn').onclick = async () => {
    if (!confirm('로그아웃 하시겠습니까?')) return;
    try {
      persistEditor();
      if ($('#saveStatus')) $('#saveStatus').textContent = '저장 중...';
      await forceSaveAllSupabase();
      showToast('저장 완료. 로그아웃합니다.');
    } catch (saveErr) {
      console.error('Save before logout failed:', saveErr);
      showToast('⚠️ 저장 실패: ' + (saveErr.message || '알 수 없는 오류') + '\n강제 로그아웃합니다.');
    }

    // 강제 로그아웃 처리
    currentUser = null;
    try {
      await sb.auth.signOut();
    } catch (e) {
      console.error('Logout error:', e);
    }

    // Supabase 토큰 강제 삭제 (만료된 토큰으로 인한 무한 로그인 방지)
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) {
          localStorage.removeItem(key);
        }
      }
    } catch (e) { }

    window.location.href = window.location.origin;
  };
}

async function migrateFromLocalStorage() {
  if (!currentUser) return;
  const localDataStr = localStorage.getItem('munjang-novel-writer-v3');
  if (!localDataStr) return;

  // 무한 지연을 막기 위해 시도 즉시 키 이름을 변경 (백업으로만 보존)
  localStorage.setItem('munjang-novel-writer-v3_backup', localDataStr);
  localStorage.removeItem('munjang-novel-writer-v3');

  try {
    const localData = JSON.parse(localDataStr);
    if (localData && localData.projects && localData.projects.length > 0) {
      if ($('#saveStatus')) $('#saveStatus').textContent = '이전 원고 복구 중...';
      for (const p of localData.projects) {
        await sb.from('novel_projects').upsert({
          id: p.id, user_id: currentUser.id, title: p.title, status: p.status, cover: p.cover,
          cover_color: p.coverColor, view_mode: p.viewMode, plan_sections: p.planSections, updated_at: p.updatedAt
        });
        if (p.episodes && p.episodes.length > 0) {
          const epData = p.episodes.map((ep, i) => ({
            id: ep.id, project_id: p.id, user_id: currentUser.id, title: ep.title, body: ep.body,
            plan: ep.plan || '',
            type: ep.type, status: ep.status || 'idea', order_idx: i,
            created_at: ep.createdAt || Date.now(),
            updated_at: ep.updatedAt || Date.now()
          }));
          await sb.from('novel_episodes').upsert(epData);
        }
      }
      localStorage.removeItem('munjang-novel-writer-v3'); // 이주 완료 후 삭제
      if ($('#saveStatus')) $('#saveStatus').textContent = '복구 완료';
    }
  } catch (e) {
    console.error('Migration failed:', e);
    // 반복 시도를 방지하기 위해 1회 실패 후 키 이름을 변경하여 백업으로만 남김
    localStorage.setItem('munjang-novel-writer-v3_failed_backup', localDataStr);
    localStorage.removeItem('munjang-novel-writer-v3');
    showToast('⚠️ 이전 로컬 원고 복구에 일부 실패했습니다.');
  }
}

async function ensureProjectBodiesLoaded(p) {
  if (!p) return;
  const missingEps = p.episodes.filter(e => e.body === undefined);
  if (missingEps.length === 0) return; // 이미 다 불러옴

  // 여러 번에 걸쳐 가져올 수 있으므로 in 조건 사용
  const missingIds = missingEps.map(e => e.id);
  const { data, error } = await sb.from('novel_episodes')
    .select('id, body, plan, comments')
    .in('id', missingIds);

  if (error) {
    console.error('Failed to load episode bodies:', error);
    return;
  }

  if (data) {
    data.forEach(d => {
      const ep = p.episodes.find(e => e.id === d.id);
      if (ep) {
        ep.body = d.body || '';
        ep.plan = deduplicateBeatSheets(d.plan || '');
        ep.comments = (() => { try { return d.comments ? JSON.parse(d.comments) : []; } catch (_) { return []; } })();
        ep._dirty = false;
      }
    });
  }
}

function deduplicateBeatSheets(planStr) {
  if (!planStr) return '';
  const blocks = planStr.split(/(?:^|\n)### 📋 비트시트 — /);
  if (blocks.length <= 1) return planStr; // No beatsheets

  let result = blocks[0]; // User's manual notes before the first beatsheet
  const seenHeaders = new Set();

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const headerMatch = block.match(/^([^\n]+)/);
    if (!headerMatch) {
      result += '\n### 📋 비트시트 — ' + block;
      continue;
    }
    const header = headerMatch[1].trim();
    if (!seenHeaders.has(header)) {
      seenHeaders.add(header);
      result += '\n### 📋 비트시트 — ' + block;
    }
  }

  return result.replace(/(?:\n\n---\n\n)+/g, '\n\n---\n\n').trim();
}

async function loadStateSupabase() {
  const newState = { schemaVersion: 6, currentProjectId: null, projects: [] };

  // 1. Projects 로드
  const { data: projectsData, error: pErr } = await sb.from('novel_projects').select('*').eq('user_id', currentUser.id).order('updated_at', { ascending: false });
  if (pErr) {
    console.error('Project Load Error:', pErr);
    showToast('프로젝트 로딩 실패: ' + (pErr.message || ''));

    // JWT 만료 등 인증 오류일 경우 강제 로그아웃 처리
    if (pErr.code === 'PGRST301' || (pErr.message && pErr.message.toUpperCase().includes('JWT'))) {
      try {
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) localStorage.removeItem(key);
        }
      } catch (e) { }
      currentUser = null;
      showToast('⚠️ JWT 토큰 만료 또는 인증 오류가 발생했습니다. 로그아웃 후 다시 로그인해주세요.');
    }
    return;
  }


  if (projectsData && projectsData.length > 0) {

    // 2. Episodes 로드 (body, plan, comments 제외하여 지연 로딩)
    const { data: episodesData, error: eErr } = await sb.from('novel_episodes')
      .select('id,project_id,type,title,status,order_idx,created_at,updated_at')
      .eq('user_id', currentUser.id);
    if (eErr) console.error('Episode Load Error:', eErr);

    for (const pRow of projectsData) {
      const p = {
        id: pRow.id,
        title: pRow.title || '제목 없는 작품',
        status: pRow.status || 'serializing',
        cover: pRow.cover || '',
        coverColor: pRow.cover_color || DEFAULT_COVER_COLOR,
        viewMode: pRow.view_mode || 'split',
        planSections: pRow.plan_sections || [],
        updatedAt: pRow.updated_at || Date.now(),
        episodes: [],
        selectedEpisodeId: null,
        _dirty: false
      };

      try {
        const pubSet = localStorage.getItem('novel_pubset_' + p.id);
        if (pubSet) p.publishSettings = JSON.parse(pubSet);
      } catch (e) { console.warn(e); }

      // 에피소드 매핑
      if (episodesData) {
        p.episodes = episodesData.filter(e => e.project_id === p.id).map(e => ({
          id: e.id,
          type: e.type,
          title: e.title,
          status: e.status,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
          order: e.order_idx,
          _dirty: false
        })).sort((a, b) => a.order - b.order); // 서버의 order_idx로 정렬
      }
      if (p.episodes.length > 0) p.selectedEpisodeId = p.episodes[0].id;
      newState.projects.push(p);
    }
  } else {
    // 신규 유저 템플릿
    const p = { id: uid('project'), title: '신이 있는 교실', status: 'serializing', cover: '', coverColor: DEFAULT_COVER_COLOR, updatedAt: Date.now(), selectedEpisodeId: null, viewMode: 'split', planSections: [defaultPlanSection('작품 핵심', '권력을 가진 교사가...')], episodes: [] };
    const ep = defaultEpisode('prologue'); p.episodes.push(ep); p.selectedEpisodeId = ep.id;
    newState.projects.push(p);
    state = newState;
    await forceSaveAllSupabase();
    return;
  }

  state = newState;
  if (state.projects.length > 0) state.currentProjectId = state.projects[0].id;
}

async function forceSaveAllSupabase() {
  if (!currentUser) return;
  if ($('#saveStatus')) $('#saveStatus').textContent = '저장 중...';
  try {
    for (const p of state.projects) { await saveProjectSupabase(p); }
    if ($('#saveStatus')) $('#saveStatus').textContent = `저장됨 · ${new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`;
  } catch (e) {
    console.error(e);
    if ($('#saveStatus')) $('#saveStatus').textContent = '저장 실패';
  }
}

function queueSaveFS() {
  if (!currentUser) return;
  if ($('#saveStatus')) $('#saveStatus').textContent = '저장 중…';



  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => forceSaveAllSupabase(), 1500);
}

async function saveProjectSupabase(p) {
  if (!currentUser) return;

  // Project Update
  if (p._dirty) {
    const pData = {
      id: p.id,
      user_id: currentUser.id,
      title: p.title,
      status: p.status,
      cover: p.cover,
      cover_color: p.coverColor,
      view_mode: p.viewMode,
      plan_sections: p.planSections,
      updated_at: p.updatedAt || Date.now()
    };
    await sb.from('novel_projects').upsert(pData);
    p._dirty = false;
  }

  // Episodes Update (Bulk Upsert for dirty only)
  if (p.episodes && p.episodes.length > 0) {
    const dirtyEps = p.episodes.filter(ep => ep._dirty || typeof ep._dirty === 'undefined');
    if (dirtyEps.length > 0) {
      const epData = dirtyEps.map((ep, i) => {
        const data = {
          id: ep.id,
          project_id: p.id,
          user_id: currentUser.id,
          type: ep.type,
          title: ep.title,
          status: ep.status || 'idea',
          created_at: ep.createdAt || Date.now(),
          updated_at: ep.updatedAt || Date.now(),
          order_idx: p.episodes.indexOf(ep),
          comments: ep.comments && ep.comments.length ? JSON.stringify(ep.comments) : null
        };
        if (ep.body !== undefined) data.body = ep.body;
        if (ep.plan !== undefined) data.plan = ep.plan;
        return data;
      });
      const { error: epErr } = await sb.from('novel_episodes').upsert(epData);
      if (epErr) {
        if (epErr.message && epErr.message.includes('plan')) {
          console.warn('plan column missing, saving without plan. Please run ALTER TABLE.');
          const epDataNoPlan = epData.map(({ plan, ...rest }) => rest);
          await sb.from('novel_episodes').upsert(epDataNoPlan);
        } else {
          throw epErr;
        }
      }
      dirtyEps.forEach(ep => ep._dirty = false);
    }
  }
}

// 에피소드 삭제 (DB)
async function deleteEpisode(epId) {
  if (!confirm('정말 이 회차를 삭제하시겠습니까?\n(삭제 후 복구할 수 없습니다)')) return;
  const p = currentProject(); if (!p) return;
  const idx = p.episodes.findIndex(e => e.id === epId);
  if (idx === -1) return;

  const deletedEp = p.episodes[idx];
  p.episodes.splice(idx, 1);
  if (p.selectedEpisodeId === epId) p.selectedEpisodeId = p.episodes[0]?.id || null;

  // Supabase Delete
  if (currentUser) {
    const { error } = await sb.from('novel_episodes').delete().eq('id', epId);
    if (error) {
      console.error('Failed to delete episode:', error);
      showToast('❌ 서버에서 회차를 삭제하는 데 실패했습니다.');
      p.episodes.splice(idx, 0, deletedEp); // Rollback
      return;
    }
  }

  touchProject();
  queueSaveFS();
  renderWorkspace();
}
// --- End Supabase Cloud Logic ---

function currentProject() { return state.projects.find(p => p.id === state.currentProjectId) || state.projects[0]; }
function currentEpisode() { const p = currentProject(); return p?.episodes.find(e => e.id === p.selectedEpisodeId) || p?.episodes[0]; }
function touchProject() { const p = currentProject(); if (p) { p.updatedAt = Date.now(); p._dirty = true; } }
function cleanText(t = '') {
  let s = String(t);
  if (s.includes('<p') || s.includes('<br')) {
    const d = document.createElement('div');
    d.innerHTML = s;
    s = d.innerText || d.textContent || '';
  }
  return s.replace(/\r\n/g, '\n').replace(/[\t\u00A0]+/g, ' ').replace(/[ ]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n').trim();
}
function stats(t = '') {
  let text = String(t).replace(/<p[^>]*>/gi, '\n').replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
  const withSpaces = Array.from(text).length;
  return { withSpaces, manuscript: Math.ceil(withSpaces / 200) };
}
function escapeHtml(v = '') { return String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[c])); }
function showToast(msg) { clearTimeout(toastTimer); $('#toast').textContent = msg; $('#toast').classList.add('show'); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 2100); }
function openModal(id) { $('#' + id).classList.remove('hidden'); } function closeModal(id) { $('#' + id).classList.add('hidden'); }

// Scroll State Management
function saveEditorScroll() {
  const ep = currentEpisode(); if (!ep) return;
  const body = $('#bodyEditor');
  episodeScrollState.set(ep.id, { plan: $('#planEditor').scrollTop, body: body.scrollTop, start: body.selectionStart, end: body.selectionEnd });
}
function restoreEditorScroll() {
  const ep = currentEpisode(); if (!ep) return;
  const st = episodeScrollState.get(ep.id) || { plan: 0, body: 0, start: 0, end: 0 };
  requestAnimationFrame(() => {
    $('#planEditor').scrollTop = st.plan;
    const body = $('#bodyEditor');
    body.scrollTop = st.body;
    if (typeof body.setSelectionRange === 'function') body.setSelectionRange(st.start, st.end);
  });
}

function autosizePlanSection(el, min = 250) {
  // resize:vertical이 적용된 경우(기획 드로어 textarea) 자동 높이 조정 생략
  if (el.style.resize === 'vertical' || getComputedStyle(el).resize === 'vertical') return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(min, el.scrollHeight + 24)}px`;
}

// Cover
function coverTextColor(hex) { const v = String(hex || '').trim().slice(1); const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16); return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.67 ? '#17141F' : '#FFFFFF'; }
function coverPlaceholderMarkup(p) {
  const c = p.coverColor || DEFAULT_COVER_COLOR, t = coverTextColor(c);
  return `<span class="book-placeholder" style="--cover-color:${c};--cover-text:${t}"><strong>${escapeHtml(p.title)}</strong></span>`;
}

// Library
function renderLibrary() {
  $('#allCount').textContent = state.projects.length;
  $('#serializingCount').textContent = state.projects.filter(p => p.status === 'serializing').length;
  $('#completedCount').textContent = state.projects.filter(p => p.status === 'completed').length;
  $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === libraryFilter));
  const projects = (libraryFilter === 'all' ? state.projects : state.projects.filter(p => p.status === libraryFilter)).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  $('#projectGrid').innerHTML = projects.length ? projects.map(p => {
    const total = p.episodes.reduce((s, e) => s + stats(e.body || '').withSpaces, 0);
    const cover = p.cover ? `<img src="${p.cover}" alt="표지"/>` : coverPlaceholderMarkup(p);
    const badgeCls = p.status === 'serializing' ? 'serializing' : 'completed';
    const badgeLabel = p.status === 'serializing' ? '연재 중' : '완결';
    return `<article class="project-book">
      <div class="book-stage">
        <button class="book-cover" data-open-project="${p.id}">${cover}<span class="cover-edit">📖 집필하기</span></button>
      </div>
      <div class="project-book-info">
        <div class="title-row">
          <span class="title-badge ${badgeCls}">${badgeLabel}</span>
          <h2 title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</h2>
        </div>
        <div class="book-meta"><span><strong>${p.episodes.length}</strong> 회차</span><span><strong>${total.toLocaleString()}</strong>자</span></div>
        <div class="project-book-actions">
          <button class="secondary border" data-book-cover="${p.id}" style="width:100%;">🎨 표지 꾸미기</button>
          <div style="position:relative;">
            <button class="kebab-btn" data-kebab="${p.id}">···</button>
            <div class="kebab-menu" id="kebab-${p.id}">
              <button data-kebab-cover="${p.id}">🎨 표지 꾸미기</button>
              <button data-rename-project="${p.id}">✏️ 제목 변경</button>
              <button class="danger-item" data-delete-project="${p.id}">🗑 삭제</button>
            </div>
          </div>
        </div>
      </div>
    </article>`;
  }).join('') : `<div class="empty-state"><strong>작품이 없어요.</strong></div>`;
  $$('[data-open-project]').forEach(b => b.onclick = () => openProject(b.dataset.openProject));
  $$('[data-book-cover]').forEach(b => b.onclick = (e) => { e.stopPropagation(); openCoverSettings(b.dataset.bookCover); });
  $$('[data-kebab]').forEach(b => b.onclick = (e) => {
    e.stopPropagation();
    const menu = document.getElementById('kebab-' + b.dataset.kebab);
    $$('.kebab-menu.show').forEach(m => { if (m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
  });
  $$('[data-kebab-cover]').forEach(b => b.onclick = (e) => { e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show')); openCoverSettings(b.dataset.kebabCover); });
  $$('[data-rename-project]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show'));
    const proj = state.projects.find(x => x.id === b.dataset.renameProject); if (!proj) return;
    const nt = prompt('새 작품 제목을 입력하세요.', proj.title);
    if (nt && nt.trim()) { proj.title = nt.trim(); touchProject(); queueSaveFS(); renderLibrary(); }
  });
  $$('[data-delete-project]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show'));
    const proj = state.projects.find(x => x.id === b.dataset.deleteProject);
    if (confirm((proj ? proj.title : '이 작품') + '을(를) 삭제할까요?\n삭제한 작품은 복구할 수 없습니다.')) {
      const delId = b.dataset.deleteProject;
      state.projects = state.projects.filter(x => x.id !== delId);
      if (state.currentProjectId === delId) state.currentProjectId = null;
      // Supabase에서도 삭제
      if (currentUser) {
        try {
          await sb.from('novel_episodes').delete().eq('project_id', delId);
          await sb.from('novel_projects').delete().eq('id', delId);
        } catch (e) { console.error('Delete from DB failed:', e); }
      }
      renderLibrary();
    }
  });
  // 서재 필터 기본값을 'all'로 초기화
  if (!state.projects.some(p => p.status === libraryFilter) && libraryFilter !== 'all') libraryFilter = 'all';
  setTimeout(() => window.addEventListener('click', () => $$('.kebab-menu').forEach(m => m.classList.remove('show')), { once: true }), 0);
}
function showLibrary() {
  persistEditor();
  // 서재로 돌아갈 때 저장 반드시 완료
  forceSaveAllSupabase().then(() => {
    $('#workspaceView').classList.add('hidden');
    $('#libraryView').classList.remove('hidden');
    renderLibrary();
  }).catch(err => {
    console.error('Save on showLibrary failed:', err);
    // 저장 실패해도 서재로 이동
    $('#workspaceView').classList.add('hidden');
    $('#libraryView').classList.remove('hidden');
    renderLibrary();
    showToast('⚠️ 저장 중 오류가 말생했습니다. 확인해주세요.');
  });
}
function isMobile() { return window.innerWidth <= 760; }

function migrateTitles(p) {
  let migrated = false;
  p.episodes.forEach(ep => {
    if (ep.type === 'chapter' && ep.title) {
      const match = ep.title.match(/^(?:제)?\s*\d+\s*(?:화|회|회차|장|편)[\s:.-]*(.*)/);
      if (match && match[0] !== ep.title) {
        ep.title = match[1].trim();
        ep._dirty = true;
        migrated = true;
      } else if (match && match[0] === ep.title) {
        ep.title = '';
        ep._dirty = true;
        migrated = true;
      }
    }
  });
  if (migrated) {
    touchProject();
    queueSaveFS();
    forceSaveAllSupabase();
  }
}

async function openProject(id) {
  state.currentProjectId = id;
  const p = currentProject();
  migrateTitles(p);
  if (!p.selectedEpisodeId && p.episodes[0]) p.selectedEpisodeId = p.episodes[0].id;

  if (p.episodes.some(e => e.body === undefined)) {
    showToast('프로젝트 본문을 불러오는 중입니다...');
    await ensureProjectBodiesLoaded(p);
  }

  queueSaveFS();
  // PC에서도 이북 버튼 제공, 모바일은 항상 이북으로
  if (isMobile()) {
    openEbook(id);
  } else {
    $('#libraryView').classList.add('hidden');
    $('#workspaceView').classList.remove('hidden');
    showEditor();
    renderWorkspace();
    updateCommentBadge();
  }
}

// Order Logic
function orderedEpisodes(p = currentProject()) {
  const fm = p.episodes.filter(e => e.type === 'frontmatter');
  const pr = p.episodes.filter(e => e.type === 'prologue');
  const ch = p.episodes.filter(e => e.type === 'chapter' || !['frontmatter', 'prologue', 'epilogue', 'backmatter'].includes(e.type));
  const ep = p.episodes.filter(e => e.type === 'epilogue');
  const bm = p.episodes.filter(e => e.type === 'backmatter');
  return [...fm, ...pr, ...ch, ...ep, ...bm];
}
function reorderEpisode(targetId) {
  if (!draggedId || draggedId === targetId) return;
  const p = currentProject();
  const fIdx = p.episodes.findIndex(e => e.id === draggedId);
  const tIdx = p.episodes.findIndex(e => e.id === targetId);
  if (fIdx < 0 || tIdx < 0) { draggedId = null; return; }

  const [m] = p.episodes.splice(fIdx, 1);
  p.episodes.splice(tIdx, 0, m);

  p.episodes = orderedEpisodes(p);
  p.episodes.forEach(e => e._dirty = true);
  touchProject(); queueSaveFS(); renderEpisodeList(); draggedId = null;
}

// Workspace
function renderWorkspace() {
  const p = currentProject(); if (!p) return showLibrary();
  $('#projectTitle').value = p.title; $('#projectStatus').value = p.status; $('#projectBreadcrumb').textContent = p.title;
  setViewMode(p.viewMode || 'split', false);
  renderEpisodeList(); renderEpisode(); updateProjectStats();
}



function getEpisodeDisplayTitle(ep, p, asHtml = false) {
  if (ep.type === 'frontmatter' || ep.type === 'backmatter') return asHtml ? escapeHtml(ep.title) : ep.title;
  let prefix = '';
  if (ep.type === 'prologue') prefix = '프롤로그';
  else if (ep.type === 'epilogue') prefix = '에필로그';
  else {
    let chapterIndex = 1;
    const eps = p.episodes.slice().sort((a, b) => a.order - b.order);
    for (const e of eps) {
      if (e.id === ep.id) break;
      if (e.type === 'chapter') chapterIndex++;
    }
    prefix = `${chapterIndex}화`;
  }

  if (asHtml) {
    const prefixSpan = `<span class="toc-prefix">${prefix}</span>`;
    return ep.title ? `${prefixSpan} ${escapeHtml(ep.title)}` : prefixSpan;
  } else {
    return ep.title ? `${prefix} ${ep.title}` : prefix;
  }
}

function renderEpisodeList() {
  const p = currentProject(), eps = orderedEpisodes(p);
  const listEl = $('#episodeList');
  listEl.innerHTML = '';

  // 표지 (고정 항목) - 인디자인 느낌
  const coverRow = document.createElement('div');
  coverRow.className = 'tree-category-label';
  coverRow.style.cursor = 'pointer';
  coverRow.style.color = 'var(--c-ink)';
  coverRow.style.transition = 'color 0.2s';
  coverRow.onmouseover = () => coverRow.style.color = 'var(--c-accent)';
  coverRow.onmouseout = () => coverRow.style.color = 'var(--c-ink)';
  coverRow.innerHTML = `<span class="tree-icon">🖼</span> <span>표지 (Cover)</span>`;
  coverRow.title = "표지 설정 열기";
  coverRow.onclick = () => {
    const btn = $('#openPodSettingsBtn');
    if (btn) btn.click();
    setTimeout(() => { if ($$('.pod-settings-tab')[3]) $$('.pod-settings-tab')[3].click(); }, 50);
  };
  listEl.appendChild(coverRow);

  let chapterIdx = 1;
  let currentCategory = null;

  eps.forEach(ep => {
    let cat = 'body';
    if (ep.type === 'frontmatter' || ep.type === 'prologue') cat = 'front';
    else if (ep.type === 'epilogue' || ep.type === 'backmatter') cat = 'back';

    if (cat !== currentCategory) {
      const catLabel = document.createElement('div');
      catLabel.className = 'tree-category-label';
      if (cat === 'front') catLabel.innerHTML = `<span class="tree-icon">📂</span> <span>앞부속 (Front Matter)</span>`;
      else if (cat === 'body') catLabel.innerHTML = `<span class="tree-icon">📖</span> <span>본문 (Main Body)</span>`;
      else if (cat === 'back') catLabel.innerHTML = `<span class="tree-icon">📄</span> <span>뒷부속 (Back Matter)</span>`;
      listEl.appendChild(catLabel);
      currentCategory = cat;
    }

    const isChap = ep.type === 'chapter';
    let rawTitle = ep.title;
    let badgeType = '', badgeText = '';

    const prologueMatch = rawTitle.match(/^(프롤로그)\s*[-:|]?\s*/);
    const epilogueMatch = rawTitle.match(/^(에필로그)\s*[-:|]?\s*/);
    const chapMatch = rawTitle.match(/^(\d+화)\s*[-:|]?\s*/);

    if (prologueMatch) {
      badgeType = 'prologue'; badgeText = '프롤로그';
      rawTitle = rawTitle.substring(prologueMatch[0].length).trim();
    } else if (epilogueMatch) {
      badgeType = 'epilogue'; badgeText = '에필로그';
      rawTitle = rawTitle.substring(epilogueMatch[0].length).trim();
    } else if (chapMatch) {
      badgeType = 'chapter'; badgeText = chapMatch[1];
      rawTitle = rawTitle.substring(chapMatch[0].length).trim();
    } else if (isChap) {
      badgeType = 'chapter'; badgeText = `${chapterIdx++}화`;
    } else if (ep.type === 'prologue') {
      badgeType = 'prologue'; badgeText = '프롤로그';
    } else if (ep.type === 'epilogue') {
      badgeType = 'epilogue'; badgeText = '에필로그';
    }

    let badgeHtml = badgeText ? `<span class="ep-badge ${badgeType}">${escapeHtml(badgeText)}</span>` : '';
    let dispTitle = rawTitle || '(제목 없는 회차)';

    const row = document.createElement('div');
    row.className = `episode-row tree-item ${ep.id === p.selectedEpisodeId ? 'active' : ''}`;
    row.draggable = true;
    row.innerHTML = `<span class="drag" title="드래그하여 순서 변경">⋮</span><div class="episode-main"><strong><span style="display:inline-flex; align-items:center; gap:4px; max-width:100%;">${badgeHtml}<span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(dispTitle)}</span></span></strong><span>${stats(ep.body).withSpaces.toLocaleString()}자</span></div>` +
      `<button class="icon-btn delete-ep-btn" title="삭제" onclick="event.stopPropagation(); deleteEpisode('${ep.id}')" style="opacity:0; transition:opacity .15s;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>`;
    row.querySelector('.episode-main').onclick = () => selectEpisode(ep.id);
    row.ondragstart = (e) => { draggedId = ep.id; row.classList.add('dragging'); e.dataTransfer.setData('text/plain', ep.id); };
    row.ondragover = e => e.preventDefault();
    row.ondrop = e => { e.preventDefault(); reorderEpisode(ep.id); };
    row.ondragend = () => row.classList.remove('dragging');
    listEl.appendChild(row);
  });
  requestAnimationFrame(() => { const el = $('.episode-row.active'); if (el) el.scrollIntoView({ block: 'nearest' }); });
}



function renderEpisode() {
  const p = currentProject();
  const ep = currentEpisode(); if (!ep) return;
  $('#episodeTitle').value = ep.title; $('#episodeType').value = ep.type; $('#episodeBreadcrumb').textContent = getEpisodeDisplayTitle(ep, p);
  $('#planEditor').value = ep.plan || '';
  if ($('#planMdPreview')) $('#planMdPreview').innerHTML = window.marked ? marked.parse(ep.plan || '이번 화 기획이나 메모를 자유롭게 적으세요.') : escapeHtml(ep.plan || '이번 화 기획이나 메모를 자유롭게 적으세요.');
  if ($('#planMdPreview')) $('#planMdPreview').classList.remove('hidden');
  if ($('#planEditor')) $('#planEditor').classList.add('hidden');
  if (!quill) {
    const icons = Quill.import('ui/icons');

    // 서사 블록 (Narrative) Attributor 등록
    const Parchment = Quill.import('parchment');
    const ClassAttributor = Parchment.Attributor.Class;
    const NarrativeClass = new ClassAttributor('narrative', 'n', {
      scope: Parchment.Scope.BLOCK,
      whitelist: ['msg', 'msg-y', 'noti', 'sys', 'log', 'alert', 'record', 'status', 'email', 'email-body', 'doc', 'field', 'memo']
    });
    Quill.register(NarrativeClass, true);

    const HideIconClass = new ClassAttributor('hideicon', 'no-icon', {
      scope: Parchment.Scope.BLOCK,
      whitelist: ['true']
    });
    Quill.register(HideIconClass, true);

    // 구분선(Divider) 블록 등록
    const BlockEmbed = Quill.import('blots/block/embed');
    class DividerBlot extends BlockEmbed { }
    DividerBlot.blotName = 'divider';
    DividerBlot.tagName = 'hr';
    Quill.register(DividerBlot);

    // UI 인라인 포맷 등록
    const Inline = Quill.import('blots/inline');
    class UiBlot extends Inline {
      static create(value) {
        let node = super.create(value);
        node.setAttribute('spellcheck', 'false');
        return node;
      }
    }
    UiBlot.blotName = 'ui';
    UiBlot.tagName = 'SPAN';
    UiBlot.className = 'n-ui';
    Quill.register(UiBlot, true);

    quill = new Quill('#bodyEditor', {
      theme: 'snow',
      placeholder: '첫 문장을 시작하세요...',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          [{ 'narrative': [false, 'msg', 'msg-y', 'noti', 'sys', 'log', 'alert', 'record', 'status', 'email', 'email-body', 'doc', 'field', 'memo'] }],
          ['bold', 'italic', 'underline', 'strike', 'ui', 'hideicon', 'divider', 'image'],
          ['clean']
        ]
      }
    });

    // Custom Image Handler for Compression and Resizing
    quill.getModule('toolbar').addHandler('image', function () {
      const input = document.createElement('input');
      input.setAttribute('type', 'file');
      input.setAttribute('accept', 'image/*');
      input.click();
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        showToast('이미지 최적화 중...');
        try {
          const compressedDataUrl = await compressImage(file, 1200); // Max width 1200px
          const range = quill.getSelection(true);
          quill.insertEmbed(range.index, 'image', compressedDataUrl, Quill.sources.USER);
          quill.setSelection(range.index + 1, Quill.sources.SILENT);
          showToast('이미지가 삽입되었습니다.');
        } catch (e) {
          console.error(e);
          showToast('이미지 처리 실패');
        }
      };
    });

    quill.getModule('toolbar').addHandler('divider', function () {
      let range = quill.getSelection(true);
      quill.insertText(range.index, '\n', Quill.sources.USER);
      quill.insertEmbed(range.index + 1, 'divider', true, Quill.sources.USER);
      quill.setSelection(range.index + 2, Quill.sources.SILENT);
    });

    setTimeout(() => {
      const uiBtn = document.querySelector('button.ql-ui');
      if (uiBtn) {
        uiBtn.title = 'UI 강조 (확인, 선택 등)';
        uiBtn.innerHTML = '<span style="font-size:12px; font-weight:700; color:#444; line-height:24px; display:inline-block;">UI</span>';
      }
      const divBtn = document.querySelector('button.ql-divider');
      if (divBtn) {
        divBtn.title = '장면 전환 (구분선)';
        divBtn.innerHTML = '<span style="font-size:14px; font-weight:700; color:#444; line-height:24px; display:inline-block;">―</span>';
      }
    }, 100);


    quill.root.addEventListener('paste', async (e) => {
      const items = (e.clipboardData || e.originalEvent.clipboardData).items;
      for (const item of items) {
        if (item.type.indexOf('image') === 0) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) {
            showToast('붙여넣은 이미지 최적화 중...');
            const compressedDataUrl = await compressImage(file, 1200);
            const range = quill.getSelection(true);
            quill.insertEmbed(range.index, 'image', compressedDataUrl, Quill.sources.USER);
            quill.setSelection(range.index + 1, Quill.sources.SILENT);
          }
        }
      }
    });

    quill.on('text-change', (delta, oldDelta, source) => {
      const ep = currentEpisode();
      ep.body = quill.root.innerHTML;
      ep._dirty = true;
      touchProject(); updateBodyStats(); queueSaveFS();
      // 성능 최적화: 타이핑 중 에피소드 목록 전체 리렌더 제거 (자수만 업데이트)
    });

    quill.root.addEventListener('click', (e) => {
      let target = e.target.closest('.n-field');
      if (target) {
        let blot = Quill.find(target);
        if (blot) {
          while (blot.parent && blot.parent.domNode !== quill.root) {
            blot = blot.parent;
          }
          let index = quill.getIndex(blot);
          let length = blot.length();
          setTimeout(() => {
            quill.setSelection(index + length - 1, 0, Quill.sources.USER);
          }, 0);
        }
      }
    });
  }

  if (quill.root.innerHTML !== (ep.body || '<p><br></p>')) {
    if (ep.body && !ep.body.startsWith('<')) {
      // 기존 텍스트(마크다운 포함) 호환성: 줄바꿈을 p 태그로.
      const htmlText = ep.body.split('\n').map(line => line ? `<p>${escapeHtml(line)}</p>` : `<p><br></p>`).join('');
      quill.root.innerHTML = htmlText;
    } else {
      quill.root.innerHTML = ep.body || '<p><br></p>';
    }
  }
  updateBodyStats(); renderEpisodeList(); restoreEditorScroll();
}



function selectEpisode(id) { persistEditor(); saveEditorScroll(); currentProject().selectedEpisodeId = id; touchProject(); queueSaveFS(); showEditor(); renderEpisode(); }
function persistEditor() { if ($('#workspaceView').classList.contains('hidden') || $('#manuscriptView').classList.contains('active')) return; const p = currentProject(), ep = currentEpisode(); if (!p || !ep) return; ep.title = $('#episodeTitle').value.trim() || '제목 없는 회차'; ep.type = $('#episodeType').value; ep.plan = $('#planEditor').value; ep.body = quill ? quill.root.innerHTML : $('#bodyEditor').innerHTML; ep._dirty = true; }
function updateProjectStats() { const p = currentProject(); if (!p) return; const total = p.episodes.reduce((s, e) => s + stats(e.body || '').withSpaces, 0); $('#projectStats').textContent = `총 ${total.toLocaleString()}자`; $('#projectBreadcrumb').textContent = p.title; }
function updateBodyStats() { const s = stats(quill ? quill.getText() : $('#bodyEditor').innerText || ''); $('#bodyStats').textContent = `${s.withSpaces.toLocaleString()}자 · 원고지 ${s.manuscript}매`; updateProjectStats(); }
function setViewMode(mode, save = true) { saveEditorScroll(); const p = currentProject(); if (p) p.viewMode = mode; $('#editorColumns').className = `editor-columns mode-${mode}`; $$('.view-tab').forEach(b => b.classList.toggle('active', b.dataset.mode === mode)); if (save) queueSaveFS(); restoreEditorScroll(); }
function addEpisode() { const title = prompt('새 회차의 제목을 입력하세요 (예: 불길한 징조)'); if (title === null) return; const t = title.trim(); persistEditor(); const p = currentProject(); const ep = defaultEpisode('chapter', 1); ep.title = t; if (t.includes('프롤로그')) ep.type = 'prologue'; else if (t.includes('에필로그')) ep.type = 'epilogue'; p.episodes.push(ep); p.selectedEpisodeId = ep.id; p.episodes = orderedEpisodes(p); touchProject(); queueSaveFS(); showEditor(); renderEpisodeList(); renderEpisode(); showToast('회차를 추가했어요.'); }

function addFrontMatter() {
  persistEditor();
  const p = currentProject();
  if (!p) return;
  const ep = defaultEpisode('frontmatter', 1);
  ep.title = '부속 페이지 (속표지/판권지)';
  ep.body = '<p style="text-align: center;"><strong>(도서명)</strong></p><p style="text-align: center;"><br></p><p style="text-align: center;">지은이: (저자명)</p><p style="text-align: center;">발행일: 2026년 00월 00일</p><p style="text-align: center;">출판사: (출판사명)</p><p style="text-align: center;"><br></p><p style="text-align: center;">ⓒ 2026 (저자명). All rights reserved.</p>';
  p.episodes.push(ep);
  p.selectedEpisodeId = ep.id;
  p.episodes = orderedEpisodes(p);
  touchProject(); queueSaveFS(); showEditor(); renderEpisodeList(); renderEpisode();
  setTimeout(() => { const el = $('.episode-row.active'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 100);
  showToast('부속 페이지를 맨 위에 추가했습니다. 위아래로 끌어다 놓아 순서를 변경하세요.');
}
if ($('#addFrontMatterBtn')) $('#addFrontMatterBtn').onclick = addFrontMatter;

function togglePlanDrawer() {
  saveEditorScroll();
  isPlanDrawerOpen = !isPlanDrawerOpen;
  $('#planDrawer').classList.toggle('open', isPlanDrawerOpen);
  if (isPlanDrawerOpen) renderProjectPlan();
  restoreEditorScroll();
}



// Export / Import
async function exportBackup() {
  persistEditor(); queueSaveFS();

  // 전체 백업이므로 안 불러온 모든 본문 로드
  let needsLoading = state.projects.some(p => p.episodes.some(e => e.body === undefined));
  if (needsLoading) {
    showToast('백업을 위해 전체 데이터를 불러오는 중입니다...');
    for (const p of state.projects) {
      if (p.episodes.some(e => e.body === undefined)) await ensureProjectBodiesLoaded(p);
    }
  }

  const jsonString = JSON.stringify(state, null, 2);
  let blob = new Blob([jsonString], { type: 'application/json' });
  let filename = `야니의_소설창고_backup_${new Date().toISOString().slice(0, 10)}.json`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function remapImportedProject(project) {
  const episodeIdMap = new Map();
  const episodes = (project.episodes || []).map(ep => {
    const newId = uid('ep'); episodeIdMap.set(ep.id, newId);
    return { ...ep, id: newId, versions: (ep.versions || []).map(v => ({ ...v, id: uid('ver') })) };
  });
  return {
    ...project,
    id: uid('project'),
    selectedEpisodeId: episodeIdMap.get(project.selectedEpisodeId) || episodes[0]?.id || null,
    planSections: (project.planSections || []).map(sec => ({ ...sec, id: uid('plan') })),
    episodes
  };
}
async function handleImport(mode) {
  if (!importTempData || !importTempData.projects) return;
  try {
    let newState = mode === 'replace' ? importTempData : { ...state, projects: [...state.projects, ...importTempData.projects.map(remapImportedProject)] };
    state = newState;
    closeModal('importModal');
    showToast('클라우드에 백업 데이터를 동기화 중입니다...');
    await forceSaveAllSupabase();
    if ($('#libraryView').classList.contains('hidden')) { renderWorkspace(); } else { renderLibrary(); }
    showToast(mode === 'replace' ? '백업 데이터를 완벽하게 복원했어요!' : '백업 데이터를 추가했어요!');
  } catch (e) {
    console.error(e);
    showToast('저장 중 오류가 발생했습니다.');
  }
}

// Cover Settings
function openCoverSettings(projectId) {
  coverTargetProjectId = projectId;
  const p = state.projects.find(x => x.id === projectId); if (!p) return;
  // Render preview
  const preview = $('#coverPreview');
  if (p.cover) { preview.innerHTML = `<img src="${p.cover}" alt="표지"/>`; }
  else { preview.innerHTML = coverPlaceholderMarkup(p); }
  // Color swatches
  $('#coverColors').innerHTML = COVER_COLORS.map(c => `<button class="cover-color-swatch ${p.coverColor === c ? 'active' : ''}" data-cover-color="${c}" style="background:${c}"></button>`).join('');
  $('#coverCustomColor').value = p.coverColor || DEFAULT_COVER_COLOR;
  $('#coverColorValue').textContent = p.coverColor || DEFAULT_COVER_COLOR;
  $$('#coverColors [data-cover-color]').forEach(b => b.onclick = () => {
    const c = b.dataset.coverColor; p.coverColor = c; p.cover = '';
    $$('#coverColors [data-cover-color]').forEach(x => x.classList.remove('active')); b.classList.add('active');
    $('#coverCustomColor').value = c; $('#coverColorValue').textContent = c;
    $('#coverPreview').innerHTML = coverPlaceholderMarkup(p);
    touchProject(); queueSaveFS(); renderLibrary();
  });
  openModal('coverModal');
}
$('#coverCustomColor').oninput = () => {
  const p = state.projects.find(x => x.id === coverTargetProjectId); if (!p) return;
  const c = $('#coverCustomColor').value; p.coverColor = c; p.cover = '';
  $('#coverColorValue').textContent = c;
  $$('#coverColors [data-cover-color]').forEach(x => x.classList.remove('active'));
  $('#coverPreview').innerHTML = coverPlaceholderMarkup(p);
  touchProject(); queueSaveFS(); renderLibrary();
};
$('#uploadCoverBtn').onclick = () => $('#coverInput').click();
$('#coverInput').onchange = () => {
  const file = $('#coverInput').files?.[0]; if (!file) return;
  const p = state.projects.find(x => x.id === coverTargetProjectId); if (!p) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const MAX_SIZE = 800;
      let width = img.width, height = img.height;
      if (width > MAX_SIZE || height > MAX_SIZE) {
        if (width > height) { height *= MAX_SIZE / width; width = MAX_SIZE; }
        else { width *= MAX_SIZE / height; height = MAX_SIZE; }
      }
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      p.cover = canvas.toDataURL('image/webp', 0.8);
      $('#coverPreview').innerHTML = `<img src="${p.cover}" alt="표지"/>`;
      touchProject(); queueSaveFS(); renderLibrary();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
};
$('#removeCoverImageBtn').onclick = () => {
  const p = state.projects.find(x => x.id === coverTargetProjectId); if (!p) return;
  p.cover = '';
  $('#coverPreview').innerHTML = coverPlaceholderMarkup(p);
  touchProject(); queueSaveFS(); renderLibrary();
  showToast('표지 이미지를 지웠어요.');
};

// Drawer & Plan

async function openAttachedPdf(sectionId) {
  const p = currentProject();
  const section = (p.planSections || []).find(x => x.id === sectionId);
  if (!section) return showToast('파일을 찾을 수 없습니다.');

  // pdfUrl이 저장된 경우 (신규 방식)
  if (section.pdfUrl) {
    try {
      showToast('PDF 다운로드를 시작합니다...');
      const res = await fetch(section.pdfUrl);
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = section.pdfName || '다운로드.pdf';
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
    } catch (e) {
      console.error('PDF 다운로드 에러', e);
      window.open(section.pdfUrl, '_blank');
    }
    return;
  }

  // pdfName만 있는 구버전 파일: rootHandle에서 시도
  if (rootHandle && section.pdfName) {
    try {
      const folderName = safeName(p.title) + '_' + p.id.split('-').pop();
      const projDir = await rootHandle.getDirectoryHandle(folderName);
      const planDir = await projDir.getDirectoryHandle('기획');
      const pdfFileHandle = await planDir.getFileHandle(section.pdfName);
      const file = await pdfFileHandle.getFile();
      const blobUrl = URL.createObjectURL(file);
      window.open(blobUrl, '_blank');
    } catch (e) {
      console.error(e);
      showToast('파일을 찾을 수 없습니다.');
    }
    return;
  }

  showToast('파일을 찾을 수 없습니다. 파일을 다시 쳊부해주세요.');
}

// ─── 비트시트 배포 함수 ─────────────────────────────────────
function removeBeatSheetFromPlan(planStr) {
  if (!planStr) return '';
  let old = '';
  while (old !== planStr) {
    old = planStr;
    planStr = planStr.replace(/(?:^|\n)### 📋 비트시트 —[\s\S]*?(?:\n\n---\n\n|$)/, '\n').trim();
  }
  return planStr.replace(/\n{3,}/g, '\n\n').trim();
}
function parseBeatSheet(text) {
  // #, ##, ### 헤더 모두 인식 가능하도록 파싱
  const blocks = [];
  let currentHeader = null, currentLines = [];
  for (const line of text.split('\n')) {
    const hMatch = line.match(/^#{1,4}\s*([^#].*)/);
    if (hMatch) {
      if (currentHeader !== null) blocks.push({ header: currentHeader, body: currentLines.join('\n').trim() });
      currentHeader = hMatch[1].trim();
      currentLines = [];
    } else {
      if (currentHeader !== null) currentLines.push(line);
    }
  }
  if (currentHeader !== null) blocks.push({ header: currentHeader, body: currentLines.join('\n').trim() });
  return blocks;
}

function matchEpisodeForBeat(header, episodes, index, totalBlocks) {
  const h = header.trim().toLowerCase();

  if (h.includes('프롤로그') || h.includes('prologue')) {
    return episodes.find(e => e.type === 'prologue' || (e.title && (e.title.includes('프롤로그') || e.title.toLowerCase().includes('prologue')))) || null;
  }
  if (h.includes('에필로그') || h.includes('epilogue')) {
    return episodes.find(e => e.type === 'epilogue' || (e.title && (e.title.includes('에필로그') || e.title.toLowerCase().includes('epilogue')))) || null;
  }

  // 숫자화 매핑: "1화", "1회차", "제1장", "1" 등
  const numMatch = h.match(/(?:제)?\s*(\d+)\s*(?:화|회차|장|회|편)?/);
  if (numMatch) {
    const num = parseInt(numMatch[1]);

    // 스마트 타이틀 매칭
    const matchedByTitle = episodes.find(e => {
      if (!e.title) return false;
      // 프롤로그/에필로그는 숫자 매칭에서 무조건 제외
      if (e.title.includes('프롤로그') || e.title.includes('에필로그')) return false;

      const regex = /(\d+)\s*(?:화|회|장|편)/g;
      let match;
      while ((match = regex.exec(e.title)) !== null) {
        if (parseInt(match[1]) === num) return true;
      }
      return false;
    });
    if (matchedByTitle) return matchedByTitle;

    // 순서 기반 매칭 시, 프롤로그/에필로그 이름이 들어간 챕터는 제외
    const chapters = episodes.filter(e => {
      if (e.type !== 'chapter') return false;
      const t = e.title ? e.title.replace(/\s+/g, '') : '';
      if (t.includes('프롤로그') || t.includes('에필로그')) return false;
      return true;
    });
    return chapters[num - 1] || null;
  }

  // 제목 부분 매핑 (빈 문자열 제외)
  const exactMatched = episodes.find(e => {
    const t = e.title ? e.title.trim().toLowerCase() : '';
    if (!t) return false;
    return t.includes(h) || h === t;
  });
  if (exactMatched) return exactMatched;

  // 제목/번호 등 명시적 매칭 실패 시 -> 순서 기반 위치 추론
  if (typeof index === 'number' && typeof totalBlocks === 'number' && totalBlocks > 0) {
    if (index === 0) {
      return episodes.find(e => e.type === 'prologue') || null;
    } else if (index === totalBlocks - 1 && totalBlocks > 1) {
      return episodes.find(e => e.type === 'epilogue') || null;
    } else {
      const targetNum = index;
      const chapters = episodes.filter(e => {
        if (e.type !== 'chapter') return false;
        const t = e.title ? e.title.replace(/\s+/g, '') : '';
        if (t.includes('프롤로그') || t.includes('에필로그')) return false;
        return true;
      });
      return chapters[targetNum - 1] || null;
    }
  }

  return null;
}

function distributeBeatSheet(sectionId) {
  const p = currentProject();

  // 편집 중인 내용(textarea)이 있다면 실시간으로 반영 (블러 이벤트 전에 배포 버튼 누를 수 있으므로)
  const tx = document.querySelector(`.plan-section-body[data-bdy="${sectionId}"]`);
  if (tx) {
    const secObj = (p.planSections || []).find(x => x.id === sectionId);
    if (secObj) secObj.body = tx.value;
  }

  const section = (p.planSections || []).find(x => x.id === sectionId);
  if (!section) return;
  const blocks = parseBeatSheet(section.body);
  if (!blocks.length) { alert('비트시트 내용이 없거나 #, ##, ### 기호로 구분된 회차 헤더(예: "## 1화")를 찾을 수 없습니다.'); return; }
  let eps = orderedEpisodes(p);
  let matched = 0, created = 0; const matchedEpNames = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (!block.body) continue;
    let ep = matchEpisodeForBeat(block.header, eps, i, blocks.length);
    if (!ep) {
      let type = 'chapter';
      const lh = block.header.toLowerCase();
      if (lh.includes('프롤로그') || lh.includes('prologue')) type = 'prologue';
      else if (lh.includes('에필로그') || lh.includes('epilogue')) type = 'epilogue';
      else {
        if (i === 0) type = 'prologue';
        else if (i === blocks.length - 1 && blocks.length > 1) type = 'epilogue';
      }

      ep = defaultEpisode(type, 0);
      ep.title = block.header;
      p.episodes.push(ep);
      eps = orderedEpisodes(p);
      created++;
    }
    if (ep) {
      if (ep.plan) ep.plan = removeBeatSheetFromPlan(ep.plan);
      const beatMd = `### 📋 비트시트 — ${block.header}\n${block.body}`;
      ep.plan = beatMd + (ep.plan ? '\n\n---\n\n' + ep.plan : '');
      ep._dirty = true;
      if (p.selectedEpisodeId === ep.id && !$('#workspaceView').classList.contains('hidden')) {
        $('#planEditor').value = ep.plan;
      }
      matched++; matchedEpNames.push(ep.title);
    }
  }
  if (matched === 0 && created === 0) { alert('매칭되는 회차를 찾지 못했습니다.\\n"1화", "프롤로그" 등의 제목이나 번호가 있는지 확인해주세요.'); return; }
  section.distributed = true;
  touchProject();
  forceSaveAllSupabase();
  renderProjectPlan();
  if (created > 0) renderEpisodeList();
  const debugNames = Array.from(new Set(matchedEpNames)).slice(0, 3).join(', ');
  showToast(created > 0 ? `${matched - created}개 배포, ${created}개 새 회차 생성 완료! (${debugNames})` : `${matched}개의 회차에 배포 완료! (${debugNames})`);
  // 현재 선택된 에피소드 기획창 갱신
  const curEp = currentEpisode();
  if (curEp) {
    $('#planEditor').value = curEp.plan || '';
    $('#planMdPreview').innerHTML = window.marked ? marked.parse(curEp.plan || '') : escapeHtml(curEp.plan || '');
  }
  // 현재 선택된 에피소드 기획창 갱신
}
// ─────────────────────────────────────────────────────────────

function syncPlanToBeatSheet(ep) {
  const p = currentProject();
  if (!p || !p.planSections) return;
  const bsSection = p.planSections.find(s => s.type === 'beatsheet');
  if (!bsSection || !bsSection.body) return;

  const blocks = parseBeatSheet(bsSection.body);
  if (!blocks.length) return;

  const regex = /(?:^|\n)### 📋 비트시트 — ([^\n]+)\n([\s\S]*?)(?:\n\n---\n\n|$)/;
  const match = ep.plan.match(regex);
  if (!match) return;

  const header = match[1].trim();
  const newBody = match[2].trim();

  const blockIndex = blocks.findIndex(b => b.header === header);
  if (blockIndex === -1) return;

  if (blocks[blockIndex].body !== newBody) {
    blocks[blockIndex].body = newBody;
    bsSection.body = blocks.map(b => `## ${b.header}\n${b.body}`).join('\n\n');
    touchProject();
    queueSaveFS();
    if (!$('#workspaceView').classList.contains('hidden')) {
      renderProjectPlan(); // UI 즉시 갱신
    }
  }
}

function renderProjectPlan() {
  const p = currentProject();
  let list = $('#projectPlanList');
  if (!list) {
    list = document.createElement('div');
    list.id = 'projectPlanList';
    list.style.cssText = 'padding:16px; display:flex; flex-direction:column; gap:16px;';
    const wrapper = $('#planBodyWrapper');
    if (wrapper) wrapper.appendChild(list);
  }
  const sections = p.planSections || [];
  if (!sections.length) { list.innerHTML = `<div class="plan-empty">기획 항목이 없어요.</div>`; return; }
  list.innerHTML = sections.map(x => {
    const isPdf = x.type === 'pdf_attachment';
    const isBeat = x.type === 'beatsheet';
    let bodyContent;
    if (isPdf) {
      bodyContent = `<div style="padding:16px;text-align:center;"><button class="secondary" data-open-pdf="${x.id}" style="width:100%;">📄 PDF 문서 열기</button><p style="margin:8px 0 0;font-size:11px;color:var(--c-muted);word-break:break-all;">${escapeHtml(x.pdfName || '')}</p></div>`;
    } else {
      bodyContent = `<div class="plan-md-view" style="padding:12px; font-size:13px; line-height:1.6; cursor:pointer;" data-mdv="${x.id}" title="클릭하여 수정">${window.marked ? marked.parse(x.body || '내용이 없습니다.') : escapeHtml(x.body)}</div>
         <textarea class="plan-section-body hidden" data-bdy="${x.id}">${escapeHtml(x.body)}</textarea>`;
    }
    const distributeBtn = isBeat
      ? (x.distributed
        ? `<button class="secondary" style="margin-right:6px; padding:4px 10px; font-size:11px; height:24px; border-radius:4px; line-height:1;" data-distribute-beat="${x.id}">✅ 재배포</button>`
        : `<button class="primary" style="margin-right:6px; padding:4px 10px; font-size:11px; height:24px; border-radius:4px; line-height:1;" data-distribute-beat="${x.id}">🚀 배포하기</button>`)
      : '';
    return `<article class="plan-accordion ${x.open ? 'open' : ''}" data-plan-sec="${x.id}">
    <div class="plan-accordion-head">
      <button class="accordion-toggle" data-tgl="${x.id}">›</button>
      <input class="plan-section-title" data-ttl="${x.id}" value="${escapeHtml(x.title)}"/>
      <div style="display:flex; align-items:center; gap:4px;">
        ${distributeBtn}
        <button class="icon-btn" style="width:28px;height:28px;" data-del="${x.id}">×</button>
      </div>
    </div>
    <div class="plan-accordion-body">${bodyContent}</div>
  </article>`;
  }).join('');
  // 마크다운 미리보기 클릭 → 텍스트에리어 전환 (JS 이벤트)
  $$('[data-mdv]').forEach(div => div.onclick = () => {
    div.classList.add('hidden');
    const ta = div.nextElementSibling;
    ta.classList.remove('hidden');
    ta.focus();
  });
  $$('[data-tgl]').forEach(b => b.onclick = () => { const s = sections.find(x => x.id === b.dataset.tgl); s.open = !s.open; touchProject(); queueSaveFS(); renderProjectPlan(); });
  $$('[data-ttl]').forEach(i => i.oninput = () => { sections.find(x => x.id === i.dataset.ttl).title = i.value; touchProject(); queueSaveFS(); });
  $$('[data-bdy]').forEach(t => {
    t.oninput = () => { sections.find(x => x.id === t.dataset.bdy).body = t.value; touchProject(); queueSaveFS(); };
    t.onblur = () => {
      // blur 시 최신값 저장 보장
      const sec = sections.find(x => x.id === t.dataset.bdy);
      if (sec) { sec.body = t.value; touchProject(); queueSaveFS(); }
      t.classList.add('hidden');
      const mdv = t.previousElementSibling;
      mdv.classList.remove('hidden');
      mdv.innerHTML = window.marked ? marked.parse(t.value) : escapeHtml(t.value);
    };
    requestAnimationFrame(() => autosizePlanSection(t));
  });
  $$('[data-del]').forEach(b => b.onclick = () => {
    if (confirm('항목을 삭제할까요?')) {
      const delId = b.dataset.del;
      const sec = p.planSections.find(x => x.id === delId);
      if (sec && sec.type === 'beatsheet') {
        if (confirm('이 비트시트로 각 회차에 배포되었던 내용도 모두 삭제할까요?\n(회차 기획에 배포된 비트시트만 안전하게 지워집니다)')) {
          p.episodes.forEach(ep => {
            if (ep.plan) {
              ep.plan = removeBeatSheetFromPlan(ep.plan);
              ep._dirty = true;
            }
          });
        }
      }
      p.planSections = p.planSections.filter(x => x.id !== delId);
      touchProject(); queueSaveFS(); renderProjectPlan();
    }
  });
  $$('[data-distribute-beat]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); e.preventDefault();
    distributeBeatSheet(b.dataset.distributeBeat);
  });
  $$('[data-open-pdf]').forEach(b => b.onclick = () => openAttachedPdf(b.dataset.openPdf));
}

function updateCommentBadge() {
  const p = currentProject();
  if (!p) return;
  const count = p.episodes.reduce((acc, ep) => acc + (ep.comments?.length || 0), 0);
  const badge = $('#pcCommentBadge');
  if (count > 0) {
    badge.style.display = 'inline-block';
    badge.textContent = count;
  } else {
    badge.style.display = 'none';
  }
}

function renderPCCommentList() {
  const p = currentProject();
  let list = $('#projectCommentList');
  if (!list) {
    list = document.createElement('div');
    list.id = 'projectCommentList';
    list.style.cssText = 'flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:12px;';
    const wrapper = $('#commentBodyWrapper');
    if (wrapper) wrapper.appendChild(list);
  }
  if (!p) return;

  let html = '';
  let total = 0;
  p.episodes.forEach((ep, i) => {
    const comments = ep.comments || [];
    if (comments.length === 0) return;
    total += comments.length;

    html += `<div style="margin-bottom:16px;">
      <h3 style="font-size:13px;color:var(--c-sub);margin:0 0 8px;">${ep.type === 'prologue' ? '프' : ep.type === 'epilogue' ? '에' : (i + 1) + '화'} - ${escapeHtml(ep.title)}</h3>
      <div style="display:grid;gap:8px;">
        ${comments.map(c => `
          <div class="comment-item" style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px;padding:12px;cursor:pointer;" onclick="gotoComment('${ep.id}', '${escapeHtml(c.quote).replace(/'/g, "\\'")}')">
            <div style="font-size:12px;color:var(--c-muted);margin-bottom:6px;padding-left:8px;border-left:2px solid var(--border);">"${escapeHtml(c.quote)}"</div>
            <div style="font-size:13px;color:var(--c-body);line-height:1.5;">${escapeHtml(c.text)}</div>
            <div style="font-size:11px;color:var(--c-muted);margin-top:6px;text-align:right;">${new Date(c.createdAt).toLocaleString()}</div>
          </div>
        `).join('')}
      </div>
    </div>`;
  });

  if (total === 0) {
    list.innerHTML = `<div class="plan-empty">등록된 코멘트가 없어요.<br><br>📖 이북 뷰어에서 텍스트를 선택해<br>코멘트를 남겨보세요.</div>`;
  } else {
    list.innerHTML = html;
  }
  updateCommentBadge();
}

function gotoComment(epId, quote) {
  // 에피소드 열기
  const p = currentProject();
  if (p.selectedEpisodeId !== epId) {
    p.selectedEpisodeId = epId;
    renderEpisodeList();
    renderEditor();
  }

  // 본문 이동
  const editor = $('#bodyEditor');
  if (window.quill) {
    // 텍스트에서 인용구 위치 검색
    const text = quill.getText();
    const idx = text.indexOf(quote);
    if (idx !== -1) {
      quill.setSelection(idx, quote.length);
      const bounds = quill.getBounds(idx);
      editor.scrollTop = bounds.top - 100; // 스크롤 여유
    } else {
      showToast('해당 문장을 찾을 수 없습니다. (수정되었을 수 있음)');
    }
  }
}

// Copy Logic
function buildEpisodeText(ep, mode) {
  const t = cleanText(ep.title), p = cleanText(ep.plan), b = cleanText(ep.body);
  if (mode === 'body') return b; if (mode === 'plan') return p; if (mode === 'plan-body') return `[기획]\n${p}\n\n[본문]\n${t}\n\n${b}`.trim(); return `${t}\n\n${b}`.trim();
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch (e) { const a = document.createElement('textarea'); a.value = text; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  showToast(msg);
}

// Bindings
$('#newProjectBtn').onclick = () => { $('#newProjectColors').innerHTML = COVER_COLORS.map(c => `<button class="cover-color-swatch ${c === DEFAULT_COVER_COLOR ? 'active' : ''}" data-new-color="${c}" style="background:${c}"></button>`).join(''); $$('[data-new-color]').forEach(b => b.onclick = () => { $$('[data-new-color]').forEach(x => x.classList.remove('active')); b.classList.add('active'); }); openModal('newProjectModal'); setTimeout(() => $('#newProjectTitle').focus(), 30); };
$('#createProjectBtn').onclick = async () => {
  const p = { id: uid('project'), title: $('#newProjectTitle')?.value.trim() || '제목 없는 작품', status: $('#newProjectStatus')?.value || 'serializing', cover: '', coverColor: $('.cover-color-swatch.active')?.dataset.newColor || DEFAULT_COVER_COLOR, updatedAt: Date.now(), selectedEpisodeId: null, viewMode: 'split', planSections: [], episodes: [], _dirty: true };
  const ep = defaultEpisode('prologue'); p.episodes.push(ep); p.selectedEpisodeId = ep.id;
  state.projects.unshift(p);
  closeModal('newProjectModal'); if ($('#newProjectTitle')) $('#newProjectTitle').value = '';
  showToast('새 작품을 저장 중...');
  await forceSaveAllSupabase(); // 서재로 돌아갔을 때 즉시 표시되도록 저장 완료 보장
  openProject(p.id); showToast('새 작품을 만들었어요.');
};
$('#backLibraryBtn').onclick = showLibrary;
libraryFilter = 'all'; // 서재 기본 필터를 '모든 작품'으로
$$('.filter-btn').forEach(b => b.onclick = () => { libraryFilter = b.dataset.filter; renderLibrary(); });

// Editor bindings
$('#projectTitle').oninput = () => { const p = currentProject(); p.title = $('#projectTitle').value || '제목 없는 작품'; $('#projectBreadcrumb').textContent = p.title; touchProject(); queueSaveFS(); };
$('#projectStatus').onchange = () => { currentProject().status = $('#projectStatus').value; touchProject(); queueSaveFS(); };
$('#addEpisodeBtn').onclick = addEpisode;
$('#cleanEmptyEpsBtn').onclick = async () => {
  const p = currentProject(); if (!p) return;
  const ghosts = p.episodes.filter(e => !e.body || e.body.replace(/<[^>]*>?/gm, '').trim() === '');
  if (ghosts.length === 0) { showToast('정리할 빈 회차가 없습니다.'); return; }
  if (!confirm(`본문 내용이 없는 빈 회차 ${ghosts.length}개를 모두 삭제하시겠습니까?\n(기획 및 메모가 적힌 회차도 본문이 없으면 삭제됩니다)`)) return;
  $('#saveStatus').textContent = '빈 회차 정리 중...';
  let deleted = 0;
  for (const ep of ghosts) {
    if (ep.id === p.selectedEpisodeId) continue;
    const idx = p.episodes.findIndex(x => x.id === ep.id);
    if (idx > -1) {
      p.episodes.splice(idx, 1);
      if (currentUser) {
        const { error } = await sb.from('novel_episodes').delete().eq('id', ep.id);
        if (error) console.error('Failed to delete ghost ep:', error);
      }
      deleted++;
    }
  }
  touchProject(); queueSaveFS(); renderEpisodeList();
  showToast(`${deleted}개의 빈 회차가 깔끔하게 정리되었습니다! 🧹`);
};
$('#episodeTitle').oninput = () => { const ep = currentEpisode(); ep.title = $('#episodeTitle').value; $('#episodeBreadcrumb').textContent = $('#episodeTitle').value || '제목 없는 회차'; ep._dirty = true; touchProject(); renderEpisodeList(); queueSaveFS(); };
$('#episodeType').onchange = () => { const ep = currentEpisode(); ep.type = $('#episodeType').value; currentProject().episodes = orderedEpisodes(); ep._dirty = true; touchProject(); renderEpisodeList(); queueSaveFS(); };

// planMdPreview 클릭 → planEditor 전환 (인라인 onclick 대신 안전한 JS 이벤트)
$('#planMdPreview').onclick = () => {
  const ep = currentEpisode(); if (!ep) return;
  $('#planEditor').value = ep.plan || '';
  $('#planMdPreview').classList.add('hidden');
  $('#planEditor').classList.remove('hidden');
  $('#planEditor').focus();
};

$('#planEditor').oninput = () => {
  const ep = currentEpisode();
  if (!ep) return;
  ep.plan = $('#planEditor').value;
  ep._dirty = true;
  touchProject();
  queueSaveFS();
};
$('#planEditor').onblur = () => {
  const ep = currentEpisode();
  if (ep) {
    ep.plan = $('#planEditor').value;
    touchProject();
    queueSaveFS();
    syncPlanToBeatSheet(ep);
    forceSaveAllSupabase();
  }
  $('#planEditor').classList.add('hidden');
  const preview = $('#planMdPreview');
  preview.classList.remove('hidden');
  preview.innerHTML = window.marked
    ? marked.parse($('#planEditor').value || '이번 화 기획이나 메모를 자유롭게 적으세요.')
    : escapeHtml($('#planEditor').value || '이번 화 기획이나 메모를 자유롭게 적으세요.');
};
$('#bodyEditor').oninput = () => { const ep = currentEpisode(); ep.body = quill ? quill.root.innerHTML : $('#bodyEditor').innerHTML; ep._dirty = true; touchProject(); updateBodyStats(); renderEpisodeList(); queueSaveFS(); };
$$('.view-tab').forEach(b => b.onclick = () => setViewMode(b.dataset.mode));
$('#toggleDrawerBtn').onclick = togglePlanDrawer;
$('#openPCEbookBtn').onclick = () => openEbook(currentProject().id);
if ($('#closePlanDrawerBtn')) $('#closePlanDrawerBtn').onclick = togglePlanDrawer;

$('#tabPlanBtn').onclick = () => {
  $('#tabPlanBtn').classList.add('active');
  $('#tabPlanBtn').style.color = '';
  $('#tabCommentBtn').classList.remove('active');
  $('#tabCommentBtn').style.color = 'var(--c-muted)';
  if ($('#projectPlanList')) $('#projectPlanList').classList.remove('hidden');
  $('#planToolbar').classList.remove('hidden');
  if ($('#projectCommentList')) $('#projectCommentList').classList.add('hidden');
};
$('#tabCommentBtn').onclick = () => {
  $('#tabCommentBtn').classList.add('active');
  $('#tabCommentBtn').style.color = '';
  $('#tabPlanBtn').classList.remove('active');
  $('#tabPlanBtn').style.color = 'var(--c-muted)';
  if ($('#projectCommentList')) $('#projectCommentList').classList.remove('hidden');
  if ($('#projectPlanList')) $('#projectPlanList').classList.add('hidden');
  $('#planToolbar').classList.add('hidden');
  renderPCCommentList();
};
$('#addPlanSectionBtn').onclick = () => { currentProject().planSections.push(defaultPlanSection()); touchProject(); queueSaveFS(); renderProjectPlan(); };
$('#addBeatSheetBtn').onclick = () => {
  const p = currentProject();
  p.planSections.push({ id: uid('plan'), title: '🎬 비트시트', body: '## 프롤로그\n(프롤로그 내용)\n\n## 1화\n(1화 비트 내용)\n\n## 2화\n(2화 비트 내용)', type: 'beatsheet', open: true, distributed: false });
  touchProject(); queueSaveFS(); renderProjectPlan();
  showToast('비트시트 항목이 추가됐어요. ## 헤더로 회차를 구분하여 작성하세요.');
};
$('#copyAllPlanBtn').onclick = () => { const txt = (currentProject().planSections || []).map(x => `${cleanText(x.title)}\n\n${cleanText(x.body)}`).join('\n\n\n'); copyText(txt, '전체 기획을 복사했어요.'); };


function getMarkdownForEpisode(ep) {
  if (!ep.body || ep.body.trim() === '' || ep.body === '<p><br></p>') return '';

  let html = ep.body;
  const norm = (s) => s.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
  if (ep.title) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    const titleNorm = norm(ep.title);

    // 헤딩 또는 첫 단락 중복 제목 제거
    const headings = tempDiv.querySelectorAll('h1, h2');
    let hasTitle = false;
    if (headings.length > 0 && norm(headings[0].textContent) === norm(ep.title)) {
      headings[0].remove();
      hasTitle = true;
    }
    if (!hasTitle) {
      const firstP = tempDiv.querySelector('p');
      if (firstP && norm(firstP.textContent) === norm(ep.title)) firstP.remove();
    }
    html = tempDiv.innerHTML;
  }

  let md = html;

  // 인라인 스타일
  md = md.replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**');
  md = md.replace(/<em>([\s\S]*?)<\/em>/g, '*$1*');
  md = md.replace(/<s>([\s\S]*?)<\/s>/g, '~~$1~~');
  md = md.replace(/<u>([\s\S]*?)<\/u>/g, '$1'); // MD는 밑줄 비표준
  md = md.replace(/<span class="n-ui"[^>]*>([\s\S]*?)<\/span>/g, '`$1`');

  // <br> 태그를 줄바꿈 문자로 변경
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // 서사 블록
  md = md.replace(/<p class="n-msg"[^>]*>([\s\S]*?)<\/p>/g, '> [메시지] $1\n\n');
  md = md.replace(/<p class="n-msg-y"[^>]*>([\s\S]*?)<\/p>/g, '> [메시지(노랑)] $1\n\n');
  md = md.replace(/<p class="n-sys"[^>]*>([\s\S]*?)<\/p>/g, '> [시스템] $1\n\n');
  md = md.replace(/<p class="n-alert"[^>]*>([\s\S]*?)<\/p>/g, '> [알림] $1\n\n');
  md = md.replace(/<p class="n-record"[^>]*>([\s\S]*?)<\/p>/g, '> [기록] $1\n\n');
  md = md.replace(/<p class="n-status"[^>]*>([\s\S]*?)<\/p>/g, '> [상태창] $1\n\n');
  md = md.replace(/<p class="n-log"[^>]*>([\s\S]*?)<\/p>/g, '```log\n$1\n```\n\n');
  md = md.replace(/<p class="n-noti"[^>]*>([\s\S]*?)<\/p>/g, '> [휴대폰] $1\n\n');
  md = md.replace(/<p class="n-email"[^>]*>([\s\S]*?)<\/p>/g, '> [이메일 알림] $1\n\n');
  md = md.replace(/<p class="n-email-body"[^>]*>([\s\S]*?)<\/p>/g, '> [이메일 본문] $1\n\n');
  md = md.replace(/<p class="n-doc"[^>]*>([\s\S]*?)<\/p>/g, '> [서신] $1\n\n');
  md = md.replace(/<p class="n-field"[^>]*>([\s\S]*?)<\/p>/g, '> [입력칸] $1\n\n');

  // 헤더
  md = md.replace(/<h1>([\s\S]*?)<\/h1>/g, '# $1\n\n');
  md = md.replace(/<h2>([\s\S]*?)<\/h2>/g, '## $1\n\n');
  md = md.replace(/<h3>([\s\S]*?)<\/h3>/g, '### $1\n\n');

  // 일반 단락
  md = md.replace(/<p><\/p>/g, '\n\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/g, '$1\n\n');

  // 남은 태그 제거 및 엔티티 복원
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

  // 연속된 개행 정리
  md = md.replace(/\n{3,}/g, '\n\n');

  return `## ${ep.title}\n\n` + md.trim();
}

function buildEpisodeText(ep, mode) {
  const t = cleanText(ep.title), p = cleanText(ep.plan), b = cleanText(ep.body);
  if (mode === 'plan') return p;
  if (mode === 'body') return b;
  if (mode === 'plan-body') return p ? `${p}\n\n${b}` : b;
  return `${t}\n\n${b}`;
}

$('#quickCopyBodyBtn').onclick = () => {
  const md = getMarkdownForEpisode(currentEpisode());
  copyText(md, '본문을 복사했어요. (마크다운)');
};
$('#copyDropdownToggle').onclick = (e) => { e.stopPropagation(); $('#copyDropdownMenu').classList.toggle('show'); };
$$('[data-copy]').forEach(b => b.onclick = (e) => {
  e.stopPropagation();
  const mode = b.dataset.copy;
  const ep = currentEpisode();
  if (mode.includes('body')) {
    const titleMd = mode.includes('title') ? `# ${ep.title}\n\n` : '';
    const planMd = mode.includes('plan') && ep.plan ? `${ep.plan}\n\n---\n\n` : '';
    const bodyMd = getMarkdownForEpisode(ep).replace(/^## .+\n\n/, ''); // title 제거
    copyText(planMd + titleMd + bodyMd, '복사했어요. (마크다운)');
  } else {
    copyText(buildEpisodeText(ep, mode), '복사했어요.');
  }
  $('#copyDropdownMenu').classList.remove('show');
});
window.addEventListener('click', (e) => { if (!e.target.closest('.dropdown-container')) $('#copyDropdownMenu')?.classList.remove('show'); });

// Search
$('#openSearchBtn').onclick = () => { openModal('searchModal'); $('#searchInput').focus(); };
$('#searchInput').oninput = () => {
  const q = $('#searchInput').value.trim().toLowerCase();
  if (!q) { $('#searchResults').innerHTML = ''; return; }
  const res = [], p = currentProject();
  p.episodes.forEach(ep => [{ type: '본문', t: ep.body || '' }, { type: '기획', t: ep.plan || '' }].forEach(src => {
    let pos = 0; const lower = src.t.toLowerCase();
    while ((pos = lower.indexOf(q, pos)) !== -1 && res.length < 15) {
      const snip = src.t.slice(Math.max(0, pos - 30), Math.min(src.t.length, pos + q.length + 30));
      const marked = escapeHtml(snip).replace(new RegExp(escapeHtml(q), 'gi'), '<mark>$&</mark>');
      res.push({ kind: 'ep', ep, type: src.type, html: marked }); pos += q.length;
    }
  }));
  (p.planSections || []).forEach(sec => {
    const txt = `${sec.title} ${sec.body}`, lower = txt.toLowerCase(); let pos = 0;
    while ((pos = lower.indexOf(q, pos)) !== -1 && res.length < 20) {
      const snip = txt.slice(Math.max(0, pos - 30), Math.min(txt.length, pos + q.length + 30));
      const marked = escapeHtml(snip).replace(new RegExp(escapeHtml(q), 'gi'), '<mark>$&</mark>');
      res.push({ kind: 'plan', sec, type: '작품 기획', html: marked }); pos += q.length;
    }
  });
  $('#searchResults').innerHTML = res.map((r, i) => `<button class="search-result" data-sr="${i}"><strong>${escapeHtml(r.kind === 'ep' ? r.ep.title : r.sec.title)} · ${r.type}</strong><span>${r.html}</span></button>`).join('');
  $$('[data-sr]').forEach(b => b.onclick = () => {
    const r = res[Number(b.dataset.sr)]; closeModal('searchModal');
    if (r.kind === 'plan') {
      if (!isPlanDrawerOpen) togglePlanDrawer();
      r.sec.open = true; renderProjectPlan();
      setTimeout(() => { $(`[data-plan-sec="${r.sec.id}"]`)?.scrollIntoView({ behavior: 'smooth' }); }, 100);
    } else {
      selectEpisode(r.ep.id); setViewMode(r.type === '본문' ? 'body' : 'plan');
    }
  });
};

// Versions


// Manuscript
function showEditor() { $('#manuscriptView').classList.remove('active'); $('#editorView').classList.remove('hidden'); }
$('#openManuscriptBtn').onclick = () => {
  persistEditor(); queueSaveFS();
  $('#editorView').classList.add('hidden'); $('#manuscriptView').classList.add('active');
  const eps = orderedEpisodes().filter(e => cleanText(e.body));
  $('#manuscriptTitle').textContent = currentProject().title;
  $('#manuscriptMeta').textContent = `총 ${eps.reduce((s, e) => s + stats(e.body).withSpaces, 0).toLocaleString()}자 · ${eps.length}회차`;
  $('#manuscriptContent').innerHTML = eps.map(e => `<article class="manuscript-ep"><div class="ql-editor">${e.body || ''}</div></article>`).join('');
};
$('#backFromManuscript').onclick = showEditor;
$('#copyManuscriptFull').onclick = () => {
  const mdText = orderedEpisodes().filter(e => cleanText(e.body)).map(e => getMarkdownForEpisode(e)).join('\n\n\n');
  copyText(mdText, '전체 본문을 복사했어요. (마크다운)');
};



// Publish Settings Logic
function getPublishSettings(p) {
  if (!p.publishSettings) {
    const presetObj = POD_PRESETS['purple'] || { margins: { top: 20, bottom: 20, inner: 25, outer: 18, bleed: 3 } };
    return { preset: 'purple', paperSize: 'A5', margins: presetObj.margins, includeCover: true, autoTOC: true, showTitle: false };
  }
  return p.publishSettings;
}

function calculateSpineWidth(p) {
  const estimatedPages = p.podExactPages || podEstimatePages(p);
  return Math.max(1, Math.round(estimatedPages * (8.8 / 96) * 10) / 10);
}

// ============================================================
//  POD Publishing Studio — Phase 1
//  Split View 출판 스튜디오 로직
// ============================================================

// ── 출판사 프리셋 데이터 ──────────────────────────────────────
const POD_PRESETS = {
  purple: {
    name: '교보 퍼플',
    paperSize: 'A5',
    margins: { top: 20, bottom: 20, inner: 25, outer: 18, bleed: 3 }
  },
  bookcube: {
    name: '부크크',
    paperSize: 'A5',
    margins: { top: 20, bottom: 20, inner: 22, outer: 17, bleed: 0 }
  },
  onehyphen: {
    name: '원하이프레스',
    paperSize: 'A5',
    margins: { top: 18, bottom: 18, inner: 23, outer: 16, bleed: 3 }
  }
};



// ── mm → px 변환 (화면 축척 기준) ────────────────────────────
const PREVIEW_SCALE = 1; // 화면 내 1mm = PREVIEW_SCALE px (JS에서 계산)
let podPreviewScale = 1;



// ── 용지 크기 매핑 ────────────────────────────────────────────
const PAPER_SIZES = {
  A5: { w: 148, h: 210 },
  B6: { w: 128, h: 182 }
};

// ── 스튜디오 열기 ─────────────────────────────────────────────
async function showPodStudio() {
  const p = currentProject(); if (!p) return;
  const set = getPublishSettings(p);

  // 브레드크럼
  $('#podStudioBreadcrumb').textContent = p.title;

  // 기존 설정값 반영
  const margins = set.margins || { top: 20, bottom: 20, inner: 25, outer: 18, bleed: 3 };
  $('#podPaperSize').value = set.paperSize || 'A5';
  $('#podMarginTop').value = margins.top;
  $('#podMarginBottom').value = margins.bottom;
  $('#podMarginInner').value = margins.inner;
  $('#podMarginOuter').value = margins.outer;
  $('#podBleed').value = margins.bleed !== undefined ? margins.bleed : 3;
  $('#podFontSize').value = set.fontSize || 10;
  $('#podLineHeight').value = set.lineHeight || '1.75';
  $('#podAutoTOC').checked = set.autoTOC !== false;
  $('#podShowTitle').checked = !!set.showTitle;

  // 전면부 블록 초기화
  initFmBlocks(p);
  renderFmBlockList();

  // 표지 설정
  $('#podCoverBgColor').value = set.coverOptions?.bgColor || '#2c2c2c';
  $('#podCoverBgColorHex').value = set.coverOptions?.bgColor || '#2c2c2c';
  $('#podSpineFont').value = set.coverOptions?.spineFont || "'KoPub Batang', serif";
  const spineW = calculateSpineWidth(p);
  $('#podSpineWidth').value = set.coverOptions?.spineWidthMm || spineW;
  $('#podSpineCalcText').textContent = `(자동 계산: ${spineW}mm)`;
  $('#podPublisherLogo').value = set.coverOptions?.logo || '';
  if ($('#podLogoOptions')) {
    $('#podLogoOptions').style.display = set.coverOptions?.logo ? 'block' : 'none';
    $('#podLogoFrontSize').value = set.coverOptions?.logoFrontSize || 7;
    $('#podLogoFrontBottom').value = set.coverOptions?.logoFrontBottom || 15;
    $('#podLogoSpineRatio').value = set.coverOptions?.logoSpineRatio || 60;
    $('#podLogoSpineBottom').value = set.coverOptions?.logoSpineBottom || 15;
  }

  // 기타 탭 통계 (UI 요소가 삭제되었으므로 접근할 때 null 체크 필수)
  const estPages = p.podExactPages || podEstimatePages(p);
  const podEstPagesEl = $('#podEstPages');
  const podEstSpineEl = $('#podEstSpine');
  if (podEstPagesEl) {
    if (p.podExactPages) {
      podEstPagesEl.innerHTML = `${p.podExactPages} <span style="font-size:10px; color:#5e9c76;">(실제 측정됨)</span>`;
    } else {
      podEstPagesEl.textContent = estPages;
    }
  }
  if (podEstSpineEl) {
    podEstSpineEl.textContent = Math.max(1, Math.round(estPages * (8.8 / 96) * 10) / 10).toFixed(1);
  }

  // 이미지 로드 (표지) - async 로딩 보장
  const loadImg = src => src ? new Promise(res => {
    const img = new Image(); img.onload = () => res(img); img.onerror = () => res(null); img.src = src;
  }) : Promise.resolve(null);

  const coverOptions = set.coverOptions || {};

  [currentFrontCoverObj, currentBackCoverObj] = await Promise.all([
    loadImg(coverOptions.frontOriginal),
    loadImg(coverOptions.backOriginal)
  ]);

  // 화면 전환: manuscriptView를 숨기고 podStudioView를 활성화
  $('#manuscriptView').classList.remove('active');
  $('#editorView').classList.add('hidden');
  $('#podStudioView').classList.add('active');

  // ── 초기 탭: 표지 설정이 기본 활성 ──
  $$('.pod-settings-tab').forEach(b => b.classList.remove('active'));
  $$('.pod-settings-pane').forEach(p => p.classList.remove('active'));
  const coverTab = document.querySelector('.pod-settings-tab[data-pane="cover"]');
  if (coverTab) coverTab.classList.add('active');
  if ($('#podPane-cover')) $('#podPane-cover').classList.add('active');

  // Single Viewer 초기 상태: 표지 미리보기 노출
  if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'none';
  if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'flex';
  if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'none';

  // 표지 미리보기 갱신
  setTimeout(() => { podUpdateCoverPreview(); }, 300);
}

function hidePodStudio() {
  $('#podStudioView').classList.remove('active');
  // 원고 보기로 복귀 (manuscriptView는 editorView와 별도)
  $('#editorView').classList.add('hidden');
  $('#manuscriptView').classList.add('active');
}

function podEstimatePages(p) {
  let total = 0;
  const set = p.publishSettings || {};
  const paperKey = set.paperSize || 'A5';

  // 용지 크기에 따른 한 페이지당 대략적인 글자 수 (여백 포함 보수적 산정)
  let charsPerPage = 500;
  if (paperKey === 'B6') charsPerPage = 400;
  else if (paperKey === '46') charsPerPage = 450;

  const eps = orderedEpisodes(p);
  for (const e of eps) {
    if (!e.body) continue;
    const text = e.body.replace(/<[^>]*>?/gm, '').trim();
    if (text.length === 0 && !e.title) continue; // 내용이 완전히 없는 회차 제외

    let pages = Math.ceil(text.length / charsPerPage);
    if (pages === 0) pages = 1; // 최소 1페이지

    // 장이 시작될 때 우측면(홀수) 시작이므로 평균 1.5쪽 소모, 여유분 1쪽 추가
    total += pages + 1;
  }

  // 앞/뒷부속(속표지, 본표지, 판권지, 목차 등) 대략 8쪽 추가
  return total + 8;
}

// ── 내지 라이브 렌더링(Paged.js) ────────────────────────────
let podLiveRenderTimer = null;
let podLastRenderedTotalPages = 0; // Paged.js 렌더링 후 얻은 실제 페이지 수
let podRenderSessionId = 0; // Race Condition 방지용 렌더 세션 ID

function podScheduleLiveRender() {
  $('#podLiveRenderStatus').textContent = '조판 재계산 중... (여백/폰트 적용 중)';
  if (podLiveRenderTimer) clearTimeout(podLiveRenderTimer);
  podLiveRenderTimer = setTimeout(() => {
    renderLivePodPreview();
  }, 800); // 디바운스 800ms
}

async function renderLivePodPreview(forceMode = null) {
  // PagedJS 코드가 캐싱되어 있지 않다면 메인 스레드에서 먼저 다운로드
  if (!window.POD_PAGEDJS_CODE) {
    try {
      const res = await fetch('https://cdn.jsdelivr.net/npm/pagedjs@0.4.3/dist/paged.polyfill.js');
      if (!res.ok) throw new Error('CDN 응답 실패');
      const text = await res.text();
      if (text.includes('<html') || text.trim() === '') throw new Error('잘못된 응답 (HTML 반환됨)');
      window.POD_PAGEDJS_CODE = text;
    } catch (e) {
      const st = $('#podLiveRenderStatus');
      if (st) st.textContent = '렌더링 에러: PagedJS 스크립트 로드 실패';
      return;
    }
  }

  const p = currentProject();
  if (!p) return;

  const activeTab = document.querySelector('.pod-settings-tab.active');
  const activePane = activeTab ? activeTab.dataset.pane : 'inner';
  const isTreeMode = forceMode === 'tree' || activePane === 'tree';

  const st = $('#podLiveRenderStatus');

  // [요구사항 반영] 내지 설정 탭일 경우 PagedJS를 완전히 배제하고 순수 CSS 2장(Spread) 뷰어를 하드코딩으로 보여줌
  if (activePane === 'inner' || activePane === 'tree') {
    const iframe = document.getElementById('podLiveIframe');
    if (!iframe) return;
    
    const pubSet = getPublishSettings(p);
    const paper = PAPER_SIZES[$('#podPaperSize') ? $('#podPaperSize').value : (pubSet.paperSize || 'A5')] || PAPER_SIZES.A5;
    
    // 실시간 입력을 위해 DOM에서 직접 값을 읽어옴 (없으면 pubSet 사용)
    const m = {
      top: parseFloat($('#podMarginTop')?.value) || pubSet.margins?.top || 20,
      bottom: parseFloat($('#podMarginBottom')?.value) || pubSet.margins?.bottom || 20,
      inner: parseFloat($('#podMarginInner')?.value) || pubSet.margins?.inner || 25,
      outer: parseFloat($('#podMarginOuter')?.value) || pubSet.margins?.outer || 18,
      bleed: parseFloat($('#podBleed')?.value) || pubSet.margins?.bleed || 3
    };
    const b = m.bleed;
    
    const canvasEl = $('#podPreviewInner');
    const cW = canvasEl ? canvasEl.clientWidth : window.innerWidth;
    const cH = canvasEl ? canvasEl.clientHeight : window.innerHeight;
    
    const tw = (paper.w * 2); 
    const sc = Math.max(0.2, Math.min(1, (cW - 40) / (tw * (96 / 25.4)), (cH - 40) / (paper.h * (96 / 25.4))));

    iframe.style.width = tw + 'mm';
    iframe.style.height = paper.h + 'mm';
    iframe.style.transform = `scale(${sc})`;
    iframe.style.transformOrigin = 'top center';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';

    const showGuides = $('#podShowGuides') && $('#podShowGuides').checked;

    const dummyText = activePane === 'tree' ? '' : `
      <p style="text-indent:10pt; margin-bottom:12px;">이 화면은 출판될 책의 실제 여백과 재단선을 확인하기 위한 <strong>순수 CSS 미리보기 화면</strong>입니다.</p>
      <p style="text-indent:10pt; margin-bottom:12px;">좌측과 우측 페이지가 실제 책을 펼쳤을 때와 동일하게 일렬로 배치되어 있습니다. 빨간 점선은 인쇄소에서 잘려나가는 <strong>재단선(Bleed)</strong>을 의미하며, 파란 실선은 텍스트가 안전하게 배치되어야 하는 <strong>안전영역(여백)</strong>을 의미합니다.</p>
      <p style="text-indent:10pt; margin-bottom:12px;">좌측 메뉴에서 상단, 하단, 내측, 외측 여백을 조절하면 실시간으로 가이드라인이 움직입니다. 완벽한 레이아웃을 위해 여백을 세밀하게 조정해 보세요.</p>
    `;

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; height: 100%; display: flex; font-family:'KoPub Batang','Noto Serif KR',serif; font-size:${parseFloat($('#podFontSize')?.value) || pubSet.fontSize || 10}pt; line-height:${$('#podLineHeight')?.value || pubSet.lineHeight || 1.75}; color:#111; word-break:keep-all; }
  .page {
    width: ${paper.w}mm;
    height: ${paper.h}mm;
    background: #fff;
    box-sizing: border-box;
    position: relative;
    box-shadow: 0 4px 16px rgba(0,0,0,.12);
    text-align: left; /* 좌측 정렬 요구사항 */
    overflow: hidden; /* 강제로 스크롤 방지 */
  }
  .page-left { padding: ${m.top}mm ${m.inner}mm ${m.bottom}mm ${m.outer}mm; }
  .page-right { padding: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm; }
  
  .page-left::after { content:""; position:absolute; top:0; right:0; bottom:0; width:20px; background:linear-gradient(to left,rgba(0,0,0,.06),transparent); pointer-events:none; z-index:10; }
  .page-right::after { content:""; position:absolute; top:0; left:0; bottom:0; width:20px; background:linear-gradient(to right,rgba(0,0,0,.06),transparent); pointer-events:none; z-index:10; }
  
  /* 가이드라인 (ShowGuides가 켜져있을 때만) */
  ${showGuides ? `
  /* 재단선(Bleed): 종이 끝에서 bleed 만큼 들어간 위치 */
  .page-left .bleed-guide { position:absolute; top:${b}mm; bottom:${b}mm; left:${b}mm; right:0; border:1px dashed red; pointer-events:none; z-index:99; }
  .page-right .bleed-guide { position:absolute; top:${b}mm; bottom:${b}mm; left:0; right:${b}mm; border:1px dashed red; pointer-events:none; z-index:99; }
  
  /* 안전영역(Margin) */
  .page-left .safe-guide { position:absolute; top:${m.top}mm; bottom:${m.bottom}mm; left:${m.outer}mm; right:${m.inner}mm; border:1px solid rgba(0,0,255,0.3); pointer-events:none; z-index:99; }
  .page-right .safe-guide { position:absolute; top:${m.top}mm; bottom:${m.bottom}mm; left:${m.inner}mm; right:${m.outer}mm; border:1px solid rgba(0,0,255,0.3); pointer-events:none; z-index:99; }
  ` : ''}
  /* 원고 본문 서식 적용 */
  .page-left > div > div:nth-child(2) p, .page-right > div > div:nth-child(2) p, .ql-editor p {
    text-indent: ${pubSet.paragraphIndent ? pubSet.paragraphIndent + 'em' : '0'};
    margin-bottom: ${pubSet.paragraphSpacing ? pubSet.paragraphSpacing + 'em' : '0'};
    text-align: ${pubSet.align || 'justify'};
    word-break: break-all;
    overflow-wrap: break-word;
  }
</style>
</head>
<body>
  <div class="page page-left">
    ${showGuides ? '<div class="bleed-guide"></div><div class="safe-guide"></div>' : ''}
    <div style="position:relative; z-index:1; height:100%; overflow-y:auto; overflow-x:hidden; padding-bottom:20px;">
      <h2 style="margin-top:0; margin-bottom:30px;">왼쪽 페이지 (짝수 쪽)</h2>
      <div style="opacity:0.8;">${dummyText}</div>
    </div>
    <div style="position:absolute; bottom:${m.bottom/2}mm; left:0; right:0; text-align:center; font-size:9pt; color:#666;">10</div>
  </div>
  <div class="page page-right">
    ${showGuides ? '<div class="bleed-guide"></div><div class="safe-guide"></div>' : ''}
    <div style="position:relative; z-index:1; height:100%; overflow-y:auto; overflow-x:hidden; padding-bottom:20px;">
      <h2 style="margin-top:0; margin-bottom:30px;">오른쪽 페이지 (홀수 쪽)</h2>
      <div style="opacity:0.8;">${dummyText}</div>
    </div>
    <div style="position:absolute; bottom:${m.bottom/2}mm; left:0; right:0; text-align:center; font-size:9pt; color:#666;">11</div>
  </div>
</body>
</html>`;

    iframe.removeAttribute('srcdoc');
    iframe.srcdoc = html;
    
    if (st) {
      st.style.display = 'block';
      st.textContent = `렌더링 완료 ✓ (내지 여백 확인 모드)`;
    }
    
    if (activePane === 'tree') {
      runHiddenPagedJsForTree(p);
    }
    return;
  }

  // [새로운 요구사항 반영] 전면부 디자인 탭일 경우 현재 선택된 템플릿 1장만 단면(Single)으로 하드코딩 렌더링
  if (activePane === 'fm') {
    const iframe = document.getElementById('podLiveIframe');
    if (!iframe) return;
    
    const pubSet = getPublishSettings(p);
    const paper = PAPER_SIZES[$('#podPaperSize') ? $('#podPaperSize').value : (pubSet.paperSize || 'A5')] || PAPER_SIZES.A5;
    
    // 실시간 여백
    const m = {
      top: parseFloat($('#podMarginTop')?.value) || pubSet.margins?.top || 20,
      bottom: parseFloat($('#podMarginBottom')?.value) || pubSet.margins?.bottom || 20,
      inner: parseFloat($('#podMarginInner')?.value) || pubSet.margins?.inner || 25,
      outer: parseFloat($('#podMarginOuter')?.value) || pubSet.margins?.outer || 18,
      bleed: parseFloat($('#podBleed')?.value) || pubSet.margins?.bleed || 3
    };

    // 현재 선택된 active 블록 찾기
    const fmBlocksForRender = window.fmBlocks || pubSet.fmBlocks || [];
    let blockIdx = typeof fmActiveBlockIdx !== 'undefined' ? fmActiveBlockIdx : null;
    let block = fmBlocksForRender[blockIdx];
    if (!block) {
      block = fmBlocksForRender.find(b => b.active);
      blockIdx = fmBlocksForRender.indexOf(block);
    }
    
    let blockHtml = '';
    if (block) {
      // 기존 generatePODBodyContent 로직을 이용하여 이 블록 1개의 HTML 생성
      const tempPubSet = JSON.parse(JSON.stringify(pubSet));
      tempPubSet.fmBlocks = [block];
      // 목차를 위해 loadedEps는 전체로 넘김
      const loadedEpsForToc = orderedEpisodes(p).filter(e => cleanText(e.body));
      blockHtml = generatePODBodyContent(p, tempPubSet, loadedEpsForToc, 'fm'); 
    } else {
      blockHtml = '<div style="display:flex; height:100%; align-items:center; justify-content:center; color:#999;">활성화된 전면부 템플릿이 없습니다.</div>';
    }
    
    // 단면 보기이므로 폭은 paper.w 1장 크기
    const canvasEl = $('#podPreviewInner');
    const cW = canvasEl ? canvasEl.clientWidth : window.innerWidth;
    const cH = canvasEl ? canvasEl.clientHeight : window.innerHeight;
    const sc = Math.max(0.2, Math.min(1, (cW - 40) / (paper.w * (96 / 25.4)), (cH - 40) / (paper.h * (96 / 25.4))));

    iframe.style.width = paper.w + 'mm';
    iframe.style.height = paper.h + 'mm';
    iframe.style.transform = `scale(${sc})`;
    iframe.style.transformOrigin = 'top center';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';

    const showGuides = $('#fmShowGuides') ? $('#fmShowGuides').checked : false;
    let gH = '';
    if (showGuides) {
      gH = `
      <!-- 가이드라인 (전면부 단면, 우측 페이지 기준) -->
      <div style="position:absolute; inset:0; pointer-events:none; z-index:9999;">
        <!-- 재단선 (빨간 점선, 우측 페이지이므로 왼쪽 제본면은 0) -->
        <div style="position:absolute; left:0; right:${m.bleed}mm; top:${m.bleed}mm; bottom:${m.bleed}mm; border:1px dashed red;"></div>
        <!-- 안전영역 (파란 실선, 우측 페이지이므로 왼쪽이 inner, 오른쪽이 outer) -->
        <div style="position:absolute; left:${m.inner}mm; right:${m.outer}mm; top:${m.top}mm; bottom:${m.bottom}mm; border:1px solid rgba(0,0,255,0.3);"></div>
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; padding: 0; background: transparent; height: 100%; display: flex; justify-content:center; align-items:center; }
  .page {
    width: ${paper.w}mm;
    height: ${paper.h}mm;
    background: #fff;
    box-sizing: border-box;
    position: relative;
    box-shadow: 0 4px 16px rgba(0,0,0,.12);
    /* 단면일 땐 우측 페이지(홀수쪽) 기준으로 여백 설정: top, outer(right), bottom, inner(left) */
    padding: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
    overflow: hidden;
  }
  .page::after { content:""; position:absolute; top:0; left:0; bottom:0; width:20px; background:linear-gradient(to right,rgba(0,0,0,.06),transparent); pointer-events:none; z-index:10; }
  
  /* 생성된 HTML 기본 스타일 대응 */
  .chapter { height: 100%; width: 100%; position: relative; }
  ul.toc-list { list-style:none; padding:0; margin:0; }
  ul.toc-list li { display:flex; margin-bottom:12px; font-size:10pt; line-height:1.5; }
  .toc-title { background:#fff; padding-right:8px; z-index:1; }
  .toc-dots { flex:1; border-bottom:1px dotted #ccc; margin:0 4px; position:relative; top:-6px; }
  .toc-page-ref { background:#fff; padding-left:8px; z-index:1; }
  .toc-page-ref::after { content:""; }
</style>
</head>
<body>
  <div class="page">
    ${gH}
    ${blockHtml}
  </div>
</body>
</html>`;

    iframe.removeAttribute('srcdoc');
    iframe.srcdoc = html;
    
    if (st) {
      st.style.display = 'block';
      st.textContent = `렌더링 완료 ✓ (전면부 단면 미리보기)`;
    }
    return;
  }

  if (p.episodes.some(e => e.body === undefined)) {
    if (st) st.textContent = '내용 데이터를 불러오는 중...';
    await ensureProjectBodiesLoaded(p);
  }
  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (loadedEps.length === 0) {
    if (st) st.textContent = '출판할 본문 내용이 없습니다.';
    return;
  }

  if (st) st.textContent = '스크립트 초기화 중... (Paged.js)';

  const iframe = document.getElementById('podLiveIframe');
  if (!iframe) return;
  const pubSet = getPublishSettings(p);
  const paper = PAPER_SIZES[pubSet.paperSize || 'A5'] || PAPER_SIZES.A5;
  const canvasEl = $('#podPreviewInner');
  const cW = canvasEl ? canvasEl.clientWidth : window.innerWidth;
  const cH = canvasEl ? canvasEl.clientHeight : window.innerHeight;

  const m = {
    top: parseFloat($('#podMarginTop')?.value) || pubSet.margins?.top || 20,
    bottom: parseFloat($('#podMarginBottom')?.value) || pubSet.margins?.bottom || 20,
    inner: parseFloat($('#podMarginInner')?.value) || pubSet.margins?.inner || 25,
    outer: parseFloat($('#podMarginOuter')?.value) || pubSet.margins?.outer || 18,
    bleed: parseFloat($('#podBleed')?.value) || pubSet.margins?.bleed || 3
  };
  const b = m.bleed;

  // 1. [레이아웃 버그 해결] 가로 폭(tw)에 5mm 안전 버퍼를 주어 구겨짐 방지
  const isSpreadMode = (activePane === 'inner' || activePane === 'tree');
  const tw = (isSpreadMode ? paper.w * 2 : paper.w) + 5;
  const sc = Math.max(0.2, Math.min(1, (cW - 40) / (tw * (96 / 25.4)), (cH - 40) / (paper.h * (96 / 25.4))));

  iframe.style.width = tw + 'mm';
  iframe.style.height = paper.h + 'mm';
  iframe.style.transform = `scale(${sc})`;
  iframe.style.transformOrigin = 'top center';
  iframe.style.border = 'none';
  iframe.style.background = 'transparent';

  const eps2Render = isTreeMode ? loadedEps : [loadedEps[0]];
  let bodyHTML = generatePODBodyContent(p, pubSet, eps2Render);

  // [중요] 완벽한 DOM 정제로 크래시 원천 차단
  const parser = new DOMParser();
  const doc = parser.parseFromString(bodyHTML, 'text/html');
  const removeComments = (node) => {
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      if (node.childNodes[i].nodeType === 8) node.childNodes[i].remove();
      else if (node.childNodes[i].nodeType === 1) removeComments(node.childNodes[i]);
    }
  };
  removeComments(doc.body);
  removeComments(doc.body);
  bodyHTML = doc.body.innerHTML;

  const mainStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');

  const pageCSS = `@page {
    size: ${pubSet.paperSize || 'A5'};
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
    @bottom-center { content: counter(page); font-size:9pt; font-family:'KoPub Batang','Noto Serif KR',serif; }
  }
  @page:left  { margin: ${m.top}mm ${m.inner}mm ${m.bottom}mm ${m.outer}mm; }
  @page:right { margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm; }
  @page:first { @bottom-center { content:none; } }
  @page cover { margin:0; @bottom-center { content:none; } }`;

  const bodyCSS = `body {
    font-family:'KoPub Batang','Noto Serif KR',serif;
    font-size:${parseFloat($('#podFontSize')?.value) || pubSet.fontSize || 10}pt;
    line-height:${$('#podLineHeight')?.value || pubSet.lineHeight || 1.75};
    color:#111; text-align:justify; word-break:keep-all;
  }
  .ql-align-center { text-align:center !important; }
  .ql-align-right  { text-align:right  !important; }
  .chapter { break-before:page; margin-top:40px; }
  .chapter.matter-page { break-before:right; }
  .chapter-title { font-size:14pt; font-weight:700; margin-bottom:30px; text-align:center; }
  .chapter-content span { background-color:transparent !important; }
  .chapter-content p { text-indent:10pt !important; margin:0 !important; }
  .ql-editor { padding:0 !important; overflow-y:visible !important; height:auto !important; }
  img { max-width: 100% !important; width: 100% !important; height: auto !important; object-fit: contain; display: block; margin: 10px auto; }`;

  const currentRenderSessionId = ++podRenderSessionId;
  window.podPendingRenderHTML = bodyHTML;
  window.podPendingRenderIsTreeMode = isTreeMode;
  window.podPendingRenderId = currentRenderSessionId;

  const headScripts = `<script>window.PagedConfig = { auto: false };<\/script>
<script>${window.POD_PAGEDJS_CODE}<\/script>
<script>window.parent.postMessage({ type: 'PAGEDJS_READY', renderId: ${currentRenderSessionId} }, '*');<\/script>
<style>
  html,body { margin:0; padding:0; background:transparent !important; }
  .pagedjs_pages { position:relative; display:flex; flex-wrap:wrap; }
  .pagedjs_page  { margin:0 !important; box-shadow:0 4px 16px rgba(0,0,0,.12) !important; flex:0 0 auto; background:#fff; position: relative; }
  .pagedjs_left_page::after  { content:""; position:absolute; top:0; right:0; bottom:0; width:20px; background:linear-gradient(to left,rgba(0,0,0,.06),transparent); pointer-events:none; z-index:10; }
  .pagedjs_right_page::after { content:""; position:absolute; top:0; left:0; bottom:0; width:20px; background:linear-gradient(to right,rgba(0,0,0,.06),transparent); pointer-events:none; z-index:10; }
</style>
<style data-pagedjs-ignore="true">
  /* 재단선(Bleed) 가이드라인 - sheet에 after 적용 */
  body.show-guides .pagedjs_left_page .pagedjs_sheet::after {
    content:""; position:absolute; top:${b}mm; bottom:${b}mm; left:${b}mm; right:0; border:1px dashed red; pointer-events:none; z-index:99;
  }
  body.show-guides .pagedjs_right_page .pagedjs_sheet::after {
    content:""; position:absolute; top:${b}mm; bottom:${b}mm; left:0; right:${b}mm; border:1px dashed red; pointer-events:none; z-index:99;
  }

  /* 안전영역(Margin) 가이드라인 - page에 before 적용 (after는 섀도우가 사용중) */
  body.show-guides .pagedjs_left_page::before {
    content:""; position:absolute; top:${m.top}mm; bottom:${m.bottom}mm; left:${m.outer}mm; right:${m.inner}mm; border:1px solid rgba(0,0,255,0.3); pointer-events:none; z-index:99;
  }
  body.show-guides .pagedjs_right_page::before {
    content:""; position:absolute; top:${m.top}mm; bottom:${m.bottom}mm; left:${m.inner}mm; right:${m.outer}mm; border:1px solid rgba(0,0,255,0.3); pointer-events:none; z-index:99;
  }
<\/style>
<script>
var _pagedHandlerRegistered = false;
window.addEventListener('message', function(ev) {
  if (!ev.data) return;

  if (ev.data.type === 'START_RENDER') {
    if (typeof Paged === 'undefined') {
      window.parent.postMessage({ type:'pagedjs-error', error:'Paged 객체가 존재하지 않습니다.' }, '*');
      return;
    }
    
    var TREE = ev.data.isTreeMode;
    var htmlContent = ev.data.html;
    var rid = ev.data.renderId;

    if (!_pagedHandlerRegistered) {
      _pagedHandlerRegistered = true;
      Paged.registerHandlers(class extends Paged.Handler {
        afterRendered(pages) {
          try {
            var map = pages.map(function(pg) {
              var el  = pg.element || pg.pageNode || pg.wrapper;
              var num = el ? (parseInt(el.getAttribute('data-page-number'), 10) || 0) : 0;
              var fm  = el && el.querySelector('[data-fm-label]');
              var ch  = el && el.querySelector('.chapter-title,.chapter-content h1');
              return {
                pageNum: num,
                label: fm ? fm.getAttribute('data-fm-label') : (ch ? ch.textContent.trim().substring(0,14) : num+'쪽'),
                epTitle: ch ? ch.textContent.trim() : ''
              };
            });
            
            if (pages[0] && pages[0].wrapper) pages[0].wrapper.style.display = 'block';
            if (pages[1] && pages[1].wrapper) pages[1].wrapper.style.display = 'block';

            window.parent.postMessage({ type:'pagedjs-rendered', totalPages:pages.length, pageMap:map, isTreeMode:TREE, renderId:rid }, '*');
          } catch(err) {
            window.parent.postMessage({ type:'pagedjs-error', error:'afterRendered:'+err.message }, '*');
          }
        }
      });
    }

    var wrap = document.createElement('div');
    wrap.innerHTML = htmlContent;
    // [크래시 해결의 핵심] 반드시 DOM에 먼저 붙이고 렌더링해야 엔진이 안 뻗습니다!
    document.body.appendChild(wrap); 

    PagedPolyfill.preview(wrap, [], document.body).catch(function(err) {
      window.parent.postMessage({ type:'pagedjs-error', error:err.message }, '*');
    });
  }

  if (ev.data.type === 'SHOW_PAGES') {
    var tgt  = parseInt(ev.data.pageNum, 10);
    var mode = ev.data.mode;
    var all  = Array.from(document.querySelectorAll('.pagedjs_page'));
    all.forEach(function(el) { el.style.display = 'none'; });
    if (mode === 'single') {
      all.forEach(function(el) {
        var n = parseInt(el.getAttribute('data-page-number'), 10);
        if (n === tgt) el.style.display = 'block';
      });
    } else {
      var lp = tgt%2===0 ? tgt : tgt-1, rp = lp+1;
      all.forEach(function(el) {
        var n = parseInt(el.getAttribute('data-page-number'), 10);
        if (n === lp || n === rp) el.style.display = 'block';
      });
    }
  }

  if (ev.data.type === 'TOGGLE_GUIDES') {
    if (ev.data.show) {
      document.body.classList.add('show-guides');
    } else {
      document.body.classList.remove('show-guides');
    }
  }
});
<\/script>`;

  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
${headScripts}
<style>
${mainStyles}
${pageCSS}
${bodyCSS}
</style>
</head>
<body>
</body>
</html>`;

  iframe.removeAttribute('srcdoc');
  await new Promise(r => setTimeout(r, 10));
  iframe.srcdoc = html;
}

// ── iframe 통신 메시지 수신 ─────────────
window.addEventListener('message', (e) => {
  if (!e.data) return;

  if (e.data.type === 'PAGEDJS_READY') {
    const st = $('#podLiveRenderStatus');
    if (st) st.textContent = window.podPendingRenderIsTreeMode ? '전체 조판 렌더링 중... (Paged.js)' : '미리보기 렌더링 중...';

    const iframe = document.getElementById('podLiveIframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({
        type: 'START_RENDER',
        html: window.podPendingRenderHTML || '',
        isTreeMode: window.podPendingRenderIsTreeMode || false
      }, '*');
    }
  }

  if (e.data.type === 'pagedjs-rendered') {
    const iframe = document.getElementById('podLiveIframe');
    if (iframe) {
      window.podLastRenderedTotalPages = e.data.totalPages;
      window.podPageMap = e.data.pageMap;
      
      // 조판 완료 후 트리 그리기 호출
      if (typeof renderPodPageTree === 'function') renderPodPageTree();

      const pubSet = getPublishSettings(currentProject());
      const paper = PAPER_SIZES[pubSet.paperSize || 'A5'] || PAPER_SIZES.A5;
      
      const activeTab = document.querySelector('.pod-settings-tab.active');
      const tabId = activeTab ? activeTab.dataset.pane : 'tree';

      let mode = (tabId === 'inner') ? 'spread' : 'single';
      let pageNum = (tabId === 'inner') ? 2 : 1;

      if (tabId === 'fm') {
        // 전면부 디자인: 저장/렌더링 직후 현재 편집 중인 페이지만 단면(single) 노출
        const block = window.fmBlocks && fmActiveBlockIdx !== null ? window.fmBlocks[fmActiveBlockIdx] : null;
        if (block && window.podPageMap) {
          const FM_LABELS = { half_title: '속표지', title_page: '본표지', copyright: '판권지', toc: '목차', dedication: '헌정', epigraph: '제사', blank: '여백' };
          const label = FM_LABELS[block.type] || block.type;
          const pm = window.podPageMap.find(m => m.label === label || (m.label && m.label.includes(label)));
          if (pm) pageNum = pm.pageNum;
        }
      }

      const tw = mode === 'spread' ? paper.w * 2 : paper.w;
      const canvasEl = $('#podPreviewInner');
      const cW = canvasEl ? canvasEl.clientWidth : window.innerWidth;
      const cH = canvasEl ? canvasEl.clientHeight : window.innerHeight;
      const sc = Math.max(0.2, Math.min(1, (cW - 40) / (tw * (96 / 25.4)), (cH - 40) / (paper.h * (96 / 25.4))));

      iframe.style.width = tw + 'mm';
      iframe.style.height = paper.h + 'mm';
      iframe.style.transform = `scale(${sc})`;

      iframe.contentWindow?.postMessage({ type: 'SHOW_PAGES', pageNum: pageNum, mode: mode }, '*');
      
      const showGuides = (tabId === 'inner' || tabId === 'tree') && $('#podShowGuides') && $('#podShowGuides').checked;
      iframe.contentWindow?.postMessage({ type: 'TOGGLE_GUIDES', show: showGuides }, '*');
    }
    const st = $('#podLiveRenderStatus');
    if (st) {
      st.style.display = 'block';
      st.textContent = `렌더링 완료 ✓ (${e.data.totalPages}쪽)`;
    }
  }

  if (e.data.type === 'pagedjs-error') {
    const st = $('#podLiveRenderStatus');
    if (st) st.textContent = `렌더링 에러: ${e.data.error}`;
  }
});
function updateSpineThickness(totalPages) {
  const paperType = $('#podPaperType')?.value || 'standard';
  // 종이 종류별 1장(2쪽)당 두께 대략 추정 (단위: mm)
  // 미색 모조 80g: 약 0.1mm, 100g: 약 0.12mm 등
  const mmPerPage = (paperType === 'premium') ? 0.06 : 0.05;
  const spineMm = Math.max(1, Math.round(totalPages * mmPerPage * 10) / 10);

  // 설정 패널 및 썸네일에 노출
  const label = $('#podSpineThicknessLabel');
  if (label) label.textContent = `예상 책등 두께: 약 ${spineMm}mm`;

  // 기타 탭의 계산기 UI에도 노출
  const estPages = $('#podEstPages');
  const estSpine = $('#podEstSpine');
  if (estPages) estPages.textContent = totalPages;
  if (estSpine) estSpine.textContent = spineMm;
}

// ── 표지 미리보기 업데이트 ────────────────────────────────────
async function podUpdateCoverPreview() {
  const p = currentProject(); if (!p) return;
  const set = getPublishSettings(p);

  // 설정 패널의 최신 값 임시 반영
  const tmpSet = {
    ...set,
    paperSize: $('#podPaperSize').value || set.paperSize,
    coverOptions: {
      ...(set.coverOptions || {}),
      bgColor: $('#podCoverBgColor').value,
      logo: $('#podPublisherLogo').value,
      spineFont: $('#podSpineFont').value,
      spineWidthMm: parseFloat($('#podSpineWidth').value) || calculateSpineWidth(p),
      logoFrontSize: parseFloat($('#podLogoFrontSize').value) || 7,
      logoFrontBottom: parseFloat($('#podLogoFrontBottom').value) || 15,
      logoSpineRatio: parseFloat($('#podLogoSpineRatio').value) || 60,
      logoSpineBottom: parseFloat($('#podLogoSpineBottom').value) || 15
    },
    frontMatter: {
      ...(set.frontMatter || {}),
      order: window.fmOrder || [
        { id: 'half_title', name: '속표지 (책 제목)', active: true },
        { id: 'title_page', name: '본표지 (제목, 저자, 출판사)', active: true },
        { id: 'copyright', name: '판권지', active: true },
        { id: 'toc', name: '목차', active: true }
      ],
      author: window.fmBlocks?.find(x => x.type === 'copyright')?.content?.author || set.frontMatter?.author || ''
    }
  };

  try {
    const dataUrl = await generateCoverPreview(p, tmpSet);
    if (!dataUrl) return;
    const imgEl = $('#podCoverPreviewImage');
    if (imgEl) {
      imgEl.src = dataUrl;
      imgEl.style.display = 'inline-block';
    }
  } catch (e) {
    console.warn('Cover preview update failed', e);
  }
}

// ── 설정 저장 ─────────────────────────────────────────────────
function podSaveSettings() {
  const p = currentProject(); if (!p) return;

  const compress = (img) => {
    if (!img) return null;
    const cvs = document.createElement('canvas');
    let w = img.width, h = img.height;
    if (w > 1200 || h > 1200) {
      if (w > h) { h *= 1200 / w; w = 1200; }
      else { w *= 1200 / h; h = 1200; }
    }
    cvs.width = w; cvs.height = h;
    cvs.getContext('2d').drawImage(img, 0, 0, w, h);
    return cvs.toDataURL('image/webp', 0.8);
  };

  const activePresetBtn = document.querySelector('.pod-preset-btn.active');
  const presetKey = activePresetBtn ? activePresetBtn.dataset.preset : '';

  p.publishSettings = {
    preset: presetKey,
    paperSize: $('#podPaperSize').value,
    autoTOC: $('#podAutoTOC').checked,
    showTitle: $('#podShowTitle').checked,
    fontSize: parseFloat($('#podFontSize').value) || 10,
    lineHeight: $('#podLineHeight').value,
    margins: {
      top: parseFloat($('#podMarginTop').value) || 20,
      bottom: parseFloat($('#podMarginBottom').value) || 20,
      inner: parseFloat($('#podMarginInner').value) || 25,
      outer: parseFloat($('#podMarginOuter').value) || 18,
      bleed: parseFloat($('#podBleed').value) || 3
    },
    coverOptions: {
      frontOriginal: compress(currentFrontCoverObj) || p.publishSettings?.coverOptions?.frontOriginal || null,
      backOriginal: compress(currentBackCoverObj) || p.publishSettings?.coverOptions?.backOriginal || null,
      bgColor: $('#podCoverBgColor').value,
      logo: $('#podPublisherLogo').value,
      spineFont: $('#podSpineFont').value,
      spineWidthMm: parseFloat($('#podSpineWidth').value) || calculateSpineWidth(p),
      logoFrontSize: parseFloat($('#podLogoFrontSize').value) || 7,
      logoFrontBottom: parseFloat($('#podLogoFrontBottom').value) || 15,
      logoSpineRatio: parseFloat($('#podLogoSpineRatio').value) || 60,
      logoSpineBottom: parseFloat($('#podLogoSpineBottom').value) || 15
    },
    frontMatter: {
      showCopyright: window.fmBlocks ? !!window.fmBlocks.find(x => x.type === 'copyright' && x.active) : false,
      author: window.fmBlocks?.find(x => x.type === 'copyright')?.content?.author || '',
      publishDate: window.fmBlocks?.find(x => x.type === 'copyright')?.content?.date || '',
      fmTitle: window.fmBlocks?.find(x => x.type === 'half_title' || x.type === 'title_page')?.content?.title || '',
      fmSubtitle: window.fmBlocks?.find(x => x.type === 'title_page')?.content?.subtitle || '',
      fmPublisher: window.fmBlocks?.find(x => x.type === 'title_page' || x.type === 'copyright')?.content?.publisher || '',
      fmBgColor: '#ffffff'
    },
    fmBlocks: window.fmBlocks || []
  };

  // 기존 modal inputs과 동기화 (exportPODPdf가 그쪽을 읽으므로)
  syncLegacyInputs(p.publishSettings);

  try {
    localStorage.setItem('novel_pubset_' + p.id, JSON.stringify(p.publishSettings));
  } catch (e) { console.warn('pubset save failed', e); }

  touchProject(); queueSaveFS();

  const saveBtn = $('#podSaveSettingsBtn');
  if (saveBtn) {
    const orig = saveBtn.innerHTML;
    saveBtn.innerHTML = '✔ 저장되었습니다';
    setTimeout(() => { saveBtn.innerHTML = orig; }, 1500);
  }
  showToast('✅ 설정이 저장되었습니다.');
}

// 구형 modal 입력에 값 동기화 (exportPODPdf가 pubPaperSize 등을 읽기 때문)
function syncLegacyInputs(s) {
  const trySet = (id, val) => { const el = $(id); if (el) el.value = val; };
  const tryCheck = (id, val) => { const el = $(id); if (el) el.checked = val; };
  trySet('#pubPaperSize', s.paperSize);
  tryCheck('#pubAutoTOC', s.autoTOC);
  tryCheck('#pubShowTitle', s.showTitle);
  trySet('#pubCoverBgColor', s.coverOptions?.bgColor || '#2c2c2c');
  trySet('#pubPublisherLogo', s.coverOptions?.logo || '');
  trySet('#pubSpineFont', s.coverOptions?.spineFont || "'KoPub Batang', serif");
  trySet('#pubSpineWidth', s.coverOptions?.spineWidthMm || '');
  tryCheck('#pubShowCopyright', s.frontMatter?.showCopyright || false);
  trySet('#pubAuthor', s.frontMatter?.author || '');
  trySet('#pubPublishDate', s.frontMatter?.publishDate || '');
}

// ── 이벤트 바인딩 ─────────────────────────────────────────────

// 스튜디오 열기/닫기
if ($('#openPublishSettingsFromEditorBtn')) $('#openPublishSettingsFromEditorBtn').onclick = () => { persistEditor(); queueSaveFS(); showPodStudio(); };
$('#backFromPodStudio').onclick = hidePodStudio;

// 스튜디오 내 내보내기 버튼
// 내지 전용 PDF: 2번째 인자 true → 표지 배제
$('#podExportPdfBtn').onclick = () => { podSaveSettings(); exportPODPdf(false, true); };
$('#podExportCoverBtn').onclick = () => { podSaveSettings(); exportPODCover(); };

// 저장 버튼
$('#podSaveSettingsBtn').onclick = podSaveSettings;

// 설정 탭 전환 (Single Live Viewer 라우팅)
$$('.pod-settings-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.pod-settings-tab').forEach(b => b.classList.remove('active'));
    $$('.pod-settings-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.pane;

    const pane = $('#podPane-' + tab);
    if (pane) {
      pane.classList.add('active');
      
      // 첫 진입 시 자동 클릭 처리
      if (!pane.dataset.initialized) {
        pane.dataset.initialized = 'true';
        if (tab === 'inner') {
          const kyoboBtn = document.querySelector('.pod-preset-btn[data-preset="kyobo"]');
          if (kyoboBtn) kyoboBtn.click();
        } else if (tab === 'fm') {
          const firstBlock = document.querySelector('#podFmBlockList .fm-block-item');
          if (firstBlock) firstBlock.click();
        }
      }
    }

    if (tab === 'cover') {
      // 표지: 표지 Canvas 노출, Iframe 숨김
      if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'none';
      if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'flex';
      if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'none';
      podUpdateCoverPreview();
    } else {
      // 내지, 전면부, 페이지 구조: Iframe 노출 및 즉시 렌더링
      if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'flex';
      if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'none';
      if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'flex';

      // 탭마다 렌더링 컨텐츠가 다르므로 무조건 렌더링을 다시 돌려줌
      renderLivePodPreview();
    }
  });
});

if ($('#podShowGuides')) {
  $('#podShowGuides').addEventListener('change', (e) => {
    const activeTab = document.querySelector('.pod-settings-tab.active');
    if (activeTab && activeTab.dataset.pane !== 'inner') return; // 내지 탭에서만 토글 허용

    const iframe = document.getElementById('podLiveIframe');
    if (iframe && iframe.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'TOGGLE_GUIDES', show: e.target.checked }, '*');
    }
  });
}

if ($('#fmShowGuides')) {
  $('#fmShowGuides').addEventListener('change', () => {
    const activeTab = document.querySelector('.pod-settings-tab.active');
    if (activeTab && activeTab.dataset.pane === 'fm') {
      renderLivePodPreview();
    }
  });
}

function getSingleFmBlockHtml(block, p, pubSet, afterTocEps, centerOffsetFm) {
  const FM_LABELS = { half_title: '속표지', title_page: '본표지', copyright: '판권지', toc: '목차', dedication: '헌정', epigraph: '제사', blank: '여백' };
  const s = block.style || {};
  const c = block.content || {};
  const type = block.type;

  const pTitle = escapeHtml(c.title || p.title || '');
  const pSub = escapeHtml(c.subtitle || '');
  const pAuth = escapeHtml(c.author || pubSet.frontMatter?.author || '저자');
  const pDate = escapeHtml(c.date || pubSet.frontMatter?.publishDate || new Date().getFullYear() + '년');
  const presetObj = POD_PRESETS[pubSet.preset] || {};
  const pPub = escapeHtml(c.publisher || pubSet.frontMatter?.fmPublisher || presetObj.name || '');
  const pCustom = escapeHtml(c.customText || '').replace(/\n/g, '<br>');
  const pQuote = escapeHtml(c.quoteAuthor || '');

  const bgColor = s.bgColor || '#ffffff';
  const bgIsColored = bgColor.toLowerCase() !== '#ffffff';
  const bgPrintCss = bgIsColored ? `-webkit-print-color-adjust:exact;print-color-adjust:exact;background-color:${bgColor} !important;` : '';

  const fontCss = `font-family:${s.fontFamily || "'KoPub Batang',serif"};color:${s.fontColor || '#1C1813'};letter-spacing:${s.letterSpacing || '0em'};`;
  const titleSz = `font-size:${s.fontSize || 20}pt;`;
  const jc = s.alignY || 'center';
  const ai = s.alignX || 'center';
  const offsetStyle = centerOffsetFm ? `transform:translateX(-${centerOffsetFm}mm);` : '';

  const bgImgHtml = s.bgImage ? `<div style="position:absolute;inset:0;background:url('${s.bgImage}') center/cover no-repeat;opacity:${s.bgImageOpacity ?? 0.8};z-index:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>` : '';
  const zi = s.bgImage ? 'position:relative;z-index:1;' : '';
  const rel = s.bgImage ? 'position:relative;overflow:hidden;' : '';

  const hideTxt = s.hideText ? 'opacity:0 !important; visibility:hidden !important; pointer-events:none !important;' : '';
  const podLogo = pubSet.coverOptions?.logo || '';
  const pPubHtml = (podLogo && type === 'copyright') ? `<img src="${podLogo}" style="max-height:16px; object-fit:contain; vertical-align:middle; margin-right:4px;"> ${pPub}` : pPub;

  const pageBase = `break-before:right;display:flex;flex-direction:column;justify-content:${jc};align-items:${ai};height:100%;${bgPrintCss}${rel}`;
  const padCss = `padding:${s.paddingTop ?? 20}mm ${s.paddingRight ?? 20}mm ${s.paddingBottom ?? 20}mm ${s.paddingLeft ?? 20}mm;`;

  let htmlFm = '';
  if (type === 'half_title') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}text-align:center;${padCss}${fontCss}"><h1 style="${titleSz}font-weight:700;margin:0;">${pTitle}</h1></div></div>`;
  } else if (type === 'title_page') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}display:flex;flex-direction:column;align-items:${ai};text-align:center;${padCss}${fontCss}"><h1 style="${titleSz}font-weight:700;margin-bottom:20px;">${pTitle}</h1>${pSub ? `<div style="font-size:12pt;opacity:0.7;margin-bottom:40px;">${pSub}</div>` : ''} ${pPubHtml ? `<div style="font-size:12pt;font-weight:700;">${pPubHtml}</div>` : ''}</div></div>`;
  } else if (type === 'dedication') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}${padCss}max-width:75%;${fontCss}"><p style="${titleSz}font-style:italic;line-height:1.8;margin:0;">${pCustom}</p></div></div>`;
  } else if (type === 'epigraph') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}${padCss}max-width:75%;${fontCss}"><blockquote style="border-left:2px solid currentColor;padding-left:16px;margin:0;"><p style="${titleSz}font-style:italic;line-height:1.8;margin-bottom:12px;">${pCustom}</p>${pQuote ? `<cite style="font-size:10pt;opacity:0.7;">${pQuote}</cite>` : ''}</blockquote></div></div>`;
  } else if (type === 'copyright') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="break-before:right;position:relative;height:100%;${bgPrintCss}${rel}">${bgImgHtml}<div style="${hideTxt}${zi}position:absolute;bottom:0;left:0;right:0;${padCss}font-size:8pt !important;font-family:'KoPub Batang',serif;line-height:1.6 !important;color:${s.fontColor || '#1C1813'};"><h2 style="font-size:12pt !important;margin-bottom:20px;font-weight:700;">${pTitle}</h2><div style="display:grid;grid-template-columns:70px 1fr;gap:6px;margin-bottom:12px;"><div style="opacity:0.6;">발행일</div><div>${pDate}</div><div style="opacity:0.6;">지은이</div><div>${pAuth}</div><div style="opacity:0.6;">출판사</div><div>퍼플</div></div><div style="margin-bottom:12px;"><p style="margin:0;">출판등록 제300-2012-167호 (2012년 09월 07일)</p><p style="margin:0;">주 소 서울시 종로구 종로1가 1번지</p><p style="margin:0;">대표전화 1544-1900</p><p style="margin:0;">홈페이지 www.kyobobook.co.kr</p></div><div style="font-size:7.5pt !important;opacity:0.7;padding-top:12px;border-top:1px solid currentColor;"><p style="margin-bottom:4px;">ⓒ ${pAuth} ${new Date().getFullYear()}</p><p>본 책 내용의 전부 또는 일부를 재사용하려면 반드시 저작권자의 동의를 받으셔야 합니다.</p></div></div></div>`;
  } else if (type === 'toc') {
    const tocEps = afterTocEps.filter(e => e.type !== 'frontmatter' && e.type !== 'backmatter');
    if (pubSet.autoTOC !== false && tocEps.length > 0) {
      let tocHtml = `<div class="chapter matter-page toc-page" data-fm-label="목차" style="break-before:right;${bgPrintCss}${rel}">${bgImgHtml}<div style="${zi}"><h2 style="margin-bottom:30px;font-size:16pt;font-weight:700;text-align:center;">목차</h2><ul class="toc-list" style="list-style:none;padding:0;">`;
      tocEps.forEach(ep => { tocHtml += `<li style="margin-bottom:8px;"><span class="toc-title">${getEpisodeDisplayTitle(ep, p, true)}</span></li>`; });
      tocHtml += `</ul></div></div>`;
      htmlFm = tocHtml;
    }
  } else if (type === 'blank') {
    htmlFm = `<div class="chapter matter-page" data-fm-label="여백" style="break-before:right;height:100%;${bgPrintCss}${rel}">${bgImgHtml}</div>`;
  }
  return htmlFm;
}

// ── 페이지 트리 렌더링 ────────────────────────────────────────
function renderPodPageTree() {
  const p = currentProject(); if (!p) return;
  const set = getPublishSettings(p);
  const treeEl = $('#podPageTree');
  if (!treeEl) return;
  treeEl.innerHTML = '';

  const pubSet = getPublishSettings(p);

  // ── [1] 구조도 헤더 ──
  const hdr = document.createElement('div');
  hdr.style.cssText = 'padding:12px; border-bottom:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; background:#fafafa; font-size:12px;';
  const hdrTitle = document.createElement('div');
  hdrTitle.style.cssText = 'font-weight:700; color:var(--c-ink);';
  hdrTitle.textContent = '페이지 구조도';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'btn';
  refreshBtn.style.cssText = 'padding:4px 8px; font-size:11px;';
  refreshBtn.textContent = '새로고침';
  refreshBtn.onclick = () => renderLivePodPreview();
  hdr.appendChild(hdrTitle);
  hdr.appendChild(refreshBtn);
  treeEl.appendChild(hdr);

  // ── [2] 표지 썸네일 (앞/뒤 1장만) ──
  const coverSec = document.createElement('div');
  coverSec.style.cssText = 'padding:16px 8px; border-bottom:1px solid var(--border-color);';
  coverSec.appendChild(mkSectionHead('─ 표지 (1장) ─'));
  const coverThumb = mkThumb('', '표지', '앞/뒤', '#555', () => {
    if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'none';
    if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'flex';
    if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'none';
    podUpdateCoverPreview();
  });
  coverSec.appendChild(coverThumb);
  treeEl.appendChild(coverSec);

  // ── [3] 내지 썸네일 ──
  const innerSec = document.createElement('div');
  innerSec.style.cssText = 'padding:0 8px;';
  innerSec.appendChild(mkSectionHead('─ 내지 (전체 페이지) ─'));

  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  const epMap = {};
  eps.forEach(e => epMap[e.id] = e.title);

  let mapData = [];
  if (window.podPageMap && window.podPageMap.length > 0) {
    mapData = window.podPageMap.map(m => ({
      pageNum: m.pageNum,
      label: m.type === 'ep' && m.epId && epMap[m.epId] ? epMap[m.epId] : m.label,
      type: m.type,
      isBlank: m.label === '여백' || m.label === '빈면지'
    }));
  }

  if (mapData.length === 0) {
    const loading = document.createElement('div');
    loading.style.cssText = 'text-align:center; padding:20px; font-size:12px; color:var(--c-muted);';
    loading.textContent = '조판 렌더링을 기다리는 중이거나 원고 데이터가 없습니다.';
    innerSec.appendChild(loading);
    treeEl.appendChild(innerSec);
    return;
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:16px 0; padding:0 4px 24px; position:relative;';

  const spine = document.createElement('div');
  spine.style.cssText = 'position:absolute;top:0;bottom:0;left:50%;width:1px;background:var(--border-color);opacity:.5;pointer-events:none;z-index:1;';
  grid.appendChild(spine);

  for (let i = 0; i < mapData.length; i++) {
    const pageData = mapData[i];
    const isOdd = pageData.pageNum % 2 !== 0; 
    const cell = document.createElement('div');

    cell.style.cssText = `display:flex; justify-content:${isOdd ? 'flex-start' : 'flex-end'}; align-items:flex-start;`;
    if (pageData.pageNum === 1) cell.style.gridColumn = '2'; 

    const thumb = mkThumb(
      pageData.pageNum,
      pageData.label ? pageData.label.substring(0, 12) : '',
      pageData.type === 'ep' ? '본문' : '전면',
      '#7c6bf6',
      () => {
        if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'flex';
        if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'none';
        
        podGoToPage(pageData.pageNum, true); 

        grid.querySelectorAll('.tree-thumb-active').forEach(el => el.classList.remove('tree-thumb-active'));
        cell.classList.add('tree-thumb-active');
      },
      pageData.isBlank
    );
    cell.appendChild(thumb);
    grid.appendChild(cell);
  }

  innerSec.appendChild(grid);
  treeEl.appendChild(innerSec);

  // ── [4] 푸터 ──
  const footer = document.createElement('div');
  footer.id = 'podTreeFooter';
  footer.style.cssText = 'margin-top:8px; padding:10px 12px; border-top:1px solid var(--border-color); display:flex; flex-direction:column; gap:4px; font-size:11px; font-weight:700; color:var(--c-ink);';
  const totalLabel = document.createElement('div');
  totalLabel.id = 'podTreeTotalLabel';
  totalLabel.textContent = window.podLastRenderedTotalPages > 0 ? `내지 총: ${window.podLastRenderedTotalPages}쪽` : '렌더링 대기 중...';
  const spineLabel = document.createElement('div');
  spineLabel.id = 'podSpineThicknessLabel';
  spineLabel.style.color = 'var(--c-accent)';
  spineLabel.textContent = '예상 책등 두께: 계산 중...';
  footer.appendChild(totalLabel);
  footer.appendChild(spineLabel);
  treeEl.appendChild(footer);

  if (window.podLastRenderedTotalPages > 0) updateSpineThickness(window.podLastRenderedTotalPages);
}




function podUpdateFmPreview() {
  if (typeof renderLivePodPreview === 'function') {
    renderLivePodPreview();
  }
}
let podCurrentPreviewPage = 1;
if ($('#podPrevPageBtn')) {
  $('#podPrevPageBtn').addEventListener('click', () => {
    if (podCurrentPreviewPage > 1) {
      podCurrentPreviewPage--;
      const iframe = document.getElementById('podLiveIframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'SHOW_PAGES', pageNum: podCurrentPreviewPage, mode: 'single' }, '*');
      }
      if ($('#podPageInfo')) $('#podPageInfo').textContent = podCurrentPreviewPage + 'p';
    }
  });
}
if ($('#podNextPageBtn')) {
  $('#podNextPageBtn').addEventListener('click', () => {
    const maxPage = (window.podPageMap && window.podPageMap.length > 0) ? window.podPageMap[window.podPageMap.length - 1].pageNum : 999;
    if (podCurrentPreviewPage < maxPage) {
      podCurrentPreviewPage++;
      const iframe = document.getElementById('podLiveIframe');
      if (iframe && iframe.contentWindow) {
        iframe.contentWindow.postMessage({ type: 'SHOW_PAGES', pageNum: podCurrentPreviewPage, mode: 'single' }, '*');
      }
      if ($('#podPageInfo')) $('#podPageInfo').textContent = podCurrentPreviewPage + 'p';
    }
  });
}

// 여백 등 입력 실시간 반영
['podPreviewMode', 'podMarginTop', 'podMarginBottom', 'podMarginInner', 'podMarginOuter', 'podBleed', 'podPaperSize', 'podFontSize', 'podLineHeight', 'podFmTitle', 'podFmSubtitle', 'podFmPublisher', 'podFmBgColor', 'podAuthor', 'podPublishDate'].forEach(id => {
  const el = $('#' + id);
  if (el) el.addEventListener('input', () => { podScheduleLiveRender(); });
});

// 출판사 로고 선택 시 옵션 패널 보이기/숨기기
$('#podPublisherLogo')?.addEventListener('change', (e) => {
  const optsEl = $('#podLogoOptions');
  if (optsEl) optsEl.style.display = e.target.value ? 'block' : 'none';
  podUpdateCoverPreview();
});

['podCoverBgColorHex', 'podSpineWidth', 'podShowCopyright', 'podAuthor', 'podLogoFrontSize', 'podLogoFrontBottom', 'podLogoSpineRatio', 'podLogoSpineBottom'].forEach(id => {
  const el = $('#' + id);
  if (el) el.addEventListener('input', () => { podUpdateCoverPreview(); });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 전면부 커스텀 에디터 (Front Matter Designer)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 블록 타입 메타데이터
const FM_BLOCK_META = {
  half_title: { name: '속표지', icon: '📖', fields: ['title'] },
  title_page: { name: '본표지', icon: '📗', fields: ['title', 'subtitle', 'publisher'] },
  dedication: { name: '헌사', icon: '💌', fields: ['custom'] },
  epigraph: { name: '인용구', icon: '✏️', fields: ['custom', 'quoteAuthor'] },
  copyright: { name: '판권지', icon: '©️', fields: ['title', 'author', 'date', 'publisher'] },
  toc: { name: '목차', icon: '📋', fields: [] },
  blank: { name: '빈 면지', icon: '⬜', fields: [] }
};

// 기본 스타일 팩토리
function defaultFmStyle(type) {
  const dark = ['dedication', 'epigraph'].includes(type);
  return {
    bgColor: dark ? '#1C1813' : '#ffffff',
    bgImage: null,
    bgImageOpacity: 0.8,
    alignX: 'center',
    alignY: 'center',
    fontFamily: "'KoPub Batang', serif",
    fontSize: type === 'half_title' ? 20 : type === 'title_page' ? 24 : 12,
    fontColor: dark ? '#FAF5ED' : '#1C1813',
    letterSpacing: '0em'
  };
}

// 기본 콘텐츠 팩토리
function defaultFmContent(type) {
  return { title: '', subtitle: '', publisher: '', author: '', date: '', customText: '', quoteAuthor: '' };
}

// ── 마이그레이션: 구형 fmOrder → fmBlocks ─────────────────────
function migrateFmOrder(oldOrder) {
  return (oldOrder || []).map(item => ({
    id: 'fm_' + (item.id || Date.now()) + '_' + Math.random().toString(36).slice(2, 6),
    type: item.id.startsWith('blank_') ? 'blank' : item.id,
    active: item.active !== false,
    style: defaultFmStyle(item.id.startsWith('blank_') ? 'blank' : item.id),
    content: defaultFmContent(item.id)
  }));
}

// ── fmBlocks 초기화 ────────────────────────────────────────────
function initFmBlocks(p) {
  const saved = p.publishSettings?.fmBlocks;
  if (saved && Array.isArray(saved) && saved.length > 0) {
    window.fmBlocks = saved;
  } else if (p.publishSettings?.frontMatter?.order) {
    window.fmBlocks = migrateFmOrder(p.publishSettings.frontMatter.order);
  } else {
    window.fmBlocks = [
      { id: 'fm_half_title', type: 'half_title', active: true, style: defaultFmStyle('half_title'), content: defaultFmContent('half_title') },
      { id: 'fm_title_page', type: 'title_page', active: true, style: defaultFmStyle('title_page'), content: defaultFmContent('title_page') },
      { id: 'fm_copyright', type: 'copyright', active: true, style: defaultFmStyle('copyright'), content: defaultFmContent('copyright') },
      { id: 'fm_toc', type: 'toc', active: true, style: defaultFmStyle('toc'), content: defaultFmContent('toc') }
    ];
  }
}

// 현재 편집 중인 블록 인덱스
let fmActiveBlockIdx = null;

// 9-Grid 정렬 옵션
const FM_ALIGN_GRID = [
  { ax: 'flex-start', ay: 'flex-start', label: '↖' },
  { ax: 'center', ay: 'flex-start', label: '↑' },
  { ax: 'flex-end', ay: 'flex-start', label: '↗' },
  { ax: 'flex-start', ay: 'center', label: '←' },
  { ax: 'center', ay: 'center', label: '✦' },
  { ax: 'flex-end', ay: 'center', label: '→' },
  { ax: 'flex-start', ay: 'flex-end', label: '↙' },
  { ax: 'center', ay: 'flex-end', label: '↓' },
  { ax: 'flex-end', ay: 'flex-end', label: '↘' },
];

// ── 9-Grid 렌더링 ──────────────────────────────────────────────
function renderAlignGrid(curAX, curAY) {
  const grid = $('#fmAlignGrid'); if (!grid) return;
  grid.innerHTML = '';
  FM_ALIGN_GRID.forEach(cell => {
    const btn = document.createElement('button');
    btn.textContent = cell.label;
    const isActive = cell.ax === curAX && cell.ay === curAY;
    btn.style.cssText = `
      width:34px; height:34px; border-radius:4px; cursor:pointer; font-size:14px;
      border: 1.5px solid ${isActive ? 'var(--primary)' : 'var(--c-line)'};
      background: ${isActive ? 'var(--primary)' : 'var(--c-bg)'};
      color: ${isActive ? '#fff' : 'var(--c-ink)'};
    `;
    btn.onclick = () => {
      if (fmActiveBlockIdx === null) return;
      window.fmBlocks[fmActiveBlockIdx].style.alignX = cell.ax;
      window.fmBlocks[fmActiveBlockIdx].style.alignY = cell.ay;
      renderAlignGrid(cell.ax, cell.ay);
      podUpdateFmPreview();
    };
    grid.appendChild(btn);
  });
}

// ── 블록 목록 렌더링 ───────────────────────────────────────────
function renderFmBlockList() {
  const container = $('#podFmBlockList'); if (!container) return;
  container.innerHTML = '';
  let dragFromIndex = null;

  window.fmBlocks.forEach((block, index) => {
    const meta = FM_BLOCK_META[block.type] || { name: block.type, icon: '📄' };
    const isSelected = fmActiveBlockIdx === index;
    const el = document.createElement('div');
    el.draggable = true;
    el.dataset.index = index;
    el.style.cssText = `
      display:flex; align-items:center; gap:8px;
      padding:9px 12px; border-radius:6px; cursor:grab; font-size:12px;
      border:1.5px solid ${isSelected ? 'var(--primary)' : 'var(--c-line)'};
      background:${isSelected ? 'rgba(99,91,255,0.07)' : 'var(--c-bg)'};
      transition: border-color 0.15s, background 0.15s;
    `;

    // 체크박스
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = block.active;
    cb.onclick = e => e.stopPropagation();
    cb.onchange = e => { block.active = e.target.checked; saveFmBlocks(); };

    // 아이콘 + 이름
    const labelSpan = document.createElement('span');
    labelSpan.style.flex = '1';
    labelSpan.innerHTML = `<span style="margin-right:6px;">${meta.icon}</span>${meta.name}`;

    // 배경색 미리보기 점
    const colorDot = document.createElement('span');
    colorDot.style.cssText = `width:10px; height:10px; border-radius:50%; flex-shrink:0;
      background:${block.style.bgColor}; border:1px solid var(--c-line);`;

    // 삭제 버튼
    const delBtn = document.createElement('span');
    delBtn.innerHTML = '🗑';
    delBtn.style.cssText = 'cursor:pointer; opacity:0.4; font-size:11px; padding:2px;';
    delBtn.onmouseenter = () => delBtn.style.opacity = '1';
    delBtn.onmouseleave = () => delBtn.style.opacity = '0.4';
    delBtn.onclick = e => { e.stopPropagation(); deleteFmBlock(index); };

    el.appendChild(document.createTextNode('≡ '));
    el.appendChild(cb);
    el.appendChild(labelSpan);
    el.appendChild(colorDot);
    el.appendChild(delBtn);

    // 클릭 → 에디터 열기
    el.addEventListener('click', () => openFmBlockEditor(index));

    // 드래그 앤 드롭
    el.addEventListener('dragstart', e => {
      dragFromIndex = index;
      el.style.opacity = '0.4';
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => { el.style.opacity = '1'; dragFromIndex = null; });
    el.addEventListener('dragover', e => { e.preventDefault(); el.style.borderColor = 'var(--primary)'; });
    el.addEventListener('dragleave', () => { el.style.borderColor = isSelected ? 'var(--primary)' : 'var(--c-line)'; });
    el.addEventListener('drop', e => {
      e.preventDefault();
      if (dragFromIndex === null || dragFromIndex === index) return;
      const [moved] = window.fmBlocks.splice(dragFromIndex, 1);
      window.fmBlocks.splice(index, 0, moved);
      if (fmActiveBlockIdx === dragFromIndex) fmActiveBlockIdx = index;
      renderFmBlockList();
      saveFmBlocks();
    });

    container.appendChild(el);
  });
}

// ── 블록 에디터 열기 ───────────────────────────────────────────
function openFmBlockEditor(index) {
  fmActiveBlockIdx = index;
  const block = window.fmBlocks[index];
  const meta = FM_BLOCK_META[block.type] || { name: block.type };
  const s = block.style;
  const c = block.content;

  // [요구사항 반영] 전면부 템플릿 클릭 시 PagedJS 의존성을 제거하고 즉각적인 CSS 단면 렌더링 호출
  if ($('#podPreviewInner')) $('#podPreviewInner').style.display = 'flex';
  if ($('#podPreviewCover')) $('#podPreviewCover').style.display = 'none';
  if ($('#podPageToggleWrap')) $('#podPageToggleWrap').style.display = 'none'; // 이전/다음 버튼 숨김(안전장치)
  
  // 리스트 클릭 즉시 해당 템플릿 단면 보기 렌더링
  if (typeof renderLivePodPreview === 'function') {
    renderLivePodPreview();
  }

  // 에디터 패널 표시
  const ed = $('#fmBlockEditor'); if (!ed) return;
  ed.style.display = 'block';
  $('#fmEditorTitle').textContent = `${meta.name} 편집`;

  // 배경색
  $('#fmBgColorPicker').value = s.bgColor || '#ffffff';
  $('#fmBgColorHex').value = s.bgColor || '#ffffff';

  // 배경이미지
  const prevBox = $('#fmBgImagePreview');
  const thumb = $('#fmBgImageThumb');
  if (s.bgImage) {
    prevBox.style.display = 'block';
    thumb.src = s.bgImage;
    $('#fmBgOpacityField').style.display = 'block';
    $('#fmBgOpacity').value = s.bgImageOpacity ?? 0.8;
    $('#fmBgOpacityVal').textContent = s.bgImageOpacity ?? 0.8;
  } else {
    prevBox.style.display = 'none';
    $('#fmBgOpacityField').style.display = 'none';
  }

  // 9-Grid
  renderAlignGrid(s.alignX || 'center', s.alignY || 'center');

  // 여백 (Padding)
  $('#fmPaddingTop').value = s.paddingTop ?? 20;
  $('#fmPaddingBottom').value = s.paddingBottom ?? 20;
  $('#fmPaddingLeft').value = s.paddingLeft ?? 20;
  $('#fmPaddingRight').value = s.paddingRight ?? 20;

  // 글자 숨기기
  if ($('#fmHideText')) $('#fmHideText').checked = s.hideText || false;

  // 폰트
  $('#fmFontFamily').value = s.fontFamily || "'KoPub Batang', serif";
  $('#fmFontSize').value = s.fontSize || 20;
  $('#fmFontColorPicker').value = s.fontColor || '#1C1813';
  $('#fmFontColorHex').value = s.fontColor || '#1C1813';
  $('#fmLetterSpacing').value = s.letterSpacing || '0em';

  // 필드 표시/숨김
  const fields = meta.fields || [];
  const allFields = ['title', 'subtitle', 'publisher', 'author', 'date', 'custom', 'quoteAuthor'];
  allFields.forEach(f => {
    const el = $(`#fmField${f.charAt(0).toUpperCase() + f.slice(1)}`);
    if (el) el.style.display = fields.includes(f) ? 'block' : 'none';
  });
  $('#fmContentSection').style.display = fields.length ? 'block' : 'none';

  // 콘텐츠 값
  $('#fmContentTitle').value = c.title || '';
  $('#fmContentSubtitle').value = c.subtitle || '';
  $('#fmContentPublisher').value = c.publisher || '';
  $('#fmContentAuthor').value = c.author || '';
  $('#fmContentDate').value = c.date || '';
  $('#fmContentCustom').value = c.customText || '';
  $('#fmContentQuoteAuthor').value = c.quoteAuthor || '';

  // 블록 목록 재렌더 (selected 강조)
  renderFmBlockList();

  // 미리보기 즉시 업데이트
  podUpdateFmPreview();

  // 패널 스크롤
  ed.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}



// ── 실시간 미리보기 동기화 ────────────────────────────────────
function syncFmBlockLive() {
  if (fmActiveBlockIdx === null) return;
  const block = window.fmBlocks[fmActiveBlockIdx];

  block.style.hideText = $('#fmHideText')?.checked || false;
  block.style.bgColor = $('#fmBgColorHex').value || '#ffffff';
  block.style.fontFamily = $('#fmFontFamily').value;
  block.style.fontSize = parseFloat($('#fmFontSize').value) || 20;
  block.style.fontColor = $('#fmFontColorHex').value || '#1C1813';
  block.style.letterSpacing = $('#fmLetterSpacing').value;
  block.style.bgImageOpacity = parseFloat($('#fmBgOpacity').value) || 0.8;
  block.style.paddingTop = parseFloat($('#fmPaddingTop').value) || 0;
  block.style.paddingBottom = parseFloat($('#fmPaddingBottom').value) || 0;
  block.style.paddingLeft = parseFloat($('#fmPaddingLeft').value) || 0;
  block.style.paddingRight = parseFloat($('#fmPaddingRight').value) || 0;

  block.content.title = $('#fmContentTitle').value;
  block.content.subtitle = $('#fmContentSubtitle').value;
  block.content.publisher = $('#fmContentPublisher').value;
  block.content.author = $('#fmContentAuthor').value;
  block.content.date = $('#fmContentDate').value;
  block.content.customText = $('#fmContentCustom').value;
  block.content.quoteAuthor = $('#fmContentQuoteAuthor').value;

  podUpdateFmPreview();
}

[
  '#fmBgColorHex', '#fmBgColorPicker', '#fmFontFamily', '#fmFontSize', '#fmFontColorHex', '#fmFontColorPicker', '#fmLetterSpacing', '#fmBgOpacity', '#fmHideText',
  '#fmPaddingTop', '#fmPaddingBottom', '#fmPaddingLeft', '#fmPaddingRight',
  '#fmContentTitle', '#fmContentSubtitle', '#fmContentPublisher', '#fmContentAuthor', '#fmContentDate', '#fmContentCustom', '#fmContentQuoteAuthor'
].forEach(sel => {
  const el = $(sel);
  if (el) el.addEventListener('input', syncFmBlockLive);
});


// ── 블록에 적용 (저장용) 버튼 ───────────────────────────────────────────
$('#fmApplyBlockBtn').onclick = () => {
  if (fmActiveBlockIdx === null) return;
  syncFmBlockLive(); // 최신값 반영
  saveFmBlocks();
  renderFmBlockList();
  showToast('✅ 블록 설정이 적용 및 저장되었습니다.');
  
  // 2. 전면부 디자인: 저장 직후 백그라운드 렌더링을 다시 돌려 즉시 반영
  renderLivePodPreview();
};

// ── 배경색 동기화 ──────────────────────────────────────────────
$('#fmBgColorPicker').addEventListener('input', e => { $('#fmBgColorHex').value = e.target.value; });
$('#fmBgColorHex').addEventListener('input', e => {
  if (/^#[0-9A-Fa-f]{6}$/i.test(e.target.value)) $('#fmBgColorPicker').value = e.target.value;
});
$('#fmFontColorPicker').addEventListener('input', e => { $('#fmFontColorHex').value = e.target.value; });
$('#fmFontColorHex').addEventListener('input', e => {
  if (/^#[0-9A-Fa-f]{6}$/i.test(e.target.value)) $('#fmFontColorPicker').value = e.target.value;
});

// ── 투명도 슬라이더 ────────────────────────────────────────────
$('#fmBgOpacity').addEventListener('input', e => { $('#fmBgOpacityVal').textContent = e.target.value; });

// ── 배경 이미지 업로드 ─────────────────────────────────────────
$('#fmBgImageInput').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file || fmActiveBlockIdx === null) return;
  const reader = new FileReader();
  reader.onload = ev => {
    // 1MB 이하로 압축
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      let w = img.width, h = img.height;
      const MAX = 1200;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else { w = Math.round(w * MAX / h); h = MAX; }
      }
      cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = cvs.toDataURL('image/jpeg', 0.85);
      window.fmBlocks[fmActiveBlockIdx].style.bgImage = dataUrl;
      $('#fmBgImageThumb').src = dataUrl;
      $('#fmBgImagePreview').style.display = 'block';
      $('#fmBgOpacityField').style.display = 'block';
      podUpdateFmPreview();
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

window.clearFmBgImage = () => {
  if (fmActiveBlockIdx === null) return;
  window.fmBlocks[fmActiveBlockIdx].style.bgImage = null;
  $('#fmBgImagePreview').style.display = 'none';
  $('#fmBgOpacityField').style.display = 'none';
  $('#fmBgImageInput').value = '';
  podUpdateFmPreview();
};

// ── 블록 추가 ─────────────────────────────────────────────────
$$('[data-fm-add]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.fmAdd;
    const meta = FM_BLOCK_META[type] || {};
    window.fmBlocks.push({
      id: 'fm_' + type + '_' + Date.now(),
      type,
      active: true,
      style: defaultFmStyle(type),
      content: defaultFmContent(type)
    });
    fmActiveBlockIdx = window.fmBlocks.length - 1;
    renderFmBlockList();
    openFmBlockEditor(fmActiveBlockIdx);
    saveFmBlocks();
  });
});

// ── 블록 삭제 ─────────────────────────────────────────────────
function deleteFmBlock(index) {
  if (!confirm(`이 블록을 삭제하시겠습니까?`)) return;
  window.fmBlocks.splice(index, 1);
  if (fmActiveBlockIdx === index) {
    fmActiveBlockIdx = null;
    $('#fmBlockEditor').style.display = 'none';
  } else if (fmActiveBlockIdx > index) {
    fmActiveBlockIdx--;
  }
  renderFmBlockList();
  saveFmBlocks();
}

// ── 상태 저장 ─────────────────────────────────────────────────
function saveFmBlocks() {
  const p = currentProject(); if (!p) return;
  if (!p.publishSettings) p.publishSettings = {};
  p.publishSettings.fmBlocks = window.fmBlocks;
  try { localStorage.setItem('novel_pubset_' + p.id, JSON.stringify(p.publishSettings)); } catch (e) { }
  touchProject(); queueSaveFS();
}

// 하위 호환: fmOrder 참조를 위한 getter
Object.defineProperty(window, 'fmOrder', {
  get: () => window.fmBlocks?.map(b => ({ id: b.type === 'blank' ? 'blank_' + b.id : b.type, name: (FM_BLOCK_META[b.type]?.name || b.type), active: b.active })) || [],
  configurable: true
});

// renderFmList는 더 이상 쓰이지 않지만 하위 호환용으로 유지
function renderFmList() { renderFmBlockList(); }


// 창 크기 변경 시 미리보기 크기 업데이트
window.addEventListener('resize', () => {
  if ($('#podStudioView') && $('#podStudioView').classList.contains('active')) {
    podScheduleLiveRender();
  }
});

window.addEventListener('message', e => {
  if (e.data?.type === 'PAGES_READY') {
    const count = e.data.count;
    const isSilent = e.data.isSilent;

    const p = currentProject();
    if (p) {
      p.podExactPages = count;
    }

    $('#podEstPages').innerHTML = `${count} <span style="font-size:10px; color:#5e9c76;">(실제 측정됨)</span>`;
    $('#podEstSpine').textContent = Math.max(1, Math.round(count * (8.8 / 96) * 10) / 10).toFixed(1);

    if (isSilent) {
      const btn = $('#podCalcExactBtn');
      if (btn) {
        btn.textContent = '✨ Paged.js 기반 실제 쪽수 정밀 계산';
        btn.disabled = false;
      }
      const iframe = document.getElementById('pod-calc-iframe');
      if (iframe) iframe.remove();
    } else {
      showToast(`📄 조판 완료: 총 ${count}페이지 생성됨`);
    }
  }
});

// 출판사 프리셋 적용
$$('.pod-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    $$('.pod-preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const preset = POD_PRESETS[btn.dataset.preset];
    if (!preset) return; // 직접 입력 = 아무것도 안 함
    $('#podPaperSize').value = preset.paperSize;
    $('#podMarginTop').value = preset.margins.top;
    $('#podMarginBottom').value = preset.margins.bottom;
    $('#podMarginInner').value = preset.margins.inner;
    $('#podMarginOuter').value = preset.margins.outer;
    $('#podBleed').value = preset.margins.bleed;
    podScheduleLiveRender();
    showToast(`${preset.name} 여백 프리셋이 적용되었습니다.`);
  });
});

// 표지 배경색 동기화
$('#podCoverBgColor').addEventListener('input', (e) => {
  $('#podCoverBgColorHex').value = e.target.value;
  podUpdateCoverPreview();
});
$('#podCoverBgColorHex').addEventListener('input', (e) => {
  if (/^#[0-9A-Fa-f]{6}$/i.test(e.target.value)) {
    $('#podCoverBgColor').value = e.target.value;
    podUpdateCoverPreview();
  }
});

$('#podSpineFont').addEventListener('change', podUpdateCoverPreview);
$('#podSpineWidth').addEventListener('input', podUpdateCoverPreview);

// 표지 이미지 업로드 (스튜디오)
$('#podFrontCoverInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => { currentFrontCoverObj = img; podUpdateCoverPreview(); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
};
$('#podBackCoverInput').onchange = (e) => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => { currentBackCoverObj = img; podUpdateCoverPreview(); };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
};



// 기존 getPublishSettings 에 margins 기본값 추가 (backward compat)
// ── 기존 코드와의 하위 호환 ───────────────────────────────────
// 구형 exportPODPdf/exportPODCover는 아직 pubPaperSize 등 #pub* input을 읽으므로
// podSaveSettings()에서 syncLegacyInputs()를 통해 동기화함.
// exportPODPdf의 @page margin도 pubSet.margins로 동적 적용됨 (하단 별도 수정).

if ($('#exportPODBtn')) $('#exportPODBtn').onclick = exportPODPdf;
if ($('#exportPODCoverBtn')) $('#exportPODCoverBtn').onclick = exportPODCover;

function processEpisodeBody(html, epTitle, isForPublishing = false) {
  if (!html) return { body: '', hasTitle: false };

  // <br> 태그를 문단 분리(</p><p>)로 정규화하여 빈 줄 감지를 정확하게 함
  let normalizedHtml = html;
  if (isForPublishing) {
    normalizedHtml = html.replace(/<br\s*\/?>/gi, '</p><p>');
  }

  const div = document.createElement('div');
  div.innerHTML = normalizedHtml;

  // 1. 빈 리스트 삭제
  div.querySelectorAll('li').forEach(li => {
    if (!li.textContent.trim() && !li.querySelector('img')) li.remove();
  });
  div.querySelectorAll('ul, ol').forEach(list => {
    if (list.children.length === 0) list.remove();
  });

  // 2. 서사 블록 그룹화 (PDF용 Fallback)
  const nClasses = ['n-msg', 'n-msg-y', 'n-sys', 'n-log', 'n-alert', 'n-record', 'n-status', 'n-email', 'n-email-body', 'n-doc', 'n-noti', 'n-field', 'n-memo'];
  const els = Array.from(div.children);
  for (let i = 0; i < els.length; i++) {
    const cur = els[i];
    for (let cls of nClasses) {
      const isCls = cur.classList.contains(cls) || cur.querySelector('.' + cls);
      if (isCls) {
        const prev = els[i - 1], next = els[i + 1];
        const pIsCls = prev && (prev.classList.contains(cls) || prev.querySelector('.' + cls));
        const nIsCls = next && (next.classList.contains(cls) || next.querySelector('.' + cls));

        let target = cur.classList.contains(cls) ? cur : cur.querySelector('.' + cls);
        if (pIsCls && nIsCls) target.classList.add('pdf-group-middle');
        else if (pIsCls && !nIsCls) target.classList.add('pdf-group-last');
        else if (!pIsCls && nIsCls) target.classList.add('pdf-group-first');
        else target.classList.add('pdf-group-isolated'); // 단독 블록
        break;
      }
    }
  }

  // 3. 제목 중복 체크 (첫 번째 의미 있는 헤딩)
  let hasTitle = false;
  if (epTitle) {
    const norm = (s) => s.replace(/[\s\u200B-\u200D\uFEFF]/g, '');
    const titleNorm = norm(epTitle);

    // 1. 헤딩 태그 검사
    const headings = div.querySelectorAll('h1, h2');
    if (headings.length > 0) {
      const firstH = headings[0];
      let isFirstMeaningful = true;
      for (const cur of els) {
        if (cur === firstH) break;
        if (cur.textContent.trim() !== '') {
          isFirstMeaningful = false; break;
        }
      }
      if (isFirstMeaningful && norm(firstH.textContent) === titleNorm) {
        hasTitle = true;
        firstH.remove(); // 제목을 본문에서 아예 제거! (중복 방지)
      }
    }

    // 2. 만약 헤딩이 아니더라도 첫 번째 단락(p)이 제목과 똑같다면 제거
    if (!hasTitle && els.length > 0) {
      for (const cur of els) {
        if (cur.textContent.trim() !== '') {
          if (norm(cur.textContent) === titleNorm) {
            hasTitle = true;
            cur.remove(); // 첫 번째 단락이 제목이면 제거
          }
          break; // 첫 의미있는 요소만 검사
        }
      }
    }
  }

  // 4. 종이책용 연속된 빈 줄 정리 (웹소설식 1칸 띄어쓰기 완전 제거)
  if (isForPublishing) {
    let emptyNodes = [];
    Array.from(div.children).forEach(child => {
      // 빈 문자열이거나 nbsp(\u00A0) 등만 있는 문단 감지
      if (child.tagName === 'P' && !child.textContent.replace(/[\s\u00A0\u200B-\u200D\uFEFF]/g, '').trim() && !child.querySelector('img')) {
        emptyNodes.push(child);
      } else {
        if (emptyNodes.length === 1) {
          emptyNodes[0].remove(); // 단일 빈 줄은 일반 문단 바꿈이므로 제거
        } else if (emptyNodes.length > 1) {
          // 2개 이상의 빈 줄은 장면 전환(Scene break)이므로 1개만 남기고 모두 제거
          for (let i = 1; i < emptyNodes.length; i++) {
            emptyNodes[i].remove();
          }
        }
        emptyNodes = [];
      }
    });
    emptyNodes.forEach(node => node.remove()); // 마지막 빈 줄 제거
  }

  return { body: div.innerHTML, hasTitle };
}

async function generatePODCoverCanvas(p, set, opts) {
  const MM_TO_PX = 300 / 25.4;
  const BLEED_MM = 3; // 사방 도련 3mm

  let paperW = 148;
  let paperH = 210;
  if (set.paperSize === 'B6') {
    paperW = 128;
    paperH = 182;
  }

  const spineW = opts.spineWidthMm || calculateSpineWidth(p);
  const canvasW_mm = (BLEED_MM * 2) + (paperW * 2) + spineW;
  const canvasH_mm = paperH + (BLEED_MM * 2);

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(canvasW_mm * MM_TO_PX);
  canvas.height = Math.round(canvasH_mm * MM_TO_PX);
  const ctx = canvas.getContext('2d');

  // 배경색 칠하기
  ctx.fillStyle = opts.bgColor || '#2c2c2c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 요소별 위치 (px)
  const leftX = 0;
  const backCoverW = Math.round((BLEED_MM + paperW) * MM_TO_PX);
  const spineX = backCoverW;
  const spineW_px = Math.round(spineW * MM_TO_PX);
  const frontX = spineX + spineW_px;
  const frontCoverW = Math.round((paperW + BLEED_MM) * MM_TO_PX);

  // 이미지 로드 유틸
  const loadImg = (src) => new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

  const frontImg = currentFrontCoverObj || await loadImg(opts.frontOriginal);
  const backImg = currentBackCoverObj || await loadImg(opts.backOriginal);
  const logoImg = await loadImg(opts.logo);

  // 앞표지 그리기 (Center Crop)
  if (frontImg) {
    const scale = Math.max(frontCoverW / frontImg.width, canvas.height / frontImg.height);
    const dw = frontImg.width * scale;
    const dh = frontImg.height * scale;
    const dx = frontX + (frontCoverW - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(frontX, 0, frontCoverW, canvas.height);
    ctx.clip();
    ctx.drawImage(frontImg, dx, dy, dw, dh);
    ctx.restore();
  }

  // 뒷표지 그리기 (Center Crop)
  if (backImg) {
    const scale = Math.max(backCoverW / backImg.width, canvas.height / backImg.height);
    const dw = backImg.width * scale;
    const dh = backImg.height * scale;
    const dx = leftX + (backCoverW - dw) / 2;
    const dy = (canvas.height - dh) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(leftX, 0, backCoverW, canvas.height);
    ctx.clip();
    ctx.drawImage(backImg, dx, dy, dw, dh);
    ctx.restore();
  }

  // 책등 텍스트 그리기 (세로쓰기)
  const title = p.title || '제목 없음';
  const author = set.frontMatter?.author || '저자';
  const spineFont = $('#pubSpineFont').value || "'KoPub Batang', serif";

  ctx.save();
  ctx.fillStyle = (opts.bgColor || '#2c2c2c').toLowerCase() === '#ffffff' ? '#000' : '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const titleFontSize = Math.min(Math.round(4 * MM_TO_PX), spineW_px * 0.8);
  ctx.font = `bold ${titleFontSize}px ${spineFont}`;

  let startY = Math.round((BLEED_MM + 20) * MM_TO_PX);
  for (let i = 0; i < title.length; i++) {
    if (title[i] === ' ') { startY += titleFontSize * 0.5; continue; }
    ctx.fillText(title[i], spineX + spineW_px / 2, startY);
    startY += titleFontSize * 1.1;
  }

  const authorFontSize = Math.min(Math.round(3 * MM_TO_PX), spineW_px * 0.6);
  ctx.font = `normal ${authorFontSize}px ${spineFont}`;

  startY += Math.round(10 * MM_TO_PX);
  for (let i = 0; i < author.length; i++) {
    if (author[i] === ' ') { startY += authorFontSize * 0.5; continue; }
    ctx.fillText(author[i], spineX + spineW_px / 2, startY);
    startY += authorFontSize * 1.1;
  }

  ctx.restore();

  // 로고 그리기
  if (logoImg) {
    const spineLogoRatio = (opts.logoSpineRatio || 60) / 100;
    const spineBottomMm = opts.logoSpineBottom ?? 15;
    const spineLogoW = spineW_px * spineLogoRatio;
    const spineLogoH = (logoImg.height / logoImg.width) * spineLogoW;
    const sLx = spineX + (spineW_px - spineLogoW) / 2;
    const sLy = canvas.height - Math.round((BLEED_MM + spineBottomMm) * MM_TO_PX) - spineLogoH;
    ctx.drawImage(logoImg, sLx, sLy, spineLogoW, spineLogoH);

    const frontLogoW_mm = opts.logoFrontSize ?? 7;
    const frontBottomMm = opts.logoFrontBottom ?? 15;
    const frontLogoW = Math.round(frontLogoW_mm * MM_TO_PX);
    const frontLogoH = logoImg.height * (frontLogoW / logoImg.width);
    const fLx = frontX + (frontCoverW - frontLogoW) / 2;
    const fLy = canvas.height - Math.round((BLEED_MM + frontBottomMm) * MM_TO_PX) - frontLogoH;
    ctx.drawImage(logoImg, fLx, fLy, frontLogoW, frontLogoH);
  }

  return canvas;
}

async function generateCoverPreview(p, set) {
  const opts = set.coverOptions || {};
  const canvas = await generatePODCoverCanvas(p, set, opts);
  if (!canvas) return null;
  return canvas.toDataURL('image/jpeg', 0.8);
}

async function exportPODCover() {
  const p = currentProject(); if (!p) return;
  const set = getPublishSettings(p);
  const opts = set.coverOptions || {};
  const canvas = await generatePODCoverCanvas(p, set, opts);



  // 다운로드
  const link = document.createElement('a');
  link.download = `${p.title}_표지(300dpi).jpg`;
  link.href = canvas.toDataURL('image/jpeg', 0.95);
  link.click();
}


function generatePODBodyContent(p, pubSet, loadedEps, targetEpId = null) {
  const FM_LABELS = { half_title: '속표지', title_page: '본표지', copyright: '판권지', toc: '목차', dedication: '헌정', epigraph: '제사', blank: '여백' };
  let firstMainIdx = loadedEps.findIndex(e => e.type === 'chapter' || e.type === 'prologue' || e.type === 'epilogue');

  if (firstMainIdx === -1) firstMainIdx = loadedEps.length;

  const beforeTocEps = loadedEps.slice(0, firstMainIdx);
  const afterTocEps = loadedEps.slice(firstMainIdx);

  // ── 책머리(Front Matter) 렌더링 — fmBlocks 기반 ──────────────
  const fmBlocksForRender = (pubSet.fmBlocks && pubSet.fmBlocks.length > 0)
    ? pubSet.fmBlocks : (window.fmBlocks || []);

  // 마진 오프셋 (내측 여백과 외측 여백 차이로 인한 시각적 보정)
  const marginInnerFm = parseFloat(pubSet.margins?.inner || 25);
  const marginOuterFm = parseFloat(pubSet.margins?.outer || 18);
  const centerOffsetFm = (marginInnerFm - marginOuterFm) / 2;

  let htmlFm = '';
  fmBlocksForRender.filter(b => b.active).forEach(block => {
    const s = block.style || {};
    const c = block.content || {};
    const type = block.type;

    const pTitle = escapeHtml(c.title || p.title || '');
    const pSub = escapeHtml(c.subtitle || '');
    const pAuth = escapeHtml(c.author || pubSet.frontMatter?.author || '저자');
    const pDate = escapeHtml(c.date || pubSet.frontMatter?.publishDate || new Date().getFullYear() + '년');
    const presetObj = POD_PRESETS[pubSet.preset] || {};
    const pPub = escapeHtml(c.publisher || pubSet.frontMatter?.fmPublisher || presetObj.name || '');
    const pCustom = escapeHtml(c.customText || '').replace(/\n/g, '<br>');
    const pQuote = escapeHtml(c.quoteAuthor || '');

    const bgColor = s.bgColor || '#ffffff';
    const bgIsColored = bgColor.toLowerCase() !== '#ffffff';
    const bgPrintCss = bgIsColored ? `-webkit-print-color-adjust:exact;print-color-adjust:exact;background-color:${bgColor} !important;` : '';

    const fontCss = `font-family:${s.fontFamily || "'KoPub Batang',serif"};color:${s.fontColor || '#1C1813'};letter-spacing:${s.letterSpacing || '0em'};`;
    const titleSz = `font-size:${s.fontSize || 20}pt;`;
    const jc = s.alignY || 'center';
    const ai = s.alignX || 'center';
    const offsetStyle = centerOffsetFm ? `transform:translateX(-${centerOffsetFm}mm);` : '';

    const bgImgHtml = s.bgImage ? `<div style="position:absolute;inset:0;background:url('${s.bgImage}') center/cover no-repeat;opacity:${s.bgImageOpacity ?? 0.8};z-index:0;-webkit-print-color-adjust:exact;print-color-adjust:exact;"></div>` : '';
    const zi = s.bgImage ? 'position:relative;z-index:1;' : '';
    const rel = s.bgImage ? 'position:relative;overflow:hidden;' : '';

    // PagedJS 크래시 방지를 위해 display:none 대신 시각적 숨김 처리
    const hideTxt = s.hideText ? 'opacity:0 !important; visibility:hidden !important; pointer-events:none !important;' : '';
    const podLogo = pubSet.coverOptions?.logo || '';
    const pPubHtml = (podLogo && type === 'copyright') ? `<img src="${podLogo}" style="max-height:16px; object-fit:contain; vertical-align:middle; margin-right:4px;"> ${pPub}` : pPub;

    const pageBase = `break-before:right;display:flex;flex-direction:column;justify-content:${jc};align-items:${ai};height:100%;${bgPrintCss}${rel}`;

    const padCss = `padding:${s.paddingTop ?? 20}mm ${s.paddingRight ?? 20}mm ${s.paddingBottom ?? 20}mm ${s.paddingLeft ?? 20}mm;`;

    if (type === 'half_title') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}text-align:center;${padCss}${fontCss}"><h1 style="${titleSz}font-weight:700;margin:0;">${pTitle}</h1></div></div>`;
    } else if (type === 'title_page') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}display:flex;flex-direction:column;align-items:${ai};text-align:center;${padCss}${fontCss}"><h1 style="${titleSz}font-weight:700;margin-bottom:20px;">${pTitle}</h1>${pSub ? `<div style="font-size:12pt;opacity:0.7;margin-bottom:40px;">${pSub}</div>` : ''} ${pPubHtml ? `<div style="font-size:12pt;font-weight:700;">${pPubHtml}</div>` : ''}</div></div>`;
    } else if (type === 'dedication') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}${padCss}max-width:75%;${fontCss}"><p style="${titleSz}font-style:italic;line-height:1.8;margin:0;">${pCustom}</p></div></div>`;
    } else if (type === 'epigraph') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="${pageBase}">${bgImgHtml}<div style="${hideTxt}${zi}${offsetStyle}${padCss}max-width:75%;${fontCss}"><blockquote style="border-left:2px solid currentColor;padding-left:16px;margin:0;"><p style="${titleSz}font-style:italic;line-height:1.8;margin-bottom:12px;">${pCustom}</p>${pQuote ? `<cite style="font-size:10pt;opacity:0.7;">${pQuote}</cite>` : ''}</blockquote></div></div>`;
    } else if (type === 'copyright') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="${FM_LABELS[type] || type}" style="break-before:right;position:relative;height:100%;${bgPrintCss}${rel}">${bgImgHtml}<div style="${hideTxt}${zi}position:absolute;bottom:0;left:0;right:0;${padCss}font-size:8pt !important;font-family:'KoPub Batang',serif;line-height:1.6 !important;color:${s.fontColor || '#1C1813'};"><h2 style="font-size:12pt !important;margin-bottom:20px;font-weight:700;">${pTitle}</h2><div style="display:grid;grid-template-columns:70px 1fr;gap:6px;margin-bottom:12px;"><div style="opacity:0.6;">발행일</div><div>${pDate}</div><div style="opacity:0.6;">지은이</div><div>${pAuth}</div><div style="opacity:0.6;">출판사</div><div>퍼플</div></div><div style="margin-bottom:12px;"><p style="margin:0;">출판등록 제300-2012-167호 (2012년 09월 07일)</p><p style="margin:0;">주 소 서울시 종로구 종로1가 1번지</p><p style="margin:0;">대표전화 1544-1900</p><p style="margin:0;">홈페이지 www.kyobobook.co.kr</p></div><div style="font-size:7.5pt !important;opacity:0.7;padding-top:12px;border-top:1px solid currentColor;"><p style="margin-bottom:4px;">ⓒ ${pAuth} ${new Date().getFullYear()}</p><p>본 책 내용의 전부 또는 일부를 재사용하려면 반드시 저작권자의 동의를 받으셔야 합니다.</p></div></div></div>`;
    } else if (type === 'toc') {
      const tocEps = afterTocEps.filter(e => e.type !== 'frontmatter' && e.type !== 'backmatter');
      if (pubSet.autoTOC !== false && tocEps.length > 0) {
        let tocHtml = `<div class="chapter matter-page toc-page" data-fm-label="목차" style="break-before:right;${bgPrintCss}${rel}">${bgImgHtml}<div style="${zi}"><h2 style="margin-bottom:30px;font-size:16pt;font-weight:700;text-align:center;">목차</h2><ul class="toc-list">`;
        tocEps.forEach(ep => { tocHtml += `<li><span class="toc-title">${getEpisodeDisplayTitle(ep, p, true)}</span><span class="toc-dots"></span><a href="#ep-${ep.id}" class="toc-page-ref"></a></li>`; });
        tocHtml += `</ul></div></div>`;
        htmlFm += tocHtml;
      }
    } else if (type === 'blank') {
      htmlFm += `<div class="chapter matter-page" data-fm-label="여백" style="break-before:right;height:100%;${bgPrintCss}${rel}">${bgImgHtml}</div>`;
    }
  });

  let bodyHtml = htmlFm;


  // 3. 목차 전 부속 (사용자가 추가한 앞부속)
  beforeTocEps.forEach(ep => {
    if (targetEpId && targetEpId !== 'fm' && targetEpId !== ep.id) return;
    const processed = processEpisodeBody(ep.body, ep.title, true);

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = processed.body;
    Array.from(tempDiv.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
        const p = document.createElement('p');
        p.textContent = node.textContent;
        tempDiv.replaceChild(p, node);
      }
    });
    tempDiv.querySelectorAll('p').forEach(pTag => {
      if (pTag.innerHTML.trim() === '' || pTag.innerHTML === '<br>') pTag.remove();
    });
    let safeBody = tempDiv.innerHTML;
    if (safeBody.trim() === '') safeBody = '<p>&nbsp;</p>';

    htmlFm += `<div class="chapter matter-page" style="break-before: right;"><div class="chapter-content ql-editor" id="ep-${ep.id}">${safeBody}</div></div>`;
  });

  if (targetEpId === 'fm') return htmlFm;

  bodyHtml = targetEpId ? '' : htmlFm;

  // 5. 본문 (목차 이후의 회차 및 뒷부속)
  afterTocEps.forEach((ep, i) => {
    if (targetEpId && targetEpId !== ep.id) return;
    const processed = processEpisodeBody(ep.body, ep.title, true);
    const isMatter = ep.type === 'frontmatter' || ep.type === 'backmatter';
    const renderTitle = false; // !isMatter && pubSet.showTitle && !processed.hasTitle;
    const displayTitle = getEpisodeDisplayTitle(ep, p);

    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = processed.body;
    Array.from(tempDiv.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '') {
        const p = document.createElement('p');
        p.textContent = node.textContent;
        tempDiv.replaceChild(p, node);
      }
    });
    tempDiv.querySelectorAll('p').forEach(pTag => {
      if (pTag.innerHTML.trim() === '' || pTag.innerHTML === '<br>') pTag.remove();
    });
    let safeBody = tempDiv.innerHTML;
    if (safeBody.trim() === '') safeBody = '<p>&nbsp;</p>';

    bodyHtml += `<div class="chapter ${isMatter ? 'matter-page' : ''}">` +
      (renderTitle ? `<div class="chapter-title">${escapeHtml(displayTitle)}</div>` : '') +
      `<div class="chapter-content ql-editor" id="ep-${ep.id}">${safeBody}</div></div>`;
  });

  return bodyHtml;
}

async function exportPODPdf(isSilent = false) {
  const p = currentProject();
  if (!p) return;

  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (eps.length === 0) {
    if (!isSilent) showToast('출판할 본문이 없습니다.');
    return;
  }

  let win;
  if (isSilent) {
    let iframe = document.getElementById('pod-calc-iframe');
    if (!iframe) {
      iframe = document.createElement('iframe');
      iframe.id = 'pod-calc-iframe';
      iframe.style.position = 'absolute';
      iframe.style.width = '0';
      iframe.style.height = '0';
      iframe.style.border = 'none';
      iframe.style.visibility = 'hidden';
      document.body.appendChild(iframe);
    }
    win = iframe.contentWindow;
  } else {
    // 브라우저 팝업 차단 우회를 위해 await 전에 창을 띄웁니다.
    win = window.open('', '_blank');
    if (!win) {
      showToast('팝업 차단을 해제하고 다시 시도해주세요.');
      return;
    }
    win.document.write('<div style="text-align:center; padding:50px; font-family:sans-serif;">PDF 변환을 준비 중입니다. 잠시만 기다려주세요...<br><br><small>본문 데이터가 많을 경우 수 초가 소요될 수 있습니다.</small></div>');
  }

  if (p.episodes.some(e => e.body === undefined)) {
    if (!isSilent) showToast('PDF 생성을 위해 데이터를 불러오는 중입니다...');
    await ensureProjectBodiesLoaded(p);
  }

  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  const mainStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');
  const pubSet = getPublishSettings(p);

  if (!isSilent) showToast('PDF 변환을 준비 중입니다...');

  let html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${escapeHtml(p.title)} - 출판용 원고</title>
<link href="https://fonts.googleapis.com/css2?family=KoPub+Batang&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/toss/tossface/dist/tossface.css">
<script src="https://unpkg.com/pagedjs/dist/js/paged.polyfill.js"></${'script'}>
<style>
${mainStyles}
</style>
<style>
  html, body {
    background: transparent !important;
  }
  @page front-matter {
    @bottom-center { content: none; }
  }
  .bg-colored {
    page: front-matter;
  }
  @page {
    size: ${pubSet.paperSize};
    margin: ${pubSet.margins?.top || 20}mm ${pubSet.margins?.outer || 18}mm ${pubSet.margins?.bottom || 20}mm ${pubSet.margins?.inner || 25}mm;
    @bottom-center {
      content: counter(page);
      font-size: 9pt;
      font-family: 'KoPub Batang', 'Noto Serif KR', serif;
    }
  }
  @page:left {
    margin: ${pubSet.margins?.top || 20}mm ${pubSet.margins?.inner || 25}mm ${pubSet.margins?.bottom || 20}mm ${pubSet.margins?.outer || 18}mm;
  }
  @page:right {
    margin: ${pubSet.margins?.top || 20}mm ${pubSet.margins?.outer || 18}mm ${pubSet.margins?.bottom || 20}mm ${pubSet.margins?.inner || 25}mm;
  }
  @page:first {
    @bottom-center { content: none; }
  }
  @page cover {
    margin: 0;
    @bottom-center { content: none; }
  }
  body {
    font-family: 'KoPub Batang', 'Noto Serif KR', serif;
    font-size: ${pubSet.fontSize || 10}pt;
    line-height: ${pubSet.lineHeight || 1.75};
    color: #111;
    background: transparent !important;
    text-align: justify;
    word-break: keep-all;
  }

  .ql-align-center { text-align: center !important; }
  .ql-align-right { text-align: right !important; }
  .ql-align-justify { text-align: justify !important; }
  .cover-page {
    page: cover;
    break-after: right;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100%;
    width: 100%;
    background-color: ${p.coverColor || '#2c2c2c'};
    color: #fff;
  }
  .title-page {
    break-before: right;
    break-after: page;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100%;
    text-align: center;
  }
  .title-page h1 { font-size: 24pt; margin-bottom: 20px; font-weight: 700; }
  .toc-page {
    break-before: right;
    break-after: page;
    padding-top: 40px;
  }
  .toc-page h2 {
    font-size: 16pt;
    font-weight: 700;
    margin-bottom: 40px;
    text-align: center;
  }
  .toc-list {
    list-style: none;
    padding: 0;
    margin: 0 20px;
    overflow-x: hidden;
  }
  .toc-list li {
    margin-bottom: 12px;
    font-size: 10pt;
    display: flex;
    align-items: baseline;
  }
  .toc-list li .toc-title {
    flex: 0 0 auto;
  }
  .toc-list li .toc-page-ref {
    color: inherit;
    text-decoration: none;
    flex: 0 0 auto;
  }
  .toc-list li .toc-dots {
    flex: 1 1 auto;
    border-bottom: 1px dotted #999;
    margin: 0 8px;
    position: relative;
    top: -4px;
  }
  .toc-list li .toc-page-ref::after {
    content: target-counter(attr(href), page);
  }
  .toc-prefix {
    color: #888;
    margin-right: 6px;
  }
  .chapter {
    break-before: page;
    margin-top: 40px;
  }
  .chapter.matter-page {
    break-before: right;
  }
  .chapter-title {
    font-size: 14pt;
    font-weight: 700;
    margin-bottom: 30px;
    text-align: center;
  }
  .chapter-content span {
    background-color: transparent !important;
  }
  .chapter-content p {
    text-indent: 10pt !important;
    margin: 0 !important;
    word-break: keep-all;
  }
  .chapter-content h1, .chapter-content h3 {
    margin-top: 1.5em !important;
    margin-bottom: 1em !important;
    line-height: 1.4;
  }
  .chapter-content h2 {
    margin-top: 1.5em !important;
    margin-bottom: 2.75em !important; /* ## 제목 아래 1줄 여백 추가 */
    line-height: 1.4;
  }
  .chapter-content .ql-size-huge,
  .chapter-content .ql-size-large {
    display: block;
    margin-top: 1.5em !important;
    margin-bottom: 1em !important;
    line-height: 1.4;
  }
  
  /* Paged.js Fallback for Narrative Blocks */
  .chapter-content p.pdf-group-isolated,
  .chapter-content p.pdf-group-last,
  .chapter-content .pdf-group-isolated,
  .chapter-content .pdf-group-last {
    margin-bottom: 24px !important;
    border-bottom-left-radius: 6px !important;
    border-bottom-right-radius: 6px !important;
    padding-bottom: 14px !important;
  }
  .chapter-content p.n-msg.pdf-group-isolated, .chapter-content p.n-msg.pdf-group-last,
  .chapter-content p.n-msg-y.pdf-group-isolated, .chapter-content p.n-msg-y.pdf-group-last,
  .chapter-content p.n-noti.pdf-group-isolated, .chapter-content p.n-noti.pdf-group-last {
    margin-bottom: 12px !important; padding-bottom: 10px !important; border-radius: 18px 18px 18px 2px !important;
  }
  
  .chapter-content p.pdf-group-first,
  .chapter-content p.pdf-group-middle,
  .chapter-content .pdf-group-first,
  .chapter-content .pdf-group-middle {
    margin-bottom: 0 !important;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
    padding-bottom: 4px !important;
  }
  .chapter-content p.n-msg.pdf-group-first, .chapter-content p.n-msg.pdf-group-middle,
  .chapter-content p.n-msg-y.pdf-group-first, .chapter-content p.n-msg-y.pdf-group-middle,
  .chapter-content p.n-noti.pdf-group-first, .chapter-content p.n-noti.pdf-group-middle,
  .chapter-content p.n-email.pdf-group-first, .chapter-content p.n-email.pdf-group-middle {
    margin-bottom: 4px !important;
    border-bottom-left-radius: 6px !important;
    padding-bottom: 10px !important;
  }
  
  .chapter-content p.pdf-group-middle,
  .chapter-content p.pdf-group-last,
  .chapter-content .pdf-group-middle,
  .chapter-content .pdf-group-last {
    margin-top: 0 !important;
    border-top-left-radius: 0 !important;
    border-top-right-radius: 0 !important;
    padding-top: 4px !important;
  }
  .chapter-content p.n-msg.pdf-group-middle, .chapter-content p.n-msg.pdf-group-last,
  .chapter-content p.n-msg-y.pdf-group-middle, .chapter-content p.n-msg-y.pdf-group-last,
  .chapter-content p.n-noti.pdf-group-middle, .chapter-content p.n-noti.pdf-group-last,
  .chapter-content p.n-email.pdf-group-middle, .chapter-content p.n-email.pdf-group-last {
    border-top-left-radius: 6px !important;
    padding-top: 10px !important;
  }
  .chapter-content p.n-email-body.pdf-group-middle, .chapter-content p.n-email-body.pdf-group-last,
  .chapter-content p.n-doc.pdf-group-middle, .chapter-content p.n-doc.pdf-group-last {
    padding-left: 38px !important;
  }

  /* Remove overrides that break print */
  html, body { height: auto !important; overflow: visible !important; }
  .ql-editor { padding: 0 !important; overflow-y: visible !important; height: auto !important; }
</style>
</head>
<body>
`;

  // ⚠️ 핵심 수정: isSilent(정밀계산용) 또는 coverExcluded(내지 전용 내보내기) 시 표지 완전 배제
  //    내지 PDF 내보내기 버튼은 exportPODPdf(false, true)로 호출 → 표지 없이 내지만 출력
  const coverExcluded = arguments[1] === true; // 2번째 인자가 true이면 내지 전용
  if (!isSilent && !coverExcluded && pubSet.includeCover !== false) {
    try {
      const coverB64 = await generateCoverPreview(p, pubSet);
      if (coverB64) {
        html += `<div class="cover-page" style="page: cover; break-after: right; margin: 0; padding: 0; width: 100vw; height: 100vh; overflow: hidden; display: flex; align-items: center; justify-content: center; background-color: #2c2c2c;"><img src="${coverB64}" style="width: 100%; height: 100%; object-fit: contain;"></div>`;
      }
    } catch (err) { console.warn('Cover rendering skipped:', err); }
  }

  html += generatePODBodyContent(p, pubSet, loadedEps);
  html += `
  <script>
    class PrintHandler extends window.Paged.Handler {
      afterRendered(pages) {
        if (window.parent && window.parent !== window) {
           window.parent.postMessage({ type: 'PAGES_READY', count: pages.length, isSilent: ${isSilent} }, '*');
        } else {
           window.opener?.postMessage({ type: 'PAGES_READY', count: pages.length, isSilent: false }, '*');
        }
        ${isSilent ? '' : 'setTimeout(() => window.print(), 500);'}
      }
    }
    window.Paged.registerHandlers(PrintHandler);
  </${'script'}>
</body>
</html>`;


  win.document.open();
  win.document.write(html);
  win.document.close();
}



// Export/Import
$('#exportBackupBtn').onclick = exportBackup;
$('#importBackupBtn').onclick = () => { $('#importInput').value = ''; $('#importInput').click(); };
$('#importInput').onchange = async () => {
  const file = $('#importInput').files?.[0]; if (!file) return;
  try {
    let jsonString = '';
    // 압축된 파일(.gz)인 경우 해제
    if (file.name.endsWith('.gz') && window.DecompressionStream) {
      const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      const text = await new Response(stream).text();
      jsonString = text;
    } else {
      jsonString = await file.text();
    }
    const data = JSON.parse(jsonString);
    if (Array.isArray(data.projects)) {
      importTempData = data;
      $('#importProjectCount').textContent = data.projects.length;
      openModal('importModal');
    } else throw new Error();
  } catch (e) {
    console.error(e);
    showToast('잘못된 백업 파일입니다.');
  }
};
$('#importReplaceBtn').onclick = () => handleImport('replace');
$('#importAddBtn').onclick = () => handleImport('add');


// Plan Import Logic

$('#attachPdfRawBtn').onclick = () => $('#attachPdfRawInput').click();
$('#attachPdfRawInput').onchange = async () => {
  const file = $('#attachPdfRawInput').files?.[0]; if (!file) return;
  if (file.type !== 'application/pdf') return showToast('PDF 파일만 원본으로 첨부할 수 있습니다.');
  if (!currentUser) return showToast('로그인 후 사용할 수 있습니다.');

  const p = currentProject();
  if (!p) return;

  $('#attachPdfRawBtn').textContent = '업로드 중...';
  try {
    // Supabase Storage에 업로드
    const storagePath = `${currentUser.id}/${p.id}/${uid('pdf')}_${file.name}`;
    const { data: uploadData, error: uploadErr } = await sb.storage
      .from('novel-pdfs')
      .upload(storagePath, file, { contentType: 'application/pdf', upsert: false });

    if (uploadErr) throw uploadErr;

    // 공개 URL 가져오기
    const { data: urlData } = sb.storage.from('novel-pdfs').getPublicUrl(storagePath);
    const pdfUrl = urlData?.publicUrl;

    // 기획 항목에 추가
    p.planSections = p.planSections || [];
    p.planSections.push({
      id: uid('plan'),
      title: '📎 ' + file.name.replace('.pdf', ''),
      type: 'pdf_attachment',
      pdfName: file.name,
      pdfUrl,
      body: '',
      open: true
    });

    touchProject();
    queueSaveFS();
    renderProjectPlan();
    closeModal('planImportModal');
    showToast('PDF가 쳊부되었습니다!');
  } catch (e) {
    console.error(e);
    // Storage 버킷이 없으면 안내
    if (e.message && (e.message.includes('bucket') || e.message.includes('not found') || e.message.includes('Bucket'))) {
      showToast('⚠️ Supabase Storage 버킷을 먼저 만들어주세요! (novel-pdfs 버킷, Public)');
    } else {
      showToast('PDF 업로드 실패: ' + (e.message || '알 수 없는 오류'));
    }
  } finally {
    $('#attachPdfRawBtn').textContent = '📎 PDF 원본 첨부하기';
    $('#attachPdfRawInput').value = '';
  }
};

$('#importPlanBtn').onclick = () => { $('#planImportText').value = ''; $('#planImportFileName').textContent = '선택된 파일 없음'; $('#planImportFileInput').value = ''; openModal('planImportModal'); };
$('#uploadPlanPdfBtn').onclick = () => $('#planImportFileInput').click();
$('#planImportFileInput').onchange = async () => {
  const file = $('#planImportFileInput').files?.[0]; if (!file) return;
  $('#planImportFileName').textContent = file.name;

  if (file.type === 'application/pdf') {
    $('#planImportText').value = 'PDF를 분석하는 중...';
    try {
      if (!window.pdfjsLib) throw new Error('PDF 라이브러리를 불러올 수 없습니다.');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const arrayBuffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      let fullText = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        let lastY, text = '';
        for (let item of textContent.items) {
          if (lastY !== item.transform[5] && text !== '') { text += '\n'; }
          text += item.str;
          lastY = item.transform[5];
        }
        fullText += text + '\n\n';
      }
      $('#planImportText').value = fullText;
    } catch (e) {
      console.error(e); $('#planImportText').value = 'PDF 분석 실패: ' + e.message;
    }
  } else if (file.name.endsWith('.docx')) {
    $('#planImportText').value = 'Word 문서를 분석하는 중...';
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = await mammoth.extractRawText({ arrayBuffer: arrayBuffer });
      $('#planImportText').value = result.value;
    } catch (e) {
      console.error(e); $('#planImportText').value = 'Word 분석 실패: ' + e.message;
    }
  } else {
    const reader = new FileReader();
    reader.onload = () => $('#planImportText').value = reader.result;
    reader.readAsText(file);
  }
};
$('#executePlanImportBtn').onclick = () => {
  const text = $('#planImportText').value;
  if (!text.trim()) return showToast('가져올 텍스트가 없습니다.');

  const lines = text.split('\n');
  const sections = [];
  let currentTitle = '기본 정보';
  let currentBody = [];

  const isHeader = (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.length > 50) return false;
    if (/^#+\s+(.*)/.test(trimmed)) return trimmed.replace(/^#+\s+/, '');
    if (/^\[(.*)\]$/.test(trimmed)) return trimmed.replace(/^\[|\]$/g, '');
    const numMatch = trimmed.match(/^(?:제\s*\d+\s*[장부]\s*)?(?:\d+[\.\)]|[IVX]+[\.\)])\s+(.+)$/);
    if (numMatch) return numMatch[1];
    const keywords = ['등장인물', '시놉시스', '줄거리', '세계관', '플롯', '로그라인', '주제', '기획의도', '배경', '캐릭터'];
    if (keywords.some(k => trimmed === k || trimmed === k + ':')) return trimmed.replace(/:$/, '');
    return false;
  };

  for (const line of lines) {
    const headerTitle = isHeader(line);
    if (headerTitle) {
      const bodyText = currentBody.join('\n').trim();
      if (bodyText.length > 0 || currentTitle !== '기본 정보') {
        sections.push(defaultPlanSection(currentTitle, bodyText));
      }
      currentTitle = headerTitle;
      currentBody = [];
    } else {
      currentBody.push(line);
    }
  }

  const lastBodyText = currentBody.join('\n').trim();
  if (lastBodyText.length > 0 || currentTitle !== '기본 정보') {
    sections.push(defaultPlanSection(currentTitle, lastBodyText));
  }

  const validSections = sections.filter(s => s.body.trim() !== '');
  if (validSections.length === 0) return showToast('변환할 항목을 찾지 못했습니다.');

  const p = currentProject();
  p.planSections = [...(p.planSections || []), ...validSections];
  touchProject(); queueSaveFS(); renderProjectPlan();
  closeModal('planImportModal');
  showToast(`${validSections.length}개의 항목을 가져왔어요.`);
};

// Global Keys & Modals
$$('[data-close]').forEach(b => b.onclick = () => closeModal(b.dataset.close));
$$('.modal-overlay').forEach(m => m.onclick = e => { if (e.target === m) m.classList.add('hidden') });
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === '.') { e.preventDefault(); toggleFocusMode(); }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && !$('#workspaceView').classList.contains('hidden')) { e.preventDefault(); $('#openSearchBtn').click(); }
  if (e.key === 'Escape') { if (isFocusMode) toggleFocusMode(); else $$('.modal-overlay').forEach(m => m.classList.add('hidden')); }
});
window.addEventListener('beforeunload', () => { persistEditor(); queueSaveFS(); });


const manualSaveBtn = $('#manualSaveBtn');
if (manualSaveBtn) {
  manualSaveBtn.onclick = () => {
    if (quill) {
      const ep = currentEpisode();
      if (ep) ep.body = quill.root.innerHTML;
    }
    forceSaveAllSupabase();
    showToast('수동으로 저장했습니다.');
  };
}


// 기존 Service Worker 해제 & 캐시 클리어
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(registrations => {
    registrations.forEach(r => r.unregister());
  });
  caches.keys().then(names => names.forEach(n => caches.delete(n)));
}

// Init
initApp();

// ─────────────────────────────────────────────────────────
// 📱  모바일 이북 뷰어
// ─────────────────────────────────────────────────────────
let ebookProjectId = null;
let ebookEpIndex = 0;

async function openEbook(projectId) {
  ebookProjectId = projectId;
  state.currentProjectId = projectId;
  const p = currentProject();

  if (p.episodes.some(e => e.body === undefined)) {
    showToast('프로젝트 본문을 불러오는 중입니다...');
    await ensureProjectBodiesLoaded(p);
  }

  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (!eps.length) { showToast('작성된 회차가 없습니다.'); return; }

  // 서재 숨기고 이북 뷰어 오픈
  $('#libraryView').classList.add('hidden');
  $('#ebookTitle').textContent = p.title;
  ebookEpIndex = 0;
  renderEbookPage(eps, ebookEpIndex);
  renderEbookEpList(eps);
  $('#ebookView').classList.add('open');
}

function renderEbookPage(eps, idx) {
  ebookEpIndex = idx;
  const ep = eps[idx];
  const p = currentProject();

  // 에피소드 당 배지 및 번호 계산
  let epLabel = '';
  const chapters = eps.filter(e => e.type === 'chapter');
  if (ep.type === 'prologue') epLabel = '프롤로그';
  else if (ep.type === 'epilogue') epLabel = '에필로그';
  else {
    const ci = chapters.findIndex(e => e.id === ep.id);
    epLabel = `${ci + 1}화 / ${chapters.length}화`;
  }

  const processed = processEpisodeBody(ep.body, ep.title);
  $('#ebookEpNum').textContent = epLabel;

  if (processed.hasTitle) {
    $('#ebookEpTitle').style.display = 'none';
  } else {
    $('#ebookEpTitle').style.display = 'block';
    $('#ebookEpTitle').textContent = ep.title;
  }

  $('#ebookContent').innerHTML = `<div class="ql-editor">${processed.body}</div>`;

  // 코멘트 오버레이 렌더
  renderEbookComments(ep);

  // 이전 / 다음 버튼
  // 이전 / 다음 버튼
  $('#ebookPrev').disabled = idx === 0;
  $('#ebookNext').disabled = idx === eps.length - 1;

  // 스크롤 맨 위로
  $('#ebookBody').scrollTop = 0;

  // 이북 목록 하이라이트 갱신
  $$('.ebook-ep-item').forEach((btn, i) => btn.classList.toggle('active', i === idx));

  // 텍스트 선택 시 코멘트 접기 버튼 표시
  attachEbookSelectionHandler(ep);
}

function renderEbookEpList(eps) {
  const list = $('#ebookEpList');
  // 핸들 유지 (first child)
  const handle = list.querySelector('.ebook-sheet-handle');
  list.innerHTML = '';
  if (handle) list.appendChild(handle);

  eps.forEach((ep, i) => {
    const btn = document.createElement('button');
    btn.className = 'ebook-ep-item' + (i === ebookEpIndex ? ' active' : '');
    let label = ep.title;
    // 챕터만 따로 세서 번호 매기기
    let badgeLabel = '';
    if (ep.type === 'prologue') badgeLabel = '프';
    else if (ep.type === 'epilogue') badgeLabel = '에';
    else {
      const chaptersBefore = eps.slice(0, i + 1).filter(e => e.type === 'chapter').length;
      badgeLabel = String(chaptersBefore);
    }
    btn.innerHTML = `<span class="ep-badge ${ep.type}">${badgeLabel}</span><span>${escapeHtml(label)}</span>`;
    btn.onclick = () => {
      renderEbookPage(eps, i);
      closeEbookSheet();
    };
    list.appendChild(btn);
  });
}

function closeEbookSheet() {
  $('#ebookEpSheet').classList.remove('open');
}

// 코멘트 관련
function getEpComments(ep) {
  if (!ep.comments) ep.comments = [];
  return ep.comments;
}


function renderEbookComments(ep) {
  const existing = $$('.ebook-comment-bubble');
  existing.forEach(b => b.remove());

  const comments = getEpComments(ep);
  const content = $('#ebookContent');

  // 코멘트 수 안내 배지
  const badge = document.getElementById('ebookCommentCount') || (() => {
    const b = document.createElement('div');
    b.id = 'ebookCommentCount';
    b.style.cssText = 'position:fixed;top:60px;right:14px;background:#6B5CE7;color:#fff;font-size:11px;font-weight:800;padding:3px 8px;border-radius:20px;z-index:50;display:none;';
    document.getElementById('ebookView').appendChild(b);
    return b;
  })();
  if (comments.length > 0) {
    badge.textContent = `개 코멘트 ${comments.length}`;
    badge.style.display = 'block';
    badge.onclick = () => showEbookCommentList(ep);
  } else {
    badge.style.display = 'none';
  }
}

function attachEbookSelectionHandler(ep) {
  const content = $('#ebookContent');

  const showTip = () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const selectedText = sel.toString().trim();
    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const old = document.getElementById('ebook-comment-tooltip');
    if (old) old.remove();

    const tip = document.createElement('div');
    tip.id = 'ebook-comment-tooltip';
    tip.innerHTML = `<span style="font-size:18px;">💬</span> 선택한 문장에 코멘트 달기`;

    // 모바일 기본 메뉴와 겹치지 않도록 하단 중앙 고정 플로팅 버튼으로 배치
    tip.style.cssText = `
      position: fixed;
      left: 50%;
      bottom: 80px;
      transform: translateX(-50%);
      background: #6B5CE7;
      color: #fff;
      font-size: 15px;
      font-weight: 800;
      padding: 14px 24px;
      border-radius: 30px;
      z-index: 99999;
      cursor: pointer;
      white-space: nowrap;
      box-shadow: 0 8px 24px rgba(107, 92, 231, 0.4);
      font-family: 'Pretendard', sans-serif;
      user-select: none;
      -webkit-user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
      animation: slideUp 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
    `;
    tip.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      tip.remove();
      const capturedText = selectedText;
      sel.removeAllRanges();
      openEbookCommentInput(ep, capturedText);
    };
    document.body.appendChild(tip);

    // 외부 탭 시 제거
    const dismiss = (ev) => {
      if (ev.target !== tip) {
        tip.remove();
        document.removeEventListener('pointerdown', dismiss);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', dismiss), 200);
  };

  // 모바일: touchend 이후 selectionchange
  // PC: mouseup 이후
  content.onmouseup = () => setTimeout(showTip, 50);
  document.addEventListener('selectionchange', () => {
    // 이북 뷰어가 열려있고 content 안의 selection일 때만
    if (!$('#ebookView').classList.contains('open')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim() && content.contains(sel.anchorNode)) {
      clearTimeout(content._selTipTimer);
      content._selTipTimer = setTimeout(showTip, 300);
    } else {
      const old = document.getElementById('ebook-comment-tooltip');
      if (old) old.remove();
    }
  });
}

function openEbookCommentInput(ep, selectedText) {
  // 모달 오버레이 생성
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,.5); backdrop-filter: blur(8px);
    display: flex; flex-direction: column; justify-content: flex-end;
    font-family: 'Pretendard', sans-serif;
  `;

  overlay.innerHTML = `
    <div style="background:#FAF7F0; border-radius:24px 24px 0 0; padding:20px 20px 36px;">
      <div style="width:36px;height:4px;background:rgba(0,0,0,.15);border-radius:2px;margin:0 auto 16px;"></div>
      <p style="font-size:11px;font-weight:700;color:#6B5CE7;margin:0 0 6px;">선택한 문장</p>
      <p style="font-size:14px;color:#2E2A25;background:#EFECE4;border-radius:10px;padding:10px 12px;margin:0 0 16px;line-height:1.6;">&ldquo;${escapeHtml(selectedText.slice(0, 100))}${selectedText.length > 100 ? '…' : ''}&rdquo;</p>
      <p style="font-size:11px;font-weight:700;color:#858793;margin:0 0 6px;">코멘트</p>
      <textarea id="ebookCommentInput" placeholder="아이디어, 수정 메모, 느낀 점 등을 자유롭게 남겨보세요!" style="width:100%;box-sizing:border-box;height:100px;border:1px solid rgba(0,0,0,.12);border-radius:12px;padding:12px;font-size:15px;font-family:inherit;resize:none;background:#fff;color:#1C1813;outline:none;line-height:1.6;"></textarea>
      <div style="display:flex;gap:10px;margin-top:12px;">
        <button id="ebookCommentCancel" style="flex:1;height:48px;border-radius:12px;border:1px solid rgba(0,0,0,.12);background:#EFECE4;color:#3B3529;font-size:15px;font-weight:700;cursor:pointer;">취소</button>
        <button id="ebookCommentSave" style="flex:2;height:48px;border-radius:12px;border:none;background:#6B5CE7;color:#fff;font-size:15px;font-weight:700;cursor:pointer;">저장</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  setTimeout(() => overlay.querySelector('#ebookCommentInput').focus(), 100);

  overlay.querySelector('#ebookCommentCancel').onclick = () => overlay.remove();
  overlay.querySelector('#ebookCommentSave').onclick = () => {
    const text = overlay.querySelector('#ebookCommentInput').value.trim();
    if (!text) { showToast('코멘트를 입력해주세요.'); return; }
    if (!ep.comments) ep.comments = [];
    ep.comments.push({
      id: uid('cmt'),
      quote: selectedText,
      text,
      createdAt: Date.now()
    });
    touchProject();
    queueSaveFS();
    renderEbookComments(ep);
    overlay.remove();
    showToast('하코멘트를 저장했습니다.');
  };

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) overlay.remove();
  });
}

function showEbookCommentList(ep) {
  const comments = getEpComments(ep);
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 1000;
    background: rgba(0,0,0,.5); backdrop-filter: blur(8px);
    display: flex; flex-direction: column; justify-content: flex-end;
    font-family: 'Pretendard', sans-serif;
  `;

  const items = comments.map((c, i) => `
    <div style="padding:14px 20px;border-bottom:1px solid rgba(0,0,0,.06);">
      <p style="font-size:12px;color:#6B5CE7;margin:0 0 4px;font-weight:700;">&ldquo;${escapeHtml(c.quote.slice(0, 60))}${c.quote.length > 60 ? '…' : ''}&rdquo;</p>
      <p style="font-size:14px;color:#1C1813;margin:0 0 6px;line-height:1.6;">${escapeHtml(c.text)}</p>
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11px;color:#858793;">${new Date(c.createdAt).toLocaleDateString('ko')}</span>
        <button data-del-comment="${i}" style="font-size:12px;color:#C94F68;background:none;border:none;cursor:pointer;font-weight:700;">삭제</button>
      </div>
    </div>
  `).join('');

  overlay.innerHTML = `
    <div style="background:#FAF7F0;border-radius:24px 24px 0 0;max-height:75vh;overflow-y:auto;">
      <div style="width:36px;height:4px;background:rgba(0,0,0,.15);border-radius:2px;margin:12px auto 0;"></div>
      <div style="padding:16px 20px 8px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(0,0,0,.06);">
        <p style="font-size:16px;font-weight:800;color:#1C1813;margin:0;">코멘트 ${comments.length}개</p>
        <button id="closeCommentList" style="background:none;border:none;font-size:22px;color:#858793;cursor:pointer;">×</button>
      </div>
      ${items || '<p style="padding:40px 20px;text-align:center;color:#858793;font-size:14px;">코멘트가 없습니다.</p>'}
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector('#closeCommentList').onclick = () => overlay.remove();
  overlay.querySelectorAll('[data-del-comment]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.dataset.delComment);
      ep.comments.splice(idx, 1);
      touchProject(); queueSaveFS();
      renderEbookComments(ep);
      overlay.remove();
      showEbookCommentList(ep);
    };
  });
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) overlay.remove(); });
}

// 이북 버튼 이벤트
$('#ebookBackBtn').onclick = () => {
  $('#ebookView').classList.remove('open');
  $('#libraryView').classList.remove('hidden');
  const old = document.getElementById('ebook-comment-tooltip');
  if (old) old.remove();
};

$('#ebookEpListBtn').onclick = () => {
  const sheet = $('#ebookEpSheet');
  sheet.classList.toggle('open');
};

$('#ebookEpSheet').onclick = (e) => {
  if (e.target === $('#ebookEpSheet')) closeEbookSheet();
};

$('#ebookPrev').onclick = () => {
  const p = currentProject();
  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (ebookEpIndex > 0) renderEbookPage(eps, ebookEpIndex - 1);
};

$('#ebookNext').onclick = () => {
  const p = currentProject();
  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (ebookEpIndex < eps.length - 1) renderEbookPage(eps, ebookEpIndex + 1);
};

// 코멘트는 Supabase 에피소드에 저장됨 (ep.comments 필드)
// forceSaveAllSupabase 에서 ep.plan 저장할 때쳀럼 JSON.stringify로 함께 저장
// [클릭 이벤트용 공통 함수] 전면부 리스트나 구조도 트리 항목을 클릭할 때 이 함수를 호출하게 하세요!
function runHiddenPagedJsForTree(p) {
  let hiddenIframe = document.getElementById('podHiddenPagedjsIframe');
  if (!hiddenIframe) {
    hiddenIframe = document.createElement('iframe');
    hiddenIframe.id = 'podHiddenPagedjsIframe';
    hiddenIframe.style.cssText = 'position:absolute; width:1000px; height:1000px; left:-9999px; top:-9999px; visibility:hidden; pointer-events:none;';
    document.body.appendChild(hiddenIframe);
  }

  const pubSet = getPublishSettings(p);
  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  let htmlContent = generatePODBodyContent(p, pubSet, loadedEps);

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlContent, 'text/html');
  const removeComments = (node) => {
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      if (node.childNodes[i].nodeType === 8) node.childNodes[i].remove();
      else if (node.childNodes[i].nodeType === 1) removeComments(node.childNodes[i]);
    }
  };
  removeComments(doc.body);
  removeComments(doc.body);
  htmlContent = doc.body.innerHTML;

  const m = {
    top: parseFloat($('#podMarginTop')?.value) || pubSet.margins?.top || 20,
    bottom: parseFloat($('#podMarginBottom')?.value) || pubSet.margins?.bottom || 20,
    inner: parseFloat($('#podMarginInner')?.value) || pubSet.margins?.inner || 25,
    outer: parseFloat($('#podMarginOuter')?.value) || pubSet.margins?.outer || 18,
    bleed: parseFloat($('#podBleed')?.value) || pubSet.margins?.bleed || 3
  };

  const pageCSS = `@page {
    size: ${pubSet.paperSize || 'A5'};
    margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm;
  }
  @page:left  { margin: ${m.top}mm ${m.inner}mm ${m.bottom}mm ${m.outer}mm; }
  @page:right { margin: ${m.top}mm ${m.outer}mm ${m.bottom}mm ${m.inner}mm; }
  @page:first { @bottom-center { content:none; } }
  @page cover { margin:0; @bottom-center { content:none; } }`;

  const bodyCSS = `body {
    font-family:'KoPub Batang','Noto Serif KR',serif;
    font-size:${parseFloat($('#podFontSize')?.value) || pubSet.fontSize || 10}pt;
    line-height:${$('#podLineHeight')?.value || pubSet.lineHeight || 1.75};
    color:#111; text-align:justify; word-break:keep-all;
  }
  .ql-align-center { text-align:center !important; }
  .ql-align-right  { text-align:right  !important; }
  .chapter { break-before:page; margin-top:40px; }
  .chapter.matter-page { break-before:right; }
  .chapter-title { font-size:14pt; font-weight:700; margin-bottom:30px; text-align:center; }
  .chapter-content span { background-color:transparent !important; }
  .chapter-content p { text-indent:10pt !important; margin:0 !important; }
  .ql-editor { padding:0 !important; overflow-y:visible !important; height:auto !important; }
  img { max-width: 100% !important; width: 100% !important; height: auto !important; object-fit: contain; display: block; margin: 10px auto; }`;

  const mainStyles = Array.from(document.querySelectorAll('style')).map(s => s.innerHTML).join('\n');

  const iframeHtml = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=KoPub+Batang&family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/toss/tossface/dist/tossface.css">
<script>
  ${(window.POD_PAGEDJS_CODE || '').replace(/<\/script>/gi, '<\\/script>')}
</script>
<style>
  html, body { background: transparent !important; }
  ${mainStyles}
  ${pageCSS}
  ${bodyCSS}
</style>
</head>
<body>
  ${htmlContent}
  <script>
    if (!window.Paged || !window.Paged.Handler) {
      window.parent.postMessage({ type:'pagedjs-error', error:'PagedJS 로드 실패' }, '*');
    } else {
      class HiddenPrintHandler extends window.Paged.Handler {
        afterRendered(pages) {
          try {
            var map = pages.map(function(pg) {
              var el  = pg.element || pg.pageNode || pg.wrapper;
              var num = el ? (parseInt(el.getAttribute('data-page-number'), 10) || 0) : 0;
              var fm  = el && el.querySelector('[data-fm-label]');
              var ch  = el && el.querySelector('.chapter-title,.chapter-content h1');
              
              var contentNode = el && el.querySelector('.pagedjs_page_content');
              var innerHtml = contentNode ? contentNode.innerHTML : '';
              
              return {
                pageNum: num,
                label: fm ? fm.getAttribute('data-fm-label') : (ch ? ch.textContent.trim().substring(0,14) : num+'쪽'),
                epTitle: ch ? ch.textContent.trim() : '',
                htmlContent: innerHtml
              };
            });
            
            window.parent.postMessage({ type:'pagedjs-rendered', totalPages:pages.length, pageMap:map, isTreeMode:true }, '*');
          } catch(err) {
            window.parent.postMessage({ type:'pagedjs-error', error:'afterRendered:'+err.message }, '*');
          }
        }
      }
      window.Paged.registerHandlers(HiddenPrintHandler);
      
      // 이미지 및 폰트 대기 후 수동 렌더링 시작
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        ...Array.from(document.images).filter(img => !img.complete).map(img => new Promise(res => { img.onload = img.onerror = res; }))
      ]).then(function() {
        window.PagedPolyfill.preview(document.body, [], document.body).catch(function(err) {
          window.parent.postMessage({ type:'pagedjs-error', error:err.message }, '*');
        });
      });
    }
  </script>
</body>
</html>`;

  hiddenIframe.removeAttribute('srcdoc');
  const win = hiddenIframe.contentWindow;
  win.document.open();
  win.document.write(iframeHtml);
  win.document.close();
}

function podGoToPage(pageNum, isSpread) {
  const iframe = document.getElementById('podLiveIframe');
  if (iframe && iframe.contentDocument) {
    const rightTitle = iframe.contentDocument.querySelector('.page-right h2');
    const rightBody = iframe.contentDocument.querySelector('.page-right > div > div:nth-child(2)');
    const leftTitle = iframe.contentDocument.querySelector('.page-left h2');
    const leftBody = iframe.contentDocument.querySelector('.page-left > div > div:nth-child(2)');
    
    const renderSinglePage = (pData, titleEl, bodyEl) => {
      if (!pData) {
        if (titleEl) titleEl.textContent = '';
        if (bodyEl) bodyEl.innerHTML = '';
        return;
      }
      if (titleEl) {
         titleEl.textContent = pData.label || pData.pageNum + '쪽';
         titleEl.style.display = 'block';
      }
      if (bodyEl) {
         if (pData.htmlContent) {
           bodyEl.innerHTML = pData.htmlContent;
         } else {
           bodyEl.innerHTML = '<div style="text-align:center; padding:50px; color:#999;">빈 면지</div>';
         }
         bodyEl.style.display = 'block';
      }
    };

    const isOddPage = pageNum % 2 !== 0;
    const leftPageNum = isOddPage ? pageNum - 1 : pageNum;
    const rightPageNum = isOddPage ? pageNum : pageNum + 1;
    const leftPageData = window.podPageMap ? window.podPageMap.find(d => d.pageNum === leftPageNum) : null;
    const rightPageData = window.podPageMap ? window.podPageMap.find(d => d.pageNum === rightPageNum) : null;

    renderSinglePage(leftPageData, leftTitle, leftBody);
    renderSinglePage(rightPageData, rightTitle, rightBody);
  }
}
