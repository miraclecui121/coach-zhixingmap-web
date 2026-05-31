# 教练预约商城 H5

一个可公网部署的教练预约 MVP，包含用户、教练、管理员三个独立入口。默认不预置教练、订单、评价数据，只保留一个管理员启动账号。

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:4173/user`。

## 三个入口

- 用户端：`/user`，只用于查看已上架教练、预约、支付、订单和评价。
- 教练端：`/coach`，只用于教练申请、资料维护、排期、订单处理、评价查看和提现。
- 管理员端：`/admin`，只用于教练审核、上架/下架、分佣、订单收款、提现审核、数据备份和支付配置。

根路径 `/` 会回到 `/user`。入口只决定当前工作台体验，真实权限仍由服务端校验；非管理员访问 `/admin` 只会看到无权限提示。

## 认证方式

真实环境使用微信公众号网页授权登录。服务端会引导用户进入微信授权页，回调后用 `code` 换取 `openid`，再创建或更新平台用户。

需要在服务端配置：

```bash
WECHAT_OAUTH_APPID=认证服务号 AppID
WECHAT_OAUTH_SECRET=认证服务号 AppSecret
WECHAT_OAUTH_CALLBACK_URL=https://你的公网域名/api/auth/wechat/callback
WECHAT_OAUTH_SCOPE=snsapi_userinfo
SESSION_SECRET=任意高强度随机字符串
ADMIN_OPENID=你的管理员微信 openid
BOOTSTRAP_FIRST_WECHAT_ADMIN=true
```

在微信公众平台后台还需要把公网域名配置到“网页授权域名”。如果只想静默确认身份，可把 `WECHAT_OAUTH_SCOPE` 改为 `snsapi_base`，这样只能拿到 `openid`；如果要拿昵称头像，用默认的 `snsapi_userinfo`。

微信授权 `state` 和登录会话使用签名校验，不依赖服务端内存；Render 冷启动或重启后不会因为内存丢失直接提示 state 过期。生产环境建议单独配置 `SESSION_SECRET`，不配置时会回退使用 `WECHAT_OAUTH_SECRET`。

如果微信后台要求上传 `MP_verify_xxx.txt` 验证文件，可配置：

```bash
WECHAT_VERIFY_FILENAME=MP_verify_xxx.txt
WECHAT_VERIFY_CONTENT=文件里的那一串验证内容
```

第一次上线时可以临时设置 `BOOTSTRAP_FIRST_WECHAT_ADMIN=true`，让第一个微信授权用户自动成为管理员；确认 `ADMIN_OPENID` 后可关闭这个开关。本地自动化测试可设置 `ALLOW_DEV_LOGIN=true` 打开开发登录入口；真实部署不要开启。

## 启动管理员

默认只保留一个本地管理员启动账号，手机号/openid 为 `admin`。真实微信授权后，推荐用 `ADMIN_OPENID` 绑定你的微信为管理员。

## 已实现流程

- 用户查看已审核且已上架的教练、预约时间、微信扫码支付；未配置微信支付时可提交人工收款确认，管理员确认后继续流转
- 教练维护介绍、价格、周三/周四下午可约时间、申请提现
- 管理员审核教练、维护教练、上架/下架教练、查看用户、设置抽佣、审核提现
- 管理员可在后台导出完整 JSON 数据备份，适合免费试运营阶段定期留档
- 服务端共享数据存储，部署后同一环境内多个角色访问同一套数据
- 微信公众号网页授权登录已接入服务端流程
- 微信支付 Native 扫码支付接口已接入；未配置商户参数时自动提供人工收款确认兜底，不阻断上线试运营

## 教练上架逻辑

教练资质审核和用户端展示是两个状态：

- `status=pending|approved|rejected` 表示资质审核状态。
- `listingStatus=listed|unlisted` 表示是否在用户端上架展示。

用户端只展示 `approved + listed` 的教练。新提交的教练申请默认未上架，管理员需要先通过审核，再单独点击“上架”。下架后不再接受新预约，但历史订单、评价和提现记录仍保留。

## 微信支付配置

真实微信支付需要在服务端配置以下环境变量：

```bash
WECHAT_PAY_APPID=公众号/小程序/开放平台 APPID
WECHAT_PAY_MCH_ID=微信支付商户号
WECHAT_PAY_SERIAL_NO=商户 API 证书序列号
WECHAT_PAY_API_V3_KEY=API v3 密钥
WECHAT_PAY_PRIVATE_KEY_PATH=/path/to/apiclient_key.pem
WECHAT_PAY_NOTIFY_URL=https://你的公网域名/api/payments/wechat/notify
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=/path/to/wechatpay_public_key.pem
```

也可以用 `WECHAT_PAY_PRIVATE_KEY` 和 `WECHAT_PAY_PLATFORM_PUBLIC_KEY` 直接传 PEM 内容。回调验签默认必须配置微信支付平台公钥；仅测试环境可设置 `WECHAT_PAY_SKIP_NOTIFY_VERIFY=true`。

用户在微信内置浏览器访问时会自动走 JSAPI 支付，直接拉起微信支付；在电脑或非微信浏览器访问时走 Native 扫码支付。商户平台需要同时确认当前公众号 AppID 已绑定该商户号，并开通 JSAPI 支付和 Native 支付。不要依赖用户在微信里长按识别同屏 Native 二维码，部分商户会被微信提示不支持这种方式。

在微信支付参数未配置前，用户支付弹窗会显示“已付款，提交平台确认”。订单进入“待平台确认收款”后，管理员在“订单收款与流转”里点击“确认收款”，订单会继续进入“待教练确认”。这适合先用转账、人工核销或线下收款方式启动试运营；正式收款上线后再补齐上面的微信支付环境变量。

管理员后台的“微信支付配置”面板会显示网页登录入口、推荐支付回调地址、缺失环境变量和逐步配置清单。配置时先登录 [微信支付商户平台](https://pay.weixin.qq.com/)，再把商户号、API v3 密钥、证书序列号、商户私钥、微信支付平台公钥和回调地址填到 Render Environment。

## 免费部署到 Render

仓库已包含 `render.yaml`。部署步骤：

1. 把当前目录推送到 GitHub 仓库。
2. 在 Render 创建 Blueprint，选择该仓库。
3. Render 会使用 `npm install && npm run build` 构建，并用 `npm start` 启动。

如果已经绑定 Render，更新上线流程是：

```bash
git push origin main
```

然后在 Render 后台点击 `Manual Deploy -> Deploy latest commit`。部署完成后运行：

```bash
npm run check:online
```

这个检查会确认线上健康接口、支付配置、人工收款确认接口、管理员备份接口保护，以及订单引用完整性。

当前版本使用服务端 JSON 文件存储，适合试用环境。Render 免费实例默认文件系统是临时的，重启或重新部署后可能丢失本地写入数据；管理员应在试运营阶段定期从后台导出数据备份。

如果要继续使用 JSON 文件并保留数据，需要把 Render 服务升级到支持 Persistent Disk 的付费实例，挂载例如 `/var/data`，并配置：

```bash
DATA_FILE=/var/data/store.json
```

正式商业环境建议下一步接 Supabase/PostgreSQL。
