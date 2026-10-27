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

  // 2. 状态变量
  let allTracks = [];
  let filteredTracks = [];
  let currentIndex = -1;
  let isShuffle = false;
  let currentCategory = 'all';

  // 多语言国际化 (i18n) 状态管理 (中 / 日 / 韩 / 英)
  function detectInitialLang() {
    const saved = localStorage.getItem('mcr_lang');
    if (saved && ['en', 'zh', 'ja', 'ko'].includes(saved)) return saved;
    const nav = (navigator.language || '').toLowerCase();
    if (nav.startsWith('zh')) return 'zh';
    if (nav.startsWith('ja')) return 'ja';
    if (nav.startsWith('ko')) return 'ko';
    return 'en';
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

    const elCreatorLicenseTitle = document.getElementById('creatorLicenseTitle');
    if (elCreatorLicenseTitle && dict.creatorLicense) elCreatorLicenseTitle.textContent = dict.creatorLicense;

    const elLicenseDesc = document.getElementById('licenseDesc');
    if (elLicenseDesc && dict.licenseDesc) elLicenseDesc.innerHTML = dict.licenseDesc;

    const elPillTag1 = document.getElementById('pillTag1');
    if (elPillTag1 && dict.pillTag1) elPillTag1.textContent = dict.pillTag1;

    const elPillTag2 = document.getElementById('pillTag2');
    if (elPillTag2 && dict.pillTag2) elPillTag2.textContent = dict.pillTag2;

    const elPillTag3 = document.getElementById('pillTag3');
    if (elPillTag3 && dict.pillTag3) elPillTag3.textContent = dict.pillTag3;

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
    // 异步拉取全网 D1 真实云端总账本
    loadCloudStats();
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

      // 3. 点击整行播放切换
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

  // 8. 播放器核心
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
      audio.play().catch(e => console.log('Autoplay prevented:', e));
    }
    updatePlayBtnState();
    renderTracksList();
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
    renderTracksList();
  });

  audio.addEventListener('play', () => {
    initWebAudioVisualizer();
    updatePlayBtnState();
    renderTracksList();
  });

  audio.addEventListener('pause', () => {
    updatePlayBtnState();
    renderTracksList();
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

  let audioCtx = null;
  let analyser = null;
  let sourceNode = null;
  let freqDataArray = null;
  let isWebAudioActive = false;

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
