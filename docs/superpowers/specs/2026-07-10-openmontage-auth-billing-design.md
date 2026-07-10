# OpenMontage 独立登录、支付与成本结算设计

日期：2026-07-10

## 1. 目标

把 OpenMontage 从浏览器本地、用户自行填写模型 Key 的工作台，扩展为具备独立账号、充值钱包、项目权限和可核对 AI 成本结算的商业化产品。

OpenMontage 独立拥有用户、登录态、项目归属、充值订单、钱包和销售计费。NewAPI 不参与 OpenMontage 用户登录或充值，只继续承担模型路由、上游成本扣除和成本回执。

本设计与正在执行的工作台前端优化计划互补：

- `docs/superpowers/plans/2026-07-10-openmontage-frontend-optimization.md` 继续完成项目列表、创建、分镜、资源和制作页面。
- 本设计新增登录、账号、钱包、订单、管理员计费和服务端项目权限。
- 前端优化计划明确排除的登录与支付能力由后续两份独立实施计划交付。

## 2. 已确认的产品决策

- OpenMontage 账号体系独立，不复用 NewAPI 用户、Session、钱包或订单。
- 数据库使用独立 PostgreSQL；Redis 使用独立数据库编号或键前缀。
- 登录方式为邮箱 + 密码；注册必须验证邮箱验证码。
- 密码使用 Argon2id；验证码哈希后存 Redis；登录态使用服务端 Session。
- 支付复用当前已跑通的易支付商户通道，首期只开放支付宝。
- OpenMontage 自己创建支付订单并接收回调，不调用 NewAPI 的充值接口。
- NewAPI admin 账号下创建文本、图片、视频三个 OpenMontage 专用普通 API Token。
- 所有生产模型请求都通过自有 NewAPI 网关；浏览器不接触 NewAPI Token 或上游 Key。
- 用户最终扣费为 NewAPI 实际成本乘一个管理员可调整的全局倍率。
- 全局倍率只影响新创建的任务；任务创建时保存倍率快照。
- 异步视频失败、NewAPI 已退款或退款状态尚未确认时，OpenMontage 用户不得被扣款。

## 3. 总体架构

采用方案 A：在现有 FastAPI 服务内建立模块化单体，使用 PostgreSQL、Redis 和后台任务执行器。

```text
React Web
  |
  v
OpenMontage FastAPI
  |- auth          用户、邮箱验证、Session、密码重置
  |- projects      用户项目归属与访问控制
  |- wallet        余额、冻结、不可变资金流水
  |- payments      易支付下单、回调、订单查询
  |- billing       成本倍率、预冻结、最终结算、退款释放
  |- provider      NewAPI Token 路由与成本回执客户端
  |- jobs          生成任务状态与后台对账
  `- admin         用户、订单、倍率、套餐和异常对账
       |
       v
PostgreSQL + Redis

OpenMontage provider bridge
  |
  v
NewAPI
  |- 文本 Token
  |- 图片 Token
  |- 视频 Token
  `- 成本回执接口
       |
       v
上游模型渠道
```

FastAPI 仍是唯一面向 OpenMontage 前端的业务 API。后台执行器与 API 使用相同的领域模块和数据库，不在 Python 之外再建立第二套账号计费服务。

## 4. 模块边界

### 4.1 Auth

负责：

- 邮箱验证码发送与校验。
- 用户注册、登录、退出、当前用户查询。
- 密码重置和全设备 Session 吊销。
- 登录限流、会话轮换和 CSRF 防护。

不负责钱包余额或 NewAPI 身份。

### 4.2 Wallet 与 Payments

负责：

- 充值产品、支付订单和易支付回调。
- 钱包可用余额、活动冻结和不可变流水。
- 同一支付回调的幂等入账。

支付订单只增加 OpenMontage 钱包，不增加 NewAPI 余额。

### 4.3 Billing 与 Jobs

负责：

- 在模型调用前冻结用户额度。
- 保存任务使用的全局倍率快照。
- 保存 NewAPI `request_id` 或 `task_id`。
- 获取最终成本回执并执行成功扣款或失败释放。
- 对超时、退款失败和回执缺失建立后台对账项。

