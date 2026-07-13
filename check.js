
const STORAGE_KEY = 'munjang-novel-writer-v3';
// --- 강제 캐시 초기화 (Service Worker 킬러) ---
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(registrations) {
    for(let registration of registrations) { registration.unregister(); }
  });
  if (window.caches) {

    caches.keys().then(function(names) {
      for (let name of names) { caches.delete(name); }
    });
  }
}


const VERSION_LIMIT = 5, VERSION_INTERVAL = 5*60*1000;
const DEFAULT_COVER_COLOR = '#6B5CE7';
const COVER_COLORS = ['#17141F','#6B5CE7','#6D9DF6','#5CB6C9','#46A57F','#F39AB9','#F5B86C','#B4A5FF','#8C91A5','#E4E6ED'];

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

function uid(prefix='id') { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; }
function defaultEpisode(type='prologue', index=0) { return { id: uid('ep'), type, title: '', status: 'idea', plan: '', body: '', versions: [], lastVersionAt: Date.now(), _dirty: true }; }
function defaultPlanSection(title='새 기획 항목', body='') { return { id: uid('plan'), title, body, open: true }; }
function normalizeProject(p) { p.cover=p.cover||''; p.coverColor=p.coverColor||DEFAULT_COVER_COLOR; p.planSections=p.planSections||[]; p.planSections=p.planSections.map(x=>({id:x.id||uid('plan'),title:x.title||'제목 없는 항목',body:x.body||'',open:x.open!==false})); return p; }

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
    console.log('Auth event:', event);
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') && session && !currentUser) {
      showToast('로그인 성공! 서재를 불러옵니다...');
      currentUser = session.user;
      $('#welcomeScreen').style.display = 'none';
      try {
        await Promise.race([
          migrateFromLocalStorage(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Migration Timeout')), 15000))
        ]);
      } catch(err) {
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
  sb.auth.getSession().then(async ({ data: { session } }) => {
    if (session && !currentUser) {
      console.log('Manual session recovery successful');
      showToast('세션을 복구했습니다. 서재를 불러옵니다...');
      currentUser = session.user;
      $('#welcomeScreen').style.display = 'none';
      try { await migrateFromLocalStorage(); } catch(e) {}
      try { await loadStateSupabase(); } catch(e) { showToast('DB 로딩 지연. 새로고침 해주세요.'); }
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
        provider: 'google',
        options: {
          redirectTo: window.location.origin
        }
      });
      if(error) throw error;
    } catch(err) {
      console.error(err);
      $('#googleLoginBtn').style.opacity = '1';
      $('#googleLoginBtn').innerHTML = 'Google 계정으로 시작하기';
      if($('#authError')) $('#authError').innerHTML = '구글 로그인 실패: ' + err.message;
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
    } catch(saveErr) {
      console.error('Save before logout failed:', saveErr);
      showToast('⚠️ 저장 실패: ' + (saveErr.message || '알 수 없는 오류') + '\n강제 로그아웃합니다.');
    }
    
    // 강제 로그아웃 처리
    currentUser = null;
    try {
      await sb.auth.signOut();
    } catch(e) {
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
    } catch(e) {}
    
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
  } catch(e) { 
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
        ep.comments = (() => { try { return d.comments ? JSON.parse(d.comments) : []; } catch(_) { return []; } })();
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
      } catch(e) {}
      currentUser = null;
      window.location.href = window.location.origin;
    }
    return; 
  }
  
  
  if (projectsData && projectsData.length > 0) {
    // 버전을 로컬 백업에서 복원!
    try {
      const localDataStr = localStorage.getItem('novel_emergency_backup');
      if (localDataStr) {
        const localState = JSON.parse(localDataStr);
        for (const pRow of projectsData) {
          const lp = localState.find(x => x.id === pRow.id);
          if (lp && lp.episodes) {
            pRow._localEpisodes = lp.episodes; // 임시 저장
          }
        }
      }
    } catch(e) {}

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
      // 에피소드 매핑
      if (episodesData) {
        p.episodes = episodesData.filter(e => e.project_id === p.id).map(e => ({
          id: e.id,
          type: e.type,
          title: e.title,
          status: e.status,
          createdAt: e.created_at,
          updatedAt: e.updated_at,
          versions: (pRow._localEpisodes?.find(x => x.id === e.id)?.versions || []).slice(0, 5),
          order: e.order_idx,
          _dirty: false
        })).sort((a,b) => a.order - b.order); // 서버의 order_idx로 정렬
      }
      if(p.episodes.length > 0) p.selectedEpisodeId = p.episodes[0].id;
      newState.projects.push(p);
    }
  } else {
    // 신규 유저 템플릿
    const p = {id:uid('project'),title:'신이 있는 교실',status:'serializing',cover:'',coverColor:DEFAULT_COVER_COLOR,updatedAt:Date.now(),selectedEpisodeId:null,viewMode:'split',planSections:[defaultPlanSection('작품 핵심','권력을 가진 교사가...')],episodes:[]};
    const ep = defaultEpisode('prologue'); p.episodes.push(ep); p.selectedEpisodeId = ep.id;
    newState.projects.push(p);
    state = newState;
    await forceSaveAllSupabase();
    return;
  }
  
  state = newState;
  if(state.projects.length > 0) state.currentProjectId = state.projects[0].id;
}

async function forceSaveAllSupabase() {
  if(!currentUser) return;
  if($('#saveStatus')) $('#saveStatus').textContent = '저장 중...';
  try {
    for (const p of state.projects) { await saveProjectSupabase(p); }
    if($('#saveStatus')) $('#saveStatus').textContent = `저장됨 · ${new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})}`;
  } catch(e) {
    console.error(e);
    if($('#saveStatus')) $('#saveStatus').textContent = '저장 실패';
  }
}

function queueSaveFS() {
  if(!currentUser) return;
  if($('#saveStatus')) $('#saveStatus').textContent='저장 중…';
  
  // 서버 에러나 오프라인에 대비한 로컬 2중 백업 (버전 기록 포함 완벽 보존)
  try {
    localStorage.setItem('novel_emergency_backup', JSON.stringify(state.projects));
  } catch(e) { console.warn('Local backup failed', e); }

  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => forceSaveAllSupabase(), 1500);
}

async function saveProjectSupabase(p) {
  if(!currentUser) return;
  
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
  if(!confirm('정말 이 회차를 삭제하시겠습니까?\n(삭제 후 복구할 수 없습니다)')) return;
  const p = currentProject(); if(!p) return;
  const idx = p.episodes.findIndex(e=>e.id===epId);
  if(idx===-1) return;
  
  p.episodes.splice(idx, 1);
  if(p.selectedEpisodeId === epId) p.selectedEpisodeId = p.episodes[0]?.id || null;
  
  // Supabase Delete
  if(currentUser) {
    await sb.from('novel_episodes').delete().eq('id', epId);
  }
  
  touchProject();
  queueSaveFS();
  renderWorkspace();
}
// --- End Supabase Cloud Logic ---

