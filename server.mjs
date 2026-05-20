import express from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 4173);
const dataFile =
  process.env.DATA_FILE || path.join(__dirname, "data", "store.json");
const adminName = process.env.ADMIN_NAME || "管理员";
const adminPhone = process.env.ADMIN_PHONE || "admin";
const oauthSessions = new Map();
const oauthStates = new Map();

const seedStore = {
  users: [
    {
      id: "admin",
      name: adminName,
      phone: adminPhone,
      avatarColor: "#111827",
      isAdmin: true,
    },
  ],
  coaches: [],
  bookings: [],
  reviews: [],
  withdrawals: [],
  settings: {
    commissionEnabled: true,
    commissionRate: 10,
  },
};

app.post(
  "/api/payments/wechat/notify",
  express.raw({ type: "application/json", limit: "1mb" }),
  async (request, response) => {
    const body = request.body.toString("utf8");
    const publicKey = getWechatPublicKey();

    if (!publicKey && process.env.WECHAT_PAY_SKIP_NOTIFY_VERIFY !== "true") {
      response.status(500).json({ code: "VERIFY_NOT_CONFIGURED" });
      return;
    }

    if (publicKey && !verifyWechatSignature(request.headers, body, publicKey)) {
      response.status(401).json({ code: "SIGNATURE_INVALID" });
      return;
    }

    try {
      const payload = JSON.parse(body);
      const transaction = decryptWechatResource(payload.resource);
      if (transaction.trade_state === "SUCCESS") {
        const store = await readStore();
        store.bookings = store.bookings.map((booking) =>
          booking.payment?.outTradeNo === transaction.out_trade_no
            ? {
                ...booking,
                status: "paid",
                payment: {
                  ...booking.payment,
                  state: "paid",
                  transactionId: transaction.transaction_id,
                  paidAt: new Date().toISOString(),
                },
              }
            : booking,
        );
        await writeStore(store);
      }
      response.json({ code: "SUCCESS", message: "成功" });
    } catch (error) {
      response.status(500).json({ code: "FAIL", message: error.message });
    }
  },
);

app.use(express.json({ limit: "1mb" }));

async function readStore() {
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch {
    await writeStore(seedStore);
    return structuredClone(seedStore);
  }
}

async function writeStore(store) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  await writeFile(dataFile, JSON.stringify(store, null, 2));
}

function validateStore(store) {
  return (
    store &&
    Array.isArray(store.users) &&
    Array.isArray(store.coaches) &&
    Array.isArray(store.bookings) &&
    Array.isArray(store.reviews) &&
    Array.isArray(store.withdrawals) &&
    store.settings
  );
}

function paymentConfigStatus() {
  const required = {
    WECHAT_PAY_APPID: process.env.WECHAT_PAY_APPID,
    WECHAT_PAY_MCH_ID: process.env.WECHAT_PAY_MCH_ID,
    WECHAT_PAY_SERIAL_NO: process.env.WECHAT_PAY_SERIAL_NO,
    WECHAT_PAY_API_V3_KEY: process.env.WECHAT_PAY_API_V3_KEY,
    WECHAT_PAY_NOTIFY_URL: process.env.WECHAT_PAY_NOTIFY_URL,
  };
  const privateKey = getMerchantPrivateKey();
  const publicKey = getWechatPublicKey();
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (!privateKey) missing.push("WECHAT_PAY_PRIVATE_KEY 或 WECHAT_PAY_PRIVATE_KEY_PATH");
  if (!publicKey && process.env.WECHAT_PAY_SKIP_NOTIFY_VERIFY !== "true") {
    missing.push("WECHAT_PAY_PLATFORM_PUBLIC_KEY 或 WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH");
  }
  return { configured: missing.length === 0, missing };
}

function authConfigStatus() {
  const required = {
    WECHAT_OAUTH_APPID: process.env.WECHAT_OAUTH_APPID,
    WECHAT_OAUTH_SECRET: process.env.WECHAT_OAUTH_SECRET,
    WECHAT_OAUTH_CALLBACK_URL: process.env.WECHAT_OAUTH_CALLBACK_URL,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const scope = process.env.WECHAT_OAUTH_SCOPE || "snsapi_userinfo";
  return {
    configured: missing.length === 0,
    missing,
    scope,
    allowDevLogin: process.env.ALLOW_DEV_LOGIN === "true",
  };
}

function parseCookies(header = "") {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [
          decodeURIComponent(part.slice(0, index)),
          decodeURIComponent(part.slice(index + 1)),
        ];
      }),
  );
}