### 4.4 Provider Bridge

负责：

- 根据能力选择服务端 Token：`text`、`image`、`video`。
- 调用 NewAPI 并捕获请求标识。
- 查询成本回执。
- 屏蔽所有 NewAPI 和上游凭据，不把 Key 写入响应、日志或项目备份。

## 5. 登录设计

### 5.1 注册流程

```text
用户输入邮箱
-> POST /api/auth/email-verifications
-> Redis 保存验证码哈希、用途、发送时间、失败次数，TTL 10 分钟
-> 用户提交邮箱、验证码、密码
-> POST /api/auth/register
-> 原子消费验证码
-> PostgreSQL 创建用户和空钱包
-> 创建并轮换 Session
-> 返回当前用户与 CSRF Token
```

验证码规则：

- 六位随机数字，使用密码学安全随机源。
- Redis 只保存 HMAC/哈希，不保存明文。
- 同邮箱 60 秒内不可重发。
- 单邮箱、单 IP 和全局发送速率分别限流。
- 最多失败 5 次；成功或达到上限后立即删除。
- Redis 键包含用途，注册验证码不能用于密码重置。
- 发送接口不在响应或日志中暴露验证码。

### 5.2 密码与登录

- 邮箱统一 `trim + lowercase`，数据库建立唯一索引。
- 密码允许 8-64 个字符，使用 Argon2id 哈希。
- 登录失败统一返回“邮箱或密码错误”，不泄露账号是否存在。
- 登录成功后轮换 Session ID，避免会话固定。
- Session 随机值存 Cookie，Session 内容存 Redis。
- Cookie 使用 `HttpOnly`、`Secure`、`SameSite=Lax`、限定 `Path=/`。
- Session 设置空闲过期与绝对过期；修改密码、封禁账号和“退出全部设备”会吊销全部 Session。
- 所有修改状态接口校验同源 `Origin` 并要求 CSRF Token。

### 5.3 密码重置

```text
提交邮箱
-> 始终返回相同成功文案
-> 已注册邮箱收到一次性重置链接/验证码
-> 用户输入新密码
-> 原子消费重置令牌
-> 更新密码哈希
-> 吊销全部旧 Session
```

系统不生成并返回新密码，也不在邮件中发送明文密码。

### 5.4 项目权限

- 服务端 `projects` 第一阶段增加可空 `owner_user_id` 外键和索引；所有新项目必须写入当前用户 ID。
- 所有项目、媒体、分镜、资源、事件和渲染接口先根据当前用户过滤项目。
- 不再允许仅凭 `project_id` 读取或修改项目。
- 浏览器本地项目仍可导入导出，但调用生成后端前必须属于当前登录用户。
- 上线前已有的无归属后端项目不自动归给任意新用户，也不通过公开 API 暴露。
- 用户导入旧浏览器备份时创建新的服务端项目 ID 和当前用户归属，不把旧后端 ID 直接绑定给用户。
- 管理员迁移或清理完全部旧项目后，第二阶段迁移再把 `owner_user_id` 改为非空。

### 5.5 OpenMontage 管理员初始化

- 公共注册只能创建普通用户，客户端提交的角色字段一律忽略。
- 首个管理员通过服务端管理命令创建，例如 `python -m server.manage create-admin`。
- 管理命令要求交互输入密码或从一次性安全输入读取，不允许把管理员密码写入仓库、迁移或进程参数。
- 后续管理员角色变更只允许已有管理员执行，并写入审计日志。

## 6. NewAPI Token 设计

在当前 NewAPI admin 账号的普通 Token 管理中创建：

| Token | 用途 | 约束 |
| --- | --- | --- |
| `openmontage-text-prod` | 故事、分镜、提示词优化 | 文本分组，只允许已批准文本模型 |
| `openmontage-image-prod` | 角色、场景、道具图 | 图片分组，只允许 `gpt-image-2` |
| `openmontage-video-prod` | 单镜头和视频生成 | 视频分组，只允许已批准视频模型 |

