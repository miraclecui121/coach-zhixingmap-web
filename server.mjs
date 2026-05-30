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
const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
const oauthStateMaxAgeMs = 10 * 60 * 1000;
const reviewMaxLength = 200;

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
          booking.payment?.outTradeNo === transaction.out_trade_no &&
          (booking.status === "reserved" || booking.status === "payment_pending")
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

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function byId(items = []) {
  return new Map(items.map((item) => [item.id, item]));
}

function changedIds(before = [], after = []) {
  const beforeMap = byId(before);
  const afterMap = byId(after);
  const added = after.filter((item) => !beforeMap.has(item.id));
  const removed = before.filter((item) => !afterMap.has(item.id));
  const updated = after.filter((item) => {
    const oldItem = beforeMap.get(item.id);
    return oldItem && !sameJson(oldItem, item);
  });
  return { added, removed, updated };
}

function sameCollectionExcept(before = [], after = [], ids = []) {
  const allowed = new Set(ids);
  const beforeMap = byId(before);
  const afterMap = byId(after);
  if (beforeMap.size !== afterMap.size) return false;
  for (const [id, beforeItem] of beforeMap) {
    if (!afterMap.has(id)) return false;
    if (!allowed.has(id) && !sameJson(beforeItem, afterMap.get(id))) return false;
  }
  return true;
}

function getCoachForUser(store, userId) {
  return store.coaches.find((coach) => coach.userId === userId);
}

function getCoachListingStatus(coach = {}) {
  return coach.listingStatus ?? (coach.status === "approved" ? "listed" : "unlisted");
}

function isSlotOccupiedStatus(status) {
  return status !== "declined" && status !== "cancelled";
}

function getCompletedIncome(store, coachId) {
  return store.bookings
    .filter(
      (booking) =>
        booking.coachId === coachId &&
        booking.status === "reviewed",
    )
    .reduce((sum, booking) => sum + Number(booking.coachIncome || 0), 0);
}

function getPaidOut(store, coachId) {
  return store.withdrawals
    .filter(
      (withdrawal) =>
        (withdrawal.target ?? "coach") === "coach" &&
        withdrawal.coachId === coachId &&
        withdrawal.status !== "rejected",
    )
    .reduce((sum, withdrawal) => sum + Number(withdrawal.amount || 0), 0);
}

function isAllowedCoachApplication(currentStore, nextStore, user) {
  const coachDiff = changedIds(currentStore.coaches, nextStore.coaches);
  const userDiff = changedIds(currentStore.users, nextStore.users);
  if (
    coachDiff.added.length !== 1 ||
    coachDiff.updated.length !== 0 ||
    coachDiff.removed.length !== 0 ||
    userDiff.added.length !== 0 ||
    userDiff.removed.length !== 0 ||
    userDiff.updated.length > 1
  ) {
    return false;
  }

  const newCoach = coachDiff.added[0];
  if (
    !newCoach ||
    newCoach.userId !== user.id ||
    newCoach.status !== "pending" ||
    getCoachListingStatus(newCoach) !== "unlisted" ||
    currentStore.coaches.some((coach) => coach.userId === user.id)
  ) {
    return false;
  }

  if (!sameCollectionExcept(currentStore.users, nextStore.users, [user.id])) {
    return false;
  }
  const previousUser = currentStore.users.find((item) => item.id === user.id);
  const nextUser = nextStore.users.find((item) => item.id === user.id);
  if (!previousUser || !nextUser) return false;
  return sameJson({ ...previousUser, coachId: newCoach.id }, nextUser);
}

function isAllowedOwnCoachUpdate(currentStore, nextStore, user) {
  const currentCoach = getCoachForUser(currentStore, user.id);
  if (!currentCoach) return false;
  const nextCoach = nextStore.coaches.find((coach) => coach.id === currentCoach.id);
  if (!nextCoach) return false;
  if (
    nextCoach.id !== currentCoach.id ||
    nextCoach.userId !== currentCoach.userId ||
    nextCoach.status !== currentCoach.status ||
    nextCoach.listingStatus !== currentCoach.listingStatus
  ) {
    return false;
  }
  return sameCollectionExcept(currentStore.coaches, nextStore.coaches, [currentCoach.id]);
}

