# OpenMontage 登录充值版前端效果图提示词

## 全局约束

- Use case: ui-mockup
- Asset type: desktop web app product screen, 16:9 landscape, 1440px-style composition
- Style/medium: realistic shippable SaaS UI mockup, clean product interface, not concept art, not a marketing landing page
- Language: Simplified Chinese UI copy
- Visual direction: clear SaaS plus light cinematic feel, white and soft gray background, soft teal primary color, dark ink text, tiny warm accent for billing/status, comfortable spacing, card radius 8px or less
- Product concept: OpenMontage is a beginner-friendly AI short-drama creation platform where users log in, recharge credits, write an idea, generate storyboard shots, manage character references, render, and download the final video
- Required structure: show complete app screen, top navigation with product name, credit balance, recharge entry, and user menu when logged in
- Constraints: no API keys, no model names, no gateway URLs, no provider names, no code, no browser chrome, no watermark, no decorative gradient blobs, no huge hero marketing layout, no tiny unreadable labels, no nested cards

## login-register

Use case: ui-mockup
Asset type: desktop web app login/register screen
Primary request: Create a complete OpenMontage login and registration screen for normal users, focused on trust and fast start.
Screen content: product name "OpenMontage"; headline "登录后开始生成短剧"; tabs "登录" and "注册"; fields "手机号或邮箱", "验证码"; buttons "获取验证码", "登录 / 注册"; secondary option "微信登录"; small trust line "作品自动保存，余额安全管理"; right side product preview showing a compact short-drama creation dashboard with cards "写故事", "生成分镜", "渲染下载".
Composition/framing: two-column app screen, left login form, right realistic product preview, balanced whitespace, no marketing hero card.
Constraints: render text cleanly; no API key fields; no model/provider/base URL text; no watermark.

## wallet-plans

Use case: ui-mockup
Asset type: desktop web app wallet and recharge page
Primary request: Create a complete recharge and plan page for OpenMontage users.
Screen content: top nav with "OpenMontage", "创作", "项目", "资源库", "充值", "设置"; credit balance "余额 3280 点"; primary button "立即充值"; plan cards "入门包 99 元 / 约 20 条短视频", "创作者包 299 元 / 约 75 条短视频", "团队包 899 元 / 约 260 条短视频"; usage estimator panel "预计消耗"; line items "生成分镜 20 点", "单镜头重生 80 点", "最终渲染 300 点"; billing history table with status chips "已完成".
Composition/framing: left sidebar navigation, main content with plan cards and estimator, right compact balance summary.
Constraints: no payment provider logos; no API/model/provider text; readable Chinese copy; no watermark.

## create-home

Use case: ui-mockup
Asset type: desktop web app creation home screen
Primary request: Create the main OpenMontage creation page after login.
Screen content: top nav with credit balance and recharge button; left sidebar "创作", "我的项目", "资源库", "充值", "设置"; main headline "把一个想法变成短剧"; large textarea labeled "故事想法"; placeholder text "例如：雨夜里，女主发现老板隐藏多年的秘密..."; controls "项目类型" with segmented options "单条视频", "短系列", "长系列"; "视频时长" options "30 秒", "60 秒", "90 秒"; "视频风格" options "都市反转", "亲情治愈", "悬疑", "爽文"; primary button "生成分镜"; right panel "新手流程" with steps "1 写想法", "2 看分镜", "3 生成视频".
Composition/framing: focused creation workspace, main action obvious, calm professional layout.
Constraints: hide advanced parameters; no API/model/provider text; no watermark.

## storyboard-workbench

Use case: ui-mockup
Asset type: desktop web app storyboard editing workbench
Primary request: Create a complete storyboard workbench screen for editing generated short-drama shots.
Screen content: top nav with project title "雨夜反转"; left vertical shot list with cards "01 雨夜相遇", "02 电梯停电", "03 真相出现", status chips "已生成", "待重生"; center panel with portrait video preview placeholder, current shot title "02 电梯停电", editable "镜头提示词", buttons "优化提示词", "重生当前镜头", "保存"; collapsible row "高级镜头设置" closed; right panel with "角色一致性" showing two character chips, "生成进度" stepper, and credit estimate "预计消耗 80 点".
Composition/framing: dense but organized tool surface, no hero layout, no nested cards, clear scanning hierarchy.
Constraints: beginner-friendly Chinese copy; no API/model/provider text; no watermark.

## asset-library

Use case: ui-mockup
Asset type: desktop web app asset library and character reference page
Primary request: Create a complete resource library page for managing character, scene, and prop references.
Screen content: top nav and left sidebar; main title "资源库"; upload area "上传参考图"; tabs "角色", "场景", "道具"; asset grid with cards "女主 林晚", "老板 顾沉", "雨夜街道", "旧办公室"; each card has image placeholder, tag, "用于 3 个镜头"; right panel "角色锁定" with explanation "选择角色图后，生成镜头时会尽量保持同一张脸和服装"; button "新建角色".
Composition/framing: asset management interface, practical and calm, thumbnail grid plus right guidance panel.
Constraints: no real celebrity faces, no API/model/provider text, no watermark.

## render-download

Use case: ui-mockup
Asset type: desktop web app final render and download page
Primary request: Create a complete final rendering and download page.
Screen content: top nav with balance and recharge; main title "最终视频"; large portrait video preview area with controls; progress stepper "排队中", "生成镜头", "合成视频", "完成" with "合成视频" active; status text "预计还需 2 分钟"; right panel "本次消耗" showing "已用 420 点", "余额 2860 点"; buttons "下载视频", "继续修改分镜", "复制分享链接"; lower section "生成记录" with rows and status "完成", "生成中".
Composition/framing: final production screen, clear next actions, reassuring status feedback.
Constraints: no API/model/provider text; no watermark; no overly dark cinematic UI.