这些是普通模型 Token，不是 admin 管理 Access Token。Token 归 admin 账号管理，但只具有模型调用和自己的只读成本回执权限。

OpenMontage 服务端环境变量：

```text
NEWAPI_BASE_URL
NEWAPI_TEXT_API_KEY
NEWAPI_IMAGE_API_KEY
NEWAPI_VIDEO_API_KEY
```

Token 轮换时先禁用旧 Token，等所有引用旧 Token 的任务完成对账后再删除。回执接口使用 NewAPI 已有的只读 Token 鉴权语义，允许禁用或额度耗尽但尚未删除的 Token 查询自己的历史回执。

## 7. NewAPI 成本回执

### 7.1 接口

新增两个 Token 范围内的只读接口：

```text
GET /api/usage/receipt/request/{request_id}
GET /api/usage/receipt/task/{task_id}
Authorization: Bearer <发起原请求的同一个 Token>
```

同步文本和图片使用 `request_id`；异步视频使用 `task_id`。接口必须验证日志或任务的 `token_id` 与鉴权 Token 相同。

### 7.2 回执状态

```text
pending          请求或任务尚未完成
settled          成功且最终成本已确定
refunded         失败且退款记录已确认，最终成本为 0
refund_pending   任务已失败，但尚未确认 NewAPI 退款
not_chargeable   请求在产生费用前失败，最终成本为 0
```

示例：

```json
{
  "reference_type": "task",
  "reference_id": "task_xxx",
  "status": "settled",
  "model": "omni_flash-10s",
  "quota": 1449000,
  "refunded_quota": 0,
  "quota_per_unit": 500000,
  "cost_currency": "USD",
  "cost_amount_micro": 2898000,
  "settled_at": 1783389175
}
```

`quota_per_unit` 必须作为回执快照返回，OpenMontage 不得使用查询时的当前全局配置倒推历史成本。

### 7.3 异步退款判定

生产数据已经证明：NewAPI 失败任务即使完成退款，`tasks.quota` 仍可能保留原预扣额度。因此规则必须是：

- `SUCCESS`：使用最终 `tasks.quota`，状态为 `settled`。
- `FAILURE` 且初始 quota 为 0：状态为 `not_chargeable`，最终成本为 0。
- `FAILURE` 且存在同 Token、同 `task_id` 的退款日志：状态为 `refunded`，最终成本为 0。
- `FAILURE` 但退款日志尚不存在：状态为 `refund_pending`，不得返回可扣费 quota。
- 回执不得仅根据失败任务残留的 `tasks.quota` 生成成本。

若 NewAPI 退款本身失败，OpenMontage 用户仍不承担该费用；系统释放用户冻结额度，并向管理员建立“上游退款待处理”对账项。运营方承担并追踪这笔上游异常成本。

## 8. 钱包与计费模型

### 8.1 金额单位

- 支付金额使用人民币分整数保存，禁止浮点数。
- NewAPI 成本使用 `quota`、`quota_per_unit` 和整数微美元快照保存。
- OpenMontage 钱包使用整数 `credit_units`，不使用浮点余额。
- `credit_units` 以微美元销售价值为基础，`1000 credit_units = 1 积分`；UI 最多显示三位小数，历史流水始终保留原始整数单位。
- 充值产品直接保存要赠送的 `credit_units`，不按支付时汇率动态换算，订单保存产品价格和额度快照。

### 8.2 全局倍率

- `multiplier_bps` 使用万分位整数，例如 `15000 = 1.5x`。
- 首次部署从必填配置 `BILLING_DEFAULT_MULTIPLIER_BPS` 初始化；部署样例使用 `15000`，管理员之后可以在允许范围内调整。
- 修改倍率记录旧值、新值、管理员、时间和原因。
- 任务创建时复制倍率到任务，后续修改不影响该任务。
- 结算使用整数向上取整，避免浮点误差和少扣。

概念公式：