function isAllowedCoachResubmit(currentStore, nextStore, user) {
  const currentCoach = getCoachForUser(currentStore, user.id);
  if (!currentCoach || currentCoach.status !== "rejected") return false;
  const nextCoach = nextStore.coaches.find((coach) => coach.id === currentCoach.id);
  if (!nextCoach) return false;
  if (
    nextCoach.id !== currentCoach.id ||
    nextCoach.userId !== currentCoach.userId ||
    nextCoach.status !== "pending" ||
    getCoachListingStatus(nextCoach) !== "unlisted"
  ) {
    return false;
  }
  return sameCollectionExcept(currentStore.coaches, nextStore.coaches, [currentCoach.id]);
}

function isAllowedBookingCreate(currentStore, nextStore, user) {
  const bookingDiff = changedIds(currentStore.bookings, nextStore.bookings);
  if (
    bookingDiff.added.length !== 1 ||
    bookingDiff.updated.length !== 0 ||
    bookingDiff.removed.length !== 0
  ) {
    return false;
  }
  const booking = bookingDiff.added[0];
  const coach = currentStore.coaches.find((item) => item.id === booking.coachId);
  const slot = coach?.slots.find((item) => item.id === booking.slotId);
  const platformFee = currentStore.settings.commissionEnabled
    ? booking.amount * (currentStore.settings.commissionRate / 100)
    : 0;
  const occupied = currentStore.bookings.some(
    (item) =>
      item.coachId === booking.coachId &&
      item.slotId === booking.slotId &&
      isSlotOccupiedStatus(item.status),
  );
  return Boolean(
    coach &&
      slot?.enabled &&
      !occupied &&
      coach.status === "approved" &&
      getCoachListingStatus(coach) === "listed" &&
      coach.userId !== user.id &&
      booking.userId === user.id &&
      booking.status === "reserved" &&
      booking.amount === coach.price &&
      Math.abs(booking.platformFee - platformFee) < 0.001 &&
      Math.abs(booking.coachIncome - (booking.amount - platformFee)) < 0.001,
  );
}

function isAllowedBookingNote(currentStore, nextStore, user) {
  const bookingDiff = changedIds(currentStore.bookings, nextStore.bookings);
  if (
    bookingDiff.added.length !== 0 ||
    bookingDiff.updated.length !== 1 ||
    bookingDiff.removed.length !== 0
  ) {
    return false;
  }
  const nextBooking = bookingDiff.updated[0];
  const currentBooking = currentStore.bookings.find((item) => item.id === nextBooking.id);
  if (
    !currentBooking ||
    currentBooking.userId !== user.id ||
    !["paid", "accepted"].includes(currentBooking.status) ||
    nextBooking.status !== currentBooking.status
  ) {
    return false;
  }
  return sameJson({ ...currentBooking, note: nextBooking.note }, nextBooking);
}

function isAllowedReviewCreate(currentStore, nextStore, user) {
  const reviewDiff = changedIds(currentStore.reviews, nextStore.reviews);
  const bookingDiff = changedIds(currentStore.bookings, nextStore.bookings);
  if (
    reviewDiff.added.length !== 1 ||
    reviewDiff.updated.length !== 0 ||
    reviewDiff.removed.length !== 0 ||
    bookingDiff.added.length !== 0 ||
    bookingDiff.updated.length !== 1 ||
    bookingDiff.removed.length !== 0
  ) {
    return false;
  }
  const review = reviewDiff.added[0];
  const nextBooking = bookingDiff.updated[0];
  const currentBooking = currentStore.bookings.find((item) => item.id === nextBooking.id);
  return Boolean(
    currentBooking &&
      currentBooking.userId === user.id &&
      currentBooking.status === "completed" &&
      nextBooking.status === "reviewed" &&
      sameJson({ ...currentBooking, status: "reviewed" }, nextBooking) &&
      review.bookingId === currentBooking.id &&
      review.userId === user.id &&
      review.coachId === currentBooking.coachId &&
      Number(review.rating) >= 1 &&
      Number(review.rating) <= 5 &&
      String(review.content || "").trim() &&
      String(review.content || "").trim().length <= reviewMaxLength,
  );
}

