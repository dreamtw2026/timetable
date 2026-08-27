// =========================================================
// 飞书课程提醒 Worker (时间自适应版)
// =========================================================

// 1. 填入你的飞书机器人 Webhook 链接
const FEISHU_WEBHOOK_URL = ""; 

// 2. 基础节次与上课时间映射表 (只需配置开课时间 start，remTime 自动计算)
const PERIOD_CONFIG = {
  1: { start: "08:00", name: "第 1-2 节" },
  2: { start: "10:00", name: "第 3-4 节" },
  3: { start: "13:20", name: "第 5-6 节" },
  4: { start: "15:20", name: "第 7-8 节" },
  5: { start: "18:00", name: "第 9-10 节" },
  6: { start: "19:50", name: "第 11 节" }
};

// 💡 辅助工具：自动计算课前 N 分钟的提醒时刻 (自适应推导)
function getRemindTime(startTimeStr, aheadMinutes = 5) {
  const [hours, minutes] = startTimeStr.split(':').map(Number);
  let date = new Date();
  date.setHours(hours, minutes - aheadMinutes, 0, 0);
  
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

// 💡 动态生成带自适应 remTime 的完整 PERIOD_TIMES 映射
function getAdaptivePeriodTimes() {
  const result = {};
  for (const [period, info] of Object.entries(PERIOD_CONFIG)) {
    result[period] = {
      ...info,
      remTime: getRemindTime(info.start, 5) // 动态倒推 5 分钟
    };
  }
  return result;
}

export default {
  // 处理 HTTP 请求
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 调试诊断接口
    if (url.pathname === '/debug') {
      const debugInfo = await runDebugCheck(env);
      return new Response(JSON.stringify(debugInfo, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    // 手动发一条默认测试消息到飞书 (/test-notify)
    if (url.pathname === '/test-notify') {
      const result = await sendDefaultTestNotification();
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' }
      });
    }

    return new Response(
      "课程提醒 Worker (自适应版) 运行中！\n\n测试路由：\n- /debug : 查看当前自适应匹配状态与 KV 数据\n- /test-notify : 手动测试飞书 Webhook 连通性", 
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  },

  // 处理定时任务 (Cron Trigger)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAndNotify(env));
  }
};

// =========================================================
// 核心逻辑
// =========================================================

// 从 KV 读取课程列表
async function getCourseData(env) {
  try {
    const kv = env.TIMETABLE_DB || env.COURSES_KV;
    if (!kv) return [];

    let rawData = await kv.get("freshman-1");
    if (!rawData) rawData = await kv.get("TIMETABLE_DB");
    if (!rawData) rawData = await kv.get("timetable");

    if (!rawData) return [];

    const parsed = JSON.parse(rawData);

    if (Array.isArray(parsed)) {
      return parsed;
    } else if (parsed && Array.isArray(parsed.courses)) {
      return parsed.courses;
    }
    return [];
  } catch (err) {
    console.error("读取 KV 失败:", err);
    return [];
  }
}

// 获取北京时间 (UTC+8)
function getBeijingDateTime() {
  const now = new Date();
  const bjTimeString = now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" });
  const bjDate = new Date(bjTimeString);

  const year = bjDate.getFullYear();
  const month = String(bjDate.getMonth() + 1).padStart(2, '0');
  const day = String(bjDate.getDate()).padStart(2, '0');
  const hours = String(bjDate.getHours()).padStart(2, '0');
  const minutes = String(bjDate.getMinutes()).padStart(2, '0');

  let dayOfWeek = bjDate.getDay();
  if (dayOfWeek === 0) dayOfWeek = 7;

  return {
    dateStr: `${year}-${month}-${day}`,
    timeStr: `${hours}:${minutes}`,
    dayOfWeek
  };
}

// 默认手动测试消息
async function sendDefaultTestNotification() {
  const { dateStr, timeStr } = getBeijingDateTime();

  const defaultCard = {
    msg_type: "interactive",
    card: {
      header: {
        title: { tag: "plain_text", content: "🔔 飞书机器人测试消息" },
        template: "blue"
      },
      elements: [
        {
          tag: "div",
          text: {
            tag: "lark_md",
            content: "恭喜！你的 Cloudflare Worker 飞书提醒服务配置正常，接口调用成功！"
          }
        },
        {
          tag: "note",
          elements: [
            { tag: "plain_text", content: `测试发送时间：${dateStr} ${timeStr}` }
          ]
        }
      ]
    }
  };

  try {
    const res = await fetch(FEISHU_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(defaultCard)
    });
    const resData = await res.json();
    return { status: "success", message: "测试消息已发送", feishuResponse: resData };
  } catch (err) {
    return { status: "error", message: `发送失败: ${err.message}` };
  }
}

