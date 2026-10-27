/**
 * Midnight Coffee Radio - Cloudflare Worker Edge API
 * 结合 Cloudflare D1 边缘数据库与 Static Assets
 */

async function hashVisitor(ip, userAgent) {
  const data = new TextEncoder().encode(`${ip || 'unknown'}-${userAgent || 'unknown'}-mcr-salt-2026`);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function sanitizeText(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const jsonResponse = (data, status = 200, extraHeaders = {}) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      ...extraHeaders
    }
  });
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 处理 CORS 预检
    if (request.method === 'OPTIONS') {
      return jsonResponse({}, 204);
    }

    // --------------------------------------------------------------------------
    // 1. API 路由: GET /api/stats (获取 101 首歌曲的全网点赞与下载排行榜)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ success: false, error: 'D1 database binding missing', stats: {} }, 200);
      }

      try {
        const { results } = await env.DB.prepare(
          'SELECT track_id, likes_count, download_count FROM track_stats'
        ).all();

        const stats = {};
        for (const row of results || []) {
          stats[row.track_id] = {
            likes: row.likes_count || 0,
            downloads: row.download_count || 0
          };
        }

        return jsonResponse({ success: true, stats }, 200, {
          'Cache-Control': 'public, max-age=5, s-maxage=5'
        });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message, stats: {} }, 500);
      }
    }

    // --------------------------------------------------------------------------
    // 2. API 路由: POST /api/like (全球点赞 / 取消点赞，附带匿名哈希防刷)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/like' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ success: false, error: 'D1 database binding missing' }, 200);
      }

      try {
        const body = await request.json().catch(() => ({}));
        const trackId = parseInt(body.trackId, 10);
        const action = body.action === 'unlike' ? 'unlike' : 'like';

        if (!trackId || trackId < 1 || trackId > 101) {
          return jsonResponse({ success: false, error: 'Invalid trackId' }, 400);
        }

        const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
        const ua = request.headers.get('user-agent') || 'generic';
        const visitorHash = await hashVisitor(ip, ua);

        if (action === 'like') {
          const existing = await env.DB.prepare(
            'SELECT id FROM vote_logs WHERE track_id = ? AND visitor_hash = ? LIMIT 1'
          ).bind(trackId, visitorHash).first();

          if (!existing) {
            await env.DB.batch([
              env.DB.prepare(
                'INSERT INTO vote_logs (track_id, visitor_hash, action) VALUES (?, ?, "like")'
              ).bind(trackId, visitorHash),
              env.DB.prepare(
                'UPDATE track_stats SET likes_count = likes_count + 1 WHERE track_id = ?'
              ).bind(trackId)
            ]);
          }
        } else {
          await env.DB.batch([
            env.DB.prepare(
              'DELETE FROM vote_logs WHERE track_id = ? AND visitor_hash = ?'
            ).bind(trackId, visitorHash),
            env.DB.prepare(
              'UPDATE track_stats SET likes_count = MAX(0, likes_count - 1) WHERE track_id = ?'
            ).bind(trackId)
          ]);
        }

        const updated = await env.DB.prepare(
          'SELECT likes_count FROM track_stats WHERE track_id = ?'
        ).bind(trackId).first();

        return jsonResponse({
          success: true,
          trackId,
          likes: updated ? updated.likes_count : 0
        });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // --------------------------------------------------------------------------
    // 3. API 路由: POST /api/download (统计曲目单曲下载次数)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/download' && request.method === 'POST') {
      if (env.DB) {
        try {
          const body = await request.json().catch(() => ({}));
          const trackId = parseInt(body.trackId, 10);
          if (trackId >= 1 && trackId <= 101) {
            await env.DB.prepare(
              'UPDATE track_stats SET download_count = download_count + 1 WHERE track_id = ?'
            ).bind(trackId).run();
          }
        } catch (e) {
          // 静默忽略
        }
      }
      return jsonResponse({ success: true });
    }

    // --------------------------------------------------------------------------
    // 4. API 路由: GET /api/messages (拉取留言板最新 30 条留言)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/messages' && request.method === 'GET') {
      if (!env.DB) {
        return jsonResponse({ success: false, messages: [] }, 200);
      }

      try {
        const { results } = await env.DB.prepare(
          'SELECT id, nickname, avatar_emoji, content, created_at FROM guestbook_messages WHERE status = "approved" ORDER BY id DESC LIMIT 30'
        ).all();

        return jsonResponse({ success: true, messages: results || [] }, 200, {
          'Cache-Control': 'public, max-age=3, s-maxage=3'
        });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message, messages: [] }, 500);
      }
    }

    // --------------------------------------------------------------------------
    // 5. API 路由: POST /api/message (发布新留言，含链接拦截 + 30s 冷却)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/message' && request.method === 'POST') {
      if (!env.DB) {
        return jsonResponse({ success: false, error: 'Database not available' }, 200);
      }

      try {
        const body = await request.json().catch(() => ({}));
        let content = (body.content || '').trim();
        let nickname = (body.nickname || '').trim() || 'Anon';
        let avatarEmoji = (body.avatarEmoji || '').trim() || '☕';

        // 基础参数校验
        if (!content) {
          return jsonResponse({ success: false, error: 'ERR_EMPTY' }, 400);
        }

        // 截断超长字符串
        if (content.length > 100) {
          content = content.slice(0, 100);
        }
        if (nickname.length > 16) {
          nickname = nickname.slice(0, 16);
        }

        // 头像 Emoji 白名单
        const validAvatars = ['☕', '🐱', '🎧', '🌧️', '🌙', '✨'];
        if (!validAvatars.includes(avatarEmoji)) {
          avatarEmoji = '☕';
        }

        // 1. 严格广告与外部链接拦截
        const linkRegex = /(https?:\/\/|www\.|t\.me\/|t\.cn\/|bit\.ly\/|[a-zA-Z0-9-]+\.(com|net|org|xyz|io|co|me|vip|top|cc|ru|cn)(\/|\s|$))/i;
        if (linkRegex.test(content) || linkRegex.test(nickname)) {
          return jsonResponse({ success: false, error: 'ERR_NO_LINKS' }, 400);
        }

        const ip = request.headers.get('cf-connecting-ip') || '127.0.0.1';
        const ua = request.headers.get('user-agent') || 'generic';
        const visitorHash = await hashVisitor(ip, ua);

        // 2. 30 秒 IP 发言冷却风控
        const lastMsg = await env.DB.prepare(
          "SELECT (strftime('%s', 'now') - strftime('%s', created_at)) as diff_sec FROM guestbook_messages WHERE visitor_hash = ? ORDER BY id DESC LIMIT 1"
        ).bind(visitorHash).first();

        if (lastMsg && typeof lastMsg.diff_sec === 'number' && lastMsg.diff_sec < 30) {
          const remaining = Math.max(1, 30 - Math.floor(lastMsg.diff_sec));
          return jsonResponse({ success: false, error: 'ERR_RATE_LIMIT', remaining }, 429);
        }

        // 3. XSS 安全字符转义入库
        const safeContent = sanitizeText(content);
        const safeNickname = sanitizeText(nickname);

        const insertRes = await env.DB.prepare(
          'INSERT INTO guestbook_messages (nickname, avatar_emoji, content, visitor_hash, status) VALUES (?, ?, ?, ?, "approved")'
        ).bind(safeNickname, avatarEmoji, safeContent, visitorHash).run();

        const newId = insertRes.meta?.last_row_id;

        return jsonResponse({
          success: true,
          message: {
            id: newId,
            nickname: safeNickname,
            avatar_emoji: avatarEmoji,
            content: safeContent,
            created_at: new Date().toISOString()
          }
        });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // --------------------------------------------------------------------------
    // 6. API 路由: DELETE /api/message (管理员删除留言)
    // --------------------------------------------------------------------------
    if (url.pathname === '/api/message' && request.method === 'DELETE') {
      if (!env.DB) {
        return jsonResponse({ success: false, error: 'Database not available' }, 200);
      }

      // 管理员鉴权校验
      const authHeader = request.headers.get('Authorization') || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      const adminSecret = env.ADMIN_SECRET || 'mcr_coffee_admin_2026';

      if (!token || token !== adminSecret) {
        return jsonResponse({ success: false, error: 'UNAUTHORIZED' }, 401);
      }

      try {
        const body = await request.json().catch(() => ({}));
        const messageId = parseInt(body.id || url.searchParams.get('id'), 10);

        if (!messageId) {
          return jsonResponse({ success: false, error: 'Missing message ID' }, 400);
        }

        await env.DB.prepare(
          'DELETE FROM guestbook_messages WHERE id = ?'
        ).bind(messageId).run();

        return jsonResponse({ success: true, id: messageId });
      } catch (err) {
        return jsonResponse({ success: false, error: err.message }, 500);
      }
    }

    // --------------------------------------------------------------------------
    // 7. 静态资源托管兜底 (交由 Cloudflare Workers Assets 引擎)
    // --------------------------------------------------------------------------
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Asset Binding Not Found', { status: 404 });
  }
};
