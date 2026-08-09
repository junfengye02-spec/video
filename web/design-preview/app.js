const media = {
  showcase: "./assets/showcase.jpg",
  character: "./assets/lin-qiao.png",
  rain: "./assets/rain-cafe.png",
  hero: "./assets/hero-frame.jpg",
  face0: "./assets/face-0.jpg",
  face1: "./assets/face-1.jpg",
  frames: Array.from({ length: 6 }, (_, index) => `./assets/frame-${index}.jpg`),
};

const screens = {
  login: "登录",
  register: "注册",
  recovery: "账户恢复",
  projects: "创作首页",
  inspiration: "灵感对话",
  blueprint: "创作蓝图",
  storyboard: "分镜工作区",
  settings: "全局设定",
  resources: "资源库",
  production: "制作与成片",
  wallet: "钱包与额度",
  orders: "订单记录",
  admin: "计费管理",
};

const icon = (name, size = 16) => `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;

function logo() {
  return `<a class="ym-logo" href="?screen=projects"><span class="ym-mark"><b>O</b><b>M</b></span><span>OpenMontage</span></a>`;
}

function header({ title = "", stage = "", home = false, admin = false } = {}) {
  const center = home
    ? `<nav class="ym-nav"><a class="active" href="?screen=projects">创作</a><a href="?screen=resources">资源</a><a href="?screen=wallet">额度</a><a href="?screen=orders">订单</a></nav>`
    : `<div class="ym-title"><strong>${title}</strong>${stage ? `<span>${stage}</span>` : ""}</div>`;
  return `
    <header class="ym-header">
      <div class="ym-header-left">${logo()}${!home && title ? center : ""}</div>
      ${home ? center : ""}
      <div class="ym-actions">
        ${admin ? `<span class="muted-label">管理员视图</span>` : `<button class="ghost-icon" title="复制链接">${icon("link", 15)}</button><button class="ghost-icon" title="通知">${icon("bell", 15)}</button>`}
        <a class="outline-pill" href="?screen=wallet">${admin ? "返回创作" : "12,480 额度"}</a>
        <button class="avatar-button" title="账户">周</button>
      </div>
    </header>`;
}

function stageNav(active) {
  const stages = [
    ["inspiration", "灵感"],
    ["blueprint", "蓝图"],
    ["storyboard", "分镜"],
    ["production", "成片"],
  ];
  return `<div class="stage-nav">${stages.map(([screen, label], index) => {
    const activeIndex = stages.findIndex(([id]) => id === active);
    const state = index < activeIndex ? "done" : index === activeIndex ? "active" : "";
    return `<a class="${state}" href="?screen=${screen}">${index < activeIndex ? icon("check", 11) : `<span>${index + 1}</span>`}${label}</a>`;
  }).join("")}</div>`;
}

function authPage(kind) {
  const data = {
    login: {
      title: "欢迎回来",
      note: "继续完成你的下一部作品",
      fields: [["邮箱", "creator@openmontage.ai", "text"], ["密码", "openmontage", "password"]],
      action: "登录",
      footer: `还没有账户？ <a href="?screen=register">免费注册</a>`,
    },
    register: {
      title: "创建创作者账户",
      note: "从一个想法开始，建立完整的视频世界",
      fields: [["创作者名称", "周屿", "text"], ["邮箱", "creator@openmontage.ai", "text"], ["设置密码", "openmontage", "password"]],
      action: "创建账户",
      footer: `已有账户？ <a href="?screen=login">直接登录</a>`,
    },
    recovery: {
      title: "找回你的创作空间",
      note: "验证码已发送至 c***@openmontage.ai",
      fields: [["验证码", "628 941", "text"], ["新密码", "openmontage", "password"]],
      action: "确认并返回登录",
      footer: `没有收到？ <a href="#">54 秒后重新发送</a>`,
    },
  }[kind];
  return `
    <div class="auth-screen" style="--rain:url('${media.rain}')">
      <header class="auth-header">${logo()}<a class="outline-pill" href="?screen=projects">先看看产品</a></header>
      <main class="auth-center">
        <section class="auth-panel">
          <span class="auth-symbol">${icon("sparkles", 22)}</span>
          <h1>${data.title}</h1>
          <p>${data.note}</p>
          <div class="auth-fields">${data.fields.map(([label, value, type]) => `<label><span>${label}</span><input type="${type}" value="${value}" /></label>`).join("")}</div>
          <button class="black-command">${data.action} ${icon("arrow-right", 15)}</button>
          ${kind === "login" ? `<button class="social-command">${icon("chrome", 16)} 使用 Google 登录</button>` : ""}
          <div class="auth-footer">${data.footer}</div>
        </section>
      </main>
    </div>`;
}

const workCards = [
  [media.rain, "雨夜来信", "剧情短片 · 蓝图待确认"],
  [media.showcase, "失重城市", "概念预告 · 已完成"],
  [media.frames[0], "咖啡冷掉以前", "品牌短片 · 分镜中"],
  [media.frames[3], "最后一班地铁", "人物短片 · 已完成"],
];

function projectsPage() {
  return `
    <div class="ym-screen home-screen" style="--rain:url('${media.rain}')">
      ${header({ home: true })}
      <main class="creation-home">
        <section class="creation-focus">
          <div class="creation-heading"><h1>把想法拍成作品</h1><p>先聊灵感，再决定是否开始制作。</p></div>
          <div class="hero-composer">
            <textarea aria-label="描述你想创作的视频" placeholder="描述一个故事、一个画面，或者一种想让观众记住的感觉……"></textarea>
            <div class="composer-tools"><button class="ghost-icon" title="添加参考">${icon("paperclip", 17)}</button><button class="ghost-icon" title="录音">${icon("mic", 17)}</button></div>
            <a class="black-start" href="?screen=inspiration">开始 ${icon("arrow-right", 16)}</a>
          </div>
          <div class="mode-switch" role="tablist">
            <button class="mode-button">${icon("lightbulb", 16)} 灵感</button>
            <button class="mode-button">${icon("pen-line", 16)} 剧本</button>
            <button class="mode-button">${icon("image", 16)} 图像</button>
            <button class="mode-button active">${icon("video", 16)} 视频</button>
            <button class="mode-button">${icon("panels-top-left", 16)} 分镜</button>
          </div>
          <div class="idea-gallery">${workCards.map(([image, title, meta], index) => `<a class="idea-tile" href="?screen=${index === 0 ? "inspiration" : "production"}"><div class="idea-image" style="background-image:url('${image}')"><span>${index === 0 ? "继续创作" : "查看作品"}</span></div><strong>${title}</strong><small>${meta}</small></a>`).join("")}</div>
        </section>
        <section class="recent-strip"><div><strong>最近作品</strong><span>4 个项目</span></div><button class="outline-pill">${icon("plus", 14)} 新建项目</button></section>
      </main>
    </div>`;
}

function assistantMessage(text, options = []) {
  return `<div class="chat-row assistant"><span class="chat-avatar">OM</span><div><strong>OpenMontage</strong><p>${text}</p>${options.length ? `<div class="choice-row">${options.map((option, index) => `<button class="choice-pill ${index === 0 ? "selected" : ""}">${option}</button>`).join("")}</div>` : ""}</div></div>`;
}

function userMessage(text) {
  return `<div class="chat-row user"><div><p>${text}</p></div><span class="user-dot">周</span></div>`;
}

function workbenchHeader(title, active, extra = "") {
  return `${header({ title, stage: "自动保存" })}<div class="work-subbar">${stageNav(active)}<div>${extra}</div></div>`;
}

function composer(value = "") {
  return `<div class="chat-composer"><button class="ghost-icon" title="添加参考素材">${icon("paperclip", 17)}</button><textarea>${value}</textarea><button class="send-button" title="发送">${icon("arrow-up", 16)}</button></div>`;
}

function inspirationPage() {
  return `
    <div class="ym-screen">
      ${workbenchHeader("雨夜来信", "inspiration", `<span class="quiet-status">只讨论，不生成素材</span>`)}
      <main class="split-workspace">
        <section class="conversation-pane">
          <div class="pane-heading"><div><span>灵感对话</span><h2>先把真正想拍的东西聊清楚</h2></div><button class="ghost-icon" title="更多">${icon("ellipsis", 17)}</button></div>
          <div class="conversation-scroll">
            ${assistantMessage("你最想让观众记住这个视频里的哪一种感觉？先不急着做分镜。", ["克制的重逢", "悬疑反转", "治愈温暖"])}
            ${userMessage("一个多年未见的女人，在雨夜咖啡馆等一个不会来的人。桌上的旧信，其实是对方十年前留下的。")} 
            ${assistantMessage("我建议做成 45 秒写实电影短片：前 30 秒让观众以为她在等人，最后通过旧信和窗外倒影揭示“这场赴约迟到了十年”。结尾需要彻底错过，还是留一点希望？", ["留一点希望", "彻底错过", "开放结局"])}
            ${userMessage("留一点希望。信里写着他每个雨天都会来，也许今晚只是迟到了。")} 
          </div>
          <div class="composer-dock">${composer("补充：整体不要煽情，画面克制，台词尽量少。")}</div>
        </section>
        <section class="artifact-pane">
          <div class="artifact-toolbar"><div><span class="artifact-dot"></span><strong>创作意图</strong><small>根据对话实时整理</small></div><div><button class="ghost-icon" title="历史版本">${icon("history", 16)}</button><button class="ghost-icon" title="关闭">${icon("x", 17)}</button></div></div>
          <article class="document-canvas intent-document">
            <div class="document-meta"><span>CREATIVE INTENT</span><span>草稿 01</span></div>
            <h1>雨夜来信</h1>
            <p class="document-lead">一场迟到十年的雨夜赴约，让等待与希望在一封旧信中重新发生。</p>
            <div class="intent-table">
              <div><span>形式</span><strong>45 秒 · 16:9 剧情短片</strong></div>
              <div><span>核心情绪</span><strong>克制、余韵、仍然相信</strong></div>
              <div><span>视觉方向</span><strong>写实电影感 · 冷雨暖灯</strong></div>
              <div><span>声音方向</span><strong>雨声主导 · 极简钢琴</strong></div>
            </div>
            <section class="document-section"><h3>观众最后应该记住</h3><p>她不是在等待某个人，而是在允许自己继续相信。结尾不回答门外是谁，只让门铃、雨声和她抬起的眼睛留下可能。</p></section>
            <div class="approval-panel"><div><span>${icon("shield-check", 16)}</span><p><strong>确认之前不会生成素材</strong><br />下一步只会规划世界观、人物、场景、道具和分镜提示词，仍需逐项确认。</p></div><a class="black-command compact" href="?screen=blueprint">确认创意，开始规划 ${icon("arrow-right", 15)}</a></div>
          </article>
        </section>
      </main>
    </div>`;
}

const blueprintArtifacts = [
  ["globe-2", "世界观与视觉母提示词", "待确认"],
  ["users", "人物设定 · 2", "待确认"],
  ["map", "场景设定 · 3", "待确认"],
  ["package", "关键道具 · 4", "待确认"],
  ["music-2", "声音与配乐", "待确认"],
  ["clapperboard", "分镜规划 · 8", "待确认"],
];

function blueprintPage() {
  return `
    <div class="ym-screen">
      ${workbenchHeader("雨夜来信", "blueprint", `<span class="quiet-status warning">1 / 6 已确认</span>`)}
      <main class="split-workspace blueprint-workspace">
        <section class="conversation-pane artifact-list-pane">
          <div class="pane-heading"><div><span>规划产物</span><h2>AI 已完成第一版创作蓝图</h2></div><button class="ghost-icon" title="重新规划">${icon("refresh-cw", 16)}</button></div>
          <div class="run-summary"><span>${icon("check", 13)}</span><div><strong>规划完成 · 18 秒</strong><small>由 4 轮灵感对话生成</small></div></div>
          <div class="artifact-list">${blueprintArtifacts.map(([iconName, label, state], index) => `<button class="artifact-row ${index === 0 ? "active" : ""}"><span class="artifact-icon">${icon(iconName, 17)}</span><span><strong>${label}</strong><small>${state}</small></span>${icon("chevron-right", 15)}</button>`).join("")}</div>
          <div class="plan-chat-callout"><p>对某项规划不满意？继续告诉我想修改的方向。</p><button class="text-button">${icon("message-circle", 15)} 继续讨论</button></div>
          <div class="composer-dock">${composer("例如：女主的职业不要是建筑师……")}</div>
        </section>
        <section class="artifact-pane">
          <div class="artifact-toolbar"><div><span class="artifact-dot amber"></span><strong>创作蓝图</strong><small>世界观与视觉母提示词</small></div><div><button class="ghost-icon" title="编辑">${icon("pencil", 15)}</button><button class="outline-pill small">确认此项</button><button class="ghost-icon" title="关闭">${icon("x", 17)}</button></div></div>
          <article class="document-canvas blueprint-document">
            <div class="document-meta"><span>OPENMONTAGE BLUEPRINT</span><span>版本 01 · 待确认</span></div>
            <h1>世界观与视觉基础</h1>
            <p class="document-lead">所有人物、场景、道具和分镜提示词都将继承这组规则，以保证整部作品前后一致。</p>
            <section class="prompt-block"><div class="section-number">01</div><div><h3>世界观母提示词</h3><p>当代南方沿海城市，一个持续下雨的深夜。写实世界，无超自然元素。冷蓝雨夜与暖棕室内形成克制对比；35mm 电影摄影、浅景深、细微胶片颗粒；镜头以静态观察与极慢推进为主。</p></div></section>
            <section class="prompt-block"><div class="section-number">02</div><div><h3>连续性硬规则</h3><ul><li>窗外雨势在所有镜头中保持一致，室内暖光不高于 3200K。</li><li>林乔始终穿黑色长风衣，右手佩戴银色细戒。</li><li>陈屿只通过信、倒影和门外剪影出现，不给正面特写。</li></ul></div></section>
            <section class="prompt-block"><div class="section-number">03</div><div><h3>负面约束</h3><div class="token-row"><span>无赛博霓虹</span><span>无过度磨皮</span><span>无夸张运镜</span><span>不直白煽情</span></div></div></section>
            <section class="review-line"><div><span class="review-check">${icon("check", 13)}</span><span><strong>故事方向</strong><small>已从灵感对话确认</small></span></div><div><span class="review-clock">${icon("clock-3", 13)}</span><span><strong>其余 5 项</strong><small>等待逐项确认</small></span></div></section>
            <div class="approval-panel blueprint-approval"><div><span>${icon("lock", 16)}</span><p><strong>全部确认后才创建正式项目</strong><br />未确认前不会开始人物图、场景图或视频生成。</p></div><button class="black-command compact disabled">还有 5 项待确认</button></div>
          </article>
        </section>
      </main>
    </div>`;
}

const shotNames = ["雨夜建立", "窗边等待", "咖啡冷却", "旧信展开", "倒影中的人", "门铃响起"];

function storyboardPage() {
  return `
    <div class="ym-screen">
      ${workbenchHeader("雨夜来信", "storyboard", `<button class="outline-pill small">${icon("play", 13)} 预览全片</button>`)}
      <main class="storyboard-workspace">
        <aside class="shot-sidebar">
          <div class="panel-title"><div><span>分镜</span><strong>6 镜头 · 45 秒</strong></div><button class="ghost-icon" title="添加镜头">${icon("plus", 16)}</button></div>
          <div class="shot-list">${shotNames.map((name, index) => `<button class="shot-item ${index === 0 ? "active" : ""}"><span class="shot-thumb" style="background-image:url('${index === 0 ? media.rain : media.frames[index - 1]}')"><b>${String(index + 1).padStart(2, "0")}</b></span><span><strong>${name}</strong><small>${[6, 7, 5, 8, 7, 12][index]} 秒 · ${index < 3 ? "画面就绪" : "等待素材"}</small></span></button>`).join("")}</div>
        </aside>
        <section class="stage-pane">
          <div class="stage-toolbar"><div><strong>镜头 01 · 雨夜建立</strong><span>已自动保存</span></div><div><button class="ghost-icon" title="撤销">${icon("undo-2", 15)}</button><button class="ghost-icon" title="重做">${icon("redo-2", 15)}</button><button class="outline-pill small">16:9</button></div></div>
          <div class="video-stage"><div class="video-frame" style="background-image:url('${media.rain}')"><button class="play-button" title="播放">${icon("play", 20)}</button><div class="video-controls"><span>00:02 / 00:45</span><div></div>${icon("volume-2", 15)}${icon("maximize", 15)}</div></div></div>
          <div class="timeline-panel"><div class="timeline-scale"><span>00:00</span><span>00:10</span><span>00:20</span><span>00:30</span><span>00:40</span><span>00:45</span></div><div class="clip-track">${shotNames.map((name, index) => `<button class="clip ${index === 0 ? "active" : ""}" style="--clip:${[13, 15, 11, 18, 16, 27][index]}%;background-image:url('${index === 0 ? media.rain : media.frames[index - 1]}')"><span>${String(index + 1).padStart(2, "0")}</span></button>`).join("")}</div><div class="audio-line"><span>${icon("music-2", 13)} 雨声与极简钢琴</span></div></div>
        </section>
        <aside class="inspector-pane">
          <div class="panel-title"><div><span>镜头属性</span><strong>画面与运动</strong></div><button class="ghost-icon" title="关闭">${icon("x", 16)}</button></div>
          <div class="inspector-tabs"><button class="active">画面</button><button>镜头</button><button>声音</button></div>
          <div class="inspector-form"><label><span>镜头提示词</span><textarea>雨夜城市街道，林乔撑黑伞走向街角咖啡馆。冷蓝环境光，车灯在湿地拉出倒影，35mm 写实电影感。</textarea></label><div class="field-pair"><label><span>时长</span><input value="6 秒" /></label><label><span>景别</span><select><option>远景</option></select></label></div><label><span>镜头运动</span><select><option>缓慢跟随推进</option></select></label><label><span>绑定角色</span><button class="binding-row"><span style="background-image:url('${media.character}')"></span><b>林乔 · 形象已锁定</b>${icon("chevron-right", 14)}</button></label><button class="outline-command">${icon("wand-sparkles", 15)} 优化提示词</button><button class="black-command compact">${icon("refresh-cw", 15)} 重新生成镜头</button></div>
        </aside>
      </main>
    </div>`;
}

function settingsPage() {
  const nav = [["globe-2", "世界观"], ["users", "人物"], ["map", "场景"], ["package", "道具"], ["git-branch", "关系与状态"], ["shield-off", "禁忌规则"]];
  return `
    <div class="ym-screen">
      ${workbenchHeader("雨夜来信", "storyboard", `<span class="quiet-status success">12 项一致性检查通过</span>`)}
      <main class="settings-workspace">
        <aside class="settings-nav"><div class="panel-title"><div><span>项目规则</span><strong>全局设定</strong></div></div>${nav.map(([name, label], index) => `<button class="settings-nav-item ${index === 0 ? "active" : ""}">${icon(name, 16)}<span>${label}</span>${index === 0 ? `<b>4</b>` : icon("chevron-right", 14)}</button>`).join("")}</aside>
        <section class="settings-document-wrap">
          <div class="artifact-toolbar"><div><span class="artifact-dot"></span><strong>世界观与连续性</strong><small>自动写入每个分镜提示词</small></div><div><button class="ghost-icon" title="历史版本">${icon("history", 16)}</button><button class="black-command tiny">${icon("save", 14)} 保存设定</button></div></div>
          <article class="document-canvas settings-document"><div class="document-meta"><span>PROJECT BIBLE</span><span>覆盖率 92%</span></div><h1>雨夜来信 · 故事世界</h1><p class="document-lead">一座潮湿、安静的沿海城市。雨让街道、玻璃和记忆同时变得模糊，咖啡馆是唯一温暖但无法逃避过去的地方。</p><div class="fact-grid"><div><span>时代与地点</span><strong>当代 · 南方沿海城市</strong></div><div><span>时间跨度</span><strong>一个雨夜 · 回忆跨越十年</strong></div><div><span>现实规则</span><strong>写实世界 · 无超自然元素</strong></div><div><span>色彩逻辑</span><strong>冷蓝雨夜 · 暖棕室内</strong></div></div><section class="document-section"><div class="section-heading"><h3>连续性硬规则</h3><button class="outline-pill small">${icon("plus", 13)} 添加规则</button></div><div class="rule-lines"><div><b>01</b><p>林乔始终穿黑色风衣，右手戴银色细戒。</p><span>人物</span></div><div><b>02</b><p>旧信纸张微黄，有三道明确折痕，使用蓝黑墨水。</p><span>道具</span></div><div><b>03</b><p>咖啡馆窗外持续下雨，室内暖光不超过 3200K。</p><span>场景</span></div><div><b>04</b><p>陈屿只通过信、倒影与门外剪影出现。</p><span>叙事</span></div></div></section><section class="document-section character-inline"><div class="section-heading"><h3>主要人物</h3><button class="text-button">管理人物</button></div><div><span class="character-portrait" style="background-image:url('${media.character}')"></span><p><strong>林乔</strong><small>34 岁 · 建筑师 · 克制</small></p><span class="confirmed-label">形象已锁定</span></div><div><span class="character-portrait face" style="background-image:url('${media.face1}')"></span><p><strong>陈屿</strong><small>36 岁 · 摄影师 · 缺席者</small></p><span class="confirmed-label">叙事已锁定</span></div></section></article>
        </section>
      </main>
    </div>`;
}

const resourceCards = [
  [media.character, "林乔 · 角色四视图", "人物", "已锁定"],
  [media.face1, "林乔 · 情绪参考", "人物", "已绑定"],
  [media.rain, "雨夜咖啡馆", "场景", "核心场景"],
  [media.frames[0], "窗边等待", "分镜素材", "镜头 02"],
  [media.frames[1], "旧信与银色钢笔", "道具", "关键特写"],
  [media.frames[2], "门外剪影", "场景", "镜头 06"],
  [media.frames[3], "陈屿 · 倒影参考", "人物", "不露脸"],
  [media.frames[4], "湿地车灯倒影", "氛围", "连续性"],
];

function resourcesPage() {
  return `
    <div class="ym-screen resource-screen">
      ${header({ title: "雨夜来信", stage: "资源库" })}
      <main class="resource-page"><header class="resource-heading"><div><span>PROJECT ASSETS</span><h1>项目资源</h1><p>人物、场景、道具和分镜素材都在这里保持一致。</p></div><div><button class="outline-pill">${icon("upload", 14)} 上传素材</button><button class="black-command tiny">${icon("sparkles", 14)} 生成资源</button></div></header><div class="resource-toolbar"><div class="filter-tabs"><button class="active">全部 24</button><button>人物 6</button><button>场景 7</button><button>道具 4</button><button>分镜素材 7</button></div><div><button class="ghost-icon" title="搜索">${icon("search", 16)}</button><button class="ghost-icon" title="网格视图">${icon("grid-2x2", 16)}</button></div></div><section class="resource-grid">${resourceCards.map(([image, title, type, state], index) => `<button class="resource-card ${index === 0 ? "active" : ""}"><div class="resource-image ${index === 0 ? "character-sheet" : ""}" style="background-image:url('${image}')"><span>${type}</span><i>${icon("ellipsis", 15)}</i></div><strong>${title}</strong><small>${state} · 已加入项目</small></button>`).join("")}</section></main>
    </div>`;
}

function productionPage() {
  return `
    <div class="ym-screen">
      ${workbenchHeader("雨夜来信", "production", `<button class="outline-pill small">${icon("share-2", 13)} 分享</button>`)}
      <main class="split-workspace production-workspace">
        <section class="conversation-pane delivery-pane">
          <div class="pane-heading"><div><span>制作记录</span><h2>成片已经准备好</h2></div><button class="ghost-icon" title="更多">${icon("ellipsis", 17)}</button></div>
          <div class="delivery-scroll"><div class="run-summary success"><span>${icon("check", 13)}</span><div><strong>运行完成 · 6m 42s</strong><small>6 个镜头已合成，连续性检查通过</small></div></div><h3>交付内容</h3><ul class="deliverable-list"><li><strong>最终视频</strong><span>45 秒 · 16:9 · 1080p</span></li><li><strong>创作蓝图</strong><span>世界观、人物、场景与道具提示词</span></li><li><strong>分镜文档</strong><span>6 镜头完整生成参数</span></li></ul><div class="delivery-note"><p><strong>制作说明</strong></p><p>已保持林乔的服装、戒指和咖啡馆光线连续；镜头 04 的旧信折痕使用同一道具参考。门铃在最后 1.5 秒进入。</p></div><button class="artifact-row active"><span class="artifact-icon">${icon("file-text", 17)}</span><span><strong>《雨夜来信》完整分镜</strong><small>文档</small></span>${icon("chevron-right", 15)}</button><button class="video-delivery-card"><span class="delivery-thumb" style="background-image:url('${media.rain}')">${icon("play", 18)}</span><span><strong>雨夜来信 · 最终成片</strong><small>视频 · 45 秒</small></span></button></div>
          <div class="composer-dock">${composer("告诉我需要调整的镜头或节奏……")}</div>
        </section>
        <section class="artifact-pane final-artifact"><div class="artifact-toolbar"><div><span class="artifact-dot"></span><strong>雨夜来信</strong><small>最终视频 · 1080p</small></div><div><button class="ghost-icon" title="下载">${icon("download", 16)}</button><button class="ghost-icon" title="全屏">${icon("maximize", 16)}</button><button class="ghost-icon" title="关闭">${icon("x", 17)}</button></div></div><div class="final-video-wrap"><div class="final-video" style="background-image:url('${media.rain}')"><button class="play-button">${icon("play", 22)}</button><div class="film-title"><strong>雨夜来信</strong><span>有些赴约，只是比想象中晚了一点。</span></div><div class="video-controls"><span>00:00 / 00:45</span><div></div>${icon("volume-2", 15)}${icon("maximize", 15)}</div></div></div><div class="final-actions"><span>创建于 2026-07-15</span><div><button class="outline-pill">${icon("download", 14)} 下载视频</button><button class="black-command tiny">创建新版本</button></div></div></section>
      </main>
    </div>`;
}

function walletPage() {
  return `
    <div class="ym-screen subtle-page">${header({ title: "账户", stage: "钱包与额度" })}<main class="account-page"><header class="account-heading"><div><span>CREATIVE CREDITS</span><h1>钱包与额度</h1><p>管理生成额度，并查看每一次创作的消耗。</p></div><button class="black-command tiny">充值额度 ${icon("arrow-right", 14)}</button></header><section class="metric-row"><article class="metric-primary"><span>可用创作额度</span><strong>12,480</strong><small>约可生成 31 个高清镜头</small></article><article><span>本月已使用</span><strong>3,260</strong><small>较上月下降 12%</small></article><article><span>任务冻结</span><strong>480</strong><small>2 个任务进行中</small></article></section><section class="account-columns"><div><div class="section-heading"><h3>充值额度</h3><span>额度长期有效</span></div><div class="pack-list"><button><span><strong>3,000</strong><small>创作额度</small></span><b>¥29</b></button><button class="recommended"><i>推荐</i><span><strong>8,800</strong><small>含 800 赠送额度</small></span><b>¥69</b></button><button><span><strong>23,000</strong><small>含 3,000 赠送额度</small></span><b>¥159</b></button></div></div><div><div class="section-heading"><h3>最近明细</h3><a href="?screen=orders">查看全部</a></div><div class="ledger-list"><div><span><strong>镜头生成 · 雨夜来信</strong><small>今天 14:26</small></span><b>-320</b></div><div><span><strong>提示词与蓝图规划</strong><small>今天 13:51</small></span><b>-40</b></div><div><span><strong>套餐充值</strong><small>7 月 12 日</small></span><b class="positive">+8,800</b></div><div><span><strong>最终视频合成</strong><small>7 月 10 日</small></span><b>-180</b></div></div></div></section></main></div>`;
}

const orderRows = [
  ["OM202607151426", "镜头生成 · 雨夜来信", "今天 14:26", "-320", "已完成"],
  ["OM202607151351", "提示词与蓝图规划", "今天 13:51", "-40", "已完成"],
  ["OM202607121009", "8,800 额度套餐", "7 月 12 日", "¥69", "支付成功"],
  ["OM202607101832", "最终视频合成", "7 月 10 日", "-180", "已完成"],
  ["OM202607081245", "人物一致性生成", "7 月 8 日", "-240", "已完成"],
];

function ordersPage() {
  return `<div class="ym-screen subtle-page">${header({ title: "账户", stage: "订单记录" })}<main class="account-page"><header class="account-heading"><div><span>ORDER HISTORY</span><h1>订单记录</h1><p>查看充值、生成任务与退款状态。</p></div><button class="outline-pill">${icon("download", 14)} 导出记录</button></header><div class="table-toolbar"><div class="filter-tabs"><button class="active">全部</button><button>充值</button><button>生成消耗</button><button>退款</button></div><label>${icon("search", 15)}<input placeholder="搜索订单号或项目" /></label></div><section class="clean-table"><div class="table-head"><span>订单号</span><span>项目 / 类型</span><span>时间</span><span>金额 / 额度</span><span>状态</span><span></span></div>${orderRows.map((row) => `<div class="table-row">${row.map((cell, index) => `<span class="${index === 4 ? "table-status" : ""}">${cell}</span>`).join("")}<button class="ghost-icon">${icon("chevron-right", 15)}</button></div>`).join("")}</section></main></div>`;
}

function adminPage() {
  return `<div class="ym-screen subtle-page">${header({ title: "OpenMontage", stage: "计费管理", admin: true })}<main class="admin-page"><header class="account-heading"><div><span>OPERATIONS</span><h1>计费管理</h1><p>平台收入、用户额度与异常订单。</p></div><button class="black-command tiny">${icon("plus", 14)} 调整用户额度</button></header><section class="admin-metrics"><article><span>累计收入</span><strong>¥48,426</strong><small>本月 +18.4%</small></article><article><span>流通额度</span><strong>428K</strong><small>冻结 18.2K</small></article><article><span>付费用户</span><strong>1,284</strong><small>转化率 12.8%</small></article><article><span>异常任务</span><strong>3</strong><small>需要处理</small></article></section><section class="admin-columns"><div><div class="section-heading"><h3>最近订单</h3><button class="text-button">查看全部</button></div><div class="clean-table compact-table"><div class="table-head"><span>用户</span><span>类型</span><span>金额</span><span>状态</span></div>${[["creator@om.ai", "8,800 额度套餐", "¥69", "成功"],["zhou@studio.cn", "20,000 额度套餐", "¥159", "成功"],["lin@film.co", "自定义充值", "¥299", "审核中"],["hello@mono.cc", "退款", "-¥69", "待处理"]].map((row) => `<div class="table-row">${row.map((cell, i) => `<span class="${i === 3 ? "table-status" : ""}">${cell}</span>`).join("")}</div>`).join("")}</div></div><aside><div class="section-heading"><h3>额度调整</h3><span>管理员操作</span></div><div class="admin-form"><label><span>用户邮箱</span><input value="creator@openmontage.ai" /></label><label><span>调整额度</span><input value="+ 1,000" /></label><label><span>原因</span><textarea>活动补偿额度</textarea></label><button class="black-command tiny">确认调整</button></div><div class="risk-note"><span>${icon("shield-alert", 16)}</span><p><strong>额度保护已开启</strong><br />超过 10,000 的单次调整需要二次审核。</p></div></aside></section></main></div>`;
}

function render() {
  const screen = new URLSearchParams(window.location.search).get("screen") || "projects";
  const pages = {
    login: () => authPage("login"),
    register: () => authPage("register"),
    recovery: () => authPage("recovery"),
    projects: projectsPage,
    inspiration: inspirationPage,
    blueprint: blueprintPage,
    storyboard: storyboardPage,
    settings: settingsPage,
    resources: resourcesPage,
    production: productionPage,
    wallet: walletPage,
    orders: ordersPage,
    admin: adminPage,
  };
  document.title = `${screens[screen] || "OpenMontage"} · OpenMontage`;
  document.querySelector("#app").innerHTML = (pages[screen] || pages.projects)();
  if (window.lucide) window.lucide.createIcons();
  bindInteractions();
}

function bindInteractions() {
  document.querySelectorAll(".mode-button").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".mode-button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  }));
  document.querySelectorAll(".artifact-row, .shot-item, .settings-nav-item").forEach((button) => button.addEventListener("click", () => {
    const parent = button.parentElement;
    parent?.querySelectorAll(":scope > button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  }));
}

render();