// Cron 定时器触发的课程提醒
async function checkAndNotify(env) {
  const courses = await getCourseData(env);
  const { timeStr, dayOfWeek, dateStr } = getBeijingDateTime();
  
  // 获取自适应计算后的提醒映射表
  const periodTimes = getAdaptivePeriodTimes();

  // 匹配当前时刻的节次
  let matchedPeriod = null;
  for (const [period, info] of Object.entries(periodTimes)) {
    if (info.remTime === timeStr) {
      matchedPeriod = period;
      break;
    }
  }

  if (!matchedPeriod) {
    return { status: "skipped", reason: `当前北京时间 (${timeStr}) 非课前提醒时间节点` };
  }

  const upcomingCourses = courses.filter(c => {
    const courseDay = c.day !== undefined ? c.day : c.dayOfWeek;
    const dayMatch = String(courseDay) === String(dayOfWeek);
    const periodMatch = String(c.period) === String(matchedPeriod);
    return dayMatch && periodMatch;
  });

  if (upcomingCourses.length === 0) {
    return { 
      status: "no_course", 
      time: timeStr, 
      dayOfWeek, 
      matchedPeriod, 
      message: "当前节次无课程安排" 
    };
  }

  // 发送飞书课程提醒卡片
  const sendResults = [];
  for (const course of upcomingCourses) {
    const pInfo = periodTimes[course.period] || { name: `第 ${course.period} 节`, start: "" };
    const roomText = course.room || course.location || '未指定教室';

    const feishuCard = {
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: "⏰ 上课提醒" },
          template: "blue"
        },
        elements: [
          {
            tag: "div",
            text: {
              tag: "lark_md",
              content: `**课程名称：** ${course.name || course.title || '未命名课程'}\n` +
                       `**上课时间：** ${pInfo.name} (${pInfo.start} 上课)\n` +
                       `**上课地点：** 📍 ${roomText}\n` +
                       `**任课教师：** 👨‍🏫 ${course.teacher || '未知'}\n` +
                       `**周次范围：** 🗓️ 第 ${course.weeks || '全'} 周`
            }
          },
          {
            tag: "note",
            elements: [
              { tag: "plain_text", content: `提醒发送时间：${dateStr} ${timeStr}` }
            ]
          }
        ]
      }
    };

    const res = await fetch(FEISHU_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feishuCard)
    });
    const resData = await res.json();
    sendResults.push({ course: course.name, feishuResponse: resData });
  }

  return { status: "success", notified_courses: sendResults };
}

// 调试诊断接口
async function runDebugCheck(env) {
  const kv = env.TIMETABLE_DB || env.COURSES_KV;
  const hasKV = !!kv;
  let rawData = null;

  if (hasKV) {
    rawData = await kv.get("freshman-1");
  }

  const courses = await getCourseData(env);
  const bj = getBeijingDateTime();

  return {
    beijing_time: `${bj.dateStr} ${bj.timeStr}`,
    day_of_week: bj.dayOfWeek,
    kv_bound_correctly: hasKV,
    kv_has_freshman_1_data: !!rawData,
    adaptive_period_times: getAdaptivePeriodTimes(), // 显示自适应推导后的时间表
    total_courses_found: courses.length,
    courses_preview: courses
  };
}
