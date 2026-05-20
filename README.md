# 教练预约商城 H5

一个可公网部署的教练预约 MVP，包含用户、教练、管理员三个角色。默认不预置教练、订单、评价数据，只保留一个管理员启动账号。

## 本地运行

```bash
npm install
npm run build
npm start
```

打开 `http://127.0.0.1:4173/`。

## 认证方式

真实环境使用微信公众号网页授权登录。服务端会引导用户进入微信授权页，回调后用 `code` 换取 `openid`，再创建或更新平台用户。

需要在服务端配置：

```bash
WECHAT_OAUTH_APPID=认证服务号 AppID
WECHAT_OAUTH_SECRET=认证服务号 AppSecret
WECHAT_OAUTH_CALLBACK_URL=https://你的公网域名/api/auth/wechat/callback
WECHAT_OAUTH_SCOPE=snsapi_userinfo
ADMIN_OPENID=你的管理员微信 openid
BOOTSTRAP_FIRST_WECHAT_ADMIN=true
```

在微信公众平台后台还需要把公网域名配置到“网页授权域名”。如果只想静默确认身份，可把 `WECHAT_OAUTH_SCOPE` 改为 `snsapi_base`，这样只能拿到 `openid`；如果要拿昵称头像，用默认的 `snsapi_userinfo`。

如果微信后台要求上传 `MP_verify_xxx.txt` 验证文件，可配置：

```bash
WECHAT_VERIFY_FILENAME=MP_verify_xxx.txt
WECHAT_VERIFY_CONTENT=文件里的那一串验证内容
```

第一次上线时可以临时设置 `BOOTSTRAP_FIRST_WECHAT_ADMIN=true`，让第一个微信授权用户自动成为管理员；确认 `ADMIN_OPENID` 后可关闭这个开关。本地自动化测试可设置 `ALLOW_DEV_LOGIN=true` 打开开发登录入口；真实部署不要开启。

## 启动管理员

默认只保留一个本地管理员启动账号，手机号/openid 为 `admin`。真实微信授权后，推荐用 `ADMIN_OPENID` 绑定你的微信为管理员。

## 已实现流程

- 用户查看教练、预约时间、模拟微信扫码支付、完成后评价
- 教练维护介绍、价格、周三/周四下午可约时间、申请提现
- 管理员审核教练、维护教练、查看用户、设置抽佣、审核提现
- 服务端共享数据存储，部署后同一环境内多个角色访问同一套数据
- 微信公众号网页授权登录已接入服务端流程
- 微信支付 Native 扫码支付接口已接入；未配置商户参数时会阻止支付并提示缺失项

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

## 免费部署到 Render

仓库已包含 `render.yaml`。部署步骤：

1. 把当前目录推送到 GitHub 仓库。
2. 在 Render 创建 Blueprint，选择该仓库。
3. Render 会使用 `npm install && npm run build` 构建，并用 `npm start` 启动。

当前版本使用服务端 JSON 文件存储，适合试用环境。Render 免费实例重启或重新部署后数据可能回到种子数据；正式商业环境建议下一步接 Supabase/PostgreSQL。