```text
provider_cost_micro = ceil(quota * 1_000_000 / quota_per_unit)
user_charge_units   = ceil(provider_cost_micro * multiplier_bps / 10_000)
```

### 8.3 预冻结而非预扣款

模型调用前只建立冻结，不写最终消费流水：

```text
检查可用余额
-> 创建 generation_job
-> 创建 wallet_hold
-> 调用 NewAPI
-> 等待最终回执
```

可用余额定义为账面余额减活动冻结。冻结金额来自受控的模型/参数成本上限，并包含倍率快照；前端显示“预计最多消耗”，不把冻结显示为已消费。

冻结上限必须可解释且不可为零：

- 固定价格图片和按次视频根据 NewAPI 当前模型价格、分组倍率、时长和分辨率计算。
- 文本请求根据模型价格和服务端强制的最大输入/输出 token 上限计算。
- 计算结果乘任务倍率快照后向上取整。
- NewAPI 定价或必要参数无法读取时拒绝创建付费任务，不使用猜测价格继续调用。
- 任务保存估价输入和定价版本，便于实际费用超过冻结时审计。

### 8.4 成功结算

收到 `settled` 回执后，在一个 PostgreSQL 事务中：

1. 锁定任务、冻结和钱包行。
2. 检查任务尚未结算。
3. 保存原始回执和哈希。
4. 根据成本和倍率快照计算最终扣费。
5. 释放冻结。
6. 写入唯一的消费流水并更新余额缓存。
7. 标记任务 `billed` 后提交。

只有该事务提交后，生成结果才标记为可下载。

若实际扣费高于冻结：

- 可用余额足够时补充扣除差额。
- 可用余额不足时不产生负余额，也不交付结果；任务进入 `payment_required`，用户充值后可重试结算。
- 管理员收到估算上限失准告警，以便修正后续冻结上限。

### 8.5 失败与退款

```text
NewAPI 任务失败
-> OpenMontage 标记生成失败
-> 释放全部 wallet_hold
-> 不创建用户消费流水
-> 查询成本回执直到 refunded / not_chargeable
-> refund_pending 超时则建立管理员对账项
```

用户余额释放不依赖 NewAPI 退款最终是否成功。任何失败路径都不能把 NewAPI 的预扣 quota 作为用户最终消费。

### 8.6 幂等性

- `generation_jobs` 对 provider reference 建唯一约束。
- 钱包流水对 `idempotency_key` 建唯一约束。
- 同一任务重复轮询、重复回执和后台重试只能结算一次。
- 支付订单对商户订单号建唯一约束。
- 支付回调重复到达只返回成功，不重复入账。

## 9. 易支付设计

### 9.1 下单

```text
用户选择充值产品
-> 服务端读取产品价格和额度，忽略前端传入金额
-> 创建 pending 支付订单
-> 通过易支付生成支付宝收银台参数
-> 浏览器提交隐藏 POST 表单到收银台
```

商户地址、商户号和签名密钥通过服务端密钥配置提供，不写数据库明文、不返回前端。

### 9.2 回调

易支付通知接口支持供应商要求的方法，但只信任服务端验签后的异步通知。浏览器 return URL 只负责展示支付结果，不负责入账。

回调事务：

1. 验签并解析回调。
2. 锁定支付订单行。
3. 校验订单号、支付渠道、人民币金额和订单状态。
4. 将 `pending` 改为 `paid`。
5. 写入唯一充值流水并更新钱包余额。
6. 保存回调摘要与完成时间。
7. 同一事务提交后返回供应商成功响应。

这修复了现有 NewAPI 易支付实现中“先更新订单、再单独增加余额”的非原子边界，也不依赖单进程内存锁。

## 10. 数据模型

核心表：