function currentProject() { return state.projects.find(p=>p.id===state.currentProjectId) || state.projects[0]; }
function currentEpisode() { const p=currentProject(); return p?.episodes.find(e=>e.id===p.selectedEpisodeId) || p?.episodes[0]; }
function touchProject() { const p=currentProject(); if(p) { p.updatedAt = Date.now(); p._dirty = true; } }
function cleanText(t='') { 
  let s = String(t);
  if (s.includes('<p') || s.includes('<br')) {
    const d = document.createElement('div'); 
    d.innerHTML = s; 
    s = d.innerText || d.textContent || '';
  }
  return s.replace(/\r\n/g,'\n').replace(/[\t\u00A0]+/g,' ').replace(/[ ]+\n/g,'\n').replace(/\n{4,}/g,'\n\n\n').trim(); 
}
function stats(t='') { 
  let text = String(t).replace(/<p[^>]*>/gi, '\n').replace(/<br[^>]*>/gi, '\n').replace(/<[^>]+>/g, '');
  text = text.replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/gi, ' ').trim();
  const withSpaces = Array.from(text).length; 
  return { withSpaces, manuscript: Math.ceil(withSpaces/200) }; 
}
function escapeHtml(v='') { return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c])); }
function showToast(msg) { clearTimeout(toastTimer); $('#toast').textContent=msg; $('#toast').classList.add('show'); toastTimer=setTimeout(()=>$('#toast').classList.remove('show'),2100); }
function openModal(id) { $('#'+id).classList.remove('hidden'); } function closeModal(id) { $('#'+id).classList.add('hidden'); }

// Scroll State Management
function saveEditorScroll() {
  const ep = currentEpisode(); if(!ep) return;
  const body = $('#bodyEditor');
  episodeScrollState.set(ep.id, { plan: $('#planEditor').scrollTop, body: body.scrollTop, start: body.selectionStart, end: body.selectionEnd });
}
function restoreEditorScroll() {
  const ep = currentEpisode(); if(!ep) return;
  const st = episodeScrollState.get(ep.id) || { plan: 0, body: 0, start: 0, end: 0 };
  requestAnimationFrame(() => {
    $('#planEditor').scrollTop = st.plan;
    const body = $('#bodyEditor');
    body.scrollTop = st.body;
    if (typeof body.setSelectionRange === 'function') body.setSelectionRange(st.start, st.end);
  });
}

