// 学年制学期列表：4 个学年 × 每学年 2 个学期，KV 键名形如 2026-2027-1
const ACADEMIC_YEARS = ['2026-2027', '2027-2028', '2028-2029', '2029-2030'];
const TERMS = ACADEMIC_YEARS.flatMap(year => [1, 2].map(s => `${year}-${s}`));

// 学期显示名（用于飞书卡片落款）：2026-2027-1 -> 2026-2027学年第1学期
const TERM_LABELS = Object.fromEntries(TERMS.map(key => {
  const [year, s] = key.split('-');
  return [key, `${year}学年第${s}学期`];
}));

// 旧版年级制键名 -> 新版学年制键名（首次读取时自动迁移数据）
const LEGACY_KEY_MAP = {
  'freshman-1': '2026-2027-1', 'freshman-2': '2026-2027-2',
  'sophomore-1': '2027-2028-1', 'sophomore-2': '2027-2028-2',
  'junior-1': '2028-2029-1', 'junior-2': '2028-2029-2',
  'senior-1': '2029-2030-1', 'senior-2': '2029-2030-2'
};
const LEGACY_SOURCE = Object.fromEntries(Object.entries(LEGACY_KEY_MAP).map(([oldKey, newKey]) => [newKey, oldKey]));

// 开学日期集中存放在这个键，格式：{ "freshman-1": "2026-09-14", ... }
const TERM_STARTS_KEY = 'term_starts';

// 飞书提醒手动暂停开关（值 '1' = 已暂停），法定节假日调休等场景一键停用
const NOTIFY_PAUSED_KEY = 'notify_paused';

// 边缘缓存 60 秒：重复读取直接命中缓存，代价是改动后最多 60 秒才可见
const KV_READ_OPTS = { type: 'json', cacheTtl: 60 };

const WEEKS_RE = /^\d+(-\d+)?(,\d+(-\d+)?)*$/; // 允许：1-16、5、1-8,10-16
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 上课时间表（与前端 periods 保持一致）；飞书提醒在每节课开始前 REMIND_MINUTES_BEFORE 分钟发出
const PERIODS = [
  { id: 1, name: '1-2 节', start: '08:00', end: '09:40' },
  { id: 2, name: '3-4 节', start: '10:00', end: '11:40' },
  { id: 3, name: '5-6 节', start: '13:20', end: '15:00' },
  { id: 4, name: '7-8 节', start: '15:20', end: '17:00' },
  { id: 5, name: '9-10 节', start: '18:00', end: '19:40' },
  { id: 6, name: '第 11 节', start: '19:50', end: '20:35' }
];
const REMIND_MINUTES_BEFORE = 5;