function setSessionCookie(response, userId) {
  const sessionId = randomString(48);
  oauthSessions.set(sessionId, {
    userId,
    createdAt: Date.now(),
  });
  response.setHeader(
    "Set-Cookie",
    `coach_session=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
  );
}

function clearSessionCookie(request, response) {
  const cookies = parseCookies(request.headers.cookie);
  if (cookies.coach_session) oauthSessions.delete(cookies.coach_session);
  response.setHeader(
    "Set-Cookie",
    "coach_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0",
  );
}

function getSessionUserId(request) {
  const cookies = parseCookies(request.headers.cookie);
  const session = cookies.coach_session
    ? oauthSessions.get(cookies.coach_session)
    : undefined;
  if (!session) return "";
  if (Date.now() - session.createdAt > 30 * 24 * 60 * 60 * 1000) {
    oauthSessions.delete(cookies.coach_session);
    return "";
  }
  return session.userId;
}

function pickAvatarColor(seed) {
  const colors = ["#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c"];
  const score = Array.from(seed || "wechat").reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0,
  );
  return colors[score % colors.length];
}

async function upsertWechatUser(profile) {
  const store = await readStore();
  const openid = profile.openid;
  const existing = store.users.find((user) => user.wechatOpenid === openid);
  const hasWechatAdmin = store.users.some(
    (user) => user.wechatOpenid && user.isAdmin,
  );
  const shouldBootstrapAdmin =
    process.env.BOOTSTRAP_FIRST_WECHAT_ADMIN === "true" && !hasWechatAdmin;
  const isAdmin = Boolean(
    (process.env.ADMIN_OPENID && process.env.ADMIN_OPENID === openid) ||
      shouldBootstrapAdmin,
  );
  const name = profile.nickname || existing?.name || `微信用户${openid.slice(-4)}`;
  const patch = {
    name,
    phone: existing?.phone || "",
    avatarColor: existing?.avatarColor || pickAvatarColor(openid),
    wechatOpenid: openid,
    unionid: profile.unionid,
    nickname: profile.nickname || name,
    avatarUrl: profile.headimgurl || existing?.avatarUrl || "",
    authProvider: "wechat",
    isAdmin: existing?.isAdmin || isAdmin,
  };

  let user;
  if (existing) {
    user = { ...existing, ...patch };
    store.users = store.users.map((item) => (item.id === existing.id ? user : item));
  } else {
    user = {
      id: `u_${openid.slice(-8)}_${randomString(5)}`,
      ...patch,
    };
    store.users = [user, ...store.users];
  }

  await writeStore(store);
  return user;
}

async function exchangeWechatCode(code) {
  const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
  tokenUrl.searchParams.set("appid", process.env.WECHAT_OAUTH_APPID);
  tokenUrl.searchParams.set("secret", process.env.WECHAT_OAUTH_SECRET);
  tokenUrl.searchParams.set("code", code);
  tokenUrl.searchParams.set("grant_type", "authorization_code");

  const tokenResponse = await fetch(tokenUrl);
  const token = await tokenResponse.json();
  if (!tokenResponse.ok || token.errcode) {
    throw new Error(token.errmsg || "微信授权 code 换取 access_token 失败");
  }

  if ((process.env.WECHAT_OAUTH_SCOPE || "snsapi_userinfo") === "snsapi_base") {
    return { openid: token.openid, unionid: token.unionid };
  }

  const userInfoUrl = new URL("https://api.weixin.qq.com/sns/userinfo");
  userInfoUrl.searchParams.set("access_token", token.access_token);
  userInfoUrl.searchParams.set("openid", token.openid);
  userInfoUrl.searchParams.set("lang", "zh_CN");

  const userInfoResponse = await fetch(userInfoUrl);
  const userInfo = await userInfoResponse.json();
  if (!userInfoResponse.ok || userInfo.errcode) {
    throw new Error(userInfo.errmsg || "微信用户信息获取失败");
  }

  return userInfo;
}

function getMerchantPrivateKey() {
  if (process.env.WECHAT_PAY_PRIVATE_KEY) {
    return process.env.WECHAT_PAY_PRIVATE_KEY.replace(/\\n/g, "\n");
  }
  if (process.env.WECHAT_PAY_PRIVATE_KEY_PATH) {
    return readFileSync(process.env.WECHAT_PAY_PRIVATE_KEY_PATH, "utf8");
  }
  return "";
}

function getWechatPublicKey() {
  if (process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY) {
    return process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY.replace(/\\n/g, "\n");
  }
  if (process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH) {
    return readFileSync(process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH, "utf8");
  }
  return "";
}

function randomString(size = 32) {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function makeOutTradeNo() {
  return `CM${Date.now()}${randomString(8)}`.slice(0, 32);
}

function signWechatRequest(method, requestPath, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomString();
  const message = `${method}\n${requestPath}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto
    .createSign("RSA-SHA256")
    .update(message)
    .sign(getMerchantPrivateKey(), "base64");
  return `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WECHAT_PAY_MCH_ID}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${process.env.WECHAT_PAY_SERIAL_NO}"`;
}

function verifyWechatSignature(headers, body, publicKey) {
  const timestamp = headers["wechatpay-timestamp"];
  const nonce = headers["wechatpay-nonce"];
  const signature = headers["wechatpay-signature"];
  if (!timestamp || !nonce || !signature) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;

  const message = `${timestamp}\n${nonce}\n${body}\n`;
  return crypto
    .createVerify("RSA-SHA256")
    .update(message)
    .verify(publicKey, signature, "base64");
}

function decryptWechatResource(resource) {
  if (!resource || resource.algorithm !== "AEAD_AES_256_GCM") {
    throw new Error("Unsupported WeChat Pay resource");
  }

  const ciphertext = Buffer.from(resource.ciphertext, "base64");
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(0, ciphertext.length - 16);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    process.env.WECHAT_PAY_API_V3_KEY,
    resource.nonce,
  );
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(resource.associated_data || "", "utf8"));
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8"));
}

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.get(/^\/(MP_verify_[A-Za-z0-9_-]+\.txt)$/, (request, response, next) => {
  const filename = request.params[0];
  if (
    process.env.WECHAT_VERIFY_FILENAME === filename &&
    process.env.WECHAT_VERIFY_CONTENT
  ) {
    response.type("text/plain").send(process.env.WECHAT_VERIFY_CONTENT);
    return;
  }
  next();
});