function autosizePlanSection(el, min=250) {
  // resize:vertical이 적용된 경우(기획 드로어 textarea) 자동 높이 조정 생략
  if (el.style.resize === 'vertical' || getComputedStyle(el).resize === 'vertical') return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(min, el.scrollHeight + 24)}px`;
}

// Cover
function coverTextColor(hex) { const v=String(hex||'').trim().slice(1); const r=parseInt(v.slice(0,2),16),g=parseInt(v.slice(2,4),16),b=parseInt(v.slice(4,6),16); return (0.2126*r+0.7152*g+0.0722*b)/255 > 0.67 ? '#17141F' : '#FFFFFF'; }
function coverPlaceholderMarkup(p) {
  const c = p.coverColor || DEFAULT_COVER_COLOR, t = coverTextColor(c);
  return `<span class="book-placeholder" style="--cover-color:${c};--cover-text:${t}"><strong>${escapeHtml(p.title)}</strong></span>`;
}

// Library
function renderLibrary() {
  $('#allCount').textContent = state.projects.length;
  $('#serializingCount').textContent = state.projects.filter(p=>p.status==='serializing').length;
  $('#completedCount').textContent = state.projects.filter(p=>p.status==='completed').length;
  $$('.filter-btn').forEach(b=>b.classList.toggle('active',b.dataset.filter===libraryFilter));
  const projects = (libraryFilter === 'all' ? state.projects : state.projects.filter(p=>p.status===libraryFilter)).sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  $('#projectGrid').innerHTML = projects.length ? projects.map(p=>{
    const total = p.episodes.reduce((s,e)=>s+stats(e.body||'').withSpaces,0);
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
    $$('.kebab-menu.show').forEach(m => { if(m !== menu) m.classList.remove('show'); });
    menu.classList.toggle('show');
  });
  $$('[data-kebab-cover]').forEach(b => b.onclick = (e) => { e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show')); openCoverSettings(b.dataset.kebabCover); });
  $$('[data-rename-project]').forEach(b => b.onclick = (e) => {
    e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show'));
    const proj = state.projects.find(x => x.id === b.dataset.renameProject); if(!proj) return;
    const nt = prompt('새 작품 제목을 입력하세요.', proj.title);
    if(nt && nt.trim()) { proj.title = nt.trim(); touchProject(); queueSaveFS(); renderLibrary(); }
  });
  $$('[data-delete-project]').forEach(b => b.onclick = async (e) => {
    e.stopPropagation(); $$('.kebab-menu').forEach(m => m.classList.remove('show'));
    const proj = state.projects.find(x => x.id === b.dataset.deleteProject);
    if(confirm((proj ? proj.title : '이 작품') + '을(를) 삭제할까요?\n삭제한 작품은 복구할 수 없습니다.')) {
      const delId = b.dataset.deleteProject;
      state.projects = state.projects.filter(x => x.id !== delId);
      if(state.currentProjectId === delId) state.currentProjectId = null;
      // Supabase에서도 삭제
      if (currentUser) {
        try {
          await sb.from('novel_episodes').delete().eq('project_id', delId);
          await sb.from('novel_projects').delete().eq('id', delId);
        } catch(e) { console.error('Delete from DB failed:', e); }
      }
      renderLibrary();
    }
  });
  // 서재 필터 기본값을 'all'로 초기화
  if (!state.projects.some(p => p.status === libraryFilter) && libraryFilter !== 'all') libraryFilter = 'all';
  setTimeout(() => window.addEventListener('click', () => $$('.kebab-menu').forEach(m => m.classList.remove('show')), {once: true}), 0);
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
function orderedEpisodes(p=currentProject()) {
  const pr = p.episodes.filter(e=>e.type==='prologue');
  const ch = p.episodes.filter(e=>e.type==='chapter');
  const ep = p.episodes.filter(e=>e.type==='epilogue');
  return [...pr, ...ch, ...ep];
}
function reorderEpisode(targetId) {
  if(!draggedId || draggedId===targetId) return;
  const p = currentProject();
  const dragged = p.episodes.find(e=>e.id===draggedId);
  const target = p.episodes.find(e=>e.id===targetId);
  if(!dragged || !target || dragged.type!=='chapter' || target.type!=='chapter') { draggedId=null; return; }
  
  const ch = p.episodes.filter(e=>e.type==='chapter');
  const fIdx = ch.findIndex(e=>e.id===draggedId);
  const tIdx = ch.findIndex(e=>e.id===targetId);
  const [m] = ch.splice(fIdx, 1);
  ch.splice(tIdx, 0, m);
  
  p.episodes = [...p.episodes.filter(e=>e.type==='prologue'), ...ch, ...p.episodes.filter(e=>e.type==='epilogue')];
  p.episodes.forEach(e => e._dirty = true);
  touchProject(); queueSaveFS(); renderEpisodeList(); draggedId=null;
}

// Workspace
function renderWorkspace() {
  const p = currentProject(); if(!p) return showLibrary();
  $('#projectTitle').value = p.title; $('#projectStatus').value = p.status; $('#projectBreadcrumb').textContent = p.title;
  setViewMode(p.viewMode||'split', false);
  renderEpisodeList(); renderEpisode(); updateProjectStats();
}



function renderEpisodeList() {
  const p = currentProject(), eps = orderedEpisodes(p);
  $('#episodeList').innerHTML = '';
  let chapterIdx = 1;
  eps.forEach(ep=>{
    const isChap = ep.type==='chapter';
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
    row.className = `episode-row ${ep.id===p.selectedEpisodeId?'active':''}`;
    row.draggable = isChap;
    row.innerHTML = `<span class="drag" title="\ub4dc\ub798\uadf8\ud558\uc5ec \uc21c\uc11c \ubcc0\uacbd">\u22ee</span><div class="episode-main"><strong><span style="display:inline-flex; align-items:center; gap:4px; max-width:100%;">${badgeHtml}<span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHtml(dispTitle)}</span></span></strong><span>${stats(ep.body).withSpaces.toLocaleString()}\uc790</span></div>` + 
                    (isChap ? `<button class="icon-btn delete-ep-btn" title="\uc0ad\uc81c" onclick="event.stopPropagation(); deleteEpisode('${ep.id}')" style="opacity:0; transition:opacity .15s;"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>` : '');
    row.querySelector('.episode-main').onclick = ()=>selectEpisode(ep.id);
    if(ep.type==='chapter') {
      row.ondragstart = ()=>{ draggedId=ep.id; row.classList.add('dragging'); };
      row.ondragover = e=>e.preventDefault();
      row.ondrop = e=>{ e.preventDefault(); reorderEpisode(ep.id); };
      row.ondragend = ()=>row.classList.remove('dragging');
    }
    $('#episodeList').appendChild(row);
  });
  requestAnimationFrame(()=>{ const el = $('.episode-row.active'); if(el) el.scrollIntoView({block:'nearest'}); });
}



function renderEpisode() {
  const ep = currentEpisode(); if(!ep) return;
  $('#episodeTitle').value = ep.title; $('#episodeType').value = ep.type; $('#episodeBreadcrumb').textContent = getEpisodeDisplayTitle(ep, p);
  $('#planEditor').value = ep.plan||'';
  if($('#planMdPreview')) $('#planMdPreview').innerHTML = window.marked ? marked.parse(ep.plan || '이번 화 기획이나 메모를 자유롭게 적으세요.') : escapeHtml(ep.plan || '이번 화 기획이나 메모를 자유롭게 적으세요.');
  if($('#planMdPreview')) $('#planMdPreview').classList.remove('hidden');
  if($('#planEditor')) $('#planEditor').classList.add('hidden');
  if(!quill) {
    const icons = Quill.import('ui/icons');
    
    // 서사 블록 (Narrative) Attributor 등록
    const Parchment = Quill.import('parchment');
    const ClassAttributor = Parchment.Attributor.Class;
    const NarrativeClass = new ClassAttributor('narrative', 'n', {
      scope: Parchment.Scope.BLOCK,
      whitelist: ['msg', 'sys', 'log', 'alert', 'record', 'status']
    });
    Quill.register(NarrativeClass, true);

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
    
    try {
      quill = new Quill('#bodyEditor', {
      theme: 'snow',
      placeholder: '첫 문장을 시작하세요...',
      modules: {
        toolbar: [
          [{ 'header': [1, 2, 3, false] }],
          [{ 'narrative': [false, 'msg', 'sys', 'log', 'alert', 'record', 'status'] }],
          ['bold', 'italic', 'underline', 'strike', 'ui'],
          ['clean']
        ]
      }
    });

    setTimeout(() => {
      const toolbarGroups = document.querySelectorAll('.ql-toolbar .ql-formats');
      if (toolbarGroups.length >= 3 && !document.querySelector('.ql-ui')) {
        const btn = document.createElement('button');
        btn.className = 'ql-ui';
        btn.title = 'UI 강조 (확인, 선택 등)';
        toolbarGroups[2].appendChild(btn);
      }
    }, 100);

    quill.on('text-change', (delta, oldDelta, source) => {
      const ep = currentEpisode();
      ep.body = quill.root.innerHTML;
      ep._dirty = true;
      maybeVersion(ep); touchProject(); updateBodyStats(); queueSaveFS();
      // 성능 최적화: 타이핑 중 에피소드 목록 전체 리렌더 제거 (자수만 업데이트)
    });
  }
  
  if (quill.root.innerHTML !== (ep.body||'<p><br></p>')) {
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



function selectEpisode(id) { persistEditor(); saveEditorScroll(); currentProject().selectedEpisodeId=id; touchProject(); queueSaveFS(); showEditor(); renderEpisode(); }
function persistEditor() { if($('#workspaceView').classList.contains('hidden') || $('#manuscriptView').classList.contains('active')) return; const p=currentProject(), ep=currentEpisode(); if(!p||!ep) return; ep.title=$('#episodeTitle').value.trim()||'제목 없는 회차'; ep.type=$('#episodeType').value; ep.plan=$('#planEditor').value; ep.body=quill?quill.root.innerHTML:$('#bodyEditor').innerHTML; ep._dirty = true; }
function updateProjectStats() { const p=currentProject(); if(!p) return; const total = p.episodes.reduce((s,e)=>s+stats(e.body||'').withSpaces,0); $('#projectStats').textContent = `총 ${total.toLocaleString()}자`; $('#projectBreadcrumb').textContent = p.title; }
function updateBodyStats() { const s=stats(quill?quill.getText():$('#bodyEditor').innerText||''); $('#bodyStats').textContent = `${s.withSpaces.toLocaleString()}자 · 원고지 ${s.manuscript}매`; updateProjectStats(); }
function setViewMode(mode, save=true) { saveEditorScroll(); const p=currentProject(); if(p) p.viewMode=mode; $('#editorColumns').className=`editor-columns mode-${mode}`; $$('.view-tab').forEach(b=>b.classList.toggle('active',b.dataset.mode===mode)); if(save) queueSaveFS(); restoreEditorScroll(); }
function addEpisode() { const title = prompt('새 회차의 제목을 입력하세요 (예: 불길한 징조)'); if(title===null) return; const t = title.trim(); persistEditor(); const p=currentProject(); const ep=defaultEpisode('chapter', 1); ep.title = t; if(t.includes('프롤로그')) ep.type='prologue'; else if(t.includes('에필로그')) ep.type='epilogue'; p.episodes.push(ep); p.selectedEpisodeId=ep.id; p.episodes=orderedEpisodes(p); touchProject(); queueSaveFS(); showEditor(); renderEpisodeList(); renderEpisode(); showToast('회차를 추가했어요.'); }

function togglePlanDrawer() {
  saveEditorScroll();
  isPlanDrawerOpen = !isPlanDrawerOpen;
  $('#planDrawer').classList.toggle('open', isPlanDrawerOpen);
  if(isPlanDrawerOpen) renderProjectPlan();
  restoreEditorScroll();
}

function maybeVersion(ep, force=false) {
  const now = Date.now();
  if(!force && now-(ep.lastVersionAt||0) < VERSION_INTERVAL) return;
  if(!cleanText(ep.body)) return;
  ep.versions = ep.versions || [];
  if(ep.versions[0]?.body === ep.body) return;
  ep.versions.unshift({ id: uid('ver'), createdAt: now, body: ep.body });
  ep.versions = ep.versions.slice(0, VERSION_LIMIT);
  ep.lastVersionAt = now;
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
  let blob = new Blob([jsonString], {type:'application/json'});
  let filename = `야니의_소설창고_backup_${new Date().toISOString().slice(0,10)}.json`;
  
  // CompressionStream을 지원하는 브라우저인 경우 gzip 압축
  if (window.CompressionStream) {
    try {
      const stream = new Response(blob).body.pipeThrough(new CompressionStream('gzip'));
      blob = await new Response(stream).blob();
      filename += '.gz';
    } catch(e) {
      console.warn('압축 실패, 원본 JSON으로 다운로드합니다.', e);
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url;
  a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}
function remapImportedProject(project) {
  const episodeIdMap = new Map();
  const episodes = (project.episodes||[]).map(ep => {
    const newId = uid('ep'); episodeIdMap.set(ep.id, newId);
    return { ...ep, id: newId, versions: (ep.versions||[]).map(v=>({ ...v, id: uid('ver') })) };
  });
  return {
    ...project,
    id: uid('project'),
    selectedEpisodeId: episodeIdMap.get(project.selectedEpisodeId) || episodes[0]?.id || null,
    planSections: (project.planSections||[]).map(sec=>({ ...sec, id: uid('plan') })),
    episodes
  };
}
async function handleImport(mode) {
  if(!importTempData || !importTempData.projects) return;
  try {
    let newState = mode === 'replace' ? importTempData : { ...state, projects: [...state.projects, ...importTempData.projects.map(remapImportedProject)] };
    state = newState;
    closeModal('importModal');
    showToast('클라우드에 백업 데이터를 동기화 중입니다...');
    await forceSaveAllSupabase();
    if($('#libraryView').classList.contains('hidden')) { renderWorkspace(); } else { renderLibrary(); }
    showToast(mode==='replace'?'백업 데이터를 완벽하게 복원했어요!':'백업 데이터를 추가했어요!');
  } catch(e) {
    console.error(e);
    showToast('저장 중 오류가 발생했습니다.');
  }
}

// Cover Settings
function openCoverSettings(projectId) {
  coverTargetProjectId = projectId;
  const p = state.projects.find(x=>x.id===projectId); if(!p) return;
  // Render preview
  const preview = $('#coverPreview');
  if(p.cover) { preview.innerHTML = `<img src="${p.cover}" alt="표지"/>`; }
  else { preview.innerHTML = coverPlaceholderMarkup(p); }
  // Color swatches
  $('#coverColors').innerHTML = COVER_COLORS.map(c=>`<button class="cover-color-swatch ${p.coverColor===c?'active':''}" data-cover-color="${c}" style="background:${c}"></button>`).join('');
  $('#coverCustomColor').value = p.coverColor || DEFAULT_COVER_COLOR;
  $('#coverColorValue').textContent = p.coverColor || DEFAULT_COVER_COLOR;
  $$('#coverColors [data-cover-color]').forEach(b=>b.onclick=()=>{
    const c=b.dataset.coverColor; p.coverColor=c; p.cover='';
    $$('#coverColors [data-cover-color]').forEach(x=>x.classList.remove('active')); b.classList.add('active');
    $('#coverCustomColor').value=c; $('#coverColorValue').textContent=c;
    $('#coverPreview').innerHTML = coverPlaceholderMarkup(p);
    touchProject(); queueSaveFS(); renderLibrary();
  });
  openModal('coverModal');
}
$('#coverCustomColor').oninput = () => {
  const p = state.projects.find(x=>x.id===coverTargetProjectId); if(!p) return;
  const c = $('#coverCustomColor').value; p.coverColor=c; p.cover='';
  $('#coverColorValue').textContent=c;
  $$('#coverColors [data-cover-color]').forEach(x=>x.classList.remove('active'));
  $('#coverPreview').innerHTML = coverPlaceholderMarkup(p);
  touchProject(); queueSaveFS(); renderLibrary();
};
$('#uploadCoverBtn').onclick = () => $('#coverInput').click();
$('#coverInput').onchange = () => {
  const file = $('#coverInput').files?.[0]; if(!file) return;
  const p = state.projects.find(x=>x.id===coverTargetProjectId); if(!p) return;
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
  const p = state.projects.find(x=>x.id===coverTargetProjectId); if(!p) return;
  p.cover='';
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
    } catch(e) {
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
    } catch(e) {
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
  // ## 헤더 기준으로 파싱
  const blocks = [];
  let currentHeader = null, currentLines = [];
  for (const line of text.split('\n')) {
    const hMatch = line.match(/^##\s*([^#].*)/);
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

function matchEpisodeForBeat(header, episodes) {
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
  return episodes.find(e => {
    const t = e.title ? e.title.trim().toLowerCase() : '';
    if (!t) return false;
    return t.includes(h) || h === t;
  }) || null;
}

function distributeBeatSheet(sectionId) {
  const p = currentProject();
  const section = (p.planSections || []).find(x => x.id === sectionId);
  if (!section) return;
  const blocks = parseBeatSheet(section.body);
  if (!blocks.length) { showToast('## 헤더로 구분된 비트시트 내용이 없습니다.'); return; }
  let eps = orderedEpisodes(p);
  let matched = 0, created = 0; const matchedEpNames = [];
  for (const block of blocks) {
    if (!block.body) continue;
    let ep = matchEpisodeForBeat(block.header, eps);
    if (!ep) {
      let type = 'chapter';
      const lh = block.header.toLowerCase();
      if (lh.includes('프롤로그') || lh.includes('prologue')) type = 'prologue';
      else if (lh.includes('에필로그') || lh.includes('epilogue')) type = 'epilogue';
      const chapCount = eps.filter(e => e.type === 'chapter').length;
      ep = defaultEpisode(type, chapCount + 1);
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
  if (matched === 0 && created === 0) { showToast('매칭되는 회차를 찾지 못했습니다.'); return; }
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
  const p = currentProject(), list = $('#projectPlanList'), sections = p.planSections||[];
  if(!sections.length) { list.innerHTML = `<div class="plan-empty">기획 항목이 없어요.</div>`; return; }
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
    return `<article class="plan-accordion ${x.open?'open':''}" data-plan-sec="${x.id}">
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
  $$('[data-tgl]').forEach(b=>b.onclick=()=>{ const s=sections.find(x=>x.id===b.dataset.tgl); s.open=!s.open; touchProject(); queueSaveFS(); renderProjectPlan(); });
  $$('[data-ttl]').forEach(i=>i.oninput=()=>{ sections.find(x=>x.id===i.dataset.ttl).title=i.value; touchProject(); queueSaveFS(); });
  $$('[data-bdy]').forEach(t=>{
    t.oninput=()=>{ sections.find(x=>x.id===t.dataset.bdy).body=t.value; touchProject(); queueSaveFS(); };
    t.onblur=()=>{
      // blur 시 최신값 저장 보장
      const sec = sections.find(x=>x.id===t.dataset.bdy);
      if(sec) { sec.body=t.value; touchProject(); queueSaveFS(); }
      t.classList.add('hidden');
      const mdv = t.previousElementSibling;
      mdv.classList.remove('hidden');
      mdv.innerHTML = window.marked ? marked.parse(t.value) : escapeHtml(t.value);
    };
    requestAnimationFrame(()=>autosizePlanSection(t));
  });
  $$('[data-del]').forEach(b=>b.onclick=()=>{ 
    if(confirm('항목을 삭제할까요?')){ 
      const delId = b.dataset.del;
      const sec = p.planSections.find(x=>x.id===delId);
      if (sec && sec.type === 'beatsheet') {
        if(confirm('이 비트시트로 각 회차에 배포되었던 내용도 모두 삭제할까요?\n(회차 기획에 배포된 비트시트만 안전하게 지워집니다)')) {
          p.episodes.forEach(ep => {
            if (ep.plan) {
              ep.plan = removeBeatSheetFromPlan(ep.plan);
              ep._dirty = true;
            }
          });
        }
      }
      p.planSections=p.planSections.filter(x=>x.id!==delId); 
      touchProject(); queueSaveFS(); renderProjectPlan(); 
    }
  });
  $$('[data-distribute-beat]').forEach(b=>b.onclick=()=>distributeBeatSheet(b.dataset.distributeBeat));
  $$('[data-open-pdf]').forEach(b=>b.onclick=()=>openAttachedPdf(b.dataset.openPdf));
}