// 定时触发器（UTC！北京时间 = UTC+8）：只覆盖各提醒时刻，周末与非提醒分钟的空跑由 scheduled() 自行过滤
// 提醒点：北京 07:55 / 09:55 / 17:55、13:15 / 15:15、19:45
// 改动 PERIODS 时间或 REMIND_MINUTES_BEFORE 后，按"北京时间 - 8 小时"同步更新 wrangler.toml 的 crons
//
// cron 表达式与提醒点的对应关系：
//   55 23,1,9 * * *  -> 北京 07:55 / 09:55 / 17:55（1-2节、3-4节、9-10节）
//   15 5,7   * * *   -> 北京 13:15 / 15:15（5-6节、7-8节）
//   45 11    * * *   -> 北京 19:45（第 11 节）

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 跨域头，保障请求畅通
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // 聚合路由：一次请求带回全部学期数据，避免前端逐个学期串行请求
      if (url.pathname === '/api/timetable' && request.method === 'GET') {
        return await getTimetable(env, corsHeaders);
      }

      // 学期元数据：开学日期（第 1 周周一）
      if (url.pathname === '/api/meta') {
        return await handleMeta(request, env, url, corsHeaders);
      }

      // 飞书提醒开关：手动暂停/恢复
      if (url.pathname === '/api/notify') {
        return await handleNotify(request, env, corsHeaders);
      }

      // 测试路由：手动向飞书发一张测试卡片，验证 Webhook 连通性
      if (url.pathname === '/test-notify' && request.method === 'GET') {
        return await testNotify(env, corsHeaders);
      }

      // 核心路由：匹配前端的 courses 请求
      if (url.pathname.includes('courses')) {
        return await handleCourses(request, env, url, corsHeaders);
      }
    } catch (err) {
      return new Response(`服务异常: ${err.message}`, { status: 500, headers: corsHeaders });
    }

    return new Response('未匹配到有效的 API 路由', { status: 404 });
  },

  // 定时任务：课前飞书提醒
  async scheduled(controller, env, ctx) {
    if (!env.TIMETABLE_DB || !env.FEISHU_WEBHOOK_URL) return; // 未绑定 KV 或未配置 Webhook 时静默跳过

    // 手动暂停开关（如法定节假日调休期间），暂停时不做任何后续读取
    if ((await env.TIMETABLE_DB.get(NOTIFY_PAUSED_KEY)) === '1') return;

    const day = beijingDay();
    if (day > 5) return; // 周末不提醒

    // cron 只负责粗覆盖到分钟，这里做精确匹配（当前时刻 = 某节课的提醒时刻）
    const now = beijingNowHHMM();
    const period = PERIODS.find(p => minusMinutes(p.start, REMIND_MINUTES_BEFORE) === now);
    if (!period) return;

    const terms = await fetchAllTerms(env);

    // 判定"当前学期"：开学日期已设置、当前正处于其上课周内（1 ~ 总周数），取开学最晚的一个
    let activeTermKey = null, activeWeek = 0, latestStart = '';
    for (const [term, data] of Object.entries(terms)) {
      const week = getCurrentWeek(data.startDate);
      if (!week) continue;
      let total = 0;
      data.courses.forEach(c => parseWeeks(c.weeks).forEach(w => { if (w > total) total = w; }));
      total = total || 20;
      if (week >= 1 && week <= total && data.startDate >= latestStart) {
        latestStart = data.startDate;
        activeTermKey = term;
        activeWeek = week;
      }
    }
    if (!activeTermKey) return; // 当前没有进行中的学期（假期）

    // 只推：当前学期 + 今天这个节次 + 周次包含当前周的课程
    const active = terms[activeTermKey];
    const due = active.courses.filter(c => c.day === day && c.period === period.id && courseInWeek(c, activeWeek));
    if (due.length === 0) return;

    const termLabel = TERM_LABELS[activeTermKey] || activeTermKey;
    ctx.waitUntil(Promise.allSettled(due.map(c => sendReminder(env.FEISHU_WEBHOOK_URL, c, period, termLabel, activeWeek))));
  }
};

// 读取开学日期表，并把旧版年级制键名一次性映射为新键名
async function readTermStarts(env) {
  const stored = await env.TIMETABLE_DB.get(TERM_STARTS_KEY, KV_READ_OPTS);
  const termStarts = (stored && typeof stored === 'object') ? stored : {};
  let migrated = false;
  for (const [oldKey, oldValue] of Object.entries(termStarts)) {
    const newKey = LEGACY_KEY_MAP[oldKey];
    if (newKey && termStarts[newKey] === undefined) {
      termStarts[newKey] = oldValue;
      migrated = true;
    }
  }
  if (migrated) await env.TIMETABLE_DB.put(TERM_STARTS_KEY, JSON.stringify(termStarts));
  return termStarts;
}

