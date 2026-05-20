import {
  BadgeCheck,
  CalendarDays,
  Check,
  ClipboardList,
  CreditCard,
  Edit3,
  Eye,
  HandCoins,
  LayoutDashboard,
  MessageSquareText,
  Plus,
  QrCode,
  Search,
  ShieldCheck,
  Star,
  Trash2,
  UserRoundCheck,
  Users,
  WalletCards,
  MessageCircle,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

type Role = "user" | "coach" | "admin";
type CoachStatus = "pending" | "approved" | "rejected";
type BookingStatus = "reserved" | "paid" | "completed" | "reviewed";
type WithdrawalStatus = "pending" | "approved" | "rejected";

type User = {
  id: string;
  name: string;
  phone: string;
  avatarColor: string;
  wechatOpenid?: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
  authProvider?: "wechat" | "dev";
  isAdmin?: boolean;
  coachId?: string;
};

type Slot = {
  id: string;
  weekday: "周三" | "周四";
  date: string;
  time: string;
  enabled: boolean;
};

type Coach = {
  id: string;
  userId: string;
  name: string;
  title: string;
  status: CoachStatus;
  price: number;
  intro: string;
  background: string;
  specialties: string[];
  slots: Slot[];
};

type Booking = {
  id: string;
  userId: string;
  coachId: string;
  slotId: string;
  amount: number;
  platformFee: number;
  coachIncome: number;
  status: BookingStatus;
  createdAt: string;
  payment?: {
    provider: "wechat_native";
    state: "pending" | "paid";
    outTradeNo: string;
    codeUrl?: string;
    createdAt: string;
    paidAt?: string;
    transactionId?: string;
  };
};

type Review = {
  id: string;
  bookingId: string;
  userId: string;
  coachId: string;
  rating: number;
  content: string;
  createdAt: string;
};

type Withdrawal = {
  id: string;
  coachId: string;
  amount: number;
  status: WithdrawalStatus;
  createdAt: string;
};

type Settings = {
  commissionEnabled: boolean;
  commissionRate: number;
};

type Store = {
  users: User[];
  coaches: Coach[];
  bookings: Booking[];
  reviews: Review[];
  withdrawals: Withdrawal[];
  settings: Settings;
};

type AuthConfig = {
  configured: boolean;
  missing: string[];
  scope: "snsapi_base" | "snsapi_userinfo" | string;
  allowDevLogin: boolean;
};

const storageKey = "coach-marketplace-h5-store";

const seedStore: Store = {
  users: [
    {
      id: "admin",
      name: "管理员",
      phone: "admin",
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

const statusText: Record<BookingStatus, string> = {
  reserved: "待支付",
  paid: "平台托管中",
  completed: "已完成待评价",
  reviewed: "已评价",
};

const coachStatusText: Record<CoachStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  rejected: "已拒绝",
};

function loadStore(): Store {
  const cached = window.localStorage.getItem(storageKey);
  if (!cached) return structuredClone(seedStore);
  try {
    return JSON.parse(cached) as Store;
  } catch {
    return structuredClone(seedStore);
  }
}

function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function formatMoney(value: number) {
  return `¥${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
}

function getSlot(coach: Coach | undefined, slotId: string) {
  return coach?.slots.find((slot) => slot.id === slotId);
}

export function App() {
  const [store, setStore] = useState<Store>(() => loadStore());
  const storeRef = useRef(store);
  const [storeLoaded, setStoreLoaded] = useState(false);
  const [dataMode, setDataMode] = useState<"loading" | "api" | "local">("loading");
  const [authConfig, setAuthConfig] = useState<AuthConfig>({
    configured: false,
    missing: [],
    scope: "snsapi_userinfo",
    allowDevLogin: false,
  });
  const [sessionUser, setSessionUser] = useState<User | undefined>();
  const [role, setRole] = useState<Role>("user");
  const [selectedCoachId, setSelectedCoachId] = useState("c1");
  const [paymentBookingId, setPaymentBookingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let ignore = false;
    const loadStorePromise = fetch("/api/store")
      .then((response) => {
        if (!response.ok) throw new Error("API unavailable");
        return response.json() as Promise<Store>;
      })
      .then((remoteStore) => {
        if (ignore) return;
        storeRef.current = remoteStore;
        setStore(remoteStore);
        setDataMode("api");
        setStoreLoaded(true);
      })
      .catch(() => {
        if (ignore) return;
        setDataMode("local");
        setStoreLoaded(true);
      });

    const loadAuthPromise = fetch("/api/auth/config")
      .then((response) => response.json() as Promise<AuthConfig>)
      .then((config) => {
        if (!ignore) setAuthConfig(config);
      })
      .catch(() => undefined);

    const loadMePromise = fetch("/api/auth/me")
      .then((response) => response.json() as Promise<{ user: User | null }>)
      .then((payload) => {
        if (!ignore) setSessionUser(payload.user ?? undefined);
      })
      .catch(() => undefined);

    void Promise.allSettled([loadStorePromise, loadAuthPromise, loadMePromise]);

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    storeRef.current = store;
    if (!storeLoaded) return;
    window.localStorage.setItem(storageKey, JSON.stringify(store));
  }, [store, storeLoaded]);

  const currentUser = sessionUser
    ? store.users.find((user) => user.id === sessionUser.id) ?? sessionUser
    : undefined;
  const selectedCoach =
    store.coaches.find((coach) => coach.id === selectedCoachId) ??
    store.coaches.find((coach) => coach.status === "approved");

  const approvedCoaches = useMemo(
    () =>
      store.coaches.filter(
        (coach) =>
          coach.status === "approved" &&
          [coach.name, coach.title, coach.intro, coach.specialties.join(" ")]
            .join(" ")
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [query, store.coaches],
  );

  function persistStore(nextStore: Store) {
    window.localStorage.setItem(storageKey, JSON.stringify(nextStore));
    if (dataMode !== "api") return;
    fetch("/api/store", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextStore),
    }).catch(() => setDataMode("local"));
  }

  const setStorePatch = (updater: (draft: Store) => Store) => {
    const nextStore = updater(storeRef.current);
    storeRef.current = nextStore;
    setStore(nextStore);
    persistStore(nextStore);
  };

  async function refreshAuthState() {
    const [storeResponse, meResponse] = await Promise.all([
      fetch("/api/store"),
      fetch("/api/auth/me"),
    ]);
    if (storeResponse.ok) {
      const remoteStore = (await storeResponse.json()) as Store;
      storeRef.current = remoteStore;
      setStore(remoteStore);
    }
    if (meResponse.ok) {
      const payload = (await meResponse.json()) as { user: User | null };
      setSessionUser(payload.user ?? undefined);
    }
  }

  async function devLogin(openid: string, nickname?: string) {
    const response = await fetch("/api/auth/dev-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ openid, nickname }),
    });
    if (!response.ok) return;
    await refreshAuthState();
    setRole("user");
  }

  async function registerUser(name: string, phone: string) {
    const existing = store.users.find(
      (user) => user.phone === phone || user.wechatOpenid === phone,
    );
    if (existing) {
      await devLogin(phone, existing.name);
      setRole("user");
      return;
    }
    await devLogin(phone, name);
  }

  const currentCoach = currentUser
    ? store.coaches.find((coach) => coach.userId === currentUser.id)
    : undefined;
  const canUseCoachDesk = Boolean(currentCoach);
  const canUseAdminDesk = Boolean(currentUser?.isAdmin);

  function switchRole(nextRole: Role) {
    if (nextRole === "coach" && !canUseCoachDesk) {
      applyCoach("pending");
    }
    if (nextRole === "admin" && !canUseAdminDesk) return;
    setRole(nextRole);
  }

  function applyCoach(status: CoachStatus = "pending") {
    if (!currentUser) return;
    if (store.coaches.some((coach) => coach.userId === currentUser.id)) {
      setRole("coach");
      return;
    }
    const coachId = makeId("c");
    setStorePatch((draft) => ({
      ...draft,
      users: draft.users.map((user) =>
        user.id === currentUser.id ? { ...user, coachId } : user,
      ),
      coaches: [
        ...draft.coaches,
        {
          id: coachId,
          userId: currentUser.id,
          name: currentUser.name,
          title: "新教练申请",
          status,
          price: 399,
          intro: "请完善你的教练介绍。",
          background: "请补充你的专业背景。",
          specialties: ["待完善"],
          slots: [],
        },
      ],
    }));
    setRole("coach");
  }

  function bookSlot(coach: Coach, slot: Slot) {
    if (!currentUser) return;
    const amount = coach.price;
    const platformFee = store.settings.commissionEnabled
      ? amount * (store.settings.commissionRate / 100)
      : 0;
    const booking: Booking = {
      id: makeId("b"),
      userId: currentUser.id,
      coachId: coach.id,
      slotId: slot.id,
      amount,
      platformFee,
      coachIncome: amount - platformFee,
      status: "reserved",
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    setStorePatch((draft) => ({ ...draft, bookings: [booking, ...draft.bookings] }));
    setPaymentBookingId(booking.id);
  }

  function payBooking(id: string) {
    setStorePatch((draft) => ({
      ...draft,
      bookings: draft.bookings.map((booking) =>
        booking.id === id ? { ...booking, status: "paid" } : booking,
      ),
    }));
    setPaymentBookingId(null);
  }

  function completeBooking(id: string) {
    setStorePatch((draft) => ({
      ...draft,
      bookings: draft.bookings.map((booking) =>
        booking.id === id ? { ...booking, status: "completed" } : booking,
      ),
    }));
  }

  function addReview(bookingId: string, rating: number, content: string) {
    if (!currentUser) return;
    const booking = store.bookings.find((item) => item.id === bookingId);
    if (!booking) return;
    const review: Review = {
      id: makeId("r"),
      bookingId,
      userId: currentUser.id,
      coachId: booking.coachId,
      rating,
      content,
      createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    };
    setStorePatch((draft) => ({
      ...draft,
      reviews: [review, ...draft.reviews],
      bookings: draft.bookings.map((item) =>
        item.id === bookingId ? { ...item, status: "reviewed" } : item,
      ),
    }));
  }

  function updateCoach(coachId: string, patch: Partial<Coach>) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId ? { ...coach, ...patch } : coach,
      ),
    }));
  }

  function addSlot(coachId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? {
              ...coach,
              slots: [
                ...coach.slots,
                {
                  id: makeId("s"),
                  weekday: "周三",
                  date: "2026-05-27",
                  time: "14:00-15:00",
                  enabled: true,
                },
              ],
            }
          : coach,
      ),
    }));
  }

  function updateSlot(coachId: string, slotId: string, patch: Partial<Slot>) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? {
              ...coach,
              slots: coach.slots.map((slot) =>
                slot.id === slotId ? { ...slot, ...patch } : slot,
              ),
            }
          : coach,
      ),
    }));
  }

  function removeSlot(coachId: string, slotId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.map((coach) =>
        coach.id === coachId
          ? { ...coach, slots: coach.slots.filter((slot) => slot.id !== slotId) }
          : coach,
      ),
    }));
  }

  function requestWithdrawal(coachId: string, amount: number) {
    if (amount <= 0) return;
    setStorePatch((draft) => ({
      ...draft,
      withdrawals: [
        {
          id: makeId("w"),
          coachId,
          amount,
          status: "pending",
          createdAt: new Date().toLocaleString("zh-CN", { hour12: false }),
        },
        ...draft.withdrawals,
      ],
    }));
  }

  function deleteCoach(coachId: string) {
    setStorePatch((draft) => ({
      ...draft,
      coaches: draft.coaches.filter((coach) => coach.id !== coachId),
      bookings: draft.bookings.filter((booking) => booking.coachId !== coachId),
      reviews: draft.reviews.filter((review) => review.coachId !== coachId),
      withdrawals: draft.withdrawals.filter((withdrawal) => withdrawal.coachId !== coachId),
    }));
    if (selectedCoachId === coachId) {
      setSelectedCoachId(store.coaches.find((coach) => coach.id !== coachId)?.id ?? "");
    }
  }

  return (
    <main>
      <Header
        currentUser={currentUser}
        dataMode={dataMode}
        authConfig={authConfig}
        onRegister={registerUser}
        onLogin={(openid) => devLogin(openid)}
        onLogout={async () => {
          await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
          setSessionUser(undefined);
          setRole("user");
        }}
      />

      <div className="shell">
        <aside className="rail">
          <button
            className={role === "user" ? "active" : ""}
            onClick={() => switchRole("user")}
          >
            <Users size={18} />
            用户商城
          </button>
          <button
            className={role === "coach" ? "active" : ""}
            onClick={() => switchRole("coach")}
          >
            <UserRoundCheck size={18} />
            教练中心
          </button>
          <button
            className={role === "admin" ? "active" : ""}
            disabled={!currentUser || !canUseAdminDesk}
            onClick={() => switchRole("admin")}
          >
            <ShieldCheck size={18} />
            管理后台
          </button>
        </aside>

        {role === "user" &&
          (currentUser ? (
            <UserDesk
              coaches={approvedCoaches}
              allCoaches={store.coaches}
              bookings={store.bookings}
              reviews={store.reviews}
              users={store.users}
              currentUser={currentUser}
              selectedCoach={selectedCoach}
              query={query}
              onQuery={setQuery}
              onSelectCoach={setSelectedCoachId}
              onBook={bookSlot}
              onPay={setPaymentBookingId}
              onComplete={completeBooking}
              onReview={addReview}
            />
          ) : (
            <section className="workspace">
              <div className="panel empty-state">
                <Users size={42} />
                <h1>请先微信授权登录</h1>
                <p>进入微信后确认当前账号，即可预约教练、申请成为教练，或进入管理员后台。</p>
                {authConfig.configured && (
                  <a className="primary link-button" href="/api/auth/wechat/start?redirect=/">
                    <MessageCircle size={18} />
                    微信授权登录
                  </a>
                )}
              </div>
            </section>
          ))}

        {role === "coach" && currentUser && (
          <CoachDesk
            coach={currentCoach}
            bookings={store.bookings}
            reviews={store.reviews}
            users={store.users}
            withdrawals={store.withdrawals}
            onApply={() => applyCoach()}
            onUpdateCoach={updateCoach}
            onAddSlot={addSlot}
            onUpdateSlot={updateSlot}
            onRemoveSlot={removeSlot}
            onWithdraw={requestWithdrawal}
          />
        )}

        {role === "admin" && currentUser && (
          <AdminDesk
            store={store}
            onUpdateCoach={updateCoach}
            onDeleteCoach={deleteCoach}
            onSettings={(settings) =>
              setStorePatch((draft) => ({
                ...draft,
                settings,
              }))
            }
            onWithdrawal={(id, status) =>
              setStorePatch((draft) => ({
                ...draft,
                withdrawals: draft.withdrawals.map((withdrawal) =>
                  withdrawal.id === id ? { ...withdrawal, status } : withdrawal,
                ),
              }))
            }
          />
        )}
      </div>

      {paymentBookingId && (
        <PaymentModal
          booking={store.bookings.find((booking) => booking.id === paymentBookingId)}
          coach={store.coaches.find(
            (coach) =>
              coach.id ===
              store.bookings.find((booking) => booking.id === paymentBookingId)?.coachId,
          )}
          onClose={() => setPaymentBookingId(null)}
          onPay={() => payBooking(paymentBookingId)}
          onStoreReplace={(nextStore) => {
            storeRef.current = nextStore;
            setStore(nextStore);
          }}
        />
      )}
    </main>
  );
}

function Header({
  currentUser,
  dataMode,
  authConfig,
  onRegister,
  onLogin,
  onLogout,
}: {
  currentUser?: User;
  dataMode: "loading" | "api" | "local";
  authConfig: AuthConfig;
  onRegister: (name: string, phone: string) => void;
  onLogin: (phone: string) => void;
  onLogout: () => void;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loginPhone, setLoginPhone] = useState("");

  return (
    <header className="topbar">
      <div>
        <div className="brand">
          <MessageCircle size={24} />
          <span>教练预约商城 H5</span>
        </div>
        <p>微信注册、教练预约、微信扫码支付、平台托管与提现管理</p>
      </div>
      <div className="login-cluster">
        <span className={`data-badge ${dataMode}`}>
          {dataMode === "api"
            ? "服务端共享数据"
            : dataMode === "loading"
              ? "正在连接数据"
              : "本地备用数据"}
        </span>
        <div className="current-account">
          {currentUser?.avatarUrl ? (
            <img src={currentUser.avatarUrl} alt="" />
          ) : (
            <Avatar label={currentUser?.name ?? "微"} color={currentUser?.avatarColor ?? "#0f766e"} />
          )}
          <span>当前微信账号</span>
          <strong>{currentUser ? currentUser.nickname || currentUser.name : "未登录"}</strong>
          {currentUser?.isAdmin && <em>管理员</em>}
          {currentUser && (
            <button className="ghost small" onClick={onLogout}>
              退出
            </button>
          )}
        </div>
        {!currentUser && authConfig.configured && (
          <a className="primary link-button" href="/api/auth/wechat/start?redirect=/">
            <MessageCircle size={18} />
            微信授权登录
          </a>
        )}
        {!currentUser && !authConfig.configured && (
          <div className="auth-warning">
            <strong>微信授权未配置</strong>
            <small>{authConfig.missing.join("、") || "请检查服务端 OAuth 环境变量"}</small>
          </div>
        )}
        {authConfig.allowDevLogin && (
          <>
            <div className="register-line">
              <input
                value={loginPhone}
                onChange={(event) => setLoginPhone(event.target.value)}
                placeholder="测试 openid 登录"
              />
              <button
                className="ghost"
                disabled={!loginPhone.trim()}
                onClick={() => {
                  onLogin(loginPhone.trim());
                  setLoginPhone("");
                }}
              >
                开发登录
              </button>
            </div>
            <div className="register-line">
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="微信昵称" />
              <input value={phone} onChange={(event) => setPhone(event.target.value)} placeholder="测试 openid" />
              <button
                className="ghost"
                disabled={!name.trim() || !phone.trim()}
                onClick={() => {
                  onRegister(name.trim(), phone.trim());
                  setName("");
                  setPhone("");
                }}
              >
                开发注册
              </button>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function UserDesk({
  coaches,
  allCoaches,
  bookings,
  reviews,
  users,
  currentUser,
  selectedCoach,
  query,
  onQuery,
  onSelectCoach,
  onBook,
  onPay,
  onComplete,
  onReview,
}: {
  coaches: Coach[];
  allCoaches: Coach[];
  bookings: Booking[];
  reviews: Review[];
  users: User[];
  currentUser: User;
  selectedCoach?: Coach;
  query: string;
  onQuery: (value: string) => void;
  onSelectCoach: (id: string) => void;
  onBook: (coach: Coach, slot: Slot) => void;
  onPay: (id: string) => void;
  onComplete: (id: string) => void;
  onReview: (bookingId: string, rating: number, content: string) => void;
}) {
  const userBookings = bookings.filter((booking) => booking.userId === currentUser.id);
  const coachReviews = selectedCoach
    ? reviews.filter((review) => review.coachId === selectedCoach.id)
    : [];

  return (
    <section className="workspace two-col">
      <div className="panel coach-list">
        <div className="section-title">
          <div>
            <h1>找教练</h1>
            <p>查看介绍、评价，并预约周三或周四下午的对话时间。</p>
          </div>
        </div>
        <div className="searchbox">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            placeholder="搜索教练、特长或背景"
          />
        </div>
        <div className="coach-stack">
          {coaches.map((coach) => {
            const average =
              reviews.filter((review) => review.coachId === coach.id).reduce((sum, item) => sum + item.rating, 0) /
              Math.max(1, reviews.filter((review) => review.coachId === coach.id).length);
            return (
              <button
                className={`coach-card ${selectedCoach?.id === coach.id ? "selected" : ""}`}
                key={coach.id}
                onClick={() => onSelectCoach(coach.id)}
              >
                <Avatar label={coach.name} color={avatarForCoach(coach)} />
                <span>
                  <strong>{coach.name}</strong>
                  <small>{coach.title}</small>
                  <em>
                    <Star size={14} fill="currentColor" />
                    {average.toFixed(1)} · {formatMoney(coach.price)}/次
                  </em>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="detail-stack">
        {selectedCoach && (
          <div className="panel detail-panel">
            <div className="coach-hero">
              <Avatar label={selectedCoach.name} color={avatarForCoach(selectedCoach)} large />
              <div>
                <h2>{selectedCoach.name}</h2>
                <p>{selectedCoach.title}</p>
                <div className="tag-row">
                  {selectedCoach.specialties.map((item) => (
                    <span key={item}>{item}</span>
                  ))}
                </div>
              </div>
              <strong>{formatMoney(selectedCoach.price)}</strong>
            </div>
            <div className="info-grid">
              <article>
                <h3>介绍</h3>
                <p>{selectedCoach.intro}</p>
              </article>
              <article>
                <h3>背景</h3>
                <p>{selectedCoach.background}</p>
              </article>
            </div>
            <h3 className="subhead">可预约时间</h3>
            <div className="slot-grid">
              {selectedCoach.slots
                .filter((slot) => slot.enabled)
                .map((slot) => {
                  const occupied = bookings.some(
                    (booking) =>
                      booking.coachId === selectedCoach.id &&
                      booking.slotId === slot.id &&
                      booking.status !== "reserved",
                  );
                  return (
                    <button
                      key={slot.id}
                      className="slot-card"
                      disabled={occupied}
                      onClick={() => onBook(selectedCoach, slot)}
                    >
                      <CalendarDays size={18} />
                      <span>{slot.weekday}</span>
                      <strong>{slot.date}</strong>
                      <small>{slot.time}</small>
                      <em>{occupied ? "已预约" : "预约并支付"}</em>
                    </button>
                  );
                })}
            </div>
            <h3 className="subhead">用户评价</h3>
            <ReviewList reviews={coachReviews} users={users} empty="还没有评价" />
          </div>
        )}

        <div className="panel">
          <div className="section-title compact">
            <div>
              <h2>我的预约</h2>
              <p>支付后金额进入平台托管，完成对话后才能评价。</p>
            </div>
          </div>
          <BookingList
            bookings={userBookings}
            coaches={allCoaches}
            currentUser={currentUser}
            onPay={onPay}
            onComplete={onComplete}
            onReview={onReview}
          />
        </div>
      </div>
    </section>
  );
}

function CoachDesk({
  coach,
  bookings,
  reviews,
  users,
  withdrawals,
  onApply,
  onUpdateCoach,
  onAddSlot,
  onUpdateSlot,
  onRemoveSlot,
  onWithdraw,
}: {
  coach?: Coach;
  bookings: Booking[];
  reviews: Review[];
  users: User[];
  withdrawals: Withdrawal[];
  onApply: () => void;
  onUpdateCoach: (coachId: string, patch: Partial<Coach>) => void;
  onAddSlot: (coachId: string) => void;
  onUpdateSlot: (coachId: string, slotId: string, patch: Partial<Slot>) => void;
  onRemoveSlot: (coachId: string, slotId: string) => void;
  onWithdraw: (coachId: string, amount: number) => void;
}) {
  if (!coach) {
    return (
      <section className="workspace">
        <div className="panel empty-state">
          <UserRoundCheck size={42} />
          <h1>申请成为教练</h1>
          <p>提交后需要管理员审核，通过后才能设置价格、时间和提现。</p>
          <button className="primary" onClick={onApply}>
            <Plus size={18} />
            提交教练申请
          </button>
        </div>
      </section>
    );
  }

  const coachBookings = bookings.filter((booking) => booking.coachId === coach.id);
  const completedIncome = coachBookings
    .filter((booking) => booking.status === "completed" || booking.status === "reviewed")
    .reduce((sum, booking) => sum + booking.coachIncome, 0);
  const paidOut = withdrawals
    .filter((withdrawal) => withdrawal.coachId === coach.id && withdrawal.status !== "rejected")
    .reduce((sum, withdrawal) => sum + withdrawal.amount, 0);
  const withdrawable = Math.max(0, completedIncome - paidOut);

  return (
    <section className="workspace two-col">
      <div className="panel">
        <div className="section-title">
          <div>
            <h1>教练中心</h1>
            <p>审核通过后，用户才能看到你的主页并预约。</p>
          </div>
          <span className={`pill ${coach.status}`}>{coachStatusText[coach.status]}</span>
        </div>
        <EditableCoach coach={coach} onUpdate={onUpdateCoach} disabled={coach.status !== "approved"} />
      </div>

      <div className="detail-stack">
        <div className="panel">
          <div className="metric-row">
            <Metric icon={<CreditCard size={19} />} label="已托管订单" value={coachBookings.filter((b) => b.status === "paid").length.toString()} />
            <Metric icon={<WalletCards size={19} />} label="可提现" value={formatMoney(withdrawable)} />
            <Metric icon={<Star size={19} />} label="评价数" value={reviews.filter((review) => review.coachId === coach.id).length.toString()} />
          </div>
          <button
            className="primary full"
            disabled={coach.status !== "approved" || withdrawable <= 0}
            onClick={() => onWithdraw(coach.id, withdrawable)}
          >
            <HandCoins size={18} />
            申请提现 {formatMoney(withdrawable)}
          </button>
        </div>

        <div className="panel">
          <div className="section-title compact">
            <div>
              <h2>可预约时间</h2>
              <p>当前 MVP 限定周三或周四下午，由教练自己维护。</p>
            </div>
            <button className="ghost" disabled={coach.status !== "approved"} onClick={() => onAddSlot(coach.id)}>
              <Plus size={17} />
              添加
            </button>
          </div>
          <SlotEditor coach={coach} onUpdate={onUpdateSlot} onRemove={onRemoveSlot} disabled={coach.status !== "approved"} />
        </div>

        <div className="panel">
          <h2>预约订单</h2>
          <CoachBookingTable bookings={coachBookings} coach={coach} users={users} />
        </div>
      </div>
    </section>
  );
}

function AdminDesk({
  store,
  onUpdateCoach,
  onDeleteCoach,
  onSettings,
  onWithdrawal,
}: {
  store: Store;
  onUpdateCoach: (coachId: string, patch: Partial<Coach>) => void;
  onDeleteCoach: (coachId: string) => void;
  onSettings: (settings: Settings) => void;
  onWithdrawal: (id: string, status: WithdrawalStatus) => void;
}) {
  const gross = store.bookings
    .filter((booking) => booking.status !== "reserved")
    .reduce((sum, booking) => sum + booking.amount, 0);
  const escrow = store.bookings
    .filter((booking) => booking.status === "paid")
    .reduce((sum, booking) => sum + booking.amount, 0);
  const platformFees = store.bookings
    .filter((booking) => booking.status !== "reserved")
    .reduce((sum, booking) => sum + booking.platformFee, 0);

  return (
    <section className="workspace admin-grid">
      <div className="panel admin-span">
        <div className="section-title">
          <div>
            <h1>管理后台</h1>
            <p>管理员由后台绑定微信 openid，这里只模拟最高权限。</p>
          </div>
          <ShieldCheck size={28} />
        </div>
        <div className="metric-row">
          <Metric icon={<Users size={19} />} label="注册用户" value={store.users.length.toString()} />
          <Metric icon={<UserRoundCheck size={19} />} label="教练数" value={store.coaches.length.toString()} />
          <Metric icon={<ClipboardList size={19} />} label="订单数" value={store.bookings.length.toString()} />
          <Metric icon={<CreditCard size={19} />} label="成交金额" value={formatMoney(gross)} />
          <Metric icon={<WalletCards size={19} />} label="托管中" value={formatMoney(escrow)} />
          <Metric icon={<HandCoins size={19} />} label="平台收入" value={formatMoney(platformFees)} />
        </div>
      </div>

      <div className="panel">
        <h2>抽佣设置</h2>
        <div className="setting-line">
          <span>平台抽佣</span>
          <label className="switch">
            <input
              type="checkbox"
              checked={store.settings.commissionEnabled}
              onChange={(event) =>
                onSettings({ ...store.settings, commissionEnabled: event.target.checked })
              }
            />
            <i />
          </label>
        </div>
        <label className="field">
          <span>抽佣比例</span>
          <input
            type="number"
            min="0"
            max="80"
            value={store.settings.commissionRate}
            onChange={(event) =>
              onSettings({ ...store.settings, commissionRate: Number(event.target.value) })
            }
          />
        </label>
      </div>

      <div className="panel">
        <h2>用户注册</h2>
        <div className="simple-list">
          {store.users.map((user) => (
            <div key={user.id}>
              <Avatar label={user.name} color={user.avatarColor} />
              <span>
                <strong>{user.name}</strong>
                <small>{user.phone}</small>
              </span>
              {user.isAdmin && <em>管理员</em>}
            </div>
          ))}
        </div>
      </div>

      <div className="panel admin-span">
        <h2>教练维护与审核</h2>
        <div className="admin-table">
          {store.coaches.map((coach) => (
            <div key={coach.id} className="admin-row coach-admin-row">
              <Avatar label={coach.name} color={avatarForCoach(coach)} />
              <span>
                <strong>{coach.name}</strong>
                <small>{coach.title}</small>
              </span>
              <span className={`pill ${coach.status}`}>{coachStatusText[coach.status]}</span>
              <label>
                <span>价格</span>
                <input
                  type="number"
                  value={coach.price}
                  onChange={(event) => onUpdateCoach(coach.id, { price: Number(event.target.value) })}
                />
              </label>
              <div className="review-actions" aria-label={`${coach.name}审核操作`}>
                <button
                  className="primary small"
                  disabled={coach.status === "approved"}
                  onClick={() => onUpdateCoach(coach.id, { status: "approved" })}
                >
                  <Check size={16} />
                  通过审核
                </button>
                <button
                  className="ghost danger-text small"
                  disabled={coach.status === "rejected"}
                  onClick={() => onUpdateCoach(coach.id, { status: "rejected" })}
                >
                  <X size={16} />
                  拒绝
                </button>
              </div>
              <button className="icon-danger" onClick={() => onDeleteCoach(coach.id)} aria-label="删除教练">
                <Trash2 size={17} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="panel admin-span">
        <h2>提现审核</h2>
        <div className="admin-table">
          {store.withdrawals.length === 0 && <p className="muted">暂无提现申请</p>}
          {store.withdrawals.map((withdrawal) => {
            const coach = store.coaches.find((item) => item.id === withdrawal.coachId);
            return (
              <div key={withdrawal.id} className="admin-row">
                <HandCoins size={22} />
                <span>
                  <strong>{coach?.name ?? "未知教练"}</strong>
                  <small>{withdrawal.createdAt}</small>
                </span>
                <strong>{formatMoney(withdrawal.amount)}</strong>
                <span className={`pill ${withdrawal.status}`}>{withdrawal.status}</span>
                <button className="ghost" onClick={() => onWithdrawal(withdrawal.id, "approved")}>
                  <Check size={16} />
                  通过
                </button>
                <button className="ghost danger-text" onClick={() => onWithdrawal(withdrawal.id, "rejected")}>
                  <X size={16} />
                  拒绝
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function EditableCoach({
  coach,
  onUpdate,
  disabled,
}: {
  coach: Coach;
  onUpdate: (coachId: string, patch: Partial<Coach>) => void;
  disabled: boolean;
}) {
  return (
    <div className="form-grid">
      <label className="field">
        <span>展示名称</span>
        <input value={coach.name} disabled={disabled} onChange={(event) => onUpdate(coach.id, { name: event.target.value })} />
      </label>
      <label className="field">
        <span>单次价格</span>
        <input type="number" value={coach.price} disabled={disabled} onChange={(event) => onUpdate(coach.id, { price: Number(event.target.value) })} />
      </label>
      <label className="field full-field">
        <span>标题</span>
        <input value={coach.title} disabled={disabled} onChange={(event) => onUpdate(coach.id, { title: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>教练介绍</span>
        <textarea value={coach.intro} disabled={disabled} onChange={(event) => onUpdate(coach.id, { intro: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>背景介绍</span>
        <textarea value={coach.background} disabled={disabled} onChange={(event) => onUpdate(coach.id, { background: event.target.value })} />
      </label>
      <label className="field full-field">
        <span>特长，用逗号分隔</span>
        <input
          value={coach.specialties.join("，")}
          disabled={disabled}
          onChange={(event) =>
            onUpdate(coach.id, {
              specialties: event.target.value
                .split(/[，,]/)
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
        />
      </label>
    </div>
  );
}

function SlotEditor({
  coach,
  onUpdate,
  onRemove,
  disabled,
}: {
  coach: Coach;
  onUpdate: (coachId: string, slotId: string, patch: Partial<Slot>) => void;
  onRemove: (coachId: string, slotId: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="slot-editor">
      {coach.slots.length === 0 && <p className="muted">还没有设置可预约时间</p>}
      {coach.slots.map((slot) => (
        <div key={slot.id} className="slot-edit-row">
          <select
            value={slot.weekday}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { weekday: event.target.value as Slot["weekday"] })}
          >
            <option value="周三">周三</option>
            <option value="周四">周四</option>
          </select>
          <input
            type="date"
            value={slot.date}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { date: event.target.value })}
          />
          <input
            value={slot.time}
            disabled={disabled}
            onChange={(event) => onUpdate(coach.id, slot.id, { time: event.target.value })}
          />
          <label className="mini-check">
            <input
              type="checkbox"
              checked={slot.enabled}
              disabled={disabled}
              onChange={(event) => onUpdate(coach.id, slot.id, { enabled: event.target.checked })}
            />
            开放
          </label>
          <button disabled={disabled} className="icon-danger" onClick={() => onRemove(coach.id, slot.id)} aria-label="删除时间">
            <Trash2 size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}

function BookingList({
  bookings,
  coaches,
  currentUser,
  onPay,
  onComplete,
  onReview,
}: {
  bookings: Booking[];
  coaches: Coach[];
  currentUser: User;
  onPay: (id: string) => void;
  onComplete: (id: string) => void;
  onReview: (bookingId: string, rating: number, content: string) => void;
}) {
  const [reviewDraft, setReviewDraft] = useState<Record<string, string>>({});
  const [ratingDraft, setRatingDraft] = useState<Record<string, number>>({});

  if (bookings.length === 0) {
    return <p className="muted">暂无预约</p>;
  }

  return (
    <div className="booking-stack">
      {bookings.map((booking) => {
        const coach = coaches.find((item) => item.id === booking.coachId);
        const slot = getSlot(coach, booking.slotId);
        const rating = ratingDraft[booking.id] ?? 5;
        const content = reviewDraft[booking.id] ?? "";
        return (
          <article key={booking.id} className="booking-card">
            <div>
              <strong>{coach?.name}</strong>
              <span>{slot ? `${slot.weekday} ${slot.date} ${slot.time}` : "时间已删除"}</span>
              <small>
                {statusText[booking.status]} · 托管金额 {formatMoney(booking.amount)}
              </small>
            </div>
            <div className="booking-actions">
              {booking.status === "reserved" && (
                <button className="primary small" onClick={() => onPay(booking.id)}>
                  <QrCode size={16} />
                  去支付
                </button>
              )}
              {booking.status === "paid" && (
                <button className="ghost" onClick={() => onComplete(booking.id)}>
                  <Check size={16} />
                  模拟完成
                </button>
              )}
            </div>
            {booking.status === "completed" && (
              <div className="review-box">
                <select value={rating} onChange={(event) => setRatingDraft({ ...ratingDraft, [booking.id]: Number(event.target.value) })}>
                  {[5, 4, 3, 2, 1].map((value) => (
                    <option key={value} value={value}>
                      {value} 星
                    </option>
                  ))}
                </select>
                <input
                  value={content}
                  onChange={(event) => setReviewDraft({ ...reviewDraft, [booking.id]: event.target.value })}
                  placeholder={`${currentUser.name}，写下这次对话的反馈`}
                />
                <button className="primary small" disabled={!content.trim()} onClick={() => onReview(booking.id, rating, content.trim())}>
                  <MessageSquareText size={16} />
                  提交评价
                </button>
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

function CoachBookingTable({ bookings, coach, users }: { bookings: Booking[]; coach: Coach; users: User[] }) {
  if (bookings.length === 0) return <p className="muted">暂无预约订单</p>;
  return (
    <div className="order-table">
      {bookings.map((booking) => {
        const slot = getSlot(coach, booking.slotId);
        const user = users.find((item) => item.id === booking.userId);
        return (
          <div key={booking.id}>
            <span>{user?.name ?? "未知用户"}</span>
            <small>{slot ? `${slot.date} ${slot.time}` : "时间已删除"}</small>
            <strong>{formatMoney(booking.coachIncome)}</strong>
            <em>{statusText[booking.status]}</em>
          </div>
        );
      })}
    </div>
  );
}

function ReviewList({ reviews, users, empty }: { reviews: Review[]; users: User[]; empty: string }) {
  if (reviews.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="review-list">
      {reviews.map((review) => {
        const user = users.find((item) => item.id === review.userId);
        return (
          <article key={review.id}>
            <div>
              <strong>{user?.name ?? "匿名用户"}</strong>
              <span>
                {Array.from({ length: review.rating }).map((_, index) => (
                  <Star key={index} size={14} fill="currentColor" />
                ))}
              </span>
            </div>
            <p>{review.content}</p>
            <small>{review.createdAt}</small>
          </article>
        );
      })}
    </div>
  );
}

function PaymentModal({
  booking,
  coach,
  onClose,
  onPay,
  onStoreReplace,
}: {
  booking?: Booking;
  coach?: Coach;
  onClose: () => void;
  onPay: () => void;
  onStoreReplace: (store: Store) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [codeUrl, setCodeUrl] = useState("");
  const [missing, setMissing] = useState<string[]>([]);
  const [allowMock, setAllowMock] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!booking) return;
    let stopped = false;
    setLoading(true);
    setError("");
    setMissing([]);
    setQrDataUrl("");
    setCodeUrl("");

    fetch("/api/payment-config")
      .then((response) => response.json())
      .then((config) => {
        if (stopped) return;
        setAllowMock(Boolean(config.allowMock));
        if (!config.configured) {
          setMissing(config.missing ?? []);
          return null;
        }
        return fetch("/api/payments/wechat/native", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bookingId: booking.id }),
        });
      })
      .then((response) => {
        if (!response || stopped) return null;
        if (!response.ok) {
          return response.json().then((body) => {
            throw new Error(body.message || body.error || "微信支付下单失败");
          });
        }
        return response.json();
      })
      .then((payment) => {
        if (!payment || stopped) return;
        setQrDataUrl(payment.qrDataUrl);
        setCodeUrl(payment.codeUrl);
      })
      .catch((err) => {
        if (!stopped) setError(err.message || "微信支付下单失败");
      })
      .finally(() => {
        if (!stopped) setLoading(false);
      });

    const poll = window.setInterval(() => {
      fetch("/api/store")
        .then((response) => response.json())
        .then((remoteStore: Store) => {
          if (stopped) return;
          const remoteBooking = remoteStore.bookings.find((item) => item.id === booking.id);
          if (remoteBooking?.status === "paid") {
            onStoreReplace(remoteStore);
            onClose();
          }
        })
        .catch(() => undefined);
    }, 3000);

    return () => {
      stopped = true;
      window.clearInterval(poll);
    };
  }, [booking, onClose, onStoreReplace]);

  if (!booking || !coach) return null;
  const slot = getSlot(coach, booking.slotId);

  async function mockPay() {
    setLoading(true);
    setError("");
    const response = await fetch("/api/payments/mock-success", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: booking?.id }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error || "测试支付未启用");
      setLoading(false);
      return;
    }
    onPay();
    setLoading(false);
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <button className="close" onClick={onClose} aria-label="关闭">
          <X size={18} />
        </button>
        <div className="qr-visual">
          {qrDataUrl ? <img src={qrDataUrl} alt="微信支付二维码" /> : <QrCode size={112} />}
        </div>
        <h2>微信扫码支付</h2>
        <p>
          {coach.name} · {slot?.date} {slot?.time}
        </p>
        <strong>{formatMoney(booking.amount)}</strong>
        {loading && <p className="muted">正在创建微信支付订单...</p>}
        {qrDataUrl && (
          <p className="muted">请使用微信扫码支付。支付成功回调后，订单会自动进入平台托管。</p>
        )}
        {codeUrl && <textarea className="code-url" readOnly value={codeUrl} />}
        {missing.length > 0 && (
          <div className="payment-warning">
            <strong>微信支付尚未配置</strong>
            <p>需要在服务端环境变量中补齐：</p>
            <small>{missing.join("、")}</small>
          </div>
        )}
        {error && <p className="error-text">{error}</p>}
        {allowMock && (
          <button className="ghost full" onClick={mockPay} disabled={loading}>
            <BadgeCheck size={18} />
            测试环境标记支付成功
          </button>
        )}
      </div>
    </div>
  );
}

function Avatar({ label, color, large = false }: { label: string; color: string; large?: boolean }) {
  return (
    <div className={`avatar ${large ? "large" : ""}`} style={{ background: color }}>
      {label.slice(0, 1)}
    </div>
  );
}

function Metric({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function avatarForCoach(coach: Coach) {
  const colors = ["#0f766e", "#7c3aed", "#b45309", "#2563eb", "#be123c"];
  return colors[coach.id.charCodeAt(coach.id.length - 1) % colors.length];
}