function isAllowedCoachBookingStatus(currentStore, nextStore, user) {
  const currentCoach = getCoachForUser(currentStore, user.id);
  if (!currentCoach) return false;
  const bookingDiff = changedIds(currentStore.bookings, nextStore.bookings);
  if (
    bookingDiff.added.length !== 0 ||
    bookingDiff.updated.length !== 1 ||
    bookingDiff.removed.length !== 0
  ) {
    return false;
  }
  const nextBooking = bookingDiff.updated[0];
  const currentBooking = currentStore.bookings.find((item) => item.id === nextBooking.id);
  if (!currentBooking || currentBooking.coachId !== currentCoach.id) return false;
  const allowed =
    (currentBooking.status === "paid" &&
      (nextBooking.status === "accepted" || nextBooking.status === "declined")) ||
    (currentBooking.status === "accepted" && nextBooking.status === "completed");
  return allowed && sameJson({ ...currentBooking, status: nextBooking.status }, nextBooking);
}

function isAllowedCoachWithdrawal(currentStore, nextStore, user) {
  const currentCoach = getCoachForUser(currentStore, user.id);
  if (!currentCoach) return false;
  const withdrawalDiff = changedIds(currentStore.withdrawals, nextStore.withdrawals);
  if (
    withdrawalDiff.added.length !== 1 ||
    withdrawalDiff.updated.length !== 0 ||
    withdrawalDiff.removed.length !== 0
  ) {
    return false;
  }
  const withdrawal = withdrawalDiff.added[0];
  const withdrawable = Math.max(
    0,
    getCompletedIncome(currentStore, currentCoach.id) - getPaidOut(currentStore, currentCoach.id),
  );
  return Boolean(
    withdrawal.target === "coach" &&
      withdrawal.coachId === currentCoach.id &&
      withdrawal.status === "pending" &&
      withdrawal.amount > 0 &&
      withdrawal.amount <= withdrawable,
  );
}