// 并行读取所有学期键 + 开学日期表，单个键损坏不影响其余数据
async function fetchAllTerms(env) {
  const keys = [...TERMS, TERM_STARTS_KEY];
  const results = await Promise.allSettled(
    keys.map(key => env.TIMETABLE_DB.get(key, KV_READ_OPTS))
  );

  const startResult = results[TERMS.length];
  const termStarts = (startResult.status === 'fulfilled' && startResult.value && typeof startResult.value === 'object')
    ? startResult.value : {};

  // 旧版年级制键名的开学日期一次性迁移到新键名
  const pendingWrites = [];
  for (const [oldKey, oldValue] of Object.entries(termStarts)) {
    const newKey = LEGACY_KEY_MAP[oldKey];
    if (newKey && termStarts[newKey] === undefined) {
      termStarts[newKey] = oldValue;
      pendingWrites.push(env.TIMETABLE_DB.put(TERM_STARTS_KEY, JSON.stringify(termStarts)));
    }
  }

  const terms = {};
  for (const [i, term] of TERMS.entries()) {
    const result = results[i];
    // 课程键不存在（null）不跳过——该学期可能只设置了开学日期
    let courses = (result.status === 'fulfilled' && Array.isArray(result.value)) ? result.value : [];
    let startDate = termStarts[term] || null;

    // 新键无课程时，尝试从旧版年级制键迁移课程（一次性，迁完写入新键）
    if (courses.length === 0) {
      const legacyKey = LEGACY_SOURCE[term];
      if (legacyKey) {
        const legacy = await Promise.allSettled([env.TIMETABLE_DB.get(legacyKey, KV_READ_OPTS)]);
        if (legacy[0].status === 'fulfilled' && Array.isArray(legacy[0].value) && legacy[0].value.length > 0) {
          courses = legacy[0].value;
          pendingWrites.push(env.TIMETABLE_DB.put(term, JSON.stringify(courses)));
        }
      }
    }

    // 没有课程也没设置开学日期的学期不下发，减小响应体积
    if (courses.length === 0 && !startDate) continue;
    terms[term] = { courses, startDate };
  }
  if (pendingWrites.length > 0) await Promise.allSettled(pendingWrites);
  return terms;
}

async function getTimetable(env, corsHeaders) {
  if (!env.TIMETABLE_DB) {
    return new Response('后端未检测到 TIMETABLE_DB 绑定，请检查 wrangler.toml', { status: 500, headers: corsHeaders });
  }

  const terms = await fetchAllTerms(env);
  return new Response(JSON.stringify({ terms }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
  });
}

