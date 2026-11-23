/**
 * Cloudflare Worker — LINE 團購系統後端
 * 資料層：Cloudflare D1 (SQLite)，取代原本 Google Apps Script + Google Sheets
 *
 * 環境變數（Worker Secrets，以 wrangler secret put 設定）：
 *   LINE_CHANNEL_TOKEN  — LINE Messaging API Channel Access Token
 *   LINE_GROUP_ID       — LINE 群組 ID（C 開頭）
 *   ADMIN_SECRET        — 管理員密碼
 *   GITHUB_PAT          — GitHub Personal Access Token（供圖片上傳用）
 *
 * D1 Binding（wrangler.toml）：
 *   [[d1_databases]]
 *   binding = "DB"
 */

// ── 靜態設定 ──────────────────────────────────────────────
const GITHUB_OWNER  = 'isabelcyen';
const GITHUB_REPO   = 'line-groupbuy';
const GITHUB_BRANCH = 'main';
const GITHUB_DIR    = 'images';

const LIFF_ORDER  = 'https://liff.line.me/2011684954-yOthIDvq';  // 訂購頁
const LIFF_MEMBER = 'https://liff.line.me/2011684954-5YTqdunj';  // 會員中心

// ── 回應工具函式 ──────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonErr(msg, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── 亂數 ID 產生 ──────────────────────────────────────────
function nanoid(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint8Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => chars[b % chars.length]).join('');
}

function nowIso() {
  return new Date().toISOString();
}

// ── 管理員驗證 ────────────────────────────────────────────
function requireAdmin(body, env) {
  if (!body.adminSecret || body.adminSecret !== env.ADMIN_SECRET) {
    const e = new Error('未授權：管理員密碼錯誤');
    e.status = 401;
    throw e;
  }
}

// ── GitHub 圖片上傳 ───────────────────────────────────────
async function uploadImageToGitHub(b64, fileName, env) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `${GITHUB_DIR}/${Date.now()}_${safeName}`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;

  const resp = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      Authorization: `token ${env.GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'CloudflareWorker/1.0',
    },
    body: JSON.stringify({
      message: `Upload ${safeName}`,
      content: b64,
      branch: GITHUB_BRANCH,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`GitHub 上傳失敗 (${resp.status}): ${text.slice(0, 200)}`);
  }
  const json = await resp.json();
  return json.content.download_url;
}

// ── LINE 群組推播 ─────────────────────────────────────────
async function pushToGroup(messages, env) {
  const resp = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}`,
    },
    body: JSON.stringify({ to: env.LINE_GROUP_ID, messages }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error('LINE push error:', text);
    throw new Error(`LINE API 錯誤 (${resp.status}): ${text.slice(0, 300)}`);
  }
}

// ── 解析規格字串 → JSON ───────────────────────────────────
// 輸入格式：已是 JSON 陣列 / 逗號或換行分隔的 "名稱(價格)" 或 "名稱(價格/限量)"
function parseVariantsToJson(str) {
  if (!str) return '[]';
  const s = String(str).trim();
  if (s.startsWith('[')) return s; // 已是 JSON
  const lines = s.split(/[,\n]/).map(l => l.trim()).filter(Boolean);
  const result = lines.map(l => {
    const m = l.match(/^(.+?)\((\d+(?:\.\d+)?)(?:\/(\d+))?\)$/);
    if (m) return { name: m[1].trim(), price: Number(m[2]), quota: m[3] !== undefined ? Number(m[3]) : 0 };
    return { name: l, price: 0, quota: 0 };
  });
  return JSON.stringify(result);
}

// ── 到貨通知 Flex Bubble ──────────────────────────────────
function buildArrivalBubble(product) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric' });
  const bubble = {
    type: 'bubble',
    header: {
      type: 'box', layout: 'vertical', paddingAll: '16px',
      backgroundColor: '#FF6B35',
      contents: [
        { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: '📦 團購到貨通知', color: '#FFFFFF', size: 'sm', flex: 1 },
            { type: 'text', text: dateStr, color: '#FFE0CC', size: 'sm', align: 'end' },
          ],
        },
        { type: 'text', text: product.name, color: '#FFFFFF', size: 'xl', weight: 'bold', wrap: true },
      ],
    },
    body: {
      type: 'box', layout: 'vertical', paddingAll: '16px', spacing: 'md',
      contents: [
        { type: 'text', text: '商品已到貨，請盡快來社辦取貨！取貨時間與地點請見公告或記事本"團購小幫手"', wrap: true, size: 'md', color: '#333333' },
        { type: 'text', text: '請儘量備好零錢與購物袋，謝謝您的體貼＆支持環保 ～', wrap: true, size: 'sm', color: '#888888' },
      ],
    },
    footer: {
      type: 'box', layout: 'vertical', paddingAll: '12px', paddingTop: '0px',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: '📲 點此查看到貨通知',
            uri: `${LIFF_MEMBER}?liff.state=${encodeURIComponent('#arrivals')}`,
          },
          style: 'primary',
          color: '#FF6B35',
          height: 'sm',
        },
      ],
    },
  };
  return bubble;
}