function isAuthorizedStoreUpdate(currentStore, nextStore, user) {
  if (!user) return false;
  if (user.isAdmin) return true;
  if (!sameJson(currentStore.settings, nextStore.settings)) return false;
  if (!sameJson(currentStore.users, nextStore.users) && !isAllowedCoachApplication(currentStore, nextStore, user)) {
    return false;
  }
  if (!sameJson(currentStore.coaches, nextStore.coaches)) {
    if (
      !isAllowedCoachApplication(currentStore, nextStore, user) &&
      !isAllowedOwnCoachUpdate(currentStore, nextStore, user) &&
      !isAllowedCoachResubmit(currentStore, nextStore, user)
    ) {
      return false;
    }
  }
  if (!sameJson(currentStore.bookings, nextStore.bookings)) {
    if (
      !isAllowedBookingCreate(currentStore, nextStore, user) &&
      !isAllowedBookingNote(currentStore, nextStore, user) &&
      !isAllowedReviewCreate(currentStore, nextStore, user) &&
      !isAllowedCoachBookingStatus(currentStore, nextStore, user)
    ) {
      return false;
    }
  }
  if (!sameJson(currentStore.reviews, nextStore.reviews) && !isAllowedReviewCreate(currentStore, nextStore, user)) {
    return false;
  }
  if (
    !sameJson(currentStore.withdrawals, nextStore.withdrawals) &&
    !isAllowedCoachWithdrawal(currentStore, nextStore, user)
  ) {
    return false;
  }
  return true;
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

function getPublicOrigin(request) {
  const proto = String(request.headers["x-forwarded-proto"] || request.protocol || "http")
    .split(",")[0]
    .trim();
  const host = String(request.headers["x-forwarded-host"] || request.headers.host || "")
    .split(",")[0]
    .trim();
  return host ? `${proto}://${host}` : "";
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

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getSigningSecret() {
  return (
    process.env.SESSION_SECRET ||
    process.env.WECHAT_OAUTH_SECRET ||
    process.env.WECHAT_PAY_API_V3_KEY ||
    "coach-marketplace-local-dev-secret"
  );
}

function signValue(value, bytes = 18) {
  return crypto
    .createHmac("sha256", getSigningSecret())
    .update(value)
    .digest("base64url")
    .slice(0, bytes);
}

function timingSafeEqualText(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function appendSetCookie(response, cookie) {
  const current = response.getHeader("Set-Cookie");
  if (!current) {
    response.setHeader("Set-Cookie", cookie);
    return;
  }
  response.setHeader(
    "Set-Cookie",
    Array.isArray(current) ? [...current, cookie] : [current, cookie],
  );
}

function secureCookieSuffix() {
  return process.env.NODE_ENV === "production" ? "; Secure" : "";
}

function sanitizeRedirect(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  return value;
}

function createSignedSession(userId) {
  const encodedUserId = base64UrlEncode(userId);
  const issuedAt = Date.now().toString(36);
  const payload = `${encodedUserId}.${issuedAt}`;
  return `${payload}.${signValue(payload)}`;
}

function readSignedSession(value) {
  if (!value) return "";
  const [encodedUserId, issuedAt, signature] = value.split(".");
  if (!encodedUserId || !issuedAt || !signature) return "";
  const payload = `${encodedUserId}.${issuedAt}`;
  if (!timingSafeEqualText(signValue(payload), signature)) return "";
  const issuedAtMs = Number.parseInt(issuedAt, 36);
  if (!Number.isFinite(issuedAtMs)) return "";
  if (Date.now() - issuedAtMs > sessionMaxAgeSeconds * 1000) return "";
  try {
    return base64UrlDecode(encodedUserId);
  } catch {
    return "";
  }
}

function createOAuthState() {
  const nonce = randomString(16);
  const issuedAt = Date.now().toString(36);
  const payload = `${nonce}.${issuedAt}`;
  return `${payload}.${signValue(payload)}`;
}

function isValidOAuthState(value) {
  if (typeof value !== "string") return false;
  const [nonce, issuedAt, signature] = value.split(".");
  if (!nonce || !issuedAt || !signature) return false;
  const payload = `${nonce}.${issuedAt}`;
  if (!timingSafeEqualText(signValue(payload), signature)) return false;
  const issuedAtMs = Number.parseInt(issuedAt, 36);
  return Number.isFinite(issuedAtMs) && Date.now() - issuedAtMs <= oauthStateMaxAgeMs;
}

function createSignedRedirectCookie(redirect) {
  const safeRedirect = sanitizeRedirect(redirect);
  const encodedRedirect = base64UrlEncode(safeRedirect);
  const payload = encodedRedirect;
  return `${payload}.${signValue(payload)}`;
}

function readSignedRedirectCookie(value) {
  if (!value) return "/";
  const [encodedRedirect, signature] = value.split(".");
  if (!encodedRedirect || !signature) return "/";
  if (!timingSafeEqualText(signValue(encodedRedirect), signature)) return "/";
  try {
    return sanitizeRedirect(base64UrlDecode(encodedRedirect));
  } catch {
    return "/";
  }
}

function setSessionCookie(response, userId) {
  appendSetCookie(
    response,
    `coach_session=${encodeURIComponent(createSignedSession(userId))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionMaxAgeSeconds}${secureCookieSuffix()}`,
  );
}

function clearSessionCookie(request, response) {
  appendSetCookie(
    response,
    `coach_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}`,
  );
}

function getSessionUserId(request) {
  const cookies = parseCookies(request.headers.cookie);
  return readSignedSession(cookies.coach_session);
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

async function fetchWechatTransaction(outTradeNo) {
  const requestPath = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(
    outTradeNo,
  )}?mchid=${encodeURIComponent(process.env.WECHAT_PAY_MCH_ID)}`;
  const wxResponse = await fetch(`https://api.mch.weixin.qq.com${requestPath}`, {
    method: "GET",
    headers: {
      Authorization: signWechatRequest("GET", requestPath, ""),
      Accept: "application/json",
    },
  });
  const body = await wxResponse.json();
  if (!wxResponse.ok) {
    const error = new Error(body.message || body.code || "微信支付订单查询失败");
    error.status = wxResponse.status;
    error.detail = body;
    throw error;
  }
  return body;
}

function signWechatJsapiPay(appId, timeStamp, nonceStr, packageValue) {
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return crypto
    .createSign("RSA-SHA256")
    .update(message)
    .sign(getMerchantPrivateKey(), "base64");
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

app.get("/api/admin/export", async (request, response) => {
  const userId = getSessionUserId(request);
  const store = await readStore();
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  if (!user.isAdmin) {
    response.status(403).json({ error: "ADMIN_REQUIRED" });
    return;
  }

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="coach-marketplace-backup-${stamp}.json"`,
  );
  response.send(JSON.stringify(store, null, 2));
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

  const state = createOAuthState();
  appendSetCookie(
    response,
    `coach_oauth_redirect=${encodeURIComponent(
      createSignedRedirectCookie(request.query.redirect),
    )}; Path=/api/auth/wechat; HttpOnly; SameSite=Lax; Max-Age=600${secureCookieSuffix()}`,
  );

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
  const cookies = parseCookies(request.headers.cookie);
  const redirect = readSignedRedirectCookie(cookies.coach_oauth_redirect);
  appendSetCookie(
    response,
    `coach_oauth_redirect=; Path=/api/auth/wechat; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieSuffix()}`,
  );

  if (!isValidOAuthState(state)) {
    response
      .status(400)
      .send(
        '微信授权状态已失效，请返回首页重新登录。<p><a href="/">返回首页</a></p>',
      );
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
    response.redirect(redirect);
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

app.get("/api/payment-config", (request, response) => {
  const publicOrigin = getPublicOrigin(request);
  response.json({
    ...paymentConfigStatus(),
    allowMock: process.env.ALLOW_MOCK_PAYMENT === "true",
    suggestedNotifyUrl: publicOrigin
      ? `${publicOrigin}/api/payments/wechat/notify`
      : "/api/payments/wechat/notify",
    merchantPortalUrl: "https://pay.weixin.qq.com/",
    requiredEnv: [
      "WECHAT_PAY_APPID",
      "WECHAT_PAY_MCH_ID",
      "WECHAT_PAY_SERIAL_NO",
      "WECHAT_PAY_API_V3_KEY",
      "WECHAT_PAY_PRIVATE_KEY",
      "WECHAT_PAY_NOTIFY_URL",
      "WECHAT_PAY_PLATFORM_PUBLIC_KEY",
    ],
  });
});

app.post("/api/bookings", async (request, response) => {
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }

  const coach = store.coaches.find((item) => item.id === request.body.coachId);
  const slot = coach?.slots.find((item) => item.id === request.body.slotId);
  if (!coach || !slot) {
    response.status(404).json({ error: "SLOT_NOT_FOUND" });
    return;
  }
  if (
    coach.status !== "approved" ||
    getCoachListingStatus(coach) !== "listed" ||
    !slot.enabled ||
    coach.userId === user.id
  ) {
    response.status(409).json({ error: "SLOT_NOT_BOOKABLE" });
    return;
  }

  const occupied = store.bookings.some(
    (booking) =>
      booking.coachId === coach.id &&
      booking.slotId === slot.id &&
      isSlotOccupiedStatus(booking.status),
  );
  if (occupied) {
    response.status(409).json({ error: "SLOT_ALREADY_BOOKED" });
    return;
  }

  const amount = Number(coach.price);
  const platformFee = store.settings.commissionEnabled
    ? amount * (Number(store.settings.commissionRate) / 100)
    : 0;
  const booking = {
    id: `b_${randomString(9)}`,
    userId: user.id,
    coachId: coach.id,
    slotId: slot.id,
    amount,
    platformFee,
    coachIncome: amount - platformFee,
    status: "reserved",
    createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
  };

  store.bookings = [booking, ...store.bookings];
  await writeStore(store);
  response.json({ bookingId: booking.id, booking, store });
});

app.post("/api/payments/wechat/native", async (request, response) => {
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  const config = paymentConfigStatus();
  if (!config.configured) {
    response.status(503).json({
      error: "WECHAT_PAY_NOT_CONFIGURED",
      missing: config.missing,
    });
    return;
  }
  const booking = store.bookings.find((item) => item.id === request.body.bookingId);
  const coach = store.coaches.find((item) => item.id === booking?.coachId);

  if (!booking || !coach) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }

  if (booking.userId !== user.id) {
    response.status(403).json({ error: "BOOKING_FORBIDDEN" });
    return;
  }

  if (booking.status !== "reserved") {
    response.status(409).json({ error: "BOOKING_NOT_PAYABLE" });
    return;
  }

  try {
    if (
      booking.payment?.provider === "wechat_native" &&
      booking.payment.state === "pending" &&
      booking.payment.codeUrl
    ) {
      const qrDataUrl = await QRCode.toDataURL(booking.payment.codeUrl, {
        margin: 1,
        width: 220,
      });
      response.json({
        codeUrl: booking.payment.codeUrl,
        qrDataUrl,
        outTradeNo: booking.payment.outTradeNo,
        reused: true,
      });
      return;
    }

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

app.post("/api/payments/wechat/jsapi", async (request, response) => {
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  const config = paymentConfigStatus();
  if (!config.configured) {
    response.status(503).json({
      error: "WECHAT_PAY_NOT_CONFIGURED",
      missing: config.missing,
    });
    return;
  }
  if (!user.wechatOpenid) {
    response.status(409).json({ error: "WECHAT_OPENID_REQUIRED" });
    return;
  }

  const booking = store.bookings.find((item) => item.id === request.body.bookingId);
  const coach = store.coaches.find((item) => item.id === booking?.coachId);
  if (!booking || !coach) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }
  if (booking.userId !== user.id) {
    response.status(403).json({ error: "BOOKING_FORBIDDEN" });
    return;
  }
  if (booking.status !== "reserved") {
    response.status(409).json({ error: "BOOKING_NOT_PAYABLE" });
    return;
  }

  try {
    let prepayId = booking.payment?.provider === "wechat_jsapi" ? booking.payment.prepayId : "";
    let outTradeNo = booking.payment?.provider === "wechat_jsapi" ? booking.payment.outTradeNo : "";

    if (!prepayId) {
      outTradeNo = makeOutTradeNo();
      const requestPath = "/v3/pay/transactions/jsapi";
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
        payer: {
          openid: user.wechatOpenid,
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
      prepayId = responseBody.prepay_id;
      store.bookings = store.bookings.map((item) =>
        item.id === booking.id
          ? {
              ...item,
              payment: {
                provider: "wechat_jsapi",
                state: "pending",
                outTradeNo,
                prepayId,
                createdAt: new Date().toISOString(),
              },
            }
          : item,
      );
      await writeStore(store);
    }

    const appId = process.env.WECHAT_PAY_APPID;
    const timeStamp = Math.floor(Date.now() / 1000).toString();
    const nonceStr = randomString();
    const packageValue = `prepay_id=${prepayId}`;
    response.json({
      payParams: {
        appId,
        timeStamp,
        nonceStr,
        package: packageValue,
        signType: "RSA",
        paySign: signWechatJsapiPay(appId, timeStamp, nonceStr, packageValue),
      },
      outTradeNo,
      prepayId,
    });
  } catch (error) {
    response.status(500).json({ error: "WECHAT_PAY_ERROR", message: error.message });
  }
});

app.post("/api/payments/wechat/sync", async (request, response) => {
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  const booking = store.bookings.find((item) => item.id === request.body.bookingId);
  if (!booking) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }
  if (booking.userId !== user.id && !user.isAdmin) {
    response.status(403).json({ error: "BOOKING_FORBIDDEN" });
    return;
  }
  if (!booking.payment?.outTradeNo) {
    response.json({ booking, store, synced: false });
    return;
  }

  try {
    const transaction = await fetchWechatTransaction(booking.payment.outTradeNo);
    let nextStore = store;
    let nextBooking = booking;
    if (
      transaction.trade_state === "SUCCESS" &&
      (booking.status === "reserved" || booking.status === "payment_pending")
    ) {
      nextStore = {
        ...store,
        bookings: store.bookings.map((item) =>
          item.id === booking.id
            ? {
                ...item,
                status: "paid",
                payment: {
                  ...item.payment,
                  state: "paid",
                  transactionId: transaction.transaction_id,
                  paidAt: new Date().toISOString(),
                },
              }
            : item,
        ),
      };
      nextBooking = nextStore.bookings.find((item) => item.id === booking.id);
      await writeStore(nextStore);
    }
    response.json({
      booking: nextBooking,
      store: nextStore,
      synced: true,
      tradeState: transaction.trade_state,
    });
  } catch (error) {
    response.status(error.status || 500).json({
      error: "WECHAT_PAY_QUERY_FAILED",
      message: error.message,
      detail: error.detail,
    });
  }
});

app.post("/api/payments/mock-success", async (request, response) => {
  if (process.env.ALLOW_MOCK_PAYMENT !== "true") {
    response.status(403).json({ error: "MOCK_PAYMENT_DISABLED" });
    return;
  }
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  const target = store.bookings.find((booking) => booking.id === request.body.bookingId);
  if (!target) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }
  if (target.userId !== user.id) {
    response.status(403).json({ error: "BOOKING_FORBIDDEN" });
    return;
  }
  store.bookings = store.bookings.map((booking) =>
    booking.id === request.body.bookingId ? { ...booking, status: "paid" } : booking,
  );
  await writeStore(store);
  response.json({ ok: true });
});

app.post("/api/payments/manual-confirmation", async (request, response) => {
  const store = await readStore();
  const userId = getSessionUserId(request);
  const user = store.users.find((item) => item.id === userId);
  if (!user) {
    response.status(401).json({ error: "LOGIN_REQUIRED" });
    return;
  }
  const booking = store.bookings.find((item) => item.id === request.body.bookingId);

  if (!booking) {
    response.status(404).json({ error: "BOOKING_NOT_FOUND" });
    return;
  }

  if (booking.userId !== user.id) {
    response.status(403).json({ error: "BOOKING_FORBIDDEN" });
    return;
  }

  if (booking.status !== "reserved" && booking.status !== "payment_pending") {
    response.status(409).json({ error: "BOOKING_NOT_PAYABLE" });
    return;
  }

  store.bookings = store.bookings.map((item) =>
    item.id === booking.id
      ? {
          ...item,
          status: "payment_pending",
          payment: {
            provider: "manual_confirmation",
            state: "pending",
            outTradeNo: booking.payment?.outTradeNo || makeOutTradeNo(),
            createdAt: booking.payment?.createdAt || new Date().toISOString(),
          },
        }
      : item,
  );
  await writeStore(store);
  response.json({ ok: true, store });
});

app.put("/api/store", async (request, response) => {
  if (!validateStore(request.body)) {
    response.status(400).json({ error: "Invalid store payload" });
    return;
  }
  const currentStore = await readStore();
  const userId = getSessionUserId(request);
  const user = currentStore.users.find((item) => item.id === userId);
  if (!isAuthorizedStoreUpdate(currentStore, request.body, user)) {
    response.status(user ? 403 : 401).json({ error: "STORE_UPDATE_FORBIDDEN" });
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
