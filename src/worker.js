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

const jsonResponse = (data, status = 200, extraHeaders = {}) => {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

        // 边缘缓存 5 秒，浏览器缓存 5 秒，抵抗高并发
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
          // 检查此访客是否已点赞过该曲目 (防重复刷票)
          const existing = await env.DB.prepare(
            'SELECT id FROM vote_logs WHERE track_id = ? AND visitor_hash = ? LIMIT 1'
          ).bind(trackId, visitorHash).first();

          if (!existing) {
            // 写入日志并原子累加
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
          // 取消点赞
          await env.DB.batch([
            env.DB.prepare(
              'DELETE FROM vote_logs WHERE track_id = ? AND visitor_hash = ?'
            ).bind(trackId, visitorHash),
            env.DB.prepare(
              'UPDATE track_stats SET likes_count = MAX(0, likes_count - 1) WHERE track_id = ?'
            ).bind(trackId)
          ]);
        }

        // 查询最新票数返回
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
          // 静默记录
        }
      }
      return jsonResponse({ success: true });
    }

    // --------------------------------------------------------------------------
    // 4. 静态资源托管兜底 (交由 Cloudflare Workers Assets 引擎)
    // --------------------------------------------------------------------------
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Asset Binding Not Found', { status: 404 });
  }
};
