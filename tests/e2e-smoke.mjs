import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const port = Number(process.env.E2E_PORT || 5199);
const appUrl = process.env.APP_URL || `http://127.0.0.1:${port}/`;
const dataFile = path.join(process.cwd(), ".tmp", "e2e-store.json");
const chromePath =
  "/Users/cxn/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function clickText(page, text) {
  await page.getByText(text, { exact: true }).click();
}

async function startServer() {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const child = spawn("node", ["server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_FILE: dataFile,
      ALLOW_RESET: "true",
      ALLOW_DEV_LOGIN: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${appUrl}api/health`);
      if (response.ok) return child;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  child.kill();
  throw new Error("Test server did not start");
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: chromePath,
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

  try {
    await fetch(`${appUrl}api/reset`, { method: "POST" });
    const seedState = await fetch(`${appUrl}api/store`).then((response) => response.json());
    const unauthWrite = await fetch(`${appUrl}api/store`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(seedState),
    });
    assert(unauthWrite.status === 401, "未登录请求不应能写入共享 store");

    await page.goto(appUrl, { waitUntil: "networkidle" });

    await page.getByText("教练预约商城 H5").waitFor();
    await page.getByText("服务端共享数据").waitFor();
    assert((await page.locator(".coach-card").count()) === 0, "空环境不应预置教练数据");

    const login = async (openid) => {
      await page.getByPlaceholder("测试 openid 登录").fill(openid);
      await clickText(page, "开发登录");
    };

    await page.getByPlaceholder("微信昵称").fill("测试教练");
    await page.getByPlaceholder("测试 openid", { exact: true }).fill("coach-openid");
    await clickText(page, "开发注册");
    await page.locator(".current-account").filter({ hasText: "测试教练" }).waitFor();
    await clickText(page, "教练中心");
    await page.getByRole("heading", { name: "申请成为教练" }).waitFor();
    await page.getByLabel("展示名称").fill("测试教练");
    await page.getByLabel("单次价格").fill("499");
    await page.getByLabel("标题").fill("申请阶段填写的教练标题");
    await page.getByLabel("教练介绍").fill("这是提交审核前填写的教练介绍。");
    await page.getByLabel("背景介绍").fill("这是提交审核前填写的背景介绍。");
    await page.getByLabel("特长，用逗号分隔").fill("职业规划，表达训练");
    await page.locator(".slot-edit-row").last().locator("input[type='date']").fill("2026-05-28");
    await page.locator(".slot-edit-row").last().locator("input").nth(1).fill("14:30-15:30");
    await clickText(page, "提交教练申请");
    await page.waitForFunction(() => {
      return fetch("/api/store")
        .then((response) => response.json())
        .then((state) =>
          state.coaches.some(
            (coach) =>
              coach.name === "测试教练" &&
              coach.status === "pending" &&
              coach.title === "申请阶段填写的教练标题" &&
              coach.price === 499 &&
              coach.slots.some((slot) => slot.date === "2026-05-28" && slot.time === "14:30-15:30"),
          ),
        );
    });

    await clickText(page, "退出");
    await login("admin");
    await page.locator(".current-account").filter({ hasText: "管理员" }).waitFor();
    await clickText(page, "管理后台");
    await page.getByRole("heading", { name: "管理后台" }).waitFor();
    await page
      .locator(".admin-row")
      .filter({ hasText: "测试教练" })
      .getByRole("button", { name: "通过审核" })
      .click();

    await clickText(page, "退出");
    await login("coach-openid");
    await page.locator(".current-account").filter({ hasText: "测试教练" }).waitFor();
    await clickText(page, "教练中心");
    await page.getByLabel("单次价格").fill("599");
    await page.getByLabel("标题").fill("真实环境测试教练");
    await page.getByLabel("教练介绍").fill("这是从空环境注册并审核通过的教练。");
    await clickText(page, "添加");
    await page.locator(".slot-edit-row").last().locator("input[type='date']").fill("2026-05-28");
    await page.locator(".slot-edit-row").last().locator("input").nth(1).fill("15:00-16:00");
    await page.waitForFunction(() => {
      return fetch("/api/store")
        .then((response) => response.json())
        .then((state) =>
          state.coaches.some(
            (coach) =>
              coach.name === "测试教练" &&
              coach.title === "真实环境测试教练" &&
              coach.slots.some((slot) => slot.date === "2026-05-28"),
          ),
        );
    });

    await page.getByPlaceholder("微信昵称").fill("测试用户");
    await page.getByPlaceholder("测试 openid", { exact: true }).fill("user-openid");
    await clickText(page, "开发注册");
    await page.locator(".current-account").filter({ hasText: "测试用户" }).waitFor();
    await page.locator(".coach-card").filter({ hasText: "真实环境测试教练" }).waitFor();
    const blockedAdminMutation = await page.evaluate(async () => {
      const state = await fetch("/api/store").then((response) => response.json());
      const response = await fetch("/api/store", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...state,
          settings: { ...state.settings, commissionRate: 0 },
        }),
      });
      return response.status;
    });
    assert(blockedAdminMutation === 403, "普通用户不应能篡改平台设置");

    await page.locator(".slot-card").filter({ hasText: "预约并支付" }).first().click();
    await page.getByRole("heading", { name: "确认预约" }).waitFor();
    await clickText(page, "确认并进入支付");
    await page.getByRole("heading", { name: "支付确认" }).waitFor();
    await page.getByText("微信支付尚未配置").waitFor();
    await clickText(page, "已付款，提交平台确认");
    await page.getByText("已提交平台确认").waitFor();
    await page.getByLabel("关闭").click();
    await page.getByText("待平台确认收款").waitFor();

    await clickText(page, "退出");
    await login("admin");
    await page.locator(".current-account").filter({ hasText: "管理员" }).waitFor();
    await clickText(page, "管理后台");
    await page.getByText("订单收款与流转").waitFor();
    await page
      .locator(".admin-order-row")
      .filter({ hasText: "测试用户 预约 测试教练" })
      .getByRole("button", { name: "确认收款" })
      .click();

    await clickText(page, "退出");
    await login("user-openid");
    await page.locator(".current-account").filter({ hasText: "测试用户" }).waitFor();
    await page.getByText("待教练确认").waitFor();
    const noteText = "想重点聊转型路径和行动计划。";
    await page.getByPlaceholder("给教练捎句话").fill(noteText);
    await clickText(page, "保存留言");

    await clickText(page, "退出");
    await login("coach-openid");
    await page.locator(".current-account").filter({ hasText: "测试教练" }).waitFor();
    await clickText(page, "教练中心");
    await page.getByText(`留言：${noteText}`).waitFor();
    await page.getByRole("button", { name: "接受", exact: true }).click();
    await page.getByText("教练已接受").waitFor();
    await page.getByRole("button", { name: "确认完成" }).click();
    await page.getByText("已完成待评价").waitFor();

    await clickText(page, "退出");
    await login("user-openid");
    await page.locator(".current-account").filter({ hasText: "测试用户" }).waitFor();
    await page.getByText("已完成待评价").waitFor();
    const reviewContent = "教练很具体，预约体验顺畅。";
    const reviewBox = page.locator(".review-box").first();
    await reviewBox.locator("input").fill(reviewContent);
    await reviewBox.getByRole("button", { name: "提交评价" }).click();
    await page.getByText("教练很具体，预约体验顺畅。").waitFor();

    await clickText(page, "退出");
    await login("coach-openid");
    await page.locator(".current-account").filter({ hasText: "测试教练" }).waitFor();
    await clickText(page, "教练中心");
    assert(await page.getByText("申请提现").isEnabled(), "完成订单后教练应可申请提现");
    await page.getByText("申请提现").click();
    await page.waitForFunction(() => {
      return fetch("/api/store")
        .then((response) => response.json())
        .then((state) =>
          state.withdrawals.some((withdrawal) => withdrawal.status === "pending"),
        );
    });

    await clickText(page, "退出");
    await login("admin");
    await page.locator(".current-account").filter({ hasText: "管理员" }).waitFor();
    await clickText(page, "管理后台");
    await page.getByRole("heading", { name: "管理后台" }).waitFor();
    await page.locator(".switch").click();
    await page.getByLabel("抽佣比例").fill("15");
    await page.getByText("提现审核").waitFor();
    await page
      .locator(".admin-row")
      .filter({ hasText: "测试教练" })
      .getByRole("button", { name: "通过", exact: true })
      .click();
    const backup = await page.evaluate(async () => {
      const response = await fetch("/api/admin/export");
      return {
        ok: response.ok,
        disposition: response.headers.get("content-disposition") || "",
        data: await response.json(),
      };
    });
    assert(backup.ok, "管理员应能导出数据备份");
    assert(
      backup.disposition.includes("coach-marketplace-backup"),
      "数据备份应带下载文件名",
    );
    assert(
      backup.data.bookings.some((booking) => booking.status === "reviewed"),
      "数据备份应包含当前订单数据",
    );
    await page.getByRole("button", { name: /提取平台扣点/ }).click();
    await page
      .locator(".admin-row")
      .filter({ hasText: "平台扣点" })
      .getByRole("button", { name: "通过", exact: true })
      .click();

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByText("注册用户").waitFor();

    await page.waitForTimeout(300);
    const state = await page.evaluate(() =>
      fetch("/api/store").then((response) => response.json()),
    );
    assert(
      state.bookings.some((booking) => booking.status === "reviewed") &&
        state.reviews.some((review) => review.content === reviewContent),
      "新评价应写入服务端共享数据",
    );
    assert(
      state.coaches.some((coach) => coach.name === "测试教练" && coach.status === "approved"),
      "管理员应能审核通过教练",
    );
    assert(
      state.withdrawals.some((withdrawal) => withdrawal.status === "approved"),
      "管理员应能审核通过提现",
    );
    assert(
      state.withdrawals.some(
        (withdrawal) => withdrawal.target === "platform" && withdrawal.status === "approved",
      ),
      "管理员应能提取平台扣点",
    );
    assert(state.settings.commissionEnabled === false, "管理员应能关闭抽佣开关");
    assert(state.settings.commissionRate === 15, "管理员应能调整抽佣比例");

    console.log("E2E smoke passed");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