| 表 | 关键字段与约束 |
| --- | --- |
| `users` | `id`、规范化邮箱唯一索引、密码哈希、角色、状态、创建时间 |
| `projects` | 分阶段增加 `owner_user_id` 外键和索引，历史无归属项目不可公开访问 |
| `wallet_accounts` | `user_id` 唯一、余额缓存、版本号 |
| `wallet_entries` | 有符号金额、余额快照、来源、唯一幂等键、不可修改 |
| `wallet_holds` | `job_id` 唯一、冻结额、状态、过期时间 |
| `topup_products` | 人民币分、入账额度、启用状态、排序 |
| `payment_orders` | 用户、产品快照、商户单号唯一、金额、状态、支付方式、完成时间 |
| `generation_jobs` | 用户、项目、能力、Token 类型、provider reference、冻结和结算状态 |
| `cost_receipts` | reference 唯一、状态、quota、单位快照、原始回执哈希 |
| `billing_settings` | 单例全局倍率、版本、更新时间 |
| `billing_reconciliations` | 回执缺失、上游退款失败、估算超限等人工处理项 |
| `admin_audit_logs` | 管理员、动作、对象、变更前后摘要、时间、IP |

Session、验证码和限流状态只存 Redis，不进入业务数据库明文。

## 11. API 边界

### 11.1 登录

```text
POST /api/auth/email-verifications
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
POST /api/auth/logout-all
GET  /api/auth/me
POST /api/auth/password-reset/request
POST /api/auth/password-reset/confirm
```

### 11.2 钱包与支付

```text
GET  /api/wallet
GET  /api/wallet/entries
GET  /api/topup-products
POST /api/payment-orders
GET  /api/payment-orders
GET  /api/payment-orders/{order_id}
POST /api/payments/epay/notify
GET  /api/payments/epay/notify
GET  /api/payments/epay/return
```

### 11.3 管理员

```text
GET /api/admin/billing/settings
PUT /api/admin/billing/settings
CRUD /api/admin/topup-products
GET /api/admin/payment-orders
GET /api/admin/wallet-entries
GET /api/admin/billing-reconciliations
POST /api/admin/billing-reconciliations/{id}/retry
```

所有管理员修改接口写审计日志。

## 12. 前端信息架构

新增路由：

```text
/login
/register
/forgot-password
/wallet
/account
/account/orders
/admin/billing
/admin/orders
/admin/reconciliation
```

受保护的工作台路由未登录时跳转 `/login?returnTo=...`，登录后只允许站内安全路径返回。顶部原“充值功能开发中”替换为真实余额与充值入口；“接口配置”从普通用户界面移除，Key 只由服务端管理。

视觉继续使用已确认的 `style-a-2plus3` 登录、钱包和账户订单概念，但实施时简化为本产品真实范围：邮箱密码登录、支付宝充值、积分余额、充值订单和消费流水，不展示虚构订阅、发票、团队或支付方式。

## 13. 异常处理与运维

- NewAPI 调用失败且无费用：释放冻结，不扣款。
- NewAPI 异步失败：立即释放用户冻结，后台确认上游退款。
- 回执暂时不存在：保持任务待对账，不提前扣款。
- 支付回调验签失败或金额不符：不入账并告警。
- Redis 不可用：拒绝注册验证码和新登录；已有数据库资金不受影响。
- PostgreSQL 不可用：停止创建订单和模型任务，不降级到内存余额。
- 后台任务重复执行：依靠数据库唯一键和行锁保持幂等。
- 定时对账扫描超时冻结、未结算任务、`refund_pending` 和已支付未入账订单。
- 监控登录失败率、验证码发送率、支付回调失败率、冻结时长、回执延迟和上游退款异常。

## 14. 测试策略

### 14.1 登录

- 邮箱规范化与并发唯一性。
- 验证码过期、用途隔离、尝试上限、一次性消费和重发冷却。
- Argon2id 哈希与密码验证。
- 登录 Session 轮换、退出、全设备吊销、封禁失效。
- CSRF、Origin、Cookie 属性和安全 return URL。
- 密码重置不泄露邮箱是否存在。
- 项目越权访问返回 404/403，不能通过 ID 读取他人媒体。

### 14.2 支付与钱包

- 易支付签名生成和回调验签固定向量。
- 前端篡改金额、产品额度或支付方式无效。
- 重复回调、并发回调和多实例回调只入账一次。
- 订单状态与钱包入账在一个事务中提交或全部回滚。
- 流水幂等键、余额守恒和禁止负余额。