app.get("/api/store", async (_request, response) => {
  response.json(await readStore());
});

app.get("/api/auth/config", (_request, response) => {
  response.json(authConfigStatus());
});

app.get("/api/auth/me", async (request, response) => {
  const userId = getSessionUserId(request);
  if (!userId) {
    response.json({ user: null });
    return;
  }
  const store = await readStore();
  response.json({ user: store.users.find((user) => user.id === userId) ?? null });
});

app.post("/api/auth/logout", (request, response) => {
  clearSessionCookie(request, response);
  response.json({ ok: true });
});

app.get("/api/auth/wechat/start", (request, response) => {
  const config = authConfigStatus();
  if (!config.configured) {
    response.status(503).json({
      error: "WECHAT_OAUTH_NOT_CONFIGURED",
      missing: config.missing,
    });
    return;
  }

  const state = randomString(24);
  oauthStates.set(state, {
    redirect: typeof request.query.redirect === "string" ? request.query.redirect : "/",
    createdAt: Date.now(),
  });

  const authorizeUrl = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
  authorizeUrl.searchParams.set("appid", process.env.WECHAT_OAUTH_APPID);
  authorizeUrl.searchParams.set(
    "redirect_uri",
    process.env.WECHAT_OAUTH_CALLBACK_URL,
  );
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", config.scope);
  authorizeUrl.searchParams.set("state", state);
  response.redirect(`${authorizeUrl.toString()}#wechat_redirect`);
});

app.get("/api/auth/wechat/callback", async (request, response) => {
  const { code, state } = request.query;
  const stateRecord = typeof state === "string" ? oauthStates.get(state) : undefined;
  oauthStates.delete(state);

  if (!stateRecord || Date.now() - stateRecord.createdAt > 10 * 60 * 1000) {
    response.status(400).send("微信授权 state 已过期，请重新登录。");
    return;
  }
  if (typeof code !== "string" || !code) {
    response.status(400).send("微信授权回调缺少 code。");
    return;
  }

  try {
    const profile = await exchangeWechatCode(code);
    const user = await upsertWechatUser(profile);
    setSessionCookie(response, user.id);
    response.redirect(stateRecord.redirect || "/");
  } catch (error) {
    response.status(502).send(`微信授权失败：${error.message}`);
  }
});

