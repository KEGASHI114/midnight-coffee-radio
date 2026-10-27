/* ==============================================================================
   Midnight Coffee Radio ☕ - Production App Engine
   • 真正声学傅里叶变换频谱分析 (Web Audio API + FFT AnalyserNode)
   • 真实点赞数据体系 (0 起步真实统计 + 本地账本)
   • 强制真实文件下载拦截 (Blob 内存流注入，杜绝浏览器跳转黑屏播放)
   ============================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  // 1. 初始化 DOM 引用
  const audio = document.getElementById('audioEngine');
  audio.crossOrigin = 'anonymous'; // 开放跨域声学嗅探许可

  const playBtn = document.getElementById('playBtn');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const shuffleBtn = document.getElementById('shuffleBtn');
  const progressTrack = document.getElementById('progressTrack');
  const progressFill = document.getElementById('progressFill');
  const progressThumb = document.getElementById('progressThumb');
  const currentTimeLabel = document.getElementById('currentTimeLabel');
  const totalTimeLabel = document.getElementById('totalTimeLabel');
  const volumeSlider = document.getElementById('volumeSlider');
  
  const playerCategoryBadge = document.getElementById('playerCategoryBadge');
  const playerTrackTitle = document.getElementById('playerTrackTitle');
  const currentLikeBtn = document.getElementById('currentLikeBtn');
  const currentLikeCount = document.getElementById('currentLikeCount');
  const currentDownloadBtn = document.getElementById('currentDownloadBtn');
  
  const tracksListContainer = document.getElementById('tracksList');
  const fameListContainer = document.getElementById('fameList');
  const searchInput = document.getElementById('searchInput');
  const categoryTabs = document.getElementById('categoryTabs');
  const bulkDownloadBtn = document.getElementById('bulkDownloadBtn');

  // 拟物化卡带机组件引用
  const spoolLeft = document.getElementById('spoolLeft');
  const spoolRight = document.getElementById('spoolRight');
  const playLed = document.getElementById('playLed');

  // 2. 状态与音频引擎核心引用
  let allTracks = [];
  let filteredTracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  let currentCategory = 'all';

  // Web Audio 声学分析引擎引用 (提升至顶部，杜绝 TDZ 变量未初始化引用错误)
  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let freqDataArray = null;
  let isWebAudioActive = false;

  // 极速双缓冲后台静默预加载专用 Audio 对象
  const preloaderAudio = new Audio();
  preloaderAudio.preload = 'auto';

  // 多语言国际化 (i18n) 状态管理 (严格强制默认英文，支持手动切换 中 / 日 / 韩)
  function detectInitialLang() {
    const saved = localStorage.getItem('mcr_lang');
    if (saved && ['en', 'zh', 'ja', 'ko'].includes(saved)) return saved;
    return 'en'; // 默认英文
  }
  let currentLang = detectInitialLang();

  function getI18nDict() {
    return (window.I18N_DATA && window.I18N_DATA[currentLang]) || (window.I18N_DATA && window.I18N_DATA.en) || {};
  }

  // 真实点赞数据中心 (本地只保留“我点赞过的曲目”，全网总票数通过 Cloudflare D1 云数据库同步)
  let userLikes = JSON.parse(localStorage.getItem('mcr_user_likes') || '{}');
  // 彻底清除旧版本遗留在客户端的伪单机账本
  if (localStorage.getItem('mcr_real_votes')) {
    localStorage.removeItem('mcr_real_votes');
  }

  // 3. 强制真实下载函数 (基于 Blob 拦截，彻底禁止跳转到浏览器黑屏原生播放器，并上报下载统计)
  async function forceDownload(url, filename, triggerBtn = null, trackId = null) {
    const originalText = triggerBtn ? triggerBtn.textContent : '';
    if (triggerBtn) {
      triggerBtn.textContent = '⏳ ...';
      triggerBtn.style.pointerEvents = 'none';
    }

    // 异步上报下载统计到 Cloudflare D1
    if (trackId) {
      fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId })
      }).catch(() => {});
    }

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      
      const tempLink = document.createElement('a');
      tempLink.style.display = 'none';
      tempLink.href = blobUrl;
      tempLink.download = filename;
      document.body.appendChild(tempLink);
      tempLink.click();
      document.body.removeChild(tempLink);
      
      // 延迟释放内存
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
      if (triggerBtn) triggerBtn.textContent = '✓ DONE';
    } catch (err) {
      console.warn('Blob fetch failed, falling back to direct anchor download:', err);
      const fallbackLink = document.createElement('a');
      fallbackLink.style.display = 'none';
      fallbackLink.href = url;
      fallbackLink.download = filename;
      document.body.appendChild(fallbackLink);
      fallbackLink.click();
      document.body.removeChild(fallbackLink);
      if (triggerBtn) triggerBtn.textContent = '⬇ MP3';
    } finally {
      if (triggerBtn) {
        setTimeout(() => {
          triggerBtn.textContent = originalText;
          triggerBtn.style.pointerEvents = '';
        }, 1200);
      }
    }
  }

  // 4. 数据初始化与 Cloudflare D1 云端数据库实时对账
  async function loadCloudStats() {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && data.stats) {
          allTracks.forEach(t => {
            if (data.stats[t.id]) {
              t.likes = data.stats[t.id].likes || 0;
              t.downloads = data.stats[t.id].downloads || 0;
            }
          });
          applyFilters();
          renderHallOfFame();
          if (currentIndex >= 0 && filteredTracks[currentIndex]) {
            currentLikeCount.textContent = filteredTracks[currentIndex].likes || 0;
          }
        }
      }
    } catch (e) {
      console.log('[Cloud D1] 本地/离线运行模式，使用基线数据');
    }
  }

  // ==============================================================================
  // 4.5. 💬 午夜留言板 (Cozy Guestbook) 状态、函数与事件交互
  // ==============================================================================
  let guestbookMessages = [];
  let selectedAvatar = localStorage.getItem('mcr_avatar') || '☕';
  let adminSecret = sessionStorage.getItem('mcr_admin_secret') || '';

  const guestbookList = document.getElementById('guestbookList');
  const guestbookForm = document.getElementById('guestbookForm');
  const guestNickname = document.getElementById('guestNickname');
  const guestContent = document.getElementById('guestContent');
  const charCounter = document.getElementById('charCounter');
  const sendMsgBtn = document.getElementById('sendMsgBtn');
  const formAlert = document.getElementById('formAlert');
  const avatarPicker = document.getElementById('avatarPicker');
  const guestbookHeader = document.getElementById('guestbookHeader');
  const adminBadge = document.getElementById('adminBadge');

  // 恢复保存的昵称和头像
  if (guestNickname) {
    guestNickname.value = localStorage.getItem('mcr_nickname') || '';
  }
  if (avatarPicker) {
    avatarPicker.querySelectorAll('.avatar-opt').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-emoji') === selectedAvatar);
      btn.addEventListener('click', () => {
        selectedAvatar = btn.getAttribute('data-emoji');
        localStorage.setItem('mcr_avatar', selectedAvatar);
        avatarPicker.querySelectorAll('.avatar-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });
  }

  // 检查 URL 是否带有管理员暗号 (?admin=SECRET)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('admin')) {
    adminSecret = urlParams.get('admin');
    sessionStorage.setItem('mcr_admin_secret', adminSecret);
    const cleanUrl = window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }

  // 双击留言板标题可输入管理员口令开启暗号管理模式
  if (guestbookHeader) {
    guestbookHeader.addEventListener('dblclick', () => {
      const dict = getI18nDict();
      const input = prompt(dict.adminPromptTitle || 'Enter Admin Secret:');
      if (input !== null) {
        adminSecret = input.trim();
        sessionStorage.setItem('mcr_admin_secret', adminSecret);
        alert(dict.adminActivated || 'Admin Mode Activated! 🛡️');
        renderGuestbookMessages();
      }
    });
  }

  // 相对时间格式化
  function formatRelativeTime(dateStr) {
    const dict = getI18nDict();
    if (!dateStr) return dict.timeJustNow || 'just now';
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diffSec = Math.floor((now - then) / 1000);
    if (diffSec < 60) return dict.timeJustNow || 'just now';
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return (dict.timeMinsAgo || '{m}m ago').replace('{m}', diffMin);
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return (dict.timeHoursAgo || '{h}h ago').replace('{h}', diffHour);
    const diffDay = Math.floor(diffHour / 24);
    return `${diffDay}d ago`;
  }

  function renderGuestbookMessages() {
    if (!guestbookList) return;
    const dict = getI18nDict();

    if (adminBadge) {
      adminBadge.style.display = adminSecret ? 'inline-block' : 'none';
    }

    if (guestbookMessages.length === 0) {
      guestbookList.innerHTML = `
        <div style="padding: 20px 10px; text-align: center; color: #a69bb8; font-size: 11px; line-height: 1.5;">
          ${dict.guestbookEmpty || 'No messages yet. Be the first to leave a cozy note! ☕'}
        </div>
      `;
      return;
    }

    guestbookList.innerHTML = guestbookMessages.map(m => {
      const timeStr = formatRelativeTime(m.created_at);
      const delBtn = adminSecret ? `<button type="button" class="msg-del-btn" data-id="${m.id}" title="Delete note">🗑️</button>` : '';
      return `
        <div class="guestbook-item" data-id="${m.id}">
          <span class="msg-avatar">${m.avatar_emoji || '☕'}</span>
          <div class="msg-body">
            <div class="msg-top">
              <span class="msg-nick">${m.nickname || 'Anon'}</span>
              <div style="display: flex; align-items: center;">
                <span class="msg-time">${timeStr}</span>
                ${delBtn}
              </div>
            </div>
            <div class="msg-text">${m.content}</div>
          </div>
        </div>
      `;
    }).join('');

    // 绑定管理员一键删除事件
    if (adminSecret) {
      guestbookList.querySelectorAll('.msg-del-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const id = parseInt(btn.getAttribute('data-id'), 10);
          if (!confirm(dict.adminDelConfirm || 'Delete this message?')) return;
          try {
            const res = await fetch('/api/message', {
              method: 'DELETE',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${adminSecret}`
              },
              body: JSON.stringify({ id })
            });
            const data = await res.json();
            if (data && data.success) {
              guestbookMessages = guestbookMessages.filter(item => item.id !== id);
              renderGuestbookMessages();
              showAlert(dict.adminDelSuccess || 'Message removed!', true);
            } else {
              alert(data.error || 'Delete failed: unauthorized');
            }
          } catch (err) {
            alert('Network error while deleting note');
          }
        });
      });
    }
  }

  async function loadMessages() {
    try {
      const res = await fetch('/api/messages');
      if (res.ok) {
        const data = await res.json();
        if (data && data.success && Array.isArray(data.messages)) {
          guestbookMessages = data.messages;
          renderGuestbookMessages();
        }
      }
    } catch (e) {
      console.log('[Guestbook] Load failed:', e);
    }
  }

  function showAlert(msg, isSuccess = false) {
    if (!formAlert) return;
    formAlert.textContent = msg;
    formAlert.className = isSuccess ? 'form-alert success' : 'form-alert';
    formAlert.style.display = 'block';
    setTimeout(() => {
      formAlert.style.display = 'none';
    }, 4500);
  }

  if (guestContent && charCounter) {
    guestContent.addEventListener('input', () => {
      charCounter.textContent = `${guestContent.value.length}/100`;
    });
  }

  if (guestbookForm) {
    guestbookForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dict = getI18nDict();
      const content = (guestContent.value || '').trim();
      const nickname = (guestNickname.value || '').trim() || 'Anon';

      if (!content) {
        showAlert(dict.errEmpty || 'Please write something first! 🐾');
        return;
      }

      // 客户端极速前置链接校验
      const linkRegex = /(https?:\/\/|www\.|t\.me\/|t\.cn\/|bit\.ly\/|[a-zA-Z0-9-]+\.(com|net|org|xyz|io|co|me|vip|top|cc|ru|cn)(\/|\s|$))/i;
      if (linkRegex.test(content) || linkRegex.test(nickname)) {
        showAlert(dict.errNoLinks || 'For a cozy vibe, external links are not allowed ☕');
        return;
      }

      sendMsgBtn.disabled = true;
      const originalText = sendMsgBtn.innerHTML;
      sendMsgBtn.textContent = dict.guestbookSending || 'Sending...';

      try {
        const res = await fetch('/api/message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nickname,
            avatarEmoji: selectedAvatar,
            content
          })
        });

        const data = await res.json();
        if (data && data.success && data.message) {
          guestbookMessages.unshift(data.message);
          renderGuestbookMessages();
          guestContent.value = '';
          charCounter.textContent = '0/100';
          localStorage.setItem('mcr_nickname', nickname);
          spawnHeartBurst(window.innerWidth - 120, window.innerHeight * 0.7);
        } else {
          if (data.error === 'ERR_NO_LINKS') {
            showAlert(dict.errNoLinks || 'For a cozy vibe, external links are not allowed ☕');
          } else if (data.error === 'ERR_RATE_LIMIT') {
            const sec = data.remaining || 30;
            showAlert((dict.errRateLimit || 'Slow down! Please wait {s}s before sending another note ☕').replace('{s}', sec));
          } else {
            showAlert(data.error || 'Failed to post note');
          }
        }
      } catch (err) {
        showAlert('Network error while posting note');
      } finally {
        sendMsgBtn.disabled = false;
        sendMsgBtn.innerHTML = originalText;
      }
    });
  }

  // 多语言国际化 (i18n) 动态文本切换引擎
  function applyLanguage(lang) {
    if (!['en', 'zh', 'ja', 'ko'].includes(lang)) lang = 'en';
    currentLang = lang;
    localStorage.setItem('mcr_lang', lang);

    // 1. 更新顶部语言切换按钮激活态
    document.querySelectorAll('.lang-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-lang') === lang);
    });

    const dict = getI18nDict();

    // 2. 更新页面静态核心文本
    const elBrandName = document.getElementById('brandName');
    if (elBrandName && dict.brandName) elBrandName.textContent = dict.brandName;

    const elBrandTagline = document.getElementById('brandTagline');
    if (elBrandTagline && dict.brandTagline) elBrandTagline.textContent = dict.brandTagline;

    const elLiveBtnText = document.getElementById('liveBtnText');
    if (elLiveBtnText && dict.liveBtn) elLiveBtnText.textContent = dict.liveBtn;

    const elCatBubble = document.getElementById('catBubble');
    if (elCatBubble && dict.catBubble) elCatBubble.textContent = dict.catBubble;

    const elArtist = document.getElementById('playerArtist');
    if (elArtist && dict.artistSubtitle) elArtist.textContent = dict.artistSubtitle;

    const elPrevBtn = document.getElementById('prevBtn');
    if (elPrevBtn && dict.prevBtn) elPrevBtn.textContent = dict.prevBtn;

    const elNextBtn = document.getElementById('nextBtn');
    if (elNextBtn && dict.nextBtn) elNextBtn.textContent = dict.nextBtn;

    const elShuffleBtn = document.getElementById('shuffleBtn');
    if (elShuffleBtn && dict.shuffleBtn && !isShuffle) elShuffleBtn.textContent = dict.shuffleBtn;

    const elLikeBtnText = document.getElementById('likeBtnText');
    if (elLikeBtnText && dict.likeBtn) elLikeBtnText.textContent = dict.likeBtn;

    const elDownloadBtn = document.getElementById('currentDownloadBtn');
    if (elDownloadBtn && dict.downloadBtn) elDownloadBtn.textContent = dict.downloadBtn;

    const elVibeTitle = document.getElementById('vibeTitle');
    if (elVibeTitle && dict.vibeTitle) elVibeTitle.textContent = dict.vibeTitle;

    const elVibeSub = document.getElementById('vibeSub');
    if (elVibeSub && dict.vibeSub) elVibeSub.textContent = dict.vibeSub;

    const elSearchInput = document.getElementById('searchInput');
    if (elSearchInput && dict.searchPlaceholder) elSearchInput.placeholder = dict.searchPlaceholder;

    const elWeeklyTop10Title = document.getElementById('weeklyTop10Title');
    if (elWeeklyTop10Title && dict.weeklyTop10) elWeeklyTop10Title.textContent = dict.weeklyTop10;

    const elHallOfFameSub = document.getElementById('hallOfFameSub');
    if (elHallOfFameSub && dict.hallOfFame) elHallOfFameSub.textContent = dict.hallOfFame;

    // 留言板多语言
    const elGuestbookTitle = document.getElementById('guestbookTitle');
    if (elGuestbookTitle && dict.guestbookTitle) elGuestbookTitle.textContent = dict.guestbookTitle;

    const elGuestbookSub = document.getElementById('guestbookSub');
    if (elGuestbookSub && dict.guestbookSub) elGuestbookSub.textContent = dict.guestbookSub;

    const elGuestNick = document.getElementById('guestNickname');
    if (elGuestNick && dict.guestbookNickPlaceholder) elGuestNick.placeholder = dict.guestbookNickPlaceholder;

    const elGuestContent = document.getElementById('guestContent');
    if (elGuestContent && dict.guestbookContentPlaceholder) elGuestContent.placeholder = dict.guestbookContentPlaceholder;

    const elSendBtnText = document.getElementById('sendBtnText');
    if (elSendBtnText && dict.guestbookSendBtn) elSendBtnText.textContent = dict.guestbookSendBtn;

    const elFooterCopyright = document.getElementById('footerCopyright');
    if (elFooterCopyright && dict.footerCopyright) elFooterCopyright.textContent = dict.footerCopyright;

    const elFooterLiveLink = document.getElementById('footerLiveLink');
    if (elFooterLiveLink && dict.footerLive) elFooterLiveLink.textContent = dict.footerLive;

    const elFooterTopLink = document.getElementById('footerTopLink');
    if (elFooterTopLink && dict.footerTop) elFooterTopLink.textContent = dict.footerTop;

    // 3. 刷新分类标签按钮文本
    if (categoryTabs && dict.categories) {
      categoryTabs.querySelectorAll('.cat-tab-btn').forEach(btn => {
        const cat = btn.getAttribute('data-cat');
        if (dict.categories[cat]) {
          btn.textContent = dict.categories[cat];
        }
      });
    }

    // 4. 刷新当前播放曲目分类徽章
    if (currentIndex >= 0 && filteredTracks[currentIndex]) {
      const cur = filteredTracks[currentIndex];
      const curCatName = (dict.categories && dict.categories[cur.category_code]) || cur.category_name;
      playerCategoryBadge.textContent = `[${curCatName}]`;
    } else {
      playerTrackTitle.textContent = dict.selectTrack || 'Select a track to play...';
    }

    updatePlayBtnState();
    renderTracksList();
    renderHallOfFame();
    renderGuestbookMessages();
  }

  function initTracks(data) {
    allTracks = data;
    allTracks.forEach(t => {
      t.likes = t.likes || 0;
    });
    applyFilters();
    renderHallOfFame();
    if (allTracks.length > 0) {
      loadTrack(0, false);
    }
    // 应用当前语言
    applyLanguage(currentLang);
    // 异步拉取全网 D1 真实云端总账本与留言
    loadCloudStats();
    loadMessages();
  }

  if (window.TRACKS_DATA && Array.isArray(window.TRACKS_DATA)) {
    initTracks(window.TRACKS_DATA);
  } else {
    fetch('data/tracks.json')
      .then(res => res.json())
      .then(data => initTracks(data))
      .catch(err => {
        console.error('Failed to load tracks.json:', err);
        tracksListContainer.innerHTML = '<div style="padding: 20px; color: #ff5555;">Failed to load tracks data.</div>';
      });
  }

  // 5. 筛选与曲目列表渲染
  function applyFilters() {
    const q = (searchInput.value || '').trim().toLowerCase();
    filteredTracks = allTracks.filter(t => {
      const matchCat = currentCategory === 'all' || t.category_code === currentCategory;
      const matchQuery = !q || t.title.toLowerCase().includes(q) || t.category_name.toLowerCase().includes(q);
      return matchCat && matchQuery;
    });
    renderTracksList();
  }

  function renderTracksList() {
    const dict = getI18nDict();
    if (filteredTracks.length === 0) {
      tracksListContainer.innerHTML = `<div style="padding: 30px; text-align: center; color: #a69bb8;">${dict.noTracksFound || 'No tracks found matching your search.'}</div>`;
      return;
    }

    tracksListContainer.innerHTML = filteredTracks.map((t, idx) => {
      const isCurrent = currentIndex >= 0 && filteredTracks[currentIndex] && filteredTracks[currentIndex].id === t.id;
      const isLiked = !!userLikes[t.id];
      const catDisplay = (dict.categories && dict.categories[t.category_code]) || t.category_name;
      return `
        <div class="track-item ${isCurrent ? 'playing' : ''}" data-id="${t.id}">
          <div class="track-left">
            <span class="track-num">${String(t.id).padStart(3, '0')}</span>
            <div class="track-info-wrap">
              <div class="track-name-text">${t.title}</div>
              <span class="track-cat-pill" data-cat="${t.category_code}">[${catDisplay}]</span>
            </div>
          </div>
          <div class="track-right">
            <span class="track-duration-text">${t.duration}</span>
            <button class="pixel-btn action-btn play-track-btn" data-id="${t.id}">${isCurrent && !audio.paused ? '⏸' : '▶'}</button>
            <button class="pixel-btn action-btn like-track-btn ${isLiked ? 'liked' : ''}" data-id="${t.id}">♥ ${t.likes || 0}</button>
            <button class="pixel-btn action-btn single-dl-btn" data-url="${t.download_url}" data-name="${t.title}.m4a" title="Download directly">⬇</button>
          </div>
        </div>
      `;
    }).join('');

    // 绑定列表内交互 (使用直接监听，确保移动端触控 100% 灵敏响应)
    tracksListContainer.querySelectorAll('.track-item').forEach(item => {
      const id = parseInt(item.getAttribute('data-id'), 10);
      
      // 1. 点赞直接响应 (阻止冒泡，触发爱心粒子)
      const likeBtn = item.querySelector('.like-track-btn');
      if (likeBtn) {
        likeBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          toggleLike(id, e);
        });
      }

      // 2. 单曲下载直接响应 (阻止跳页，触发真实 Blob 下载)
      const dlBtn = item.querySelector('.single-dl-btn');
      if (dlBtn) {
        dlBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const audioUrl = dlBtn.getAttribute('data-url');
          const fileName = dlBtn.getAttribute('data-name');
          forceDownload(audioUrl, fileName, dlBtn, id);
        });
      }

      // 2.5 列表行内播放/暂停小按钮直接响应
      const playTrackBtn = item.querySelector('.play-track-btn');
      if (playTrackBtn) {
        playTrackBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const fIdx = filteredTracks.findIndex(t => t.id === id);
          if (fIdx !== -1) {
            if (currentIndex === fIdx && !audio.paused) {
              audio.pause();
            } else {
              loadTrack(fIdx, true);
            }
          }
        });
      }

      // 3. 点击整行空白或标题播放切换
      item.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('a')) return;
        const fIdx = filteredTracks.findIndex(t => t.id === id);
        if (fIdx !== -1) {
          if (currentIndex === fIdx && !audio.paused) {
            audio.pause();
          } else {
            loadTrack(fIdx, true);
          }
        }
      });
    });
  }

  // 6. 真实每周十佳名人堂榜单
  function renderHallOfFame() {
    const dict = getI18nDict();
    // 仅筛选拥有真实票数 (> 0) 的歌曲进行排行
    const votedTracks = allTracks.filter(t => (t.likes || 0) > 0);
    
    if (votedTracks.length === 0) {
      fameListContainer.innerHTML = `
        <div style="padding: 16px 10px; text-align: center; color: #a69bb8; font-size: 11px; line-height: 1.6;">
          ${dict.noVotesYet || 'NO VOTES YET! CLICK ♥ ON ANY TRACK TO START THE RANKING!'}
        </div>
      `;
      return;
    }

    const sorted = [...votedTracks].sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, 10);
    fameListContainer.innerHTML = sorted.map((t, i) => {
      const rankClass = i === 0 ? 'fame-rank-1' : (i === 1 ? 'fame-rank-2' : (i === 2 ? 'fame-rank-3' : ''));
      const medal = i === 0 ? '👑' : (i === 1 ? '🥈' : (i === 2 ? '🥉' : `#${i+1}`));
      return `
        <div class="fame-item" data-id="${t.id}" style="cursor: pointer;" title="Click to stream">
          <span class="fame-rank ${rankClass}">${medal}</span>
          <span class="fame-title">${t.title}</span>
          <span class="fame-votes">♥ ${t.likes || 0}</span>
        </div>
      `;
    }).join('');

    fameListContainer.querySelectorAll('.fame-item').forEach(item => {
      item.addEventListener('click', () => {
        const id = parseInt(item.getAttribute('data-id'), 10);
        const fIdx = filteredTracks.findIndex(t => t.id === id);
        if (fIdx !== -1) {
          loadTrack(fIdx, true);
        } else {
          currentCategory = 'all';
          updateCategoryTabsUI();
          applyFilters();
          const newIdx = filteredTracks.findIndex(t => t.id === id);
          if (newIdx !== -1) loadTrack(newIdx, true);
        }
      });
    });
  }

  // 像素心动爱心微粒爆发引擎
  function spawnHeartBurst(x, y) {
    if (!x || !y) return;
    const count = 7;
    for (let i = 0; i < count; i++) {
      const p = document.createElement('div');
      p.className = 'pixel-heart-particle';
      p.textContent = '♥';
      p.style.left = `${x}px`;
      p.style.top = `${y}px`;

      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.4;
      const dist = Math.random() * 45 + 30;
      const tx = Math.cos(angle) * dist;
      const ty = Math.sin(angle) * dist - 28;

      p.style.setProperty('--tx', `${tx}px`);
      p.style.setProperty('--ty', `${ty}px`);
      p.style.fontSize = `${Math.floor(Math.random() * 8) + 12}px`;

      document.body.appendChild(p);
      setTimeout(() => p.remove(), 950);
    }
  }

  // 7. 真实点赞数据增减 (前端毫秒级心跳反馈 + Cloudflare D1 云端数据库异步对账)
  function toggleLike(id, event = null) {
    const track = allTracks.find(t => t.id === id);
    if (!track) return;

    const isNowLiked = !userLikes[id];
    if (isNowLiked) {
      userLikes[id] = true;
      track.likes = (track.likes || 0) + 1;
      if (event && event.clientX) {
        spawnHeartBurst(event.clientX, event.clientY);
      }
    } else {
      delete userLikes[id];
      track.likes = Math.max(0, (track.likes || 1) - 1);
    }

    // 仅保存这台设备“我点过哪些歌”，不再存储单机假票数
    localStorage.setItem('mcr_user_likes', JSON.stringify(userLikes));

    if (currentIndex >= 0 && filteredTracks[currentIndex] && filteredTracks[currentIndex].id === id) {
      currentLikeCount.textContent = track.likes;
      currentLikeBtn.style.color = isNowLiked ? '#ff79c6' : '';
    }

    applyFilters();
    renderHallOfFame();

    // 异步同步到 Cloudflare D1 边缘数据库
    fetch('/api/like', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: id, action: isNowLiked ? 'like' : 'unlike' })
    })
      .then(res => res.json())
      .then(data => {
        if (data && data.success && typeof data.likes === 'number') {
          track.likes = data.likes;
          if (currentIndex >= 0 && filteredTracks[currentIndex] && filteredTracks[currentIndex].id === id) {
            currentLikeCount.textContent = track.likes;
          }
          applyFilters();
          renderHallOfFame();
        }
      })
      .catch(err => console.log('[Cloud D1 Sync Error]', err));
  }

  // 8. 播放器核心与极速流媒体加载引擎
  function preloadNextTrack() {
    if (!filteredTracks || filteredTracks.length <= 1) return;
    let nextIdx = currentIndex + 1;
    if (isShuffle) {
      nextIdx = Math.floor(Math.random() * filteredTracks.length);
    } else if (nextIdx >= filteredTracks.length) {
      nextIdx = 0;
    }
    const nextTrack = filteredTracks[nextIdx];
    if (nextTrack && nextTrack.src && preloaderAudio.src !== nextTrack.src) {
      preloaderAudio.src = nextTrack.src;
      preloaderAudio.load();
    }
  }

  // 靶向更新曲目播放状态 (避免全量重建 101 个 DOM 节点引发主线程掉帧)
  function updateTrackItemPlayingUI() {
    if (!tracksListContainer) return;
    const curId = currentIndex >= 0 && filteredTracks[currentIndex] ? filteredTracks[currentIndex].id : null;
    const isPlaying = !audio.paused;

    tracksListContainer.querySelectorAll('.track-item').forEach(item => {
      const id = parseInt(item.getAttribute('data-id'), 10);
      const isCur = id === curId;
      item.classList.toggle('playing', isCur);
      const btn = item.querySelector('.play-track-btn');
      if (btn) {
        btn.textContent = (isCur && isPlaying) ? '⏸' : '▶';
      }
    });
  }

  function loadTrack(index, autoPlay = true) {
    if (index < 0 || index >= filteredTracks.length) return;
    currentIndex = index;
    const track = filteredTracks[currentIndex];

    audio.src = track.src;
    playerTrackTitle.textContent = track.title;
    const dict = getI18nDict();
    const curCatName = (dict.categories && dict.categories[track.category_code]) || track.category_name;
    playerCategoryBadge.textContent = `[${curCatName}]`;
    currentLikeCount.textContent = track.likes || 0;
    currentLikeBtn.style.color = userLikes[track.id] ? '#ff79c6' : '';
    totalTimeLabel.textContent = track.duration;

    if (autoPlay) {
      // 唤醒声学分析引擎
      initWebAudioVisualizer();
      audio.play()
        .then(() => console.log('[Audio] Play started successfully for track:', track.title))
        .catch(e => console.warn('[Audio] Autoplay error:', e.name, e.message));
    }
    updatePlayBtnState();
    updateTrackItemPlayingUI();
    // 触发下一首后台静默双缓冲预加载
    preloadNextTrack();
  }

  function updatePlayBtnState() {
    const dict = getI18nDict();
    if (audio.paused) {
      playBtn.textContent = dict.playBtn || '▶ PLAY';
      playBtn.style.background = 'var(--accent-amber)';
      if (spoolLeft) spoolLeft.classList.remove('spinning');
      if (spoolRight) spoolRight.classList.remove('spinning');
      if (playLed) playLed.classList.remove('active');
    } else {
      playBtn.textContent = dict.pauseBtn || '⏸ PAUSE';
      playBtn.style.background = 'var(--accent-gold)';
      if (spoolLeft) spoolLeft.classList.add('spinning');
      if (spoolRight) spoolRight.classList.add('spinning');
      if (playLed) playLed.classList.add('active');
    }
  }

  playBtn.addEventListener('click', () => {
    initWebAudioVisualizer();
    if (currentIndex === -1 && filteredTracks.length > 0) {
      loadTrack(0, true);
      return;
    }
    if (audio.paused) {
      audio.play();
    } else {
      audio.pause();
    }
    updatePlayBtnState();
    updateTrackItemPlayingUI();
  });

  audio.addEventListener('play', () => {
    initWebAudioVisualizer();
    updatePlayBtnState();
    updateTrackItemPlayingUI();
  });

  audio.addEventListener('pause', () => {
    updatePlayBtnState();
    updateTrackItemPlayingUI();
  });

  prevBtn.addEventListener('click', () => {
    if (filteredTracks.length === 0) return;
    let nextIdx = currentIndex - 1;
    if (nextIdx < 0) nextIdx = filteredTracks.length - 1;
    loadTrack(nextIdx, true);
  });

  nextBtn.addEventListener('click', () => {
    if (filteredTracks.length === 0) return;
    let nextIdx = currentIndex + 1;
    if (isShuffle) {
      nextIdx = Math.floor(Math.random() * filteredTracks.length);
    } else if (nextIdx >= filteredTracks.length) {
      nextIdx = 0;
    }
    loadTrack(nextIdx, true);
  });

  shuffleBtn.addEventListener('click', () => {
    isShuffle = !isShuffle;
    shuffleBtn.style.background = isShuffle ? 'var(--accent-green)' : '';
    shuffleBtn.style.color = isShuffle ? '#1a1528' : '';
  });

  audio.addEventListener('ended', () => {
    nextBtn.click();
  });

  // 进度条平滑刷新
  audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const cur = audio.currentTime;
    const dur = audio.duration;
    const percent = (cur / dur) * 100;
    progressFill.style.width = `${percent}%`;
    progressThumb.style.left = `${percent}%`;

    const m = Math.floor(cur / 60);
    const s = Math.floor(cur % 60);
    currentTimeLabel.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  });

  // 进度条拖动与点击跳转寻轨 (支持点击瞬跳与按住平滑拖动)
  function seekToPosition(e) {
    const dur = (audio.duration && isFinite(audio.duration)) ? audio.duration : (filteredTracks[currentIndex] ? filteredTracks[currentIndex].duration_sec : 0);
    if (!dur) return;
    const rect = progressTrack.getBoundingClientRect();
    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = pos * dur;
    progressFill.style.width = `${pos * 100}%`;
    progressThumb.style.left = `${pos * 100}%`;
  }

  let isSeeking = false;
  progressTrack.addEventListener('mousedown', (e) => {
    isSeeking = true;
    seekToPosition(e);
  });
  window.addEventListener('mousemove', (e) => {
    if (isSeeking) {
      seekToPosition(e);
    }
  });
  window.addEventListener('mouseup', () => {
    isSeeking = false;
  });

  volumeSlider.addEventListener('input', (e) => {
    audio.volume = parseFloat(e.target.value);
  });

  currentLikeBtn.addEventListener('click', (e) => {
    if (currentIndex >= 0 && filteredTracks[currentIndex]) {
      toggleLike(filteredTracks[currentIndex].id, e);
    }
  });

  // 当前主播放器下载按钮 (同样使用 Blob 强制下载，禁止跳黑屏播放器)
  currentDownloadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    if (currentIndex >= 0 && filteredTracks[currentIndex]) {
      const cur = filteredTracks[currentIndex];
      forceDownload(cur.download_url, `${cur.title}.m4a`, currentDownloadBtn, cur.id);
    }
  });

  categoryTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.cat-tab-btn');
    if (!btn) return;
    currentCategory = btn.getAttribute('data-cat');
    updateCategoryTabsUI();
    applyFilters();
  });

  function updateCategoryTabsUI() {
    categoryTabs.querySelectorAll('.cat-tab-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-cat') === currentCategory);
    });
  }

  searchInput.addEventListener('input', () => {
    applyFilters();
  });

  // 语言切换监听器 (4 国语言无感热切换)
  const langSwitchGroup = document.getElementById('langSwitchGroup');
  if (langSwitchGroup) {
    langSwitchGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.lang-btn');
      if (!btn) return;
      const targetLang = btn.getAttribute('data-lang');
      if (targetLang && targetLang !== currentLang) {
        applyLanguage(targetLang);
      }
    });
  }

  // 猫咪互动彩蛋 (多语言随机治愈寄语)
  const catAvatar = document.getElementById('catAvatar');
  const catBubble = document.getElementById('catBubble');
  catAvatar.addEventListener('click', () => {
    const dict = getI18nDict();
    const quotes = dict.catQuotes || [
      "Purr... Enjoy the coffee! 🐾",
      "Focus mode on! Coding time! 💻",
      "Rainy days are the coziest 🌧️",
      "Midnight vibes only ✨"
    ];
    const randomMsg = quotes[Math.floor(Math.random() * quotes.length)];
    catBubble.textContent = randomMsg;
    catBubble.style.opacity = '1';
    catBubble.style.transform = 'translateY(0)';
    setTimeout(() => {
      catBubble.style.opacity = '';
      catBubble.style.transform = '';
    }, 2500);
  });

  // ==============================================================================
  // 9. Canvas 动态引擎：【真实物理 FFT 傅里叶声学频谱】18 频段均衡跳动谱
  // ==============================================================================
  const visCanvas = document.getElementById('visualizerCanvas');
  const visCtx = visCanvas.getContext('2d');
  const BAR_COUNT = 18;
  const barWidth = 8;
  const barGap = 4;
  let barHeights = new Array(BAR_COUNT).fill(2);
  let peakHeights = new Array(BAR_COUNT).fill(2);
  let peakSpeeds = new Array(BAR_COUNT).fill(0);

  // 18 根像素柱的真实对数声学频段映射 (聚焦于 Lo-Fi 有声区间 300Hz ~ 13.5kHz)
  const binIndices = [
    1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 21, 24, 27, 30, 33, 36, 38
  ];

  // 声学等响与高频增益补偿 (全面激活最后 4 根踩镲与黑胶杂音柱，低音与高音完美平衡)
  const weightCurve = [
    0.46, 0.48, 0.52, 0.62, 0.75, 0.90, 1.05, 1.15, 1.25, 1.35, 1.50, 1.65, 1.85, 2.05, 2.30, 2.55, 2.80, 2.95
  ];

  function initWebAudioVisualizer() {
    if (isWebAudioActive) {
      if (audioCtx && audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
      return;
    }

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;

      audioCtx = new AudioContextClass();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128; // 提供 64 个细腻频段采样
      analyser.smoothingTimeConstant = 0.84; // 顺滑阻尼衰减

      sourceNode = audioCtx.createMediaElementSource(audio);
      sourceNode.connect(analyser);
      analyser.connect(audioCtx.destination);

      freqDataArray = new Uint8Array(analyser.frequencyBinCount);
      isWebAudioActive = true;
      console.log('[Web Audio] 真实声波物理分析器 (64-Bin FFT) 成功挂载！');
    } catch (e) {
      console.warn('[Web Audio] 自动跨域嗅探受限，启用备选声学采样:', e);
    }
  }

  function renderVisualizer() {
    visCtx.clearRect(0, 0, visCanvas.width, visCanvas.height);
    const isPlaying = !audio.paused && !audio.ended;

    if (isPlaying && isWebAudioActive && analyser) {
      analyser.getByteFrequencyData(freqDataArray);
    }

    for (let i = 0; i < BAR_COUNT; i++) {
      let targetHeight = 2;

      if (isPlaying) {
        if (isWebAudioActive && freqDataArray) {
          const binIdx = Math.min(freqDataArray.length - 1, binIndices[i] || i);
          const rawAmp = freqDataArray[binIdx] || 0;
          const weight = weightCurve[i] || 1.0;
          // 经过声学等响补偿后的真实高度 (最大 40px)
          const compensated = (rawAmp / 255) * weight * 36;
          targetHeight = Math.max(2, Math.min(42, compensated));
        } else {
          targetHeight = 4 + Math.sin(Date.now() / 150 + i * 0.5) * 3;
        }
      } else {
        targetHeight = 2;
      }

      // 平滑插值上升与回落
      barHeights[i] += (targetHeight - barHeights[i]) * 0.28;

      // 顶部白色悬浮小盖帽物理重力掉落计算
      if (targetHeight >= peakHeights[i]) {
        peakHeights[i] = targetHeight;
        peakSpeeds[i] = 0;
      } else {
        peakSpeeds[i] += 0.32; // 模拟重力加速度
        peakHeights[i] = Math.max(targetHeight, peakHeights[i] - peakSpeeds[i]);
      }

      const x = i * (barWidth + barGap) + 4;
      const h = Math.max(2, barHeights[i]);
      const y = visCanvas.height - h;

      // 16-bit 像素渐变色系
      if (h > 24) {
        visCtx.fillStyle = '#ff79c6'; // 高振幅粉红
      } else if (h > 12) {
        visCtx.fillStyle = '#ffb86c'; // 中振幅暖橙
      } else {
        visCtx.fillStyle = '#f1fa8c'; // 低振幅暖黄
      }

      // 绘制主像素柱
      visCtx.fillRect(x, Math.floor(y), barWidth, Math.ceil(h));

      // 绘制带物理重力回落的白色像素小盖帽
      const capY = Math.max(0, visCanvas.height - peakHeights[i] - 2);
      visCtx.fillStyle = '#ffffff';
      visCtx.fillRect(x, Math.floor(capY), barWidth, 2);
    }

    requestAnimationFrame(renderVisualizer);
  }
  renderVisualizer();
});