### 14.3 成本与退款

- 同步请求成功回执按 request ID 结算。
- 异步成功使用最终 task quota，而非初始预扣日志。
- 异步失败且存在退款日志时用户扣费为 0。
- 异步失败但任务残留非零 quota 时用户扣费仍为 0。
- `refund_pending` 释放用户冻结并建立管理员对账项。
- 成功任务差额少于冻结时释放多余冻结。
- 成功任务高于冻结且余额不足时进入 `payment_required`，不产生负余额、不交付结果。
- 重复轮询、重复回执、服务重启和并发结算只能产生一条消费流水。
- 修改全局倍率不影响已创建任务的倍率快照。
- Token 轮换期间旧任务仍可完成回执查询。

### 14.4 端到端

- 注册 -> 登录 -> 充值 -> 创建项目 -> 生成成功 -> 实际扣费 -> 查看流水。
- 注册 -> 充值 -> 视频生成失败 -> NewAPI 退款 -> OpenMontage 冻结释放且无消费流水。
- 支付回调重复发送、后台任务重启和浏览器刷新后状态一致。

## 15. 实施拆分与并行边界

后续编写两份实施计划：

1. `OpenMontage Independent Auth And Project Ownership`
   - PostgreSQL/Alembic 和 Redis 基础接入。
   - 用户、验证码、Session、密码重置和项目归属。
   - 登录/注册/账号基础前端。
   - 输出稳定的 `CurrentUser` 与受保护路由契约。

2. `OpenMontage Wallet Payment And Provider Billing`
   - 钱包、冻结、流水、充值产品和易支付。
   - NewAPI 三 Token 路由和成本回执接口。
   - 全局倍率、生成任务结算、退款释放、管理员和对账页面。
   - 钱包、订单和消费流水前端。

并行规则：

- 登录计划拥有数据库/Redis 基础设施、`users`、认证依赖和项目权限文件。
- 支付计划拥有钱包、支付、计费、回执和管理员计费文件。
- 支付计划通过窄 `CurrentUser` 接口消费用户 ID，不修改认证内部实现。
- Alembic 迁移编号预留：认证 `001-009`，支付计费 `010-019`。
- 两份计划可以同时实现领域模块和测试；支付 API 最终接线依赖认证计划先提供 `CurrentUser`。
- 前端共享壳改动等当前工作台优化计划完成后再接入，避免同时修改 `App.tsx` 和共享路由文件。

## 16. 非目标

- 不让 OpenMontage 用户登录 NewAPI。
- 不在浏览器中保存或显示 NewAPI/上游 Key。
- 不实现订阅、自动续费、团队钱包、发票或多币种支付。
- 不实现微信支付、Stripe、Creem 或 Waffo。
- 不实现用户间转账、余额提现或现金等价兑换。
- 不把模型失败造成的上游退款异常转嫁给 OpenMontage 用户。
- 不复制 NewAPI 的完整账号或钱包代码；只复用已经验证的业务流程和支付协议经验。

## 17. 验收标准

1. 用户只能在邮箱验证后注册，并能安全登录、退出和重置密码。
2. 所有项目和媒体接口按当前用户隔离，无法通过猜测 ID 越权。
3. 支付宝充值回调重复到达不会重复入账，订单和钱包事务一致。
4. 前端不再要求普通用户输入任何模型 Key、网关或供应商信息。
5. 文本、图片、视频请求分别使用 admin 账号下的专用普通 Token。
6. 每个成功任务保存 NewAPI 成本回执、倍率快照和唯一钱包消费流水。
7. 管理员修改全局倍率只影响新任务并留下审计记录。
8. 异步视频失败、退款或退款待确认时，用户最终扣费为 0，冻结额度释放。
9. 任何重试、重复回调或服务重启都不会重复充值、扣款或退款。
10. 登录、支付、成功扣费、失败释放和管理员对账的单元、集成与端到端测试通过。