app.post("/api/auth/dev-login", async (request, response) => {
  if (process.env.ALLOW_DEV_LOGIN !== "true") {
    response.status(403).json({ error: "DEV_LOGIN_DISABLED" });
    return;
  }

  const openid = String(request.body.openid || "").trim();
  const nickname = String(request.body.nickname || "").trim() || `测试用户${openid.slice(-4)}`;
  if (!openid) {
    response.status(400).json({ error: "OPENID_REQUIRED" });
    return;
  }

  const store = await readStore();
  const existing = store.users.find(
    (user) => user.wechatOpenid === openid || user.phone === openid,
  );
  let user = existing;
  if (existing) {
    user = {
      ...existing,
      name: existing.name || nickname,
      nickname: existing.nickname || nickname,
      wechatOpenid: existing.wechatOpenid || openid,
      authProvider: existing.authProvider || "dev",
    };
    store.users = store.users.map((item) => (item.id === existing.id ? user : item));
  } else {
    user = {
      id: `u_${randomString(9)}`,
      name: nickname,
      phone: openid,
      avatarColor: pickAvatarColor(openid),
      wechatOpenid: openid,
      nickname,
      avatarUrl: "",
      authProvider: "dev",
      isAdmin: openid === adminPhone,
    };
    store.users = [...store.users, user];
  }

  await writeStore(store);
  setSessionCookie(response, user.id);
  response.json({ user });
});

app.get("/api/payment-config", (_request, response) => {
  response.json({
    ...paymentConfigStatus(),
    allowMock: process.env.ALLOW_MOCK_PAYMENT === "true",
  });
});

app.post("/api/payments/wechat/native", async (request, response) => {
  const config = paymentConfigStatus();
  if (!config.configured) {
    response.status(503).json({
      error: "WECHAT_PAY_NOT_CONFIGURED",
      missing: config.missing,
    });
    return;
  }

  const store = await readStore();
  const booking = store.bookings.find((item) => item.id === request.body.bookingId);
  const coach = store.coaches.find((item) => item.id === booking?.coachId);

  if (!booking || !coach) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }

  if (booking.status !== "reserved") {
    response.status(409).json({ error: "BOOKING_NOT_PAYABLE" });
    return;
  }

  try {
    const outTradeNo = booking.payment?.outTradeNo || makeOutTradeNo();
    const requestPath = "/v3/pay/transactions/native";
    const body = JSON.stringify({
      appid: process.env.WECHAT_PAY_APPID,
      mchid: process.env.WECHAT_PAY_MCH_ID,
      description: `教练预约-${coach.name}`.slice(0, 127),
      out_trade_no: outTradeNo,
      notify_url: process.env.WECHAT_PAY_NOTIFY_URL,
      amount: {
        total: Math.max(1, Math.round(booking.amount * 100)),
        currency: "CNY",
      },
    });

    const wxResponse = await fetch(`https://api.mch.weixin.qq.com${requestPath}`, {
      method: "POST",
      headers: {
        Authorization: signWechatRequest("POST", requestPath, body),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body,
    });
    const responseBody = await wxResponse.json();

    if (!wxResponse.ok) {
      response.status(wxResponse.status).json({
        error: "WECHAT_PAY_CREATE_FAILED",
        detail: responseBody,
      });
      return;
    }

    const qrDataUrl = await QRCode.toDataURL(responseBody.code_url, {
      margin: 1,
      width: 220,
    });

    store.bookings = store.bookings.map((item) =>
      item.id === booking.id
        ? {
            ...item,
            payment: {
              provider: "wechat_native",
              state: "pending",
              outTradeNo,
              codeUrl: responseBody.code_url,
              createdAt: new Date().toISOString(),
            },
          }
        : item,
    );
    await writeStore(store);

    response.json({
      codeUrl: responseBody.code_url,
      qrDataUrl,
      outTradeNo,
    });
  } catch (error) {
    response.status(500).json({ error: "WECHAT_PAY_ERROR", message: error.message });
  }
});

app.post("/api/payments/mock-success", async (request, response) => {
  if (process.env.ALLOW_MOCK_PAYMENT !== "true") {
    response.status(403).json({ error: "MOCK_PAYMENT_DISABLED" });
    return;
  }
  const store = await readStore();
  store.bookings = store.bookings.map((booking) =>
    booking.id === request.body.bookingId ? { ...booking, status: "paid" } : booking,
  );
  await writeStore(store);
  response.json({ ok: true });
});

app.put("/api/store", async (request, response) => {
  if (!validateStore(request.body)) {
    response.status(400).json({ error: "Invalid store payload" });
    return;
  }
  await writeStore(request.body);
  response.json({ ok: true });
});

app.post("/api/reset", async (_request, response) => {
  if (process.env.ALLOW_RESET !== "true") {
    response.status(403).json({ error: "Reset is disabled" });
    return;
  }
  await writeStore(seedStore);
  response.json({ ok: true });
});

app.use(express.static(path.join(__dirname, "dist")));

app.get(/.*/, (_request, response) => {
  response.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(port, () => {
  console.log(`Coach marketplace listening on http://127.0.0.1:${port}`);
});