// ══════════════════════════════════════════════════════════
//  主要 Handler
// ══════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      // ── LINE Webhook ────────────────────────────────────
      if (pathname === '/webhook') {
        if (request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const events = body.events || [];
          for (const ev of events) {
            // ── 管理員查詢社群/群組 ID（在群內發送 "groupid" 即可）──
            if (ev.type === 'message' && ev.message?.type === 'text') {
              const txt = (ev.message.text || '').trim().toLowerCase();
              if (txt === 'groupid') {
                const sourceId = ev.source?.groupId || ev.source?.roomId || ev.source?.userId || '（無法取得）';
                const replyToken = ev.replyToken;
                await fetch('https://api.line.me/v2/bot/message/reply', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` },
                  body: JSON.stringify({
                    replyToken,
                    messages: [{ type: 'text', text: `📋 此聊天室 ID：\n${sourceId}` }],
                  }),
                }).catch(() => {});
                continue;
              }
            }

            if (ev.type === 'memberJoined') {
              const members = ev.joined?.members || [];
              for (const m of members) {
                if (m.type !== 'user') continue;
                const uid = m.userId;
                const groupId = ev.source?.groupId || env.LINE_GROUP_ID;

                // 取得 LINE 顯示名稱
                let displayName = '';
                try {
                  const profileRes = await fetch(
                    `https://api.line.me/v2/bot/group/${groupId}/member/${uid}`,
                    { headers: { Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}` } }
                  );
                  const profile = await profileRes.json();
                  displayName = profile.displayName || '';
                } catch (_) {}

                // 寫入 members 資料表（已存在則略過，避免蓋掉原有資料）
                await db.prepare(`
                  INSERT INTO members (line_user_id, member_name, phone_last3, created_at)
                  VALUES (?, ?, '', ?)
                  ON CONFLICT(line_user_id) DO NOTHING
                `).bind(uid, displayName, nowIso()).run().catch(() => {});

                // 傳歡迎訊息到群組
                const welcomeText = `歡迎 ${displayName} 加入「交大嚴選-員生社團購」群組！🛒\n點此連結可查看公告、團購中、訂單、到貨等訊息：${LIFF_MEMBER}`;
                await fetch('https://api.line.me/v2/bot/message/push', {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${env.LINE_CHANNEL_TOKEN}`,
                  },
                  body: JSON.stringify({
                    to: groupId,
                    messages: [{ type: 'text', text: welcomeText }],
                  }),
                }).catch(() => {});
              }
            }
          }
        }
        return new Response('OK', { status: 200 });
      }

      // ── 推播到 LINE 群組 ────────────────────────────────
      if (pathname === '/push-group') {
        if (request.method !== 'POST') return jsonErr('Method not allowed', 405);
        const body = await request.json();
        if (!body.adminSecret || body.adminSecret !== env.ADMIN_SECRET) {
          return jsonErr('未授權', 403);
        }
        let messages;
        if (body.messages)      messages = body.messages;
        else if (body.text)     messages = [{ type: 'text', text: body.text }];
        else return jsonErr('messages 或 text 必填');

        await pushToGroup(messages, env);
        return jsonOk({ sent: true });
      }

      // ── 圖片上傳（透過 Worker，PAT 在 Secret）──────────
      if (pathname === '/upload-image') {
        if (request.method !== 'POST') return jsonErr('Method not allowed', 405);
        const body = await request.json();
        const { b64, fileName } = body;
        if (!b64 || !fileName) return jsonErr('b64 和 fileName 必填');
        const imageUrl = await uploadImageToGitHub(b64, fileName, env);
        return new Response(JSON.stringify({ ok: true, url: imageUrl }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }

      // ── 主 API ─────────────────────────────────────────
      const db = env.DB;

      // GET 請求（?action=product&pid=... 或 ?action=order&oid=...）
      if (request.method === 'GET') {
        return await handleGet(url, db);
      }

      // POST 請求（JSON body 含 action 欄位）
      if (request.method === 'POST') {
        const body = await request.json();
        return await handlePost(body, db, env);
      }

      return jsonErr('Method not allowed', 405);

    } catch (e) {
      console.error('Worker exception:', e.message, e.stack);
      const status = e.status || 500;
      return jsonErr(e.message || '伺服器錯誤', status);
    }
  },
};

