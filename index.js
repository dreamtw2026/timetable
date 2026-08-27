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

    // 核心路由：匹配前端的 courses 请求
    if (url.pathname.includes('courses')) {
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
          
          // 构造标准课程对象，生成随机 ID
          const newCourse = {
            id: Date.now().toString(), // 用时间戳做唯一 ID
            name: body.name,
            day: parseInt(body.day),
            period: parseInt(body.period),
            weeks: body.weeks || "1-16",
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

          // 找到对应的课程索引
          const idx = courses.findIndex(c => String(c.id) === String(id));
          if (idx === -1) return new Response('未找到该课程', { status: 404, headers: corsHeaders });

          // 更新数据
          courses[idx] = {
            id: String(id),
            name: body.name,
            day: parseInt(body.day),
            period: parseInt(body.period),
            weeks: body.weeks || "1-16",
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
    }

    return new Response('未匹配到有效的 API 路由', { status: 404 });
  }
};