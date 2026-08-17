// feishu-bridge — persistent host plugin.
// 飞书长连接收消息 → 常驻 Agent 执行命令 → 回飞书（含 typing 指示器与 / 命令）。
// 挂在 web profile 的 cordis.patch.yml，插件本体位于 $DSH_HOME/plugins/feishu-bridge/。

export const name = 'feishu-bridge';
export const inject = ['webServer', 'agents', 'agentPresets', 'fs', 'shell'];

const HOME = process.env.HOME || '/home/ateam';
const PLUGIN_DIR = (process.env.DSH_HOME || HOME + '/.dsh') + '/plugins/feishu-bridge';
const CONFIG_PATH = PLUGIN_DIR + '/config.json';
const HELPER_PATH = PLUGIN_DIR + '/helper.mjs';
const BRIDGE_PATH = '/feishu/bridge';

function log(...a) { console.log('[feishu-bridge]', ...a); }

export async function apply(ctx, config) {
  const webServer = ctx.webServer;
  const agents = ctx.agents;
  const agentPresets = ctx.agentPresets;
  const fs = ctx.fs;
  const shell = ctx.shell;
  const llm = ctx.get('llm');
  const skills = ctx.get('skills');
  const tokenMeter = ctx.get('tokenMeter');
  const agentDefaultModel = ctx.get('agentDefaultModel');

  // ---- 读取配置 ----
  let conf = null;
  try {
    const target = await fs.resolve((config && config.configPath) || CONFIG_PATH);
    const raw = await fs.readText(target);
    conf = JSON.parse(raw);
  } catch (e) {
    log('读取 config.json 失败:', (config && config.configPath) || CONFIG_PATH, '->', e && e.message);
    conf = {};
  }
  // 凭证优先级：环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET > 本地 config.json（已 gitignore）。
  const appId = String(process.env.FEISHU_APP_ID || (conf && conf.appId) || '').trim();
  const appSecret = String(process.env.FEISHU_APP_SECRET || (conf && conf.appSecret) || '').trim();
  const configCwd = String((conf && conf.cwd) || '').trim();
  const maxReplyChars = Number((conf && conf.maxReplyChars) || 4000) || 4000;
  const groupOnlyWhenMentioned = (conf && conf.groupReplyOnlyWhenMentioned) !== false;
  const helperPath = (config && config.helperPath) || HELPER_PATH;

  const hasCreds = !!appId && !!appSecret;
  if (!hasCreds) log('⚠️ config.json 中 appId/appSecret 为空，不启动飞书长连接。');

  const runtime = {
    provider: '',
    model: '',
    reasoningEffort: undefined,
    presetId: (conf && conf.presetId) || undefined,
    cwd: configCwd,
    sessionName: 'main',
  };
  if (agentDefaultModel) {
    try {
      const sel = agentDefaultModel.currentSelection();
      if (sel && sel.provider) runtime.provider = sel.provider;
      if (sel && sel.model) runtime.model = sel.model;
      if (sel && sel.reasoningEffort !== undefined) runtime.reasoningEffort = sel.reasoningEffort;
    } catch (e) {}
  }

  // ---- 飞书 HTTP API（fetch）----
  let token = null;
  let tokenExpiresAt = 0;

  async function feishuFetch(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    return { status: res.status, text, json };
  }

  async function getTenantAccessToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const res = await feishuFetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    });
    if (!res.json || res.json.code !== 0 || !res.json.tenant_access_token) {
      throw new Error('获取 tenant_access_token 失败: ' + res.text);
    }
    token = res.json.tenant_access_token;
    tokenExpiresAt = Date.now() + (res.json.expire || 7200) * 1000;
    return token;
  }

  async function replyToFeishu(msg, text) {
    if (!hasCreds) { log('无凭证，跳过回复:', text); return false; }
    const t = await getTenantAccessToken();
    const content = JSON.stringify({ text: String(text || '').slice(0, maxReplyChars) });
    const url = 'https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(msg.message_id) + '/reply';
    const res = await feishuFetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content }),
    });
    if (res.json && res.json.code === 0) return true;
    try {
      const url2 = 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';
      await feishuFetch(url2, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ receive_id: msg.chat_id, msg_type: 'text', content }),
      });
      return true;
    } catch (e) {
      log('回复失败:', e && e.message);
      return false;
    }
  }

  async function addTypingIndicator(messageId) {
    if (!hasCreds || !messageId) return null;
    try {
      const t = await getTenantAccessToken();
      const res = await feishuFetch('https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reactions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction_type: { emoji_type: 'Typing' } }),
      });
      if (res.json && res.json.code === 0 && res.json.data && res.json.data.reaction_id) return res.json.data.reaction_id;
      return null;
    } catch (e) { return null; }
  }

  async function removeTypingIndicator(messageId, reactionId) {
    if (!hasCreds || !messageId || !reactionId) return;
    try {
      const t = await getTenantAccessToken();
      await feishuFetch('https://open.feishu.cn/open-apis/im/v1/messages/' + encodeURIComponent(messageId) + '/reactions/' + encodeURIComponent(reactionId), {
        method: 'DELETE',
        headers: { 'Authorization': 'Bearer ' + t },
      });
    } catch (e) {}
  }

  // ---- 常驻飞书 Agent ----
  let feishuAgent = null;
  let disposeAgent = null;
  let sessionCounter = 0;
  let msgCounter = 0;
  let helperProc = null;

  ctx.effect(() => () => {
    if (disposeAgent) { try { disposeAgent(); } catch (e) {} disposeAgent = null; }
    feishuAgent = null;
    if (helperProc) { try { helperProc.kill(); } catch (e) {} helperProc = null; }
  });

  function makeSetup() {
    return async (agentCtx) => {
      if (agentPresets) {
        const preset = await agentPresets.mount(agentCtx, runtime.presetId);
        log('已挂载 preset:', preset && preset.id);
      }
      if (runtime.provider && runtime.model) {
        agentCtx.on('agent/request', async (payload, next) => {
          const resolved = await next();
          const out = {};
          for (const k in resolved) { if (k !== 'reasoningEffort') out[k] = resolved[k]; }
          out.provider = runtime.provider;
          out.model = runtime.model;
          if (runtime.reasoningEffort !== undefined && runtime.reasoningEffort !== null && runtime.reasoningEffort !== '') {
            out.reasoningEffort = runtime.reasoningEffort;
          }
          return out;
        });
      }
    };
  }

  function activateSession(name, forceNew) {
    const sessionId = 'feishu-' + name;
    const oldDispose = disposeAgent;
    return (async () => {
      try {
        const agentOptions = (runtime.provider && runtime.model) ? { provider: runtime.provider, model: runtime.model } : {};
        const setup = makeSetup();
        const sp = ctx.get('sessionPersistence');
        let handle;
        if (!forceNew && sp) {
          let exists = false;
          try { exists = (await sp.list()).some((h) => h && h.id === sessionId); } catch (e) { exists = false; }
          if (exists) {
            handle = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
            log('已恢复会话:', sessionId);
          } else {
            handle = await agents.create({ sessionId, agentOptions, meta: runtime.cwd ? { cwd: runtime.cwd } : {}, setup });
            log('已新建会话:', sessionId);
          }
        } else {
          handle = await agents.create({ sessionId, agentOptions, meta: runtime.cwd ? { cwd: runtime.cwd } : {}, setup });
          log('已新建会话(force):', sessionId);
        }
        feishuAgent = handle.agent;
        disposeAgent = () => handle.dispose();
        runtime.sessionName = name;
        if (feishuAgent && feishuAgent.session && feishuAgent.session.header && feishuAgent.session.header.cwd) {
          runtime.cwd = feishuAgent.session.header.cwd;
        }
        log('飞书 Agent 就绪:', feishuAgent.id, '| session=', name, '| mode=', runtime.presetId || '默认', '| model=', runtime.provider + '/' + runtime.model, '| cwd=', runtime.cwd || '(none)');
        if (oldDispose) { try { oldDispose(); } catch (e) {} }
        return true;
      } catch (e) {
        log('激活会话失败:', e && (e.message || String(e)));
        return false;
      }
    })();
  }

  activateSession(runtime.sessionName, false);

  // ---- 启动飞书长连接助手 ----
  if (hasCreds) {
    try {
      const port = webServer.port;
      const bridgeUrl = 'http://127.0.0.1:' + port + BRIDGE_PATH;
      const spec = shell.resolve({
        command: 'node ' + helperPath,
        env: {
          FEISHU_APP_ID: appId,
          FEISHU_APP_SECRET: appSecret,
          BRIDGE_URL: bridgeUrl,
          GROUP_ONLY_WHEN_MENTIONED: groupOnlyWhenMentioned ? '1' : '0',
        },
      });
      helperProc = shell.start(spec);
      log('飞书长连接助手已启动, bridge url:', bridgeUrl);
      helperProc.done.then(() => {
        try { log('助手进程退出, 输出:', helperProc.readOutput() && helperProc.readOutput().delta); } catch (e) {}
      });
    } catch (e) {
      log('启动飞书长连接助手失败:', e && (e.message || String(e)));
    }
  }

  // ---- 桥接路由 ----
  const unroute = webServer.register({
    kind: 'exact',
    path: BRIDGE_PATH,
    handler: (req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c.toString(); });
      req.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(body); } catch (e) { payload = null; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 0 }));
        if (payload && typeof payload.text === 'string' && payload.text) enqueue(payload);
      });
    },
  });
  ctx.effect(() => unroute);

  let queue = Promise.resolve();
  function enqueue(msg) {
    queue = queue.then(() => processMessage(msg)).catch((e) => log('处理消息出错:', e && e.message));
  }

  function extractReply(events, before) {
    const parts = [];
    for (let i = before; i < events.length; i++) {
      const ev = events[i];
      if (!ev || ev.type !== 'assistant/message') continue;
      const blocks = ev.data && ev.data.message && ev.data.message.content;
      if (!Array.isArray(blocks)) continue;
      for (let j = 0; j < blocks.length; j++) {
        const b = blocks[j];
        if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) parts.push(b.text.trim());
      }
    }
    return parts.join('\n');
  }

  function parseCommand(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('/')) return null;
    const m = t.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return null;
    return { cmd: m[1].toLowerCase(), arg: (m[2] || '').trim() };
  }

  const HELP = [
    '/new 新建会话',
    '/reset 重置当前会话',
    '/sessions 列出会话',
    '/session <名称> 切换会话',
    '/cd <路径> 切换 workspace',
    '/status 当前状态',
    '/context 当前上下文占用',
    '/usage API 用量（付费）',
    '/skills 列出所有 skill',
    '/models 列出可用模型',
    '/model <模型> 切换模型',
    '/efforts 列出思考强度',
    '/effort <强度> 切换思考强度',
    '/modes 列出可用模式',
    '/mode <模式> 切换模式',
    '/permissions 列出 permission',
    '/permission <名称> 切换 permission',
  ].join('\n');

  async function getHome() {
    try {
      const spec = shell.resolve({ command: 'echo $HOME', timeoutMs: 5000, stdoutMaxBytes: 4096 });
      const r = await shell.run(spec);
      return ((r.stdout && r.stdout.text) || '').trim() || null;
    } catch (e) { return null; }
  }

  async function resolveCdTarget(raw) {
    const arg = String(raw || '').trim();
    if (!arg) return { error: '用法：/cd <路径>（支持相对路径、/ 开头的绝对路径、~）' };
    let p = arg;
    if (p === '~' || p.startsWith('~/')) {
      const home = await getHome();
      if (home) p = (p === '~') ? home : home + p.slice(1);
    } else if (/^[a-zA-Z]:[\\/]/.test(p)) {
      p = p.replace(/\\/g, '/');
    }
    let target;
    try {
      target = await fs.resolve(p, runtime.cwd ? { cwd: runtime.cwd } : {});
    } catch (e) {
      return { error: '路径无效: ' + arg };
    }
    const abs = fs.processPath(target);
    let info;
    try { info = await fs.stat(target); } catch (e) { info = undefined; }
    if (!info) return { error: '路径不存在: ' + abs };
    if (info.type !== 'directory') return { error: '不是目录: ' + abs };
    return { abs };
  }

  async function listModels() {
    if (!llm) return 'llm 服务不可用';
    const lines = [];
    const providers = llm.listProviders();
    const curKey = runtime.provider + '/' + runtime.model;
    for (const p of providers) {
      let models;
      try { models = await llm.listModels(p.id); } catch (e) { continue; }
      for (const m of models) {
        const key = p.id + '/' + m.id;
        const star = (key === curKey) ? '* ' : '';
        const nm = (m.name && m.name !== m.id) ? ' - ' + m.name : '';
        lines.push(star + m.id + '  [' + (p.name || p.id) + ']' + nm);
      }
    }
    return lines.length ? '可用模型（* 为当前）：\n' + lines.join('\n') : '（未找到模型）';
  }

  async function selectModel(arg) {
    if (!llm) return 'llm 服务不可用';
    const a = arg.toLowerCase();
    const matches = [];
    const providers = llm.listProviders();
    for (const p of providers) {
      let models;
      try { models = await llm.listModels(p.id); } catch (e) { continue; }
      for (const m of models) {
        const idL = (m.id || '').toLowerCase();
        const nameL = (m.name || '').toLowerCase();
        if (idL === a || idL.includes(a) || (nameL && nameL.includes(a))) matches.push({ provider: p.id, model: m.id });
      }
    }
    if (matches.length === 0) return '未找到匹配模型：“' + arg + '”，用 /models 查看';
    const seen = {};
    const uniq = [];
    for (const m of matches) { const k = m.provider + '/' + m.model; if (!seen[k]) { seen[k] = 1; uniq.push(m); } }
    if (uniq.length > 1) return '匹配到多个模型，请精确指定：\n' + uniq.map((m) => m.provider + '/' + m.model).join('\n');
    runtime.provider = uniq[0].provider;
    runtime.model = uniq[0].model;
    return '已切换模型：' + uniq[0].provider + '/' + uniq[0].model + '（下一条消息生效）';
  }

  async function getEfforts() {
    if (!llm || !runtime.provider || !runtime.model) return null;
    try {
      const info = await llm.resolveModelInfo(runtime.provider, runtime.model);
      return (info.reasoning && Array.isArray(info.reasoning.efforts)) ? info.reasoning.efforts : null;
    } catch (e) { return null; }
  }

  async function selectEffort(arg) {
    const efforts = await getEfforts();
    if (!efforts || efforts.length === 0) return '当前模型不支持思考强度设置';
    const a = arg.toLowerCase();
    const matches = efforts.filter((e) => (e.id || '').toLowerCase() === a || (e.id || '').toLowerCase().includes(a) || ((e.name || '').toLowerCase().includes(a)));
    if (matches.length === 0) return '未找到匹配强度：“' + arg + '”，可用：' + efforts.map((e) => e.id + (e.name ? '(' + e.name + ')' : '')).join('、');
    if (matches.length > 1) return '匹配到多个：' + matches.map((e) => e.id).join('、');
    runtime.reasoningEffort = matches[0].id;
    return '已设置思考强度：' + matches[0].id + (matches[0].name ? '（' + matches[0].name + '）' : '');
  }

  async function listEffortsCmd() {
    const efforts = await getEfforts();
    if (!efforts || efforts.length === 0) return '当前模型不支持思考强度设置';
    const cur = runtime.reasoningEffort;
    return '可用思考强度（* 为当前）：\n' + efforts.map((e) => (e.id === cur ? '* ' : '') + e.id + (e.name ? '(' + e.name + ')' : '')).join('、');
  }

  async function listPresets() {
    if (!agentPresets) return [];
    try { return await agentPresets.list(); } catch (e) { return []; }
  }

  async function selectMode(arg) {
    const presets = await listPresets();
    const a = arg.toLowerCase();
    const matches = presets.filter((p) => (p.id || '').toLowerCase() === a || (p.id || '').toLowerCase().includes(a) || ((p.name || '').toLowerCase().includes(a)) || ((p.name || '') === arg));
    if (matches.length === 0) return '未找到模式：“' + arg + '”，用 /modes 查看';
    if (matches.length > 1) return '匹配到多个：' + matches.map((p) => p.id + (p.name ? '(' + p.name + ')' : '')).join('、');
    runtime.presetId = matches[0].id;
    const ok = await activateSession('@' + Date.now(), true);
    return ok ? '已切换模式：' + matches[0].id + (matches[0].name ? '（' + matches[0].name + '）' : '') + '，已新建会话' : '切换模式失败，请查看日志';
  }

  function currentPresetId() {
    if (runtime.presetId) return runtime.presetId;
    try { return (agentPresets && agentPresets.defaultId) || undefined; } catch (e) { return undefined; }
  }

  function listPermissions() {
    const pp = ctx.get('permissionPresets');
    if (!pp) return 'permission 服务不可用';
    const names = pp.names || [];
    if (!names.length) return '（未找到可用 permission）';
    const current = feishuAgent ? pp.current(feishuAgent.session.events) : null;
    const lines = names.map((n) => {
      const opt = pp.optionOf(n);
      const star = (n === current) ? '* ' : '';
      const nm = (opt && opt.name && opt.name !== n) ? '（' + opt.name + '）' : '';
      const desc = (opt && opt.description) ? ' - ' + opt.description : '';
      return star + n + nm + desc;
    });
    return '可用 permission（* 为当前）：\n' + lines.join('\n');
  }

  function selectPermission(arg) {
    const pp = ctx.get('permissionPresets');
    if (!pp) return 'permission 服务不可用';
    if (!feishuAgent) return '会话未就绪';
    const names = pp.names || [];
    const a = arg.toLowerCase();
    const matches = names.filter((n) => {
      const opt = pp.optionOf(n);
      return n.toLowerCase() === a || n.toLowerCase().includes(a) || ((opt && opt.name || '').toLowerCase().includes(a));
    });
    if (matches.length === 0) return '未找到 permission：“' + arg + '”，用 /permissions 查看';
    if (matches.length > 1) return '匹配到多个：' + matches.join('、');
    pp.set(feishuAgent.session, matches[0]);
    return '已切换 permission：' + matches[0];
  }

  async function listSessions() {
    const sp = ctx.get('sessionPersistence');
    if (!sp) return 'session 服务不可用';
    let headers;
    try { headers = await sp.list(); } catch (e) { return '列出会话失败: ' + (e && e.message); }
    // 已归档会话不列出
    const archivedSet = new Set();
    const wr = ctx.get('workspaceRegistry');
    if (wr && wr.archivedSessionIds) {
      try { for (const id of wr.archivedSessionIds) archivedSet.add(id); } catch (e) {}
    }
    const feishu = headers.filter((h) => h && h.id && h.id.indexOf('feishu-') === 0 && !archivedSet.has(h.id));
    if (!feishu.length) return '（暂无会话）';
    // 取自动生成的标题（同网页端）
    const titles = {};
    const sq = ctx.get('sessionQuery');
    if (sq) {
      try {
        const results = await sq.readTitleSnapshots(feishu.map((h) => h.id));
        for (const r of results) {
          if (r && r.status === 'fulfilled' && r.value && r.value.title && r.value.title.title) {
            titles[r.sessionId] = r.value.title.title;
          }
        }
      } catch (e) {}
    }
    const cur = runtime.sessionName;
    // 只列出有效会话：命名会话（字母开头）、当前会话、或有自动标题的会话；空的时间戳会话不列出
    const valid = feishu.filter((h) => {
      const name = h.id.slice('feishu-'.length);
      return /^[a-z]/.test(name) || name === cur || !!titles[h.id];
    });
    if (!valid.length) return '（暂无有效会话）';
    const lines = valid.map((h) => {
      const name = h.id.slice('feishu-'.length);
      const star = (name === cur) ? '* ' : '';
      const title = titles[h.id] ? ' - ' + titles[h.id] : '';
      const cwd = h.cwd ? '  (' + h.cwd + ')' : '';
      return star + name + title + cwd;
    });
    return '可用会话（* 为当前）：\n' + lines.join('\n');
  }

  async function contextSummary() {
    if (!feishuAgent) return '会话未就绪';
    let surface = null, total = null;
    if (tokenMeter) { try { const m = tokenMeter.measure(feishuAgent.session); surface = m.surfaceTokens; total = m.totalTokens; } catch (e) {} }
    let window = null;
    if (llm && runtime.provider && runtime.model) {
      try { const info = await llm.resolveModelInfo(runtime.provider, runtime.model); window = info.context && info.context.contextWindow; } catch (e) {}
    }
    let pct = '';
    if (surface !== null && window) pct = '（' + (Math.round((surface / window) * 1000) / 10) + '%）';
    return '当前上下文占用：\n' +
      '会话内容: ~' + (surface === null ? '未知' : surface) + ' tokens' + pct + '\n' +
      '请求压力: ~' + (total === null ? '未知' : total) + ' tokens\n' +
      '上下文窗口: ' + (window || '未知') + ' tokens';
  }

  function usageSummary() {
    if (!feishuAgent) return '会话未就绪';
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0;
    const events = feishuAgent.session.events;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (ev.type === 'assistant/message' && ev.data && ev.data.usage) {
        const u = ev.data.usage;
        input += u.inputTokens || 0;
        output += u.outputTokens || 0;
        cacheRead += u.cacheReadTokens || 0;
        cacheWrite += u.cacheWriteTokens || 0;
        reasoning += u.reasoningTokens || 0;
      }
    }
    const total = input + output + cacheRead + cacheWrite + reasoning;
    return '本会话 API 用量：\n' +
      '输入 tokens: ' + input + '\n' +
      '输出 tokens: ' + output + '\n' +
      '缓存读 tokens: ' + cacheRead + '\n' +
      '缓存写 tokens: ' + cacheWrite + '\n' +
      '推理 tokens: ' + reasoning + '\n' +
      '合计: ' + total + ' tokens\n' +
      '（费用 = tokens × 各 provider 单价；/new 或 /reset 后清零）';
  }

  function statusSummary() {
    const st = feishuAgent ? (feishuAgent.status || '未知') : '未就绪';
    const helper = helperProc ? (helperProc.status === 'running' ? '运行中' : (helperProc.status || '未知')) : '未启动';
    return '飞书桥接状态：\n' +
      'Agent: ' + st + '\n' +
      '模型: ' + (runtime.provider ? runtime.provider + '/' + runtime.model : '未设置') + '\n' +
      '思考强度: ' + (runtime.reasoningEffort || '默认') + '\n' +
      '模式: ' + (runtime.presetId || '默认') + '\n' +
      '工作目录: ' + (runtime.cwd || '-') + '\n' +
      '长连接: ' + helper + '\n' +
      '会话: ' + (runtime.sessionName || '-') + '\n' +
      '已处理消息: ' + msgCounter;
  }

  async function handleCommand(cmd, arg) {
    switch (cmd) {
      case 'help': return '可用命令：\n' + HELP;
      case 'new':
      case 'reset': {
        const name = '@' + Date.now();
        const ok = await activateSession(name, true);
        return ok ? '已' + (cmd === 'new' ? '新建' : '重置') + '会话：' + name : '操作失败，请查看日志';
      }
      case 'sessions': return await listSessions();
      case 'session': {
        if (!arg) return '用法：/session <名称>（用 /sessions 查看列表）';
        if (!/^[a-z0-9][a-z0-9-]*$/.test(arg)) return '会话名只能包含小写字母、数字、连字符';
        const ok = await activateSession(arg, false);
        return ok ? '已切换到会话：' + arg : '切换失败，请查看日志';
      }
      case 'cd': {
        const r = await resolveCdTarget(arg);
        if (r.error) return r.error;
        runtime.cwd = r.abs;
        const name = '@' + Date.now();
        const ok = await activateSession(name, true);
        return ok ? '已切换 workspace: ' + r.abs + '（会话 ' + name + '）' : '切换失败，请查看日志';
      }
      case 'status': return statusSummary();
      case 'context': return await contextSummary();
      case 'usage': return usageSummary();
      case 'skills': {
        if (!skills) return 'skills 服务不可用';
        try {
          const list = await skills.list(runtime.cwd ? { cwd: runtime.cwd } : {});
          if (!list || !list.length) return '（未找到 skill）';
          return '可用 Skill：\n' + list.map((s) => s.name + (s.description ? ' - ' + s.description : '')).join('\n');
        } catch (e) { return '列出 skill 失败: ' + (e && e.message); }
      }
      case 'models': return await listModels();
      case 'model': {
        if (!arg) return '用法：/model <模型>（用 /models 查看列表）';
        return await selectModel(arg);
      }
      case 'efforts': return await listEffortsCmd();
      case 'effort': {
        if (!arg) return '用法：/effort <强度>（用 /efforts 查看列表）';
        return await selectEffort(arg);
      }
      case 'modes': {
        const presets = await listPresets();
        if (!presets.length) return '（未找到可用模式）';
        const cur = currentPresetId();
        return '可用模式（* 为当前）：\n' + presets.map((p) => (p.id === cur ? '* ' : '') + p.id + (p.name ? '（' + p.name + '）' : '') + (p.description ? ' - ' + p.description : '')).join('\n');
      }
      case 'mode': {
        if (!arg) return '用法：/mode <模式>（用 /modes 查看列表）';
        return await selectMode(arg);
      }
      case 'permissions': return listPermissions();
      case 'permission': {
        if (!arg) return '用法：/permission <名称>（用 /permissions 查看列表）';
        return selectPermission(arg);
      }
      default:
        return '未知命令: /' + cmd + '\n' + HELP;
    }
  }

  async function processMessage(msg) {
    const text = (msg.text || '').trim();
    const parsed = parseCommand(text);
    if (parsed) {
      const reply = await handleCommand(parsed.cmd, parsed.arg);
      await replyToFeishu(msg, reply);
      return;
    }

    if (!feishuAgent) {
      await replyToFeishu(msg, '（飞书助手尚未就绪，请稍后再试）');
      return;
    }

    const reactionId = await addTypingIndicator(msg.message_id);
    try {
      const before = feishuAgent.session.seq;
      const userMessage = {
        id: 'feishu-' + Date.now() + '-' + (++msgCounter),
        role: 'user',
        content: [{ type: 'text', text: text }],
        source: { kind: 'user' },
      };
      feishuAgent.followup(userMessage);
      try {
        await feishuAgent.whenIdle();
      } catch (e) {
        log('whenIdle 出错:', e && e.message);
      }
      const replyText = extractReply(feishuAgent.session.events, before);
      await replyToFeishu(msg, replyText || '（没有产生回复）');
    } finally {
      await removeTypingIndicator(msg.message_id, reactionId);
    }
  }

  log('feishu-bridge 已启动（Agent 后台创建中）');
}