// ══════════════════════════════════════════════════════════
//  GET 路由
// ══════════════════════════════════════════════════════════
async function handleGet(url, db) {
  const action = url.searchParams.get('action');

  // GET ?action=product&pid=PROD...（pid 省略時回傳最新 active 商品）
  if (action === 'product') {
    const pid = url.searchParams.get('pid');

    let product;
    if (pid) {
      product = await db.prepare('SELECT * FROM products WHERE product_id = ?').bind(pid).first();
      if (!product) return jsonErr('找不到此團購', 404);
    } else {
      // 無 pid → 回傳最新 active 團購（通知 URL 未帶 pid 時的備援）
      product = await db.prepare(
        `SELECT * FROM products WHERE status = 'open' AND (deadline IS NULL OR datetime(deadline) > datetime('now')) ORDER BY created_at DESC LIMIT 1`
      ).first();
      if (!product) return jsonErr('目前沒有進行中的團購', 404);
    }

    const effectivePid = product.product_id;

    // 統計規格訂購數量（解析 "名稱×數量" 格式）
    const varRows = await db.prepare(`
      SELECT variant
      FROM orders
      WHERE product_id = ? AND pay_status != 'cancelled'
    `).bind(effectivePid).all();

    const variantTotals = {};
    let totalOrders = 0;
    for (const r of (varRows.results || [])) {
      for (const part of (r.variant || '').split(',').map(s => s.trim())) {
        const m = part.match(/^(.+?)×(\d+)$/);
        if (m) {
          const name = m[1].trim(), qty = Number(m[2]);
          variantTotals[name] = (variantTotals[name] || 0) + qty;
          totalOrders += qty;
        }
      }
    }

    const memberRow = await db.prepare(
      `SELECT COUNT(DISTINCT line_user_id) AS cnt FROM orders WHERE product_id = ? AND pay_status != 'cancelled'`
    ).bind(effectivePid).first();
    const memberCount = memberRow?.cnt || 0;

    return jsonOk({
      product_id:     product.product_id,
      name:           product.name,
      description:    product.description,
      price:          product.price,
      original_price: product.price,
      imageUrl:       product.image_url,
      deadline:       product.deadline,
      status:         product.status,
      variants:       JSON.parse(product.variants || '[]'),
      max_qty:        10,
      totalOrders,
      memberCount,
      variantTotals,
    });
  }

  // GET ?action=order&oid=ORD...
  if (action === 'order') {
    const oid = url.searchParams.get('oid');
    if (!oid) return jsonErr('oid 必填');
    const order = await db.prepare(
      'SELECT pay_status, variant, total FROM orders WHERE order_id = ?'
    ).bind(oid).first();
    if (!order) return jsonErr('找不到此訂單', 404);
    return jsonOk({ pay_status: order.pay_status, variant: order.variant, total: order.total });
  }

  return jsonErr('未知的 action', 400);
}