function updateCommentBadge() {
  const p = currentProject();
  if(!p) return;
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
  const list = $('#projectCommentList');
  if (!p) return;
  
  let html = '';
  let total = 0;
  p.episodes.forEach((ep, i) => {
    const comments = ep.comments || [];
    if (comments.length === 0) return;
    total += comments.length;
    
    html += `<div style="margin-bottom:16px;">
      <h3 style="font-size:13px;color:var(--c-sub);margin:0 0 8px;">${ep.type==='prologue'?'프':ep.type==='epilogue'?'에':(i+1)+'화'} - ${escapeHtml(ep.title)}</h3>
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
  const t=cleanText(ep.title), p=cleanText(ep.plan), b=cleanText(ep.body);
  if(mode==='body') return b; if(mode==='plan') return p; if(mode==='plan-body') return `[기획]\n${p}\n\n[본문]\n${t}\n\n${b}`.trim(); return `${t}\n\n${b}`.trim();
}
async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); } catch(e) { const a=document.createElement('textarea'); a.value=text; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  showToast(msg);
}

// Bindings
$('#newProjectBtn').onclick = () => { $('#newProjectColors').innerHTML = COVER_COLORS.map(c=>`<button class="cover-color-swatch ${c===DEFAULT_COVER_COLOR?'active':''}" data-new-color="${c}" style="background:${c}"></button>`).join(''); $$('[data-new-color]').forEach(b=>b.onclick=()=>{$$('[data-new-color]').forEach(x=>x.classList.remove('active')); b.classList.add('active');}); openModal('newProjectModal'); setTimeout(()=>$('#newProjectTitle').focus(),30); };
$('#createProjectBtn').onclick = async () => {
  const p = { id:uid('project'), title:$('#newProjectTitle').value.trim()||'제목 없는 작품', status:$('#newProjectStatus').value||'serializing', cover:'', coverColor: $('.cover-color-swatch.active')?.dataset.newColor||DEFAULT_COVER_COLOR, updatedAt:Date.now(), selectedEpisodeId:null, viewMode:'split', planSections:[], episodes:[], _dirty: true };
  const ep = defaultEpisode('prologue'); p.episodes.push(ep); p.selectedEpisodeId = ep.id;
  state.projects.unshift(p);
  closeModal('newProjectModal'); $('#newProjectTitle').value='';
  showToast('새 작품을 저장 중...');
  await forceSaveAllSupabase(); // 서재로 돌아갔을 때 즉시 표시되도록 저장 완료 보장
  openProject(p.id); showToast('새 작품을 만들었어요.');
};
$('#backLibraryBtn').onclick = showLibrary;
libraryFilter = 'all'; // 서재 기본 필터를 '모든 작품'으로
$$('.filter-btn').forEach(b=>b.onclick=()=>{ libraryFilter=b.dataset.filter; renderLibrary(); });

// Editor bindings
$('#projectTitle').oninput = () => { const p=currentProject(); p.title=$('#projectTitle').value||'제목 없는 작품'; $('#projectBreadcrumb').textContent=p.title; touchProject(); queueSaveFS(); };
$('#projectStatus').onchange = () => { currentProject().status=$('#projectStatus').value; touchProject(); queueSaveFS(); };
$('#addEpisodeBtn').onclick = addEpisode;
$('#episodeTitle').oninput = () => { const ep=currentEpisode(); ep.title=$('#episodeTitle').value; $('#episodeBreadcrumb').textContent=$('#episodeTitle').value||'제목 없는 회차'; ep._dirty = true; touchProject(); renderEpisodeList(); queueSaveFS(); };
$('#episodeType').onchange = () => { const ep=currentEpisode(); ep.type=$('#episodeType').value; currentProject().episodes=orderedEpisodes(); ep._dirty = true; touchProject(); renderEpisodeList(); queueSaveFS(); };

// planMdPreview 클릭 → planEditor 전환 (인라인 onclick 대신 안전한 JS 이벤트)
$('#planMdPreview').onclick = () => {
  const ep = currentEpisode(); if(!ep) return;
  $('#planEditor').value = ep.plan || '';
  $('#planMdPreview').classList.add('hidden');
  $('#planEditor').classList.remove('hidden');
  $('#planEditor').focus();
};

$('#planEditor').oninput = () => {
  const ep = currentEpisode();
  if(!ep) return;
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
$('#bodyEditor').oninput = () => { const ep=currentEpisode(); ep.body=quill?quill.root.innerHTML:$('#bodyEditor').innerHTML; ep._dirty = true; maybeVersion(ep); touchProject(); updateBodyStats(); renderEpisodeList(); queueSaveFS(); };
$$('.view-tab').forEach(b=>b.onclick=()=>setViewMode(b.dataset.mode));
$('#toggleDrawerBtn').onclick = togglePlanDrawer;
$('#openPCEbookBtn').onclick = () => openEbook(currentProject().id);
$('#emergencyRescueBtn').onclick = () => {
  const p = currentProject();
  if (!p) return;
  let count = 0;
  
  // 브라우저에 남아있는 모든 가능한 로컬 백업 키를 다 뒤집니다.
  const backupKeys = [
    'novel_emergency_backup',
    'munjang-novel-writer-v3_backup',
    'munjang-novel-writer-v3_failed_backup',
    'munjang-novel-writer-v3'
  ];
  
  let candidates = [];
  backupKeys.forEach(key => {
    try {
      const data = localStorage.getItem(key);
      if (data) candidates.push(JSON.parse(data));
    } catch(e) {}
  });

  p.episodes.forEach(ep => {
    const isEmpty = !ep.body || ep.body.trim() === '' || ep.body.trim() === '<p><br></p>' || ep.body.trim() === '<p></p>' || ep.body.length < 15;
    if (isEmpty) {
      let foundBody = null;
      // 1. 메모리의 버전 기록 먼저 확인
      if (ep.versions && ep.versions.length > 0) {
        const latest = ep.versions.reduce((max, v) => v.time > max.time ? v : max, ep.versions[0]);
        if (latest && latest.body && latest.body.length > 20) foundBody = latest.body;
      }
      
      // 2. localStorage의 모든 백업 스캔
      if (!foundBody) {
        for (const backup of candidates) {
          // 배열(최신) 또는 객체(과거) 형태 대응
          const projs = Array.isArray(backup) ? backup : (backup.projects || []);
          const bp = projs.find(x => x.id === p.id);
          if (bp && bp.episodes) {
            const bep = bp.episodes.find(x => x.id === ep.id);
            if (bep) {
              if (bep.body && bep.body.length > 20 && bep.body !== '<p><br></p>') {
                foundBody = bep.body;
                break;
              }
              if (bep.versions && bep.versions.length > 0) {
                const latest = bep.versions.reduce((max, v) => v.time > max.time ? v : max, bep.versions[0]);
                if (latest && latest.body && latest.body.length > 20) {
                  foundBody = latest.body;
                  break;
                }
              }
            }
          }
        }
      }
      
      if (foundBody) {
        ep.body = foundBody;
        ep._dirty = true;
        count++;
      }
    }
  });

  if (count > 0) {
    showToast(`✅ ${count}개의 회차 본문이 로컬 백업에서 복원되었습니다!`);
    touchProject();
    queueSaveFS();
    forceSaveAllSupabase();
    renderEpisode();
  } else {
    showToast('복원할 수 있는 백업을 찾지 못했습니다. 백업 파일을 분석하기 위해 다운로드합니다.');
    const dump = JSON.stringify(localStorage);
    const blob = new Blob([dump], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'munjang_full_backup_dump.json';
    a.click();
  }
};
$('#closeDrawerBtn').onclick = togglePlanDrawer;

$('#tabPlanBtn').onclick = () => {
  $('#tabPlanBtn').classList.add('active');
  $('#tabPlanBtn').style.color = '';
  $('#tabCommentBtn').classList.remove('active');
  $('#tabCommentBtn').style.color = 'var(--c-muted)';
  $('#projectPlanList').classList.remove('hidden');
  $('#planToolbar').classList.remove('hidden');
  $('#projectCommentList').classList.add('hidden');
};
$('#tabCommentBtn').onclick = () => {
  $('#tabCommentBtn').classList.add('active');
  $('#tabCommentBtn').style.color = '';
  $('#tabPlanBtn').classList.remove('active');
  $('#tabPlanBtn').style.color = 'var(--c-muted)';
  $('#projectCommentList').classList.remove('hidden');
  $('#projectPlanList').classList.add('hidden');
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
$('#copyAllPlanBtn').onclick = () => { const txt = (currentProject().planSections||[]).map(x=>`${cleanText(x.title)}\n\n${cleanText(x.body)}`).join('\n\n\n'); copyText(txt, '전체 기획을 복사했어요.'); };


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
  md = md.replace(/<p class="n-sys"[^>]*>([\s\S]*?)<\/p>/g, '> [시스템] $1\n\n');
  md = md.replace(/<p class="n-alert"[^>]*>([\s\S]*?)<\/p>/g, '> [알림] $1\n\n');
  md = md.replace(/<p class="n-record"[^>]*>([\s\S]*?)<\/p>/g, '> [기록] $1\n\n');
  md = md.replace(/<p class="n-status"[^>]*>([\s\S]*?)<\/p>/g, '> [상태창] $1\n\n');
  md = md.replace(/<p class="n-log"[^>]*>([\s\S]*?)<\/p>/g, '```log\n$1\n```\n\n');
  
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
  const t=cleanText(ep.title), p=cleanText(ep.plan), b=cleanText(ep.body);
  if(mode==='plan') return p;
  if(mode==='body') return b;
  if(mode==='plan-body') return p?`${p}\n\n${b}`:b;
  return `${t}\n\n${b}`;
}

$('#quickCopyBodyBtn').onclick = () => {
  const md = getMarkdownForEpisode(currentEpisode());
  copyText(md, '본문을 복사했어요. (마크다운)');
};
$('#copyDropdownToggle').onclick = (e) => { e.stopPropagation(); $('#copyDropdownMenu').classList.toggle('show'); };
$$('[data-copy]').forEach(b=>b.onclick=(e)=>{ 
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
window.addEventListener('click', (e) => { if(!e.target.closest('.dropdown-container')) $('#copyDropdownMenu')?.classList.remove('show'); });

// Search
$('#openSearchBtn').onclick = () => { openModal('searchModal'); $('#searchInput').focus(); };
$('#searchInput').oninput = () => {
  const q = $('#searchInput').value.trim().toLowerCase();
  if(!q) { $('#searchResults').innerHTML=''; return; }
  const res = [], p = currentProject();
  p.episodes.forEach(ep=>[{type:'본문',t:ep.body||''},{type:'기획',t:ep.plan||''}].forEach(src=>{
    let pos=0; const lower = src.t.toLowerCase();
    while((pos=lower.indexOf(q,pos))!==-1 && res.length<15) {
      const snip = src.t.slice(Math.max(0,pos-30), Math.min(src.t.length, pos+q.length+30));
      const marked = escapeHtml(snip).replace(new RegExp(escapeHtml(q), 'gi'), '<mark>$&</mark>');
      res.push({ kind:'ep', ep, type:src.type, html: marked }); pos+=q.length;
    }
  }));
  (p.planSections||[]).forEach(sec=>{
    const txt = `${sec.title} ${sec.body}`, lower = txt.toLowerCase(); let pos=0;
    while((pos=lower.indexOf(q,pos))!==-1 && res.length<20) {
      const snip = txt.slice(Math.max(0,pos-30), Math.min(txt.length, pos+q.length+30));
      const marked = escapeHtml(snip).replace(new RegExp(escapeHtml(q), 'gi'), '<mark>$&</mark>');
      res.push({ kind:'plan', sec, type:'작품 기획', html: marked }); pos+=q.length;
    }
  });
  $('#searchResults').innerHTML = res.map((r,i)=>`<button class="search-result" data-sr="${i}"><strong>${escapeHtml(r.kind==='ep'?r.ep.title:r.sec.title)} · ${r.type}</strong><span>${r.html}</span></button>`).join('');
  $$('[data-sr]').forEach(b=>b.onclick=()=>{
    const r=res[Number(b.dataset.sr)]; closeModal('searchModal');
    if(r.kind==='plan') {
      if(!isPlanDrawerOpen) togglePlanDrawer();
      r.sec.open = true; renderProjectPlan();
      setTimeout(()=>{$(`[data-plan-sec="${r.sec.id}"]`)?.scrollIntoView({behavior:'smooth'});}, 100);
    } else {
      selectEpisode(r.ep.id); setViewMode(r.type==='본문'?'body':'plan');
    }
  });
};

// Versions
$('#versionBtn').onclick = () => {
  persistEditor(); const ep=currentEpisode(); maybeVersion(ep, true); queueSaveFS();
  $('#versionList').innerHTML = (ep.versions||[]).map(v=>{
    const prev = escapeHtml(cleanText(v.body).slice(0,60));
    return `<div class="version-item"><div><strong>${new Date(v.createdAt).toLocaleString('ko-KR')}</strong><span>${stats(v.body).withSpaces.toLocaleString()}자 · ${prev}...</span></div><button class="ghost border" data-ver="${v.id}">복원</button></div>`;
  }).join('');
  $$('[data-ver]').forEach(b=>b.onclick=()=>{
    const ep=currentEpisode(); maybeVersion(ep, true); // Backup current right before restore
    ep.body = ep.versions.find(x=>x.id===b.dataset.ver).body;
    queueSaveFS(); closeModal('versionModal'); renderEpisode(); showToast('이전 버전으로 복원했어요.');
  });
  openModal('versionModal');
};

$('#emergencyRestoreBtn').onclick = () => {
  const ep = currentEpisode();
  if (!ep) return;
  if (!ep.versions || ep.versions.length === 0) {
    alert('이 회차에 저장된 백업본이 없습니다.');
    return;
  }
  // 가장 최신 백업본 가져오기 (비어있지 않은 것)
  const validBackup = ep.versions.find(v => cleanText(v.body).length > 0);
  if (!validBackup) {
    alert('저장된 유효한 텍스트 데이터가 없습니다.');
    return;
  }
  const backup = validBackup.body;
  const chars = stats(backup).withSpaces;
  if (confirm(`가장 최근에 저장된 백업본(${chars}자)을 불러오시겠습니까?\n현재 에디터의 내용은 덮어씌워집니다.`)) {
    ep.body = backup;
    if (quill) quill.root.innerHTML = backup;
    queueSaveFS(true);
    updateBodyStats();
    showToast('안전하게 백업본이 복구되었습니다!');
  }
};

// Manuscript
function showEditor() { $('#manuscriptView').classList.remove('active'); $('#editorView').classList.remove('hidden'); }
$('#openManuscriptBtn').onclick = () => {
  persistEditor(); queueSaveFS();
  $('#editorView').classList.add('hidden'); $('#manuscriptView').classList.add('active');
  const eps = orderedEpisodes().filter(e=>cleanText(e.body));
  $('#manuscriptTitle').textContent = currentProject().title;
  $('#manuscriptMeta').textContent = `총 ${eps.reduce((s,e)=>s+stats(e.body).withSpaces,0).toLocaleString()}자 · ${eps.length}회차`;
  $('#manuscriptContent').innerHTML = eps.map(e=>`<article class="manuscript-ep"><div class="ql-editor">${e.body||''}</div></article>`).join('');
};
$('#backFromManuscript').onclick = showEditor;
$('#copyManuscriptFull').onclick = () => {
  const mdText = orderedEpisodes().filter(e => cleanText(e.body)).map(e => getMarkdownForEpisode(e)).join('\n\n\n');
  copyText(mdText, '전체 본문을 복사했어요. (마크다운)');
};
$('#exportPODBtn').onclick = exportPODPdf;
function processEpisodeBody(html, epTitle) {
  if (!html) return { body: '', hasTitle: false };
  const div = document.createElement('div');
  div.innerHTML = html;

  // 1. 빈 리스트 삭제
  div.querySelectorAll('li').forEach(li => {
    if (!li.textContent.trim() && !li.querySelector('img')) li.remove();
  });
  div.querySelectorAll('ul, ol').forEach(list => {
    if (list.children.length === 0) list.remove();
  });

  // 2. n-msg 그룹화
  const els = Array.from(div.children);
  for (let i = 0; i < els.length; i++) {
    const cur = els[i];
    const isMsg = cur.classList.contains('n-msg') || cur.querySelector('.n-msg');
    if (isMsg) {
      const prev = els[i-1], next = els[i+1];
      const pIsMsg = prev && (prev.classList.contains('n-msg') || prev.querySelector('.n-msg'));
      const nIsMsg = next && (next.classList.contains('n-msg') || next.querySelector('.n-msg'));
      
      let target = cur.classList.contains('n-msg') ? cur : cur.querySelector('.n-msg');
      if (pIsMsg && nIsMsg) target.classList.add('msg-middle');
      else if (pIsMsg && !nIsMsg) target.classList.add('msg-last');
      else if (!pIsMsg && nIsMsg) target.classList.add('msg-first');
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

  return { body: div.innerHTML, hasTitle };
}

async function exportPODPdf() {
  const p = currentProject();
  if(!p) return;
  
  const eps = orderedEpisodes(p).filter(e => cleanText(e.body));
  if (eps.length === 0) return showToast('출판할 본문이 없습니다.');
  
  // 브라우저 팝업 차단 우회를 위해 await 전에 창을 띄웁니다.
  const win = window.open('', '_blank');
  if (!win) {
    showToast('팝업 차단을 해제하고 다시 시도해주세요.');
    return;
  }
  win.document.write('<div style="text-align:center; padding:50px; font-family:sans-serif;">PDF 변환을 준비 중입니다. 잠시만 기다려주세요...<br><br><small>본문 데이터가 많을 경우 수 초가 소요될 수 있습니다.</small></div>');

  if (p.episodes.some(e => e.body === undefined)) {
    showToast('PDF 생성을 위해 데이터를 불러오는 중입니다...');
    await ensureProjectBodiesLoaded(p);
  }
  
  const loadedEps = orderedEpisodes(p).filter(e => cleanText(e.body));
  
  showToast('PDF 변환을 준비 중입니다... 새 창을 허용해주세요.');
  
  let html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>${escapeHtml(p.title)} - 출판용 원고</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap" rel="stylesheet">
<script src="https://unpkg.com/pagedjs/dist/js/paged.polyfill.js"></${'script'}>
<style>
  @page {
    size: A5;
    margin: 20mm 15mm 20mm 15mm;
    @bottom-center {
      content: counter(page);
      font-size: 9pt;
      font-family: 'Noto Serif KR', serif;
    }
  }
  @page:first {
    @bottom-center { content: none; }
  }
  body {
    font-family: 'Noto Serif KR', serif;
    font-size: 10pt;
    line-height: 1.8;
    color: #111;
  }
  .title-page {
    break-after: page;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    height: 100vh;
    text-align: center;
  }
  .title-page h1 { font-size: 24pt; margin-bottom: 20px; font-weight: 700; }
  .chapter {
    break-before: page;
    margin-top: 40px;
  }
  .chapter-title {
    font-size: 14pt;
    font-weight: 700;
    margin-bottom: 30px;
    text-align: center;
  }
  .chapter-content p {
    text-indent: 10pt;
    margin: 0;
    word-break: keep-all;
  }
  /* Narrative Blocks for PDF \u2014 v3 (\uc774\ubbf8\uc9c0 \uac00\uc774\ub4dc \ub3d9\uc77c \uc801\uc6a9) */
  .n-msg {
    display: block !important;
    max-width: 68% !important;
    margin: 20px 0 !important;
    background: #EEEEEC !important;
    border: none !important;
    border-radius: 8px !important;
    padding: 14px 18px !important;
    font-size: 0.95em !important;
    line-height: 1.85 !important;
    text-align: left !important;
    text-indent: 0 !important;
  }
  .msg-first, .msg-middle {
    margin-bottom: 0 !important;
    border-bottom-left-radius: 0 !important;
    border-bottom-right-radius: 0 !important;
  }
  .msg-last, .msg-middle {
    margin-top: 0 !important;
    border-top-left-radius: 0 !important;
    border-top-right-radius: 0 !important;
  }
  .n-sys {
    display: block !important;
    text-align: center !important;
    color: #686868 !important;
    font-size: 0.9em !important;
    font-family: 'Pretendard', 'Noto Sans KR', sans-serif !important;
    font-weight: 500 !important;
    line-height: 1.8 !important;
    padding: 0 !important;
    margin: 24px 0 !important;
    text-indent: 0 !important;
    background: transparent !important;
    border: none !important;
  }
  .n-sys::before {
    content: '\u25c7' !important;
    display: block !important;
    font-size: 10px !important;
    color: #BEBBB5 !important;
    margin-bottom: 6px !important;
    background: none !important;
    padding: 0 !important;
  }
  .n-log {
    display: block; background: #F5F5F4;
    border-left: 2px solid #C4C2BC;
    padding: 12px 16px; margin: 18px 0;
    font-family: 'Menlo','Consolas','Monaco',monospace;
    font-size: 11pt; line-height: 1.8; color: #4A4A4A;
    white-space: pre-wrap; text-indent: 0 !important;
  }
  .n-alert {
    display: block; background: #FEF4F3;
    border: 1px solid #E8C3BE; border-radius: 5px;
    padding: 12px 16px 12px 42px; margin: 18px 0;
    position: relative; font-size: 0.94em; color: #464646;
    line-height: 1.75; text-indent: 0 !important;
  }
  .n-alert::before {
    content: '\u26A0\uFE0F'; position: absolute; left: 14px; top: 13px;
    font-size: 12px; color: #C0524A; line-height: 1;
  }
  .n-record {
    display: block; background: transparent;
    border-left: 2.5px solid #CCCAC5;
    padding: 2px 0 2px 20px; margin: 18px 0;
    font-size: 0.96em; line-height: 1.9; color: #505050;
    font-style: normal; text-indent: 0 !important;
  }
  .n-ui {
    display: inline-block !important;
    font-family: 'Pretendard', 'Noto Sans KR', sans-serif !important;
    font-weight: 500 !important;
    font-size: 0.86em !important;
    color: #3A3A3A !important;
    background: #F0F0F0 !important;
    border: 1px solid #E0E0E0 !important;
    border-radius: 4px !important;
    padding: 2px 6px !important;
    margin: 0 2px !important;
    line-height: 1.2 !important;
    box-decoration-break: clone !important;
    -webkit-box-decoration-break: clone !important;
  }
</style>
</head>
<body>
  <div class="title-page">
    <h1>${escapeHtml(p.title)}</h1>
  </div>
`;

  loadedEps.forEach((ep, i) => {
    const processed = processEpisodeBody(ep.body, ep.title);
    html += `
  <div class="chapter">
    ${processed.hasTitle ? '' : `<div class="chapter-title">${escapeHtml(ep.title)}</div>`}
    <div class="chapter-content">${processed.body}</div>
  </div>`;
  });

  html += `
  