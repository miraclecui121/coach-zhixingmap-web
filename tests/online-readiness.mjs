const appUrl = (process.env.APP_URL || "https://coach.zhixingmap.com").replace(/\/$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(path, options) {
  const response = await fetch(`${appUrl}${path}`, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text.slice(0, 120);
  }
  return { response, body };
}

const health = await readJson("/api/health");
assert(health.response.ok && health.body.ok === true, "线上健康检查失败");

const paymentConfig = await readJson("/api/payment-config");
assert(paymentConfig.response.ok, "支付配置接口不可用");
assert(paymentConfig.body.allowMock === false, "线上不应开启测试支付");

const storeResult = await readJson("/api/store");
assert(storeResult.response.ok, "线上 store 接口不可用");
const store = storeResult.body;
assert(Array.isArray(store.users), "store.users 格式异常");
assert(Array.isArray(store.coaches), "store.coaches 格式异常");
assert(Array.isArray(store.bookings), "store.bookings 格式异常");
assert(Array.isArray(store.reviews), "store.reviews 格式异常");
assert(Array.isArray(store.withdrawals), "store.withdrawals 格式异常");

const badBookings = store.bookings.filter((booking) => {
  const coach = store.coaches.find((item) => item.id === booking.coachId);
  return (
    !store.users.some((user) => user.id === booking.userId) ||
    !coach ||
    !coach.slots.some((slot) => slot.id === booking.slotId)
  );
});
assert(badBookings.length === 0, `线上订单存在坏引用：${badBookings.length}`);

const exportResult = await readJson("/api/admin/export");
assert(
  exportResult.response.status === 401 && exportResult.body.error === "LOGIN_REQUIRED",
  "管理员备份接口未上线或未正确保护",
);

const manualResult = await readJson("/api/payments/manual-confirmation", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ bookingId: "__readiness_missing_booking__" }),
});
assert(
  manualResult.response.status === 404 && manualResult.body.error === "BOOKING_NOT_FOUND",
  "人工收款确认接口未上线或行为异常",
);

console.log(
  JSON.stringify(
    {
      ok: true,
      appUrl,
      paymentConfigured: paymentConfig.body.configured,
      users: store.users.length,
      coaches: store.coaches.length,
      approvedCoaches: store.coaches.filter((coach) => coach.status === "approved").length,
      bookings: store.bookings.length,
      badBookings: badBookings.length,
      manualConfirmationReady: true,
      adminExportProtected: true,
    },
    null,
    2,
  ),
);