// ══════════════════════════════════════════════════════════
//  POST 路由（switch on action）
// ══════════════════════════════════════════════════════════
async function handlePost(body, db, env) {
  const { action } = body;
  if (!action) return jsonErr('action 必填');

  switch (action) {

    // ────────────────────────────────────────────────────
    //  管理員專用 API
    // ────────────────────────────────────────────────────

    case 'list_products': {
      requireAdmin(body, env);
      const r = await db.prepare(`
        SELECT p.*,
               (SELECT COUNT(DISTINCT o.line_user_id)
                FROM orders o
                WHERE o.product_id = p.product_id AND o.pay_status != 'cancelled') AS member_count,
               (SELECT COUNT(*)
                FROM orders o
                WHERE o.product_id = p.product_id AND o.pay_status IN ('pending','reviewing')) AS pending_count
        FROM products p
        ORDER BY p.created_at DESC
      `).all();
      const products = (r.results || []).map(p => ({ ...p, variants: JSON.parse(p.variants || '[]') }));
      return jsonOk({ products });
    }

    case 'list_orders': {
      requireAdmin(body, env);
      const r = await db.prepare(`
        SELECT o.*,
               m.member_name,
               m.phone_last3
        FROM   orders o
        LEFT JOIN members m ON o.line_user_id = m.line_user_id
        ORDER BY o.created_at DESC
      `).all();
      return jsonOk({ orders: r.results || [] });
    }

    case 'admin_find_members': {
      requireAdmin(body, env);
      const { name } = body;
      if (!name) return jsonErr('name 必填');
      const rows = await db.prepare(
        'SELECT line_user_id, member_name, phone_last3 FROM members WHERE member_name LIKE ? ORDER BY member_name LIMIT 20'
      ).bind('%' + name + '%').all();
      return jsonOk({ members: rows.results || [] });
    }

    case 'admin_get_member': {
      requireAdmin(body, env);
      const { lineUserId } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      const m = await db.prepare('SELECT line_user_id, member_name, phone_last3 FROM members WHERE line_user_id=?').bind(lineUserId).first();
      if (!m) return jsonErr('查無此 LINE ID 的成員', 404);
      return jsonOk({ member: m });
    }

    case 'admin_set_phone': {
      requireAdmin(body, env);
      const { lineUserId, phone } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      if (!phone || !/^\d{3}$/.test(phone)) return jsonErr('後三碼須為 3 位數字');
      const r = await db.prepare('UPDATE members SET phone_last3=? WHERE line_user_id=?').bind(phone, lineUserId).run();
      if (!r.meta?.changes) return jsonErr('查無此成員，無法更新', 404);
      return jsonOk({ updated: true });
    }

    case 'list_payments': {
      requireAdmin(body, env);
      const r = await db.prepare('SELECT * FROM payments ORDER BY submitted_at DESC').all();
      return jsonOk({ payments: r.results || [] });
    }

    case 'get_shipping_summary': {
      requireAdmin(body, env);
      // 取所有非取消訂單，JOIN 團員資料
      const r = await db.prepare(`
        SELECT o.order_id,
               o.product_id,
               o.product_name,
               o.variant,
               o.qty,
               o.total,
               o.pay_status,
               o.product_status,
               o.created_at,
               m.line_user_id,
               m.member_name,
               m.phone_last3
        FROM   orders o
        LEFT JOIN members m ON o.line_user_id = m.line_user_id
        WHERE  o.pay_status != 'cancelled'
        ORDER BY m.phone_last3, o.created_at
      `).all();

      // 以 line_user_id 為 key 聚合
      const memberMap = {};
      for (const row of (r.results || [])) {
        const key = row.line_user_id || `__${row.order_id}`;
        if (!memberMap[key]) {
          memberMap[key] = {
            line_user_id: row.line_user_id || '',
            member_name:  row.member_name  || '未知',
            phone_last3:  row.phone_last3  || '',
            orders: [],
          };
        }
        memberMap[key].orders.push({
          order_id:       row.order_id,
          product_id:     row.product_id,
          product_name:   row.product_name,
          variant:        row.variant,
          qty:            row.qty,
          total:          row.total,
          pay_status:     row.pay_status,
          product_status: row.product_status || '',
        });
      }
      return jsonOk({ members: Object.values(memberMap) });
    }

    case 'get_general_announcements': {
      const r = await db.prepare(`
        SELECT * FROM announcements
        WHERE title != '__DELETED__'
        ORDER BY pinned DESC, created_at DESC
      `).all();
      // 轉換 pinned: 1/0 → true/false
      const anns = (r.results || []).map(a => ({
        ...a, pinned: a.pinned === 1 || a.pinned === true,
      }));
      return jsonOk({ announcements: anns });
    }

    case 'create_announcement': {
      requireAdmin(body, env);
      const { title, content, imageUrl, pinned, notifyGroup } = body;
      if (!title) return jsonErr('title 必填');
      const annId = 'ANN' + nanoid();
      await db.prepare(`
        INSERT INTO announcements (ann_id, title, content, image_url, pinned, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(annId, title, content || '', imageUrl || '', pinned ? 1 : 0, nowIso()).run();

      if (notifyGroup) {
        try {
          const text = `📢 新公告：${title}${content ? '\n' + content : ''}`;
          await pushToGroup([{ type: 'text', text }], env);
        } catch {}
      }
      return jsonOk({ ann_id: annId });
    }

    case 'update_announcement': {
      requireAdmin(body, env);
      const { annId, title, content, imageUrl, pinned } = body;
      if (!annId) return jsonErr('annId 必填');
      await db.prepare(`
        UPDATE announcements
        SET title=?, content=?, image_url=?, pinned=?
        WHERE ann_id=?
      `).bind(title, content || '', imageUrl || '', pinned ? 1 : 0, annId).run();
      return jsonOk({ ann_id: annId });
    }

    case 'delete_announcement': {
      requireAdmin(body, env);
      const { annId } = body;
      if (!annId) return jsonErr('annId 必填');
      await db.prepare('DELETE FROM announcements WHERE ann_id = ?').bind(annId).run();
      return jsonOk({ ann_id: annId });
    }

    case 'create_product': {
      requireAdmin(body, env);
      const { name, price, unit, description, imageUrl, deadline, variants } = body;
      if (!name)     return jsonErr('name 必填');
      if (!variants) return jsonErr('variants 必填');
      const productId = 'PROD' + nanoid();
      const varJson   = parseVariantsToJson(variants);
      await db.prepare(`
        INSERT INTO products
          (product_id, name, description, price, unit, image_url, deadline, variants, status, order_count, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', 0, ?)
      `).bind(
        productId, name, description || '', Number(price) || 0,
        unit || '份', imageUrl || '', deadline || '', varJson, nowIso()
      ).run();
      return jsonOk({ product_id: productId });
    }

    case 'update_product': {
      requireAdmin(body, env);
      const { productId, name, price, unit, description, imageUrl, deadline, variants, status } = body;
      if (!productId) return jsonErr('productId 必填');

      const fields = [], values = [];
      if (name        !== undefined) { fields.push('name=?');        values.push(name); }
      if (price       !== undefined) { fields.push('price=?');       values.push(Number(price)); }
      if (unit        !== undefined) { fields.push('unit=?');        values.push(unit); }
      if (description !== undefined) { fields.push('description=?'); values.push(description); }
      if (imageUrl    !== undefined) { fields.push('image_url=?');   values.push(imageUrl); }
      if (deadline    !== undefined) { fields.push('deadline=?');    values.push(deadline); }
      if (variants    !== undefined) { fields.push('variants=?');    values.push(parseVariantsToJson(variants)); }
      if (status      !== undefined) { fields.push('status=?');      values.push(status); }

      if (!fields.length) return jsonErr('沒有需要更新的欄位');
      values.push(productId);
      await db.prepare(
        `UPDATE products SET ${fields.join(', ')} WHERE product_id=?`
      ).bind(...values).run();
      return jsonOk({ product_id: productId });
    }

    case 'get_product_stats': {
      requireAdmin(body, env);
      const { productId } = body;
      if (!productId) return jsonErr('productId 必填');

      // 規格統計（解析 "名稱×數量" 格式）
      const varR = await db.prepare(`
        SELECT variant
        FROM   orders
        WHERE  product_id=? AND pay_status != 'cancelled'
      `).bind(productId).all();

      const variantTotals = {};
      (varR.results || []).forEach(r => {
        for (const part of (r.variant || '').split(',').map(s => s.trim())) {
          const m = part.match(/^(.+?)×(\d+)$/);
          if (m) { const name = m[1].trim(), qty = Number(m[2]); variantTotals[name] = (variantTotals[name] || 0) + qty; }
        }
      });

      // 團員訂購明細
      const memR = await db.prepare(`
        SELECT o.line_user_id, o.variant, o.qty,
               m.member_name, m.phone_last3
        FROM   orders o
        LEFT JOIN members m ON o.line_user_id = m.line_user_id
        WHERE  o.product_id=? AND o.pay_status != 'cancelled'
        ORDER BY m.phone_last3
      `).bind(productId).all();

      const memberMap = {};
      (memR.results || []).forEach(r => {
        const key = r.line_user_id;
        if (!memberMap[key]) {
          memberMap[key] = { phone: r.phone_last3 || '—', name: r.member_name || '—', variants: {} };
        }
        const v = r.variant || '預設';
        memberMap[key].variants[v] = (memberMap[key].variants[v] || 0) + (r.qty || 1);
      });

      const cntR = await db.prepare(`
        SELECT COUNT(DISTINCT line_user_id) AS cnt
        FROM   orders
        WHERE  product_id=? AND pay_status != 'cancelled'
      `).bind(productId).first();

      // 個別訂單列表（按下單時間新→舊）
      const ordR = await db.prepare(`
        SELECT o.order_id, o.variant, o.qty, o.created_at,
               m.member_name, m.phone_last3
        FROM   orders o
        LEFT JOIN members m ON o.line_user_id = m.line_user_id
        WHERE  o.product_id=? AND o.pay_status != 'cancelled'
        ORDER BY o.created_at DESC
      `).bind(productId).all();

      return jsonOk({
        variantTotals,
        memberList: Object.values(memberMap),
        orderCount: cntR?.cnt || 0,
        orderList:  ordR.results || [],
      });
    }

    case 'diagnose_arrivals': {
      // 診斷用：查詢指定商品所有訂單的 product_status 和 pay_status
      requireAdmin(body, env);
      const { productId } = body;
      if (!productId) return jsonErr('productId 必填');
      const r = await db.prepare(`
        SELECT order_id, line_user_id, pay_status, product_status, qty, variant
        FROM orders WHERE product_id=? ORDER BY created_at DESC
      `).bind(productId).all();
      return jsonOk({ rows: r.results || [] });
    }

    case 'refresh_arrivals': {
      // 補標記：已 notified 的商品，把訂單的 product_status 也設成 notified（不重送訊息）
      requireAdmin(body, env);
      const { productId } = body;
      if (!productId) return jsonErr('productId 必填');
      const product = await db.prepare("SELECT product_id FROM products WHERE product_id=? AND status='notified'").bind(productId).first();
      if (!product) return jsonErr('找不到已通知的商品', 404);
      const r = await db.prepare(`
        UPDATE orders SET product_status='notified'
        WHERE product_id=? AND pay_status NOT IN ('cancelled','received')
      `).bind(productId).run();
      return jsonOk({ updated: r.meta?.changes ?? 0 });
    }

    case 'notify_arrived': {
      requireAdmin(body, env);
      const { productId } = body;
      if (!productId) return jsonErr('productId 必填');

      const product = await db.prepare('SELECT * FROM products WHERE product_id=?').bind(productId).first();
      if (!product) return jsonErr('找不到此團購', 404);

      // 更新團購狀態
      await db.prepare("UPDATE products SET status='notified' WHERE product_id=?").bind(productId).run();

      // 標記所有非取消/非已領貨的訂單為「已通知」
      await db.prepare(`
        UPDATE orders SET product_status='notified'
        WHERE product_id=? AND pay_status NOT IN ('cancelled', 'received')
      `).bind(productId).run();

      // 傳送 LINE 群組到貨通知
      const bubble = buildArrivalBubble(product);
      await pushToGroup([{
        type: 'flex',
        altText: `📦 ${product.name} 到貨通知，請盡快來取貨！`,
        contents: bubble,
      }], env);

      return jsonOk({ notified: true });
    }

    case 'confirm_payment': {
      requireAdmin(body, env);
      const { orderId } = body;
      if (!orderId) return jsonErr('orderId 必填');
      await db.prepare("UPDATE orders  SET pay_status='paid' WHERE order_id=?").bind(orderId).run();
      await db.prepare("UPDATE payments SET pay_status='paid' WHERE order_id=?").bind(orderId).run();
      return jsonOk({ order_id: orderId });
    }

    case 'mark_shipping': {
      requireAdmin(body, env);
      const { orderId } = body;
      if (!orderId) return jsonErr('orderId 必填');
      await db.prepare("UPDATE orders SET pay_status='received' WHERE order_id=?").bind(orderId).run();
      return jsonOk({ order_id: orderId });
    }

    case 'cancel_order': {
      const { orderId, lineUserId } = body;
      if (!orderId) return jsonErr('orderId 必填');

      if (body.adminSecret) {
        // 管理員取消：直接執行
        requireAdmin(body, env);
      } else if (lineUserId) {
        // 團員取消：驗證擁有者且必須是待付款
        const order = await db.prepare('SELECT * FROM orders WHERE order_id=?').bind(orderId).first();
        if (!order) return jsonErr('找不到此訂單', 404);
        if (order.line_user_id !== lineUserId) return jsonErr('無權限', 403);
        if (order.pay_status !== 'pending') return jsonErr('只有待付款的訂單可以取消');
      } else {
        return jsonErr('adminSecret 或 lineUserId 必填');
      }

      await db.prepare("UPDATE orders SET pay_status='cancelled' WHERE order_id=?").bind(orderId).run();

      // 減少 order_count
      const orderRow = await db.prepare('SELECT product_id FROM orders WHERE order_id=?').bind(orderId).first();
      if (orderRow?.product_id) {
        await db.prepare(
          'UPDATE products SET order_count = MAX(0, order_count - 1) WHERE product_id=?'
        ).bind(orderRow.product_id).run();
      }
      return jsonOk({ order_id: orderId });
    }

    case 'delete_comment': {
      requireAdmin(body, env);
      const { commentId } = body;
      if (!commentId) return jsonErr('commentId 必填');
      await db.prepare('DELETE FROM comments WHERE comment_id=?').bind(commentId).run();
      return jsonOk({ comment_id: commentId });
    }

    // ────────────────────────────────────────────────────
    //  會員 / 公開 API
    // ────────────────────────────────────────────────────

    case 'get_active_groups_v2': {
      const r = await db.prepare(`
        SELECT p.*,
               (SELECT COUNT(DISTINCT o.line_user_id)
                FROM orders o
                WHERE o.product_id = p.product_id AND o.pay_status != 'cancelled') AS memberCount,
               (SELECT COUNT(*)
                FROM orders o
                WHERE o.product_id = p.product_id AND o.pay_status != 'cancelled') AS totalOrders
        FROM   products p
        WHERE  p.status = 'open'
        ORDER BY p.created_at DESC
      `).all();

      const products = (r.results || []).map(p => ({
        product_id:  p.product_id,
        name:        p.name,
        description: p.description,
        image_url:   p.image_url,
        deadline:    p.deadline,
        status:      (p.deadline && new Date(p.deadline) < new Date()) ? 'expired' : p.status,
        variants:    JSON.parse(p.variants || '[]'),
        memberCount: p.memberCount || 0,
        totalOrders: p.totalOrders || 0,
      }));

      return jsonOk({ products });
    }

    case 'get_all_groups': {
      const r = await db.prepare('SELECT * FROM products ORDER BY created_at DESC').all();
      const now = new Date();
      const products = (r.results || []).map(p => {
        if (p.status === 'open' && p.deadline && new Date(p.deadline) < now) {
          return { ...p, status: 'closed' };
        }
        return p;
      });
      return jsonOk({ products });
    }

    case 'get_comments': {
      const { productId } = body;
      if (!productId) return jsonErr('productId 必填');
      const r = await db.prepare(`
        SELECT * FROM comments
        WHERE product_id=? AND content != '__DELETED__'
        ORDER BY created_at DESC
      `).bind(productId).all();
      return jsonOk({ comments: r.results || [] });
    }

    case 'post_comment': {
      const { productId, lineUserId, memberName, avatarUrl, content } = body;
      if (!productId || !lineUserId || !content) return jsonErr('productId、lineUserId、content 必填');
      const commentId = 'CMT' + nanoid();
      await db.prepare(`
        INSERT INTO comments
          (comment_id, product_id, line_user_id, member_name, avatar_url, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(commentId, productId, lineUserId, memberName || '', avatarUrl || '', content, nowIso()).run();
      return jsonOk({ comment_id: commentId });
    }

    case 'get_my_orders': {
      const { lineUserId } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      const r = await db.prepare(`
        SELECT o.*, p.image_url AS product_image
        FROM   orders o
        LEFT JOIN products p ON o.product_id = p.product_id
        WHERE  o.line_user_id=?
        ORDER BY o.created_at DESC
      `).bind(lineUserId).all();
      return jsonOk({ orders: r.results || [] });
    }

    case 'get_arrivals': {
      const { lineUserId } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      const r = await db.prepare(`
        SELECT o.*, p.image_url AS product_image
        FROM   orders o
        LEFT JOIN products p ON o.product_id = p.product_id
        WHERE  o.line_user_id=? AND o.product_status='notified' AND o.pay_status != 'received'
        ORDER BY o.created_at DESC
      `).bind(lineUserId).all();
      return jsonOk({ orders: r.results || [] });
    }

    case 'get_member_phone': {
      const { lineUserId } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      const m = await db.prepare(
        'SELECT phone_last3 FROM members WHERE line_user_id=?'
      ).bind(lineUserId).first();
      return jsonOk({ phone_last3: m?.phone_last3 || '' });
    }

    case 'save_member_phone': {
      const { lineUserId, memberName, phoneLastThree } = body;
      if (!lineUserId) return jsonErr('lineUserId 必填');
      await db.prepare(`
        INSERT INTO members (line_user_id, member_name, phone_last3, created_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(line_user_id) DO UPDATE SET
          member_name = excluded.member_name,
          phone_last3 = excluded.phone_last3
      `).bind(lineUserId, memberName || '', phoneLastThree || '', nowIso()).run();
      return jsonOk({ saved: true });
    }

    case 'submit_proof': {
      const { orderId, transferRef, screenshotBase64, fileName } = body;
      if (!orderId) return jsonErr('orderId 必填');

      // 查訂單 + 電話後三碼
      const order = await db.prepare(`
        SELECT o.*, m.phone_last3
        FROM   orders o
        LEFT JOIN members m ON o.line_user_id = m.line_user_id
        WHERE  o.order_id=?
      `).bind(orderId).first();
      if (!order) return jsonErr('找不到此訂單', 404);
      if (order.pay_status === 'paid' || order.pay_status === 'received') {
        return jsonErr('此訂單已確認付款，無需再上傳');
      }

      // 上傳截圖到 GitHub
      let screenshotUrl = '';
      if (screenshotBase64 && fileName) {
        screenshotUrl = await uploadImageToGitHub(screenshotBase64, fileName, env);
      }

      const paymentId = 'PAY' + nanoid();

      // Upsert 付款記錄（同一訂單重複提交時更新）
      await db.prepare(`
        INSERT INTO payments
          (payment_id, order_id, product_name, line_user_id, phone_last3,
           transfer_ref, screenshot_url, pay_status, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewing', ?)
        ON CONFLICT(order_id) DO UPDATE SET
          transfer_ref   = excluded.transfer_ref,
          screenshot_url = excluded.screenshot_url,
          pay_status     = 'reviewing',
          submitted_at   = excluded.submitted_at
      `).bind(
        paymentId, orderId, order.product_name, order.line_user_id,
        order.phone_last3 || '', transferRef || '', screenshotUrl, nowIso()
      ).run();

      // 更新訂單狀態
      await db.prepare("UPDATE orders SET pay_status='reviewing' WHERE order_id=?").bind(orderId).run();

      return jsonOk({ payment_id: paymentId });
    }

    case 'create_order': {
      const { lineUserId, productId, variant, qty, phoneLastThree, memberName, payMethod } = body;
      if (!lineUserId || !productId) return jsonErr('lineUserId 和 productId 必填');

      // 檢查商品存在且開放中
      const product = await db.prepare('SELECT * FROM products WHERE product_id=?').bind(productId).first();
      if (!product) return jsonErr('找不到此團購', 404);
      if (product.status !== 'open') return jsonErr('此團購已截止');
      if (product.deadline && new Date(product.deadline) < new Date()) return jsonErr('此團購已過截止時間');

      // 檢查重複訂單（同一用戶 + 同一商品，不論規格）
      // 若前端傳 allowDuplicate: true，跳過重複檢查（用戶已確認再次訂購）
      if (!body.allowDuplicate) {
        const existing = await db.prepare(`
          SELECT order_id, variant FROM orders
          WHERE line_user_id=? AND product_id=? AND pay_status != 'cancelled'
        `).bind(lineUserId, productId).first();

        if (existing) {
          return jsonOk({
            warning:       'DUPLICATE_ORDER',
            existingOrder: existing,
            orderId:       existing.order_id,
          });
        }
      }

      // 從 variants JSON 取得規格價格
      let unitPrice = product.price;
      try {
        const vars = JSON.parse(product.variants || '[]');
        const def  = vars.find(v => v.name === variant);
        if (def) unitPrice = def.price;
      } catch {}
      const total = unitPrice * (Number(qty) || 1);

      // 確保 member 記錄存在（前端已把關 phone_last3，這裡同步到後端 DB 避免 FK 失敗）
      await db.prepare(
        'INSERT OR IGNORE INTO members (line_user_id, member_name, created_at) VALUES (?, ?, ?)'
      ).bind(lineUserId, memberName || '', nowIso()).run();

      // 若前端傳來 phoneLastThree，更新到 DB（首次下單時同步）
      if (phoneLastThree && /^\d{3}$/.test(phoneLastThree)) {
        await db.prepare(
          'UPDATE members SET phone_last3=? WHERE line_user_id=? AND (phone_last3 IS NULL OR phone_last3="")'
        ).bind(phoneLastThree, lineUserId).run();
      }

      const orderId = 'ORD' + nanoid();
      await db.prepare(`
        INSERT INTO orders
          (order_id, product_id, product_name, line_user_id, variant, qty, total,
           pay_status, product_status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?)
      `).bind(
        orderId, productId, product.name, lineUserId,
        variant || '', Number(qty) || 1, total, nowIso()
      ).run();

      // 增加 order_count
      await db.prepare(
        'UPDATE products SET order_count = order_count + 1 WHERE product_id=?'
      ).bind(productId).run();

      return jsonOk({ orderId });
    }

    default:
      return jsonErr(`未知的 action: ${action}`, 400);
  }
}