// 开学日期（第 1 周周一）的读取与设置
async function handleMeta(request, env, url, corsHeaders) {
  if (!env.TIMETABLE_DB) {
    return new Response('后端未检测到 TIMETABLE_DB 绑定，请检查 wrangler.toml', { status: 500, headers: corsHeaders });
  }

  const term = url.searchParams.get('term');
  if (!term) {
    return new Response('缺少 term 参数', { status: 400, headers: corsHeaders });
  }

  if (request.method === 'GET') {
    const termStarts = await readTermStarts(env);
    return new Response(JSON.stringify({ startDate: termStarts[term] || null }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    const startDate = body.startDate ? String(body.startDate).trim() : null;
    if (startDate && !DATE_RE.test(startDate)) {
      return new Response('开学日期格式应为 YYYY-MM-DD', { status: 400, headers: corsHeaders });
    }

    // 写入路径不使用边缘缓存读取，避免拿旧值覆盖；旧键名条目先映射进内存，防止写回时丢失
    const stored = await env.TIMETABLE_DB.get(TERM_STARTS_KEY, { type: 'json' });
    const termStarts = (stored && typeof stored === 'object') ? stored : {};
    for (const [oldKey, oldValue] of Object.entries(termStarts)) {
      const newKey = LEGACY_KEY_MAP[oldKey];
      if (newKey && termStarts[newKey] === undefined) termStarts[newKey] = oldValue;
    }
    if (startDate) termStarts[term] = startDate;
    else delete termStarts[term];
    await env.TIMETABLE_DB.put(TERM_STARTS_KEY, JSON.stringify(termStarts));

    return new Response('保存成功', { status: 200, headers: corsHeaders });
  }

  return new Response('不支持的方法', { status: 405, headers: corsHeaders });
}

// 飞书提醒手动开关的读取与设置
async function handleNotify(request, env, corsHeaders) {
  if (!env.TIMETABLE_DB) {
    return new Response('后端未检测到 TIMETABLE_DB 绑定，请检查 wrangler.toml', { status: 500, headers: corsHeaders });
  }

  if (request.method === 'GET') {
    const paused = (await env.TIMETABLE_DB.get(NOTIFY_PAUSED_KEY)) === '1';
    return new Response(JSON.stringify({ paused }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  if (request.method === 'PUT') {
    const body = await request.json();
    const paused = !!body.paused;
    await env.TIMETABLE_DB.put(NOTIFY_PAUSED_KEY, paused ? '1' : '0');
    return new Response(paused ? '已暂停' : '已恢复', { status: 200, headers: corsHeaders });
  }

  return new Response('不支持的方法', { status: 405, headers: corsHeaders });
}

// 手动测试飞书 Webhook 连通性
async function testNotify(env, corsHeaders) {
  if (!env.FEISHU_WEBHOOK_URL) {
    return new Response('未配置 FEISHU_WEBHOOK_URL。线上：npx wrangler secret put FEISHU_WEBHOOK_URL；本地：项目根目录创建 .dev.vars 文件写入 FEISHU_WEBHOOK_URL=...', { status: 400, headers: corsHeaders });
  }
  const ok = await sendReminder(env.FEISHU_WEBHOOK_URL, {
    name: '飞书提醒测试',
    room: '测试教室',
    teacher: '测试教师',
    weeks: '1-16'
  }, { name: '测试节次', start: '08:00', end: '09:40' }, '当前学期', 1);
  return new Response(ok ? '测试卡片已发送，请到飞书群查看' : '发送失败，请查看 Worker 日志', {
    status: ok ? 200 : 502,
    headers: corsHeaders
  });
}

// 课程增删改查（保留原有 /api/courses 行为，供后台与旧版本使用）
async function handleCourses(request, env, url, corsHeaders) {
  const term = url.searchParams.get('term');
  const id = url.searchParams.get('id');

  if (!term) {
    return new Response('缺少 term 参数', { status: 400, headers: corsHeaders });
  }

  // 验证 KV 绑定是否存在
  if (!env.TIMETABLE_DB) {
    return new Response('后端未检测到 TIMETABLE_DB 绑定，请检查 wrangler.toml', { status: 500, headers: corsHeaders });
  }

  try {
    // 从 KV 中获取当前学期的课程列表（KV 存的是字符串，需要转回 JSON 数组）
    const kvData = await env.TIMETABLE_DB.get(term);
    let courses = kvData ? JSON.parse(kvData) : [];

    // --- 1. 获取列表 (GET) ---
    if (request.method === 'GET') {
      return new Response(JSON.stringify(courses), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // --- 2. 添加课程 (POST) ---
    if (request.method === 'POST') {
      const body = await request.json();
      const weeks = sanitizeWeeks(body.weeks);
      if (weeks === null) {
        return new Response('周次格式不合法，示例：1-16、5 或 1-8,10-16', { status: 400, headers: corsHeaders });
      }

      // 构造标准课程对象，生成随机 ID
      const newCourse = {
        id: Date.now().toString(), // 用时间戳做唯一 ID
        name: body.name,
        day: parseInt(body.day),
        period: parseInt(body.period),
        weeks: weeks,
        room: body.room,
        teacher: body.teacher,
        color: body.color || "#3b82f6"
      };

      courses.push(newCourse);
      // 写回 KV
      await env.TIMETABLE_DB.put(term, JSON.stringify(courses));
      return new Response('添加成功', { status: 200, headers: corsHeaders });
    }

    // --- 3. 修改课程 (PUT) ---
    if (request.method === 'PUT') {
      if (!id) return new Response('缺少 id 参数', { status: 400, headers: corsHeaders });
      const body = await request.json();
      const weeks = sanitizeWeeks(body.weeks);
      if (weeks === null) {
        return new Response('周次格式不合法，示例：1-16、5 或 1-8,10-16', { status: 400, headers: corsHeaders });
      }

      // 找到对应的课程索引
      const idx = courses.findIndex(c => String(c.id) === String(id));
      if (idx === -1) return new Response('未找到该课程', { status: 404, headers: corsHeaders });

      // 更新数据
      courses[idx] = {
        id: String(id),
        name: body.name,
        day: parseInt(body.day),
        period: parseInt(body.period),
        weeks: weeks,
        room: body.room,
        teacher: body.teacher,
        color: body.color || "#3b82f6"
      };

      await env.TIMETABLE_DB.put(term, JSON.stringify(courses));
      return new Response('修改成功', { status: 200, headers: corsHeaders });
    }

    // --- 4. 删除课程 (DELETE) ---
    if (request.method === 'DELETE') {
      if (!id) return new Response('缺少 id 参数', { status: 400, headers: corsHeaders });

      // 过滤掉被删除的课程
      courses = courses.filter(c => String(c.id) !== String(id));

      await env.TIMETABLE_DB.put(term, JSON.stringify(courses));
      return new Response('删除成功', { status: 200, headers: corsHeaders });
    }

  } catch (err) {
    return new Response(`KV操作失败: ${err.message}`, { status: 500, headers: corsHeaders });
  }

  return new Response('未匹配到有效的 API 路由', { status: 404 });
}

// ==================== 飞书提醒 ====================

// 发送一张课前提醒卡片，返回是否成功
async function sendReminder(webhook, course, period, termLabel, week) {
  const payload = {
    msg_type: 'interactive',
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: 'blue',
        title: { tag: 'plain_text', content: `⏰ ${REMIND_MINUTES_BEFORE} 分钟后上课：${course.name}` }
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**时间：**${period.start}-${period.end}（${period.name}）\n**教室：**${course.room || '—'}\n**教师：**${course.teacher || '—'}\n**周次：**${course.weeks || '1-16'} 周 · 当前第 ${week} 周`
          }
        },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `${termLabel} · 课前 ${REMIND_MINUTES_BEFORE} 分钟提醒` }] }
      ]
    }
  };

  try {
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      console.error('飞书提醒发送失败:', course.name, res.status, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('飞书提醒发送异常:', course.name, err.message);
    return false;
  }
}

// ==================== 时间与周次工具 ====================

// 北京时间当前 HH:MM
function beijingNowHHMM() {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// 北京时间今天星期几（1=周一 ... 7=周日）
function beijingDay() {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(new Date());
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd) + 1;
}

// 北京时间今天的 YYYY-MM-DD
function beijingToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

// 依据开学日期（第 1 周周一）推算当前周次：null=未设置，0=假期/学期外，n=第 n 周
function getCurrentWeek(startDate) {
  if (!startDate || !DATE_RE.test(startDate)) return null;
  const start = new Date(startDate + 'T00:00:00+08:00');
  const today = new Date(beijingToday() + 'T00:00:00+08:00');
  const week = Math.floor(Math.round((today - start) / 86400000) / 7) + 1;
  return (week >= 1 && week <= 30) ? week : 0;
}

// HH:MM 减去指定分钟
function minusMinutes(hhmm, minutes) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = ((h * 60 + m - minutes) % 1440 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

// 解析周次字符串（如 "1-16"、"5"、"1-8,10-16"）为周数集合，非法片段自动忽略
function parseWeeks(str) {
  const set = new Set();
  if (typeof str !== 'string') return set;
  str.split(',').forEach(part => {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) return;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let w = Math.min(a, b); w <= Math.max(a, b); w++) set.add(w);
  });
  return set;
}

// 课程是否在指定周有课（周次为空视为全周有课）
function courseInWeek(course, week) {
  const set = parseWeeks(course.weeks);
  return set.size === 0 || set.has(week);
}

// 清洗周次字符串：去空格并校验格式；空值回退 1-16，非法返回 null
function sanitizeWeeks(raw) {
  const weeks = typeof raw === 'string' ? raw.replace(/\s/g, '') : '';
  if (!weeks) return '1-16';
  return WEEKS_RE.test(weeks) ? weeks : null;
}
